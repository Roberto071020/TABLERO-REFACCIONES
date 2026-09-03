// ===================== WhatsApp Fase A -- modo "solo registro" =====================
// Autorización de Roberto (3-sep-2026): SOLO detectar y registrar qué plantilla se habría disparado
// (expediente, fecha, hora, motivo, variables), aplicar condiciones bloqueantes, deduplicar, calcular
// horario de envío (cola L-V 9-18 / Sáb 9-14) y continuidad de 72 horas hábiles.
//
// LÍMITES DUROS DE ESTE MÓDULO (no removerlos sin autorización explícita de Roberto):
//   - JAMÁS hace una llamada HTTP real a WhatsApp/Meta/Graph API. No existe ningún fetch/axios/request
//     hacia un servicio externo en este archivo. Todo lo que hace es leer la base de datos local e
//     INSERTAR filas en whatsapp_eventos_registrados (una tabla nueva, propia, sin relación con nada
//     que use Daniela).
//   - No modifica ninguna tabla ni endpoint del módulo de Daniela (pedidos/piezas/proveedores/comunicaciones
//     los LEE para detectar eventos, pero nunca los ESCRIBE).
//   - No expone ningún botón, pantalla ni menú nuevo a ningún rol. El único endpoint que expone es de
//     solo lectura, exclusivo para admin, y no está enlazado desde ninguna vista del frontend.
//
// Nota de diseño (marcada explícitamente para revisión de Roberto): dos de las reglas de detección son
// inferencias de Claude a partir de los campos que ya existen, no una confirmación operativa directa:
//   1) "Unidad en taller" vs "unidad fuera del taller" (para elegir 5.4 vs 5.5 y 5.6 vs 5.7) se deriva
//      del hito 'cita_reingreso' (Alejandra). Ver unidadEnTaller() abajo.
//   2) La etapa usada para elegir cuál de las 6 plantillas de continuidad (6.1-6.6) aplica en cada
//      momento se deriva de estado_autorizacion / piezas_autorizadas_cambio / estado_produccion /
//      estado_calidad. Ver etapaContinuidadActual() abajo.
// Ninguna de las dos requiere corregir código para ajustarse -- están centralizadas en una sola función
// cada una, precisamente para que sean fáciles de revisar y corregir.

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Mexico_City';

// ----- Catálogo de las 18 plantillas (metadatos; el texto exacto vive en el documento de diseño /
// Segunda entrega, aquí solo se usa el código, la categoría y una nota corta para el registro). -----
const PLANTILLAS = {
  '5.1': { nombre:'Bienvenida', categoria:'Utility', ciclo:'principal' },
  '5.2': { nombre:'Revisión enviada', categoria:'Utility', ciclo:'principal' },
  '5.3': { nombre:'Autorizado, con piezas', categoria:'Utility', ciclo:'principal' },
  '5.4': { nombre:'Piezas listas, en tránsito', categoria:'Utility', ciclo:'principal' },
  '5.5': { nombre:'Piezas listas, en piso', categoria:'Utility', ciclo:'principal' },
  '5.6': { nombre:'Autorizado sin piezas, en piso', categoria:'Utility', ciclo:'principal' },
  '5.7': { nombre:'Autorizado sin piezas, en tránsito', categoria:'Utility', ciclo:'principal' },
  '5.8': { nombre:'Hojalatería (inicio)', categoria:'Utility', ciclo:'principal' },
  '5.9': { nombre:'Pintura (inicio)', categoria:'Utility', ciclo:'principal' },
  '5.10': { nombre:'Revisión de calidad', categoria:'Utility', ciclo:'principal' },
  '5.11': { nombre:'Listo para entrega', categoria:'Utility', ciclo:'principal' },
  '5.12': { nombre:'Postventa', categoria:'Utility', ciclo:'principal' },
  '6.1': { nombre:'Continuidad - esperando autorización', categoria:'Utility', ciclo:'continuidad' },
  '6.2': { nombre:'Continuidad - esperando refacciones', categoria:'Utility', ciclo:'continuidad' },
  '6.3': { nombre:'Continuidad - pendiente de asignación', categoria:'Utility', ciclo:'continuidad' },
  '6.4': { nombre:'Continuidad - hojalatería', categoria:'Utility', ciclo:'continuidad' },
  '6.5': { nombre:'Continuidad - pintura', categoria:'Utility', ciclo:'continuidad' },
  '6.6': { nombre:'Continuidad - revisión de calidad', categoria:'Utility', ciclo:'continuidad' },
};

// ----- Horario hábil confirmado por Roberto: L-V 9:00-18:00, Sáb 9:00-14:00, domingo cerrado. -----
const HORARIO_HABIL = { 1:{ini:9,fin:18}, 2:{ini:9,fin:18}, 3:{ini:9,fin:18}, 4:{ini:9,fin:18}, 5:{ini:9,fin:18}, 6:{ini:9,fin:14}, 0:null };

function esHorarioHabil(dLocal){
  const cfg = HORARIO_HABIL[dLocal.day()];
  if(!cfg) return false;
  const minutos = dLocal.hour()*60 + dLocal.minute();
  return minutos >= cfg.ini*60 && minutos < cfg.fin*60;
}

// Dado un momento (dayjs en TZ local), regresa el siguiente momento dentro de horario hábil
// (si ya está dentro, regresa el mismo momento).
function siguienteMomentoHabil(dLocal){
  let cur = dLocal;
  for(let i=0;i<14;i++){
    const cfg = HORARIO_HABIL[cur.day()];
    if(cfg){
      const inicioDia = cur.hour(cfg.ini).minute(0).second(0).millisecond(0);
      const finDia = cur.hour(cfg.fin).minute(0).second(0).millisecond(0);
      if(cur.isBefore(inicioDia)) return inicioDia;
      if(cur.isBefore(finDia)) return cur;
    }
    cur = cur.add(1,'day').hour(0).minute(0).second(0).millisecond(0);
  }
  return cur;
}

// Minutos hábiles transcurridos entre dos timestamps UTC (string 'YYYY-MM-DD HH:mm:ss'), contando
// solo el horario hábil configurado. Usado para la continuidad de 72 horas.
function horasHabilesTranscurridas(desdeUTC, hastaUTC){
  if(!desdeUTC || !hastaUTC) return 0;
  let cur = dayjs.utc(desdeUTC).tz(TZ);
  const fin = dayjs.utc(hastaUTC).tz(TZ);
  if(!cur.isValid() || !fin.isValid() || !fin.isAfter(cur)) return 0;
  let minutos = 0;
  let guard = 0;
  while(cur.isBefore(fin) && guard < 400){ // 400 días de margen amplio, evita loops infinitos
    guard++;
    const cfg = HORARIO_HABIL[cur.day()];
    const medianocheSiguiente = cur.add(1,'day').hour(0).minute(0).second(0).millisecond(0);
    const limite = fin.isBefore(medianocheSiguiente) ? fin : medianocheSiguiente;
    if(cfg){
      const iniDia = cur.hour(cfg.ini).minute(0).second(0).millisecond(0);
      const finDia = cur.hour(cfg.fin).minute(0).second(0).millisecond(0);
      const desdeEfectivo = cur.isBefore(iniDia) ? iniDia : cur;
      const hastaEfectivo = limite.isAfter(finDia) ? finDia : limite;
      if(hastaEfectivo.isAfter(desdeEfectivo)) minutos += hastaEfectivo.diff(desdeEfectivo, 'minute');
    }
    cur = limite;
  }
  return minutos / 60;
}

// ----- Bloqueo: incidencia delicada activa sobre el expediente (abierta o en proceso) -----
// Regla del documento original: las incidencias delicadas no generan explicaciones automáticas y
// suspenden el envío del mensaje correspondiente mientras sigan activas.
function tieneIncidenciaDelicadaActiva(db, siniestroId){
  const row = db.prepare(`
    SELECT COUNT(*) c FROM incidencias i
    JOIN piezas p ON p.id = i.pieza_id
    JOIN pedidos pe ON pe.id = p.pedido_id
    WHERE pe.siniestro_id = ? AND i.estado IN ('abierta','en_proceso')
  `).get(siniestroId);
  return row.c > 0;
}

// ----- Ubicación de la unidad (NOTA DE DISEÑO: inferencia, ver cabecera del archivo) -----
// Se deriva del hito 'cita_reingreso' (Alejandra, condicional -- solo aplica si la unidad está
// circulando). Sin ese hito registrado, o marcado 'no_aplica'/'completado'/'enviado', se asume que la
// unidad nunca salió o ya reingresó -> "en taller". Si el hito sigue pendiente/en_proceso, se asume
// que la unidad todavía está circulando -> "fuera del taller".
function unidadEnTaller(db, siniestroId){
  const hito = db.prepare(`
    SELECT sh.estado FROM siniestro_hitos sh JOIN catalogo_hitos ch ON ch.id = sh.hito_id
    WHERE sh.siniestro_id = ? AND ch.clave = 'cita_reingreso'
  `).get(siniestroId);
  if(!hito) return true;
  if(hito.estado === 'no_aplica') return true;
  if(['completado','enviado'].includes(hito.estado)) return true;
  return false;
}

// ----- Registro central: aplica dedup, calcula horario o marca bloqueado. Nunca envía nada real. -----
function registrarEvento(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey, bloqueadoPorMotivo=null, ahoraUTC=null }){
  if(!PLANTILLAS[plantillaCodigo]) throw new Error('Plantilla desconocida: ' + plantillaCodigo);
  const dedup = String(dedupKey || '');
  const existente = db.prepare(`SELECT id FROM whatsapp_eventos_registrados WHERE siniestro_id=? AND plantilla_codigo=? AND dedup_key=?`)
    .get(siniestroId, plantillaCodigo, dedup);
  if(existente) return { creado:false, id: existente.id, motivo:'ya registrado (deduplicado)' };

  const ahora = ahoraUTC ? dayjs.utc(ahoraUTC) : dayjs.utc();
  let estado = 'registrado';
  let motivoBloqueo = null;
  let programadoPara = null;
  if(bloqueadoPorMotivo){
    estado = 'bloqueado';
    motivoBloqueo = bloqueadoPorMotivo;
  } else {
    const local = ahora.tz(TZ);
    const momentoHabil = esHorarioHabil(local) ? local : siguienteMomentoHabil(local);
    programadoPara = momentoHabil.utc().format('YYYY-MM-DD HH:mm:ss');
  }
  const info = db.prepare(`INSERT INTO whatsapp_eventos_registrados
      (siniestro_id,plantilla_codigo,estado,motivo_bloqueo,disparador,variables_json,programado_para,dedup_key)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(siniestroId, plantillaCodigo, estado, motivoBloqueo, disparador, JSON.stringify(variables||{}), programadoPara, dedup);
  return { creado:true, id: info.lastInsertRowid, estado };
}

// Envoltura que ya evalúa el bloqueo por incidencia delicada, cuando la plantilla lo requiere.
function registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey, aplicaChequeoDelicada=true }){
  const bloqueado = aplicaChequeoDelicada && tieneIncidenciaDelicadaActiva(db, siniestroId)
    ? 'Existe una incidencia delicada abierta o en proceso sobre este expediente; el envío queda suspendido hasta que se resuelva (no se genera ninguna explicación automática).'
    : null;
  return registrarEvento(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey, bloqueadoPorMotivo: bloqueado });
}

// ===================== Puntos de enganche (llamados desde las rutas ya existentes) =====================

// 5.1 Bienvenida -- al crear el expediente, si ya hay teléfono de cliente capturado.
function procesarCreacionSiniestro(db, siniestro){
  try{
    if(!siniestro || !siniestro.cliente_telefono || !String(siniestro.cliente_telefono).trim()) return;
    registrarConChequeoDelicada(db, {
      siniestroId: siniestro.id,
      plantillaCodigo: '5.1',
      disparador: 'Creación del expediente y vinculación del destino',
      variables: { nombre: siniestro.cliente_nombre||'', vehiculo: siniestro.vehiculo||'' },
      dedupKey: 'creacion',
      aplicaChequeoDelicada: false, // un expediente recién creado no puede tener ya una incidencia
    });
  } catch(e){ console.error('[whatsappFaseA] procesarCreacionSiniestro:', e.message); }
}

// 5.2 / 5.3 / 5.6 / 5.7 / 5.8 / 5.9 / 5.10 / 5.11 -- se derivan de comparar el expediente antes/después
// del PATCH general de siniestros (mismo patrón que auditarCambios, que ya compara anterior/nuevo).
function procesarTransicionSiniestro(db, { anterior, nuevo }){
  try{
    const siniestroId = anterior.id;
    const nombre = nuevo.cliente_nombre || anterior.cliente_nombre || '';
    const vehiculo = nuevo.vehiculo || anterior.vehiculo || '';

    // 5.2 Revisión enviada: primera vez que se registra la fecha de envío a valuación.
    if(nuevo.valuacion_fecha_envio && String(nuevo.valuacion_fecha_envio).trim()
        && String(nuevo.valuacion_fecha_envio) !== String(anterior.valuacion_fecha_envio||'')){
      registrarConChequeoDelicada(db, {
        siniestroId, plantillaCodigo:'5.2',
        disparador:'Revisión concluida y presupuesto enviado a la aseguradora',
        variables:{ nombre, vehiculo },
        dedupKey: 'envio:' + nuevo.valuacion_fecha_envio,
      });
    }

    // 5.3 / 5.6 / 5.7 Autorizado: transición a 'autorizada' o 'parcial' que antes no lo estaba.
    const AUTORIZADOS = ['autorizada','parcial'];
    if(AUTORIZADOS.includes(nuevo.estado_autorizacion) && !AUTORIZADOS.includes(anterior.estado_autorizacion)){
      const conPiezas = Number(nuevo.piezas_autorizadas_cambio || 0) > 0;
      const dedupKey = 'autorizacion:' + (nuevo.autorizacion_fecha_respuesta || dayjs.utc().format());
      if(conPiezas){
        registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.3',
          disparador:'Autorización confirmada y existen piezas a cambio', variables:{ nombre }, dedupKey });
      } else if(unidadEnTaller(db, siniestroId)){
        registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.6',
          disparador:'Autorización confirmada; sin piezas a cambio; unidad en piso', variables:{ nombre }, dedupKey });
      } else {
        registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.7',
          disparador:'Autorización confirmada; sin piezas a cambio; unidad fuera del taller', variables:{ nombre }, dedupKey });
      }
    }

    // 5.8 Hojalatería (inicio) / 5.9 Pintura (inicio): primera entrada real a esa etapa de producción.
    if(nuevo.estado_produccion === 'en_laminado' && anterior.estado_produccion !== 'en_laminado'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.8',
        disparador:'Cambio efectivo a Hojalatería', variables:{ nombre }, dedupKey:'hojalateria' });
    }
    if(nuevo.estado_produccion === 'pintura' && anterior.estado_produccion !== 'pintura'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.9',
        disparador:'Cambio efectivo a Pintura', variables:{ nombre }, dedupKey:'pintura' });
    }

    // 5.10 Revisión de calidad / 5.11 Listo para entrega.
    if(nuevo.estado_calidad === 'en_inspeccion' && anterior.estado_calidad !== 'en_inspeccion'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.10',
        disparador:'Entrada real al checklist / filtro final de calidad', variables:{ nombre }, dedupKey:'calidad_inspeccion' });
    }
    if(nuevo.estado_calidad === 'liberado' && anterior.estado_calidad !== 'liberado'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.11',
        disparador:'Aprobación de calidad', variables:{ nombre }, dedupKey:'calidad_liberado' });
    }
  } catch(e){ console.error('[whatsappFaseA] procesarTransicionSiniestro:', e.message); }
}

// 5.4 / 5.5 Piezas listas -- mismo disparador que ya usa verificarRefaccionesCompletas: TODOS los
// pedidos del expediente en estado terminal (Recibido completo / Cancelado / Cerrado). Se llama justo
// junto a esa función existente, en pedidos.js y piezas.js -- no se duplica su lógica de "tarea", solo
// se agrega el registro de WhatsApp en paralelo.
function procesarRefaccionesCompletas(db, siniestroId){
  try{
    const TERMINALES = ['Recibido completo','Cancelado','Cerrado'];
    const pedidos = db.prepare('SELECT estatus_operativo FROM pedidos WHERE siniestro_id = ?').all(siniestroId);
    if(pedidos.length === 0) return;
    if(!pedidos.every(p => TERMINALES.includes(p.estatus_operativo))) return;
    const siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(siniestroId);
    if(!siniestro) return;
    const enTaller = unidadEnTaller(db, siniestroId);
    const variables = { nombre: siniestro.cliente_nombre||'' };
    if(enTaller){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.5',
        disparador:'Piezas disponibles; unidad ya en el taller', variables, dedupKey:'refacciones_completas' });
    } else {
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.4',
        disparador:'Piezas disponibles; unidad fuera del taller', variables, dedupKey:'refacciones_completas' });
    }
  } catch(e){ console.error('[whatsappFaseA] procesarRefaccionesCompletas:', e.message); }
}

// ----- Etapa actual para continuidad (NOTA DE DISEÑO: inferencia, ver cabecera del archivo) -----
// Regresa el código de plantilla 6.x que aplica ahora mismo, o null si no aplica ninguna (expediente
// cerrado/archivado, calidad ya liberada, o sin autorización rechazada -- casos donde no tiene sentido
// seguir avisando "seguimos esperando").
function etapaContinuidadActual(db, siniestro){
  if(siniestro.archivado || siniestro.estatus_general === 'Cerrado') return null;
  if(siniestro.estado_calidad === 'liberado') return null;
  if(siniestro.estado_autorizacion === 'rechazada') return null;

  const AUTORIZADOS = ['autorizada','parcial'];
  if(!AUTORIZADOS.includes(siniestro.estado_autorizacion)) return '6.1';

  if(siniestro.estado_calidad === 'en_inspeccion') return '6.6';
  if(siniestro.estado_produccion === 'pintura') return '6.5';
  if(siniestro.estado_produccion === 'en_laminado') return '6.4';

  const requierePiezas = Number(siniestro.piezas_autorizadas_cambio || 0) > 0;
  if(requierePiezas){
    const pedidos = db.prepare('SELECT estatus_operativo FROM pedidos WHERE siniestro_id = ?').all(siniestro.id);
    const TERMINALES = ['Recibido completo','Cancelado','Cerrado'];
    const refaccionesCompletas = pedidos.length > 0 && pedidos.every(p => TERMINALES.includes(p.estatus_operativo));
    if(!refaccionesCompletas) return '6.2';
  }
  return '6.3';
}

// Ancla de tiempo para medir continuidad: el evento de WhatsApp más reciente ya registrado para este
// expediente (de cualquier plantilla), o si no hay ninguno, la última actualización del expediente.
function ultimoAncla(db, siniestroId, siniestroActualizadoEn){
  const ultimo = db.prepare(`SELECT creado_en FROM whatsapp_eventos_registrados WHERE siniestro_id = ? ORDER BY creado_en DESC LIMIT 1`).get(siniestroId);
  return (ultimo && ultimo.creado_en) || siniestroActualizadoEn;
}

// ----- Barrido periódico: continuidad de 72h (6.1-6.6) + postventa a 48h reales (5.12). -----
// Se llama desde el mismo lugar donde ya corren los otros barridos periódicos de la app
// (GET /api/reportes/resumen), igual que sincronizarPiezasPedidosExistentes o verificarReingreso90Porciento.
function barrerContinuidadYPostventa(db){
  try{
    const ahora = dayjs.utc();
    const ahoraStr = ahora.format('YYYY-MM-DD HH:mm:ss');

    // -- Continuidad 72h --
    const activos = db.prepare(`SELECT * FROM siniestros WHERE (archivado IS NULL OR archivado = 0) AND estatus_general != 'Cerrado'`).all();
    for(const s of activos){
      const codigo = etapaContinuidadActual(db, s);
      if(!codigo) continue;
      const anclaUTC = ultimoAncla(db, s.id, s.actualizado_en);
      const horas = horasHabilesTranscurridas(anclaUTC, ahoraStr);
      if(horas < 72) continue;
      const ultimoDeEstaPlantilla = db.prepare(
        `SELECT creado_en FROM whatsapp_eventos_registrados WHERE siniestro_id=? AND plantilla_codigo=? ORDER BY creado_en DESC LIMIT 1`
      ).get(s.id, codigo);
      if(ultimoDeEstaPlantilla){
        const horasDesdeUltimaMisma = horasHabilesTranscurridas(ultimoDeEstaPlantilla.creado_en, ahoraStr);
        if(horasDesdeUltimaMisma < 72) continue;
      }
      const disparadorTexto = '72 h hábiles sin novedad para el cliente en la etapa actual (' + codigo + ')';
      registrarConChequeoDelicada(db, {
        siniestroId: s.id, plantillaCodigo: codigo, disparador: disparadorTexto,
        variables: { nombre: s.cliente_nombre || '', vehiculo: s.vehiculo || '' },
        dedupKey: 'continuidad:' + ahora.tz(TZ).format('YYYY-MM-DD'),
      });
    }

    // -- Postventa a 48 horas reales de la entrega (5.12) --
    const entregados = db.prepare(`SELECT * FROM siniestros WHERE fecha_entrega_real IS NOT NULL AND fecha_entrega_real != ''`).all();
    for(const s of entregados){
      const entrega = dayjs.utc(s.fecha_entrega_real);
      if(!entrega.isValid()) continue;
      if(ahora.diff(entrega, 'hour') < 48) continue;
      registrarConChequeoDelicada(db, {
        siniestroId: s.id, plantillaCodigo: '5.12',
        disparador: '48 h después de registrar la entrega',
        variables: { nombre: s.cliente_nombre || '' },
        dedupKey: 'postventa:' + s.fecha_entrega_real,
      });
    }
  } catch(e){ console.error('[whatsappFaseA] barrerContinuidadYPostventa:', e.message); }
}

// ===================== Resolución de expediente por teléfono (para mensajes entrantes) =====================
// Todavía no hay conexión real ni webhook -- esta función es pura y queda lista para conectarse el día
// que exista un canal real. Regla dada por Roberto (3-sep-2026):
//   - Si el teléfono tiene un solo siniestro activo, se resuelve automáticamente.
//   - Si tiene varios activos, NO se asigna arbitrariamente: se regresa la lista de candidatos para que
//     Alejandra elija (pendiente de asignación), sin inventar ningún flujo pesado.
// "Activo" = no archivado y no Cerrado (mismo criterio que el barrido de continuidad).
function resolverExpedientePorTelefono(db, telefono){
  const tel = String(telefono || '').trim();
  if(!tel) return { resultado:'sin_telefono', siniestro: null, candidatos: [] };
  const activos = db.prepare(`
    SELECT id, numero, cliente_nombre, vehiculo, estatus_general
    FROM siniestros
    WHERE cliente_telefono = ? AND (archivado IS NULL OR archivado = 0) AND estatus_general != 'Cerrado'
    ORDER BY id DESC
  `).all(tel);
  if(activos.length === 0) return { resultado:'sin_expediente_activo', siniestro: null, candidatos: [] };
  if(activos.length === 1) return { resultado:'resuelto_automatico', siniestro: activos[0], candidatos: activos };
  return { resultado:'ambiguo_pendiente_asignacion', siniestro: null, candidatos: activos };
}

module.exports = {
  PLANTILLAS,
  esHorarioHabil, siguienteMomentoHabil, horasHabilesTranscurridas,
  tieneIncidenciaDelicadaActiva, unidadEnTaller,
  registrarEvento, registrarConChequeoDelicada,
  procesarCreacionSiniestro, procesarTransicionSiniestro, procesarRefaccionesCompletas,
  etapaContinuidadActual, barrerContinuidadYPostventa,
  resolverExpedientePorTelefono,
};
