// ===================== WhatsApp Fase A -- modo "solo registro" =====================
// Autorización de Roberto (3-sep-2026, ampliada el mismo día tras revisar la tercera entrega): SOLO
// detectar y registrar qué plantilla se habría disparado (expediente, fecha, hora, motivo, variables),
// aplicar condiciones bloqueantes con un ciclo de revisión explícito, deduplicar, calcular horario de
// envío (cola L-V 9-18 / Sáb 9-14) y continuidad de 72 HORAS NATURALES (no hábiles).
//
// LÍMITES DUROS DE ESTE MÓDULO (no removerlos sin autorización explícita de Roberto):
//   - JAMÁS hace una llamada HTTP real a WhatsApp/Meta/Graph API. No existe ningún fetch/axios/request
//     hacia un servicio externo en este archivo.
//   - No modifica ninguna tabla ni endpoint del módulo de Daniela (las LEE para detectar eventos, nunca
//     las ESCRIBE).
//   - No expone ningún botón, pantalla ni menú nuevo a ningún rol. El único endpoint que expone es de
//     solo lectura/revisión explícita, exclusivo para admin, sin enlazar desde ninguna vista.
//   - "liberado_para_programacion" NUNCA dispara un envío real -- en modo "solo registro" no existe
//     ningún mecanismo de envío; ese estado solo indica que un humano ya revalidó el mensaje retenido.
//
// Notas de diseño (con evidencia concreta, para revisión de Roberto):
//   1) Ubicación física del vehículo (5.4/5.5, 5.6/5.7): investigado en server/routes/reportes.js
//      (bandeja de Beto, variable "reingresoCitado"), que ya distingue "en piso" de "reingreso citado"
//      con esta misma lógica. Se documenta con ejemplos en unidadEnTaller() más abajo. Cuando no hay
//      certeza, el sistema NO adivina: deja el evento en un estado de revisión interna.
//   2) La etapa de continuidad (6.1-6.6) se deriva de estado_autorizacion / piezas_autorizadas_cambio /
//      estado_produccion / estado_calidad, en ese orden de prioridad -- ver etapaContinuidadActual().

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Mexico_City';

// ----- Catálogo de las 18 plantillas reales (van a Meta). -----
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
// ----- Catálogo de eventos INTERNOS (punto 2): nunca van a Meta, nunca los consume un servicio de envíos. -----
const EVENTOS_INTERNOS = {
  'ALERTA-72H-X2': { nombre:'Alerta interna: segundo periodo de 72h consecutivo sin avance real' },
};

// ----- Horario hábil confirmado por Roberto: L-V 9:00-18:00, Sáb 9:00-14:00, domingo cerrado. -----
const HORARIO_HABIL = { 1:{ini:9,fin:18}, 2:{ini:9,fin:18}, 3:{ini:9,fin:18}, 4:{ini:9,fin:18}, 5:{ini:9,fin:18}, 6:{ini:9,fin:14}, 0:null };

function esHorarioHabil(dLocal){
  const cfg = HORARIO_HABIL[dLocal.day()];
  if(!cfg) return false;
  const minutos = dLocal.hour()*60 + dLocal.minute();
  return minutos >= cfg.ini*60 && minutos < cfg.fin*60;
}
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
// Horas NATURALES (reloj/calendario) transcurridas -- punto 1: la continuidad de 72h usa esto, NO horas hábiles.
function horasNaturalesTranscurridas(desdeUTC, hastaUTC){
  if(!desdeUTC || !hastaUTC) return 0;
  const desde = dayjs.utc(desdeUTC);
  const hasta = dayjs.utc(hastaUTC);
  if(!desde.isValid() || !hasta.isValid() || !hasta.isAfter(desde)) return 0;
  return hasta.diff(desde, 'minute') / 60;
}
// Horas HÁBILES transcurridas -- se conserva para el diseño futuro de escalamiento de mensajes entrantes
// (30 min / 2 h, sección 3.6 de la tercera entrega), que si debe contar solo horario hábil por instrucción
// explícita de Roberto. Ya NO se usa para el gate de continuidad de 72h (ver horasNaturalesTranscurridas).
function horasHabilesTranscurridas(desdeUTC, hastaUTC){
  if(!desdeUTC || !hastaUTC) return 0;
  let cur = dayjs.utc(desdeUTC).tz(TZ);
  const fin = dayjs.utc(hastaUTC).tz(TZ);
  if(!cur.isValid() || !fin.isValid() || !fin.isAfter(cur)) return 0;
  let minutos = 0;
  let guard = 0;
  while(cur.isBefore(fin) && guard < 400){
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
function tieneIncidenciaDelicadaActiva(db, siniestroId){
  const row = db.prepare(`
    SELECT COUNT(*) c FROM incidencias i
    JOIN piezas p ON p.id = i.pieza_id
    JOIN pedidos pe ON pe.id = p.pedido_id
    WHERE pe.siniestro_id = ? AND i.estado IN ('abierta','en_proceso')
  `).get(siniestroId);
  return row.c > 0;
}

// ----- Ubicación física del vehículo (punto 6) -----
// Investigado en server/routes/reportes.js (bandeja de Beto): el sistema YA distingue "en piso" de
// "reingreso citado" con esta misma lógica (variable reingresoCitado). Se documenta aquí con ejemplos:
//
//   Caso 1 -- ingreso_tipo IN ('grua','permanece'): por regla de negocio ya establecida (ver
//     catalogo_hitos, hito 'cita_reingreso': "Solo si la unidad está circulando"), estos vehículos NUNCA
//     salen del taller durante el proceso. Certeza: SIEMPRE "en_taller".
//     Ejemplo: expediente llega en grúa, se queda todo el proceso -> en_taller, sin importar la etapa.
//
//   Caso 2 -- ingreso_tipo = 'circulando' Y fecha_admision está vacía: el vehículo todavía no ha sido
//     admitido físicamente ni una sola vez. Certeza: SIEMPRE "fuera_taller".
//     Ejemplo: expediente recién creado con cita a futuro, cliente todavía no lo lleva -> fuera_taller.
//
//   Caso 3 -- ingreso_tipo = 'circulando' Y fecha_admision YA tiene valor: aquí NO hay certeza con los
//     datos actuales. fecha_admision se captura UNA SOLA VEZ (nunca se borra ni se vuelve a capturar,
//     confirmado revisando cada lugar del código que la escribe) y representa "fue admitido al menos una
//     vez", no "está físicamente aquí ahora mismo". Un vehículo circulando puede haber sido admitido,
//     diagnosticado, y devuelto al cliente en lo que llegan las piezas (ese es exactamente el propósito
//     del hito "cita de reingreso") -- el sistema hoy NO tiene ningún campo que capture el momento en que
//     ese vehículo vuelve a salir ni el momento en que reingresa de verdad. Por instrucción explícita de
//     Roberto, en este caso el sistema NO ADIVINA.
//     Ejemplo: expediente admitido el 1-sep (fecha_admision=2026-09-01), circulando, con cita de
//     reingreso agendada para el 10-sep. El 5 de septiembre no hay forma de saber, solo con estos campos,
//     si el auto sigue en el taller esperando piezas o si ya se fue con el cliente.
//
// Devuelve 'en_taller' | 'fuera_taller' | 'desconocido'.
function unidadEnTaller(db, siniestroId){
  const s = db.prepare('SELECT ingreso_tipo, fecha_admision FROM siniestros WHERE id = ?').get(siniestroId);
  if(!s) return 'desconocido';
  if(s.ingreso_tipo === 'grua' || s.ingreso_tipo === 'permanece') return 'en_taller';
  if(s.ingreso_tipo === 'circulando'){
    if(!s.fecha_admision || !String(s.fecha_admision).trim()) return 'fuera_taller';
    return 'desconocido'; // Caso 3: ya fue admitido alguna vez, no hay certeza de si sigue ahí ahora.
  }
  return 'desconocido'; // ingreso_tipo sin capturar todavía.
}

// ----- Refacciones realmente disponibles (punto 7) -----
// "Todos los pedidos en estado terminal" (usado por la tarea automática existente de Daniela/Alejandra,
// verificarRefaccionesCompletas en server/utils.js) NO es lo mismo que "las refacciones están realmente
// disponibles para continuar la reparación": ese chequeo trata Cancelado/Cerrado igual que Recibido
// completo porque para ESA tarea (avisar y cerrar el pendiente) cualquier estado terminal sirve. Para
// WhatsApp, un pedido cancelado, con incidencia, o no recibido en su totalidad NO significa que el
// cliente ya pueda continuar -- por eso esta función es más estricta y vive separada, sin tocar la
// función existente de Daniela/Alejandra.
function refaccionesRealmenteDisponibles(db, siniestroId){
  const pedidos = db.prepare('SELECT numero, estatus_operativo FROM pedidos WHERE siniestro_id = ?').all(siniestroId);
  if(pedidos.length === 0) return { disponible:false, motivo:'Todavía no existe ningún pedido de refacciones para este expediente.' };
  const problematicos = pedidos.filter(p => p.estatus_operativo !== 'Recibido completo');
  if(problematicos.length){
    const detalle = problematicos.map(p => `${p.numero} (${p.estatus_operativo})`).join(', ');
    return { disponible:false, motivo:`Hay pedidos que no están realmente disponibles (cancelados, con incidencia, incompletos o en otro estatus distinto de "Recibido completo"): ${detalle}.` };
  }
  return { disponible:true, motivo:null };
}

// ===================== Registro persistente de errores (punto 8) =====================
// Un error del detector NUNCA debe quedar solo en el log del servidor: si se pierde el log, se pierde
// también la evidencia de que algo no se registró. Esta función nunca lanza (doble try/catch) para no
// arriesgar la operación principal que la llama.
const UMBRAL_ALERTA_ERROR = 3;
function registrarError(db, { contexto, siniestroId=null, plantillaCodigo=null, error }){
  try{
    const mensaje = (error && error.message) ? String(error.message).slice(0,500) : String(error).slice(0,500);
    const detalle = (error && error.stack) ? String(error.stack).slice(0,2000) : null;
    const existente = db.prepare(`SELECT id, intentos, alerta_generada FROM whatsapp_errores
      WHERE contexto = ? AND resuelto = 0
      AND (siniestro_id IS ? ) AND (plantilla_codigo IS ?)`).get(contexto, siniestroId, plantillaCodigo);
    if(existente){
      const nuevosIntentos = existente.intentos + 1;
      db.prepare(`UPDATE whatsapp_errores SET intentos=?, ultimo_intento_en=datetime('now'), mensaje=?, detalle=? WHERE id=?`)
        .run(nuevosIntentos, mensaje, detalle, existente.id);
      if(nuevosIntentos >= UMBRAL_ALERTA_ERROR && !existente.alerta_generada){
        db.prepare(`UPDATE whatsapp_errores SET alerta_generada=1 WHERE id=?`).run(existente.id);
        if(siniestroId){
          registrarEventoInterno(db, { siniestroId, codigo:'ALERTA-72H-X2', // reutiliza el mismo canal de alertas internas
            disparador:`Error persistente en la detección de WhatsApp Fase A (contexto: ${contexto}, ${nuevosIntentos} intentos) -- requiere revisión técnica.`,
            variables:{}, dedupKey:'error:'+contexto+':'+plantillaCodigo });
        }
      }
    } else {
      db.prepare(`INSERT INTO whatsapp_errores (contexto,siniestro_id,plantilla_codigo,mensaje,detalle) VALUES (?,?,?,?,?)`)
        .run(contexto, siniestroId, plantillaCodigo, mensaje, detalle);
    }
  } catch(e2){ console.error('[whatsappFaseA] registrarError también falló (no se interrumpe la operación principal):', e2.message); }
}

// ----- Registro central: aplica dedup, calcula horario o marca bloqueado. Nunca envía nada real. -----
function registrarEvento(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey, bloqueadoPorMotivo=null, tipoBloqueo=null, esPlantillaMeta=1, ahoraUTC=null }){
  const dedup = String(dedupKey || '');
  const existente = db.prepare(`SELECT id, estado FROM whatsapp_eventos_registrados WHERE siniestro_id=? AND plantilla_codigo=? AND dedup_key=?`)
    .get(siniestroId, plantillaCodigo, dedup);
  if(existente) return { creado:false, id: existente.id, motivo:'ya registrado (deduplicado); su ciclo de vida se actualiza con UPDATE, no se pierde al re-detectarse' };

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
      (siniestro_id,plantilla_codigo,estado,tipo_bloqueo,motivo_bloqueo,disparador,variables_json,programado_para,dedup_key,es_plantilla_meta)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(siniestroId, plantillaCodigo, estado, tipoBloqueo, motivoBloqueo, disparador, JSON.stringify(variables||{}), programadoPara, dedup, esPlantillaMeta?1:0);
  return { creado:true, id: info.lastInsertRowid, estado };
}

// Registra un evento INTERNO (no es una de las 18 plantillas de Meta; punto 2). Se guarda en la misma
// tabla para tener un solo historial consultable, pero con es_plantilla_meta=0 -- cualquier filtro futuro
// que solo tome plantillas reales para enviar (WHERE es_plantilla_meta=1) lo excluye automáticamente.
function registrarEventoInterno(db, { siniestroId, codigo, disparador, variables, dedupKey }){
  if(!EVENTOS_INTERNOS[codigo]) throw new Error('Evento interno desconocido: ' + codigo);
  return registrarEvento(db, { siniestroId, plantillaCodigo:codigo, disparador, variables, dedupKey, esPlantillaMeta:0 });
}

// Envoltura que evalúa el bloqueo por incidencia delicada. tipoBloqueo='incidencia_delicada' permite que
// revisarBloqueadosResueltos() sepa exactamente qué condición debe volver a comprobar más adelante.
function registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey, aplicaChequeoDelicada=true }){
  const bloqueado = aplicaChequeoDelicada && tieneIncidenciaDelicadaActiva(db, siniestroId)
    ? 'Existe una incidencia delicada abierta o en proceso sobre este expediente; el envío queda suspendido hasta que se resuelva (no se genera ninguna explicación automática).'
    : null;
  return registrarEvento(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey,
    bloqueadoPorMotivo: bloqueado, tipoBloqueo: bloqueado ? 'incidencia_delicada' : null });
}

// ===================== Ciclo de vida de eventos bloqueados (punto 3) =====================
// bloqueado -> pendiente_revision: AUTOMÁTICO, cuando la condición específica que originó el bloqueo
//   (tipo_bloqueo) ya no se cumple. Esto NO reenvía ni reprograma nada -- solo mueve el evento a la
//   bandeja de revisión humana, con la clave de deduplicación intacta (el mismo renglón, no uno nuevo).
// pendiente_revision -> descartado | liberado_para_programacion: SOLO mediante acción explícita
//   (resolverPendienteRevision), nunca automático. "liberado_para_programacion" NUNCA implica un envío
//   real -- no existe ningún mecanismo de envío en este modo.
function condicionDeBloqueoSigueActiva(db, evento){
  if(evento.tipo_bloqueo === 'incidencia_delicada') return tieneIncidenciaDelicadaActiva(db, evento.siniestro_id);
  if(evento.tipo_bloqueo === 'refacciones_no_disponibles') return !refaccionesRealmenteDisponibles(db, evento.siniestro_id).disponible;
  if(evento.tipo_bloqueo === 'ubicacion_desconocida') return unidadEnTaller(db, evento.siniestro_id) === 'desconocido';
  if(evento.tipo_bloqueo === 'autorizacion_parcial'){
    const s = db.prepare('SELECT estado_autorizacion FROM siniestros WHERE id=?').get(evento.siniestro_id);
    return !!s && s.estado_autorizacion === 'parcial';
  }
  return true; // tipo_bloqueo desconocido/nulo: por seguridad, no se mueve solo -- requiere revisión manual directa.
}
function revisarBloqueadosResueltos(db){
  try{
    const bloqueados = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE estado='bloqueado'`).all();
    for(const ev of bloqueados){
      try{
        if(!condicionDeBloqueoSigueActiva(db, ev)){
          db.prepare(`UPDATE whatsapp_eventos_registrados SET estado='pendiente_revision' WHERE id=?`).run(ev.id);
        }
      } catch(e){ registrarError(db, { contexto:'revisarBloqueadosResueltos', siniestroId:ev.siniestro_id, plantillaCodigo:ev.plantilla_codigo, error:e }); }
    }
  } catch(e){ registrarError(db, { contexto:'revisarBloqueadosResueltos', error:e }); }
}

// Acción explícita (admin, vía endpoint de solo revisión) -- exige justificación y no envía nada nunca.
function resolverPendienteRevision(db, { eventoId, decision, justificacion, usuarioId }){
  if(!['descartado','liberado_para_programacion'].includes(decision)){
    throw new Error('Decisión inválida. Usa "descartado" o "liberado_para_programacion".');
  }
  if(!justificacion || !String(justificacion).trim()){
    throw new Error('La justificación es obligatoria: debe confirmar que se revalidó el estado actual del expediente, la vigencia del mensaje, si ya ocurrió otro avance, si el texto todavía corresponde, y si requiere decisión de Daniela.');
  }
  const evento = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE id=?`).get(eventoId);
  if(!evento) throw new Error('Evento no encontrado.');
  if(evento.estado !== 'pendiente_revision'){
    throw new Error('Solo se puede resolver un evento que esté en estado "pendiente_revision".');
  }
  db.prepare(`UPDATE whatsapp_eventos_registrados SET estado=?, revisado_por=?, revisado_en=datetime('now'), justificacion=? WHERE id=?`)
    .run(decision, usuarioId||null, String(justificacion).trim(), eventoId);
  return db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE id=?`).get(eventoId);
}

// ===================== Ciclo principal (5.1, 5.2, autorización, 5.8-5.11) =====================
// Una sola función idempotente, llamada tanto al momento del evento (PATCH/POST) como periódicamente
// (reconciliarEventosPrincipales, punto 8) para reintentar cualquier detección que se haya perdido. Es
// segura de llamar repetidas veces: cada intento de registro está protegido por su propia clave de
// deduplicación (fija, no depende del momento en que se evalúa), así que llamar dos veces sobre el mismo
// expediente en el mismo estado NUNCA produce un duplicado.
function evaluarYRegistrarCicloPrincipal(db, siniestro){
  const siniestroId = siniestro.id;
  const nombre = siniestro.cliente_nombre || '';
  const vehiculo = siniestro.vehiculo || '';

  // 5.1 Bienvenida -- punto 5: no depende solo de la creación. Se evalúa cada vez que el expediente
  // tiene teléfono capturado (aquí o después); la clave de deduplicación fija ('creacion') garantiza que
  // se registre una sola vez por siniestro, sin importar cuántas veces se edite el teléfono después.
  if(siniestro.cliente_telefono && String(siniestro.cliente_telefono).trim()){
    try{
      registrarConChequeoDelicada(db, {
        siniestroId, plantillaCodigo:'5.1',
        disparador:'Creación del expediente y vinculación del destino (o captura posterior del teléfono)',
        variables:{ nombre, vehiculo }, dedupKey:'creacion', aplicaChequeoDelicada:false,
      });
    } catch(e){ registrarError(db, { contexto:'ciclo_principal:5.1', siniestroId, plantillaCodigo:'5.1', error:e }); }
  }

  // 5.2 Revisión enviada.
  if(siniestro.valuacion_fecha_envio && String(siniestro.valuacion_fecha_envio).trim()){
    try{
      registrarConChequeoDelicada(db, {
        siniestroId, plantillaCodigo:'5.2',
        disparador:'Revisión concluida y presupuesto enviado a la aseguradora',
        variables:{ nombre, vehiculo }, dedupKey:'envio:' + siniestro.valuacion_fecha_envio,
      });
    } catch(e){ registrarError(db, { contexto:'ciclo_principal:5.2', siniestroId, plantillaCodigo:'5.2', error:e }); }
  }

  // Autorización -- punto 4: 'parcial' YA NO dispara 5.3/5.6/5.7. Bloquea y pide revisión humana.
  // Solo 'autorizada' (completa y confirmada) evalúa el disparador normal.
  try{
    if(siniestro.estado_autorizacion === 'autorizada'){
      const conPiezas = Number(siniestro.piezas_autorizadas_cambio || 0) > 0;
      if(conPiezas){
        registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.3',
          disparador:'Autorización confirmada y existen piezas a cambio', variables:{ nombre }, dedupKey:'autorizacion' });
      } else {
        const ubicacion = unidadEnTaller(db, siniestroId);
        if(ubicacion === 'desconocido'){
          registrarEvento(db, { siniestroId, plantillaCodigo:'5.6',
            disparador:'Autorización confirmada; sin piezas a cambio; NO se puede determinar con certeza si la unidad está en el taller o circulando (ver nota de diseño, punto 6)',
            variables:{ nombre }, dedupKey:'autorizacion',
            bloqueadoPorMotivo:'Ubicación física de la unidad no determinable con los datos actuales; requiere confirmación humana antes de elegir entre "en piso" y "en tránsito".',
            tipoBloqueo:'ubicacion_desconocida' });
        } else if(ubicacion === 'en_taller'){
          registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.6',
            disparador:'Autorización confirmada; sin piezas a cambio; unidad en piso', variables:{ nombre }, dedupKey:'autorizacion' });
        } else {
          registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.7',
            disparador:'Autorización confirmada; sin piezas a cambio; unidad fuera del taller', variables:{ nombre }, dedupKey:'autorizacion' });
        }
      }
    } else if(siniestro.estado_autorizacion === 'parcial'){
      const conPiezas = Number(siniestro.piezas_autorizadas_cambio || 0) > 0;
      const candidato = conPiezas ? '5.3' : '5.6'; // candidato solo informativo -- ver comentario en el módulo de bloqueo.
      registrarEvento(db, { siniestroId, plantillaCodigo:candidato,
        disparador:'Autorización PARCIAL (no completa): la comunicación automática queda bloqueada por definición, requiere revisión de Daniela antes de decidir qué comunicar',
        variables:{ nombre }, dedupKey:'autorizacion_parcial',
        bloqueadoPorMotivo:'Autorización parcial: no se genera comunicación automática. Solo si posteriormente se registra autorización completa se evalúa el disparador normal.',
        tipoBloqueo:'autorizacion_parcial' });
    }
  } catch(e){ registrarError(db, { contexto:'ciclo_principal:autorizacion', siniestroId, error:e }); }

  // 5.8 Hojalatería / 5.9 Pintura (inicio de etapa).
  try{
    if(siniestro.estado_produccion === 'en_laminado'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.8',
        disparador:'Cambio efectivo a Hojalatería', variables:{ nombre }, dedupKey:'hojalateria' });
    }
    if(siniestro.estado_produccion === 'pintura'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.9',
        disparador:'Cambio efectivo a Pintura', variables:{ nombre }, dedupKey:'pintura' });
    }
  } catch(e){ registrarError(db, { contexto:'ciclo_principal:produccion', siniestroId, error:e }); }

  // 5.10 Revisión de calidad / 5.11 Listo para entrega.
  try{
    if(siniestro.estado_calidad === 'en_inspeccion'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.10',
        disparador:'Entrada real al checklist / filtro final de calidad', variables:{ nombre }, dedupKey:'calidad_inspeccion' });
    }
    if(siniestro.estado_calidad === 'liberado'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.11',
        disparador:'Aprobación de calidad', variables:{ nombre }, dedupKey:'calidad_liberado' });
    }
  } catch(e){ registrarError(db, { contexto:'ciclo_principal:calidad', siniestroId, error:e }); }
}

function procesarCreacionSiniestro(db, siniestro){
  try{ evaluarYRegistrarCicloPrincipal(db, siniestro); }
  catch(e){ registrarError(db, { contexto:'procesarCreacionSiniestro', siniestroId: siniestro && siniestro.id, error:e }); }
}
function procesarTransicionSiniestro(db, { anterior, nuevo }){
  try{ evaluarYRegistrarCicloPrincipal(db, nuevo); }
  catch(e){ registrarError(db, { contexto:'procesarTransicionSiniestro', siniestroId: anterior && anterior.id, error:e }); }
}

// 5.4 / 5.5 Piezas listas -- puntos 6 y 7. Se llama junto a verificarRefaccionesCompletas (pedidos.js,
// piezas.js) para reaccionar de inmediato, y también se reevalúa en el barrido de reconciliación.
function procesarRefaccionesCompletas(db, siniestroId){
  try{
    const siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(siniestroId);
    if(!siniestro || siniestro.requiere_refacciones !== 'si') return;
    const variables = { nombre: siniestro.cliente_nombre||'' };
    const disp = refaccionesRealmenteDisponibles(db, siniestroId);
    if(!disp.disponible){
      // Solo bloquea si ya había piezas evaluadas (evita ruido en expedientes que ni siquiera tienen
      // pedidos todavía -- refaccionesRealmenteDisponibles ya cubre "sin pedidos" con su propio motivo).
      registrarEvento(db, { siniestroId, plantillaCodigo:'5.5',
        disparador:'Se evaluó si las refacciones ya están disponibles para continuar la reparación',
        variables, dedupKey:'refacciones_completas',
        bloqueadoPorMotivo: disp.motivo, tipoBloqueo:'refacciones_no_disponibles' });
      return;
    }
    const ubicacion = unidadEnTaller(db, siniestroId);
    if(ubicacion === 'desconocido'){
      registrarEvento(db, { siniestroId, plantillaCodigo:'5.5',
        disparador:'Piezas disponibles; NO se puede determinar con certeza si la unidad está en el taller o circulando (ver nota de diseño, punto 6)',
        variables, dedupKey:'refacciones_completas',
        bloqueadoPorMotivo:'Ubicación física de la unidad no determinable con los datos actuales; requiere confirmación humana antes de elegir entre "en piso" y "en tránsito".',
        tipoBloqueo:'ubicacion_desconocida' });
    } else if(ubicacion === 'en_taller'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.5',
        disparador:'Piezas disponibles; unidad ya en el taller', variables, dedupKey:'refacciones_completas' });
    } else {
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.4',
        disparador:'Piezas disponibles; unidad fuera del taller', variables, dedupKey:'refacciones_completas' });
    }
  } catch(e){ registrarError(db, { contexto:'procesarRefaccionesCompletas', siniestroId, error:e }); }
}

// ----- Etapa actual para continuidad -----
// Regresa el código 6.x que aplica ahora, o null si no aplica ninguna (expediente cerrado/archivado,
// calidad ya liberada, autorización rechazada). 'parcial' NO cuenta como autorizado (punto 4): un
// expediente detenido en autorización parcial sigue mostrando 6.1 "esperando autorización".
function etapaContinuidadActual(db, siniestro){
  if(siniestro.archivado || siniestro.estatus_general === 'Cerrado') return null;
  if(siniestro.estado_calidad === 'liberado') return null;
  if(siniestro.estado_autorizacion === 'rechazada') return null;

  if(siniestro.estado_autorizacion !== 'autorizada') return '6.1';

  if(siniestro.estado_calidad === 'en_inspeccion') return '6.6';
  if(siniestro.estado_produccion === 'pintura') return '6.5';
  if(siniestro.estado_produccion === 'en_laminado') return '6.4';

  const requierePiezas = Number(siniestro.piezas_autorizadas_cambio || 0) > 0;
  if(requierePiezas && !refaccionesRealmenteDisponibles(db, siniestro.id).disponible) return '6.2';
  return '6.3';
}

// Ancla de tiempo para medir continuidad (punto 1): SOLO la última comunicación informativa REAL --
// una de las 12 plantillas del ciclo principal (5.x), ya "registrada" (no bloqueada, no interna). Un
// mensaje de continuidad (6.x) no cuenta como "avance", así que NO reinicia el contador -- eso es lo que
// permite detectar el segundo periodo consecutivo (punto 2). Si nunca hubo ninguna, se usa la creación
// del expediente.
function ultimoAncla(db, siniestroId, siniestroCreadoEn){
  const ultimo = db.prepare(`
    SELECT creado_en FROM whatsapp_eventos_registrados
    WHERE siniestro_id = ? AND estado = 'registrado' AND es_plantilla_meta = 1 AND plantilla_codigo LIKE '5.%'
    ORDER BY creado_en DESC LIMIT 1
  `).get(siniestroId);
  return (ultimo && ultimo.creado_en) || siniestroCreadoEn;
}

// ----- Barrido periódico: continuidad de 72h NATURALES (6.1-6.6 / alerta interna) + postventa 48h (5.12). -----
function barrerContinuidadYPostventa(db){
  try{
    const ahora = dayjs.utc();
    const ahoraStr = ahora.format('YYYY-MM-DD HH:mm:ss');

    const activos = db.prepare(`SELECT * FROM siniestros WHERE (archivado IS NULL OR archivado = 0) AND estatus_general != 'Cerrado'`).all();
    for(const s of activos){
      try{
        const codigo = etapaContinuidadActual(db, s);
        if(!codigo) continue;
        const anclaUTC = ultimoAncla(db, s.id, s.creado_en);
        const horas = horasNaturalesTranscurridas(anclaUTC, ahoraStr); // NATURALES, punto 1.
        if(horas < 72) continue;
        const ventana = Math.floor(horas / 72); // 1 = primer periodo sin novedad; 2+ = periodos consecutivos.
        const variables = { nombre: s.cliente_nombre || '', vehiculo: s.vehiculo || '' };
        if(ventana === 1){
          registrarConChequeoDelicada(db, {
            siniestroId: s.id, plantillaCodigo: codigo,
            disparador: '72 horas naturales sin comunicación informativa real en la etapa actual (' + codigo + ')',
            variables, dedupKey: 'ventana:1',
          });
        } else {
          // Punto 2: segundo periodo consecutivo (y siguientes) sin avance real -> alerta interna,
          // NUNCA otra plantilla de Meta. No se vuelve a tranquilizar automáticamente al cliente.
          registrarEventoInterno(db, {
            siniestroId: s.id, codigo:'ALERTA-72H-X2',
            disparador: `Periodo consecutivo #${ventana} de 72h naturales sin avance real en la etapa ${codigo} -- requiere revisión humana antes de decidir cualquier nueva comunicación.`,
            variables, dedupKey: 'ventana:' + ventana,
          });
        }
      } catch(e){ registrarError(db, { contexto:'barrerContinuidadYPostventa:continuidad', siniestroId: s.id, error:e }); }
    }

    const entregados = db.prepare(`SELECT * FROM siniestros WHERE fecha_entrega_real IS NOT NULL AND fecha_entrega_real != ''`).all();
    for(const s of entregados){
      try{
        const entrega = dayjs.utc(s.fecha_entrega_real);
        if(!entrega.isValid()) continue;
        if(ahora.diff(entrega, 'hour') < 48) continue;
        registrarConChequeoDelicada(db, {
          siniestroId: s.id, plantillaCodigo: '5.12',
          disparador: '48 h después de registrar la entrega',
          variables: { nombre: s.cliente_nombre || '' }, dedupKey: 'postventa:' + s.fecha_entrega_real,
        });
      } catch(e){ registrarError(db, { contexto:'barrerContinuidadYPostventa:postventa', siniestroId: s.id, error:e }); }
    }
  } catch(e){ registrarError(db, { contexto:'barrerContinuidadYPostventa', error:e }); }
}

// ===================== Reconciliación / reintento seguro (punto 8) =====================
// Se llama desde el mismo barrido periódico ya existente. Reevalúa el ciclo principal (5.1, 5.2,
// autorización, 5.8-5.11) y las refacciones completas (5.4/5.5) para todos los expedientes activos.
// Como cada registro usa una clave de deduplicación FIJA (no depende de "ahora"), llamar esto una y
// otra vez sobre expedientes que ya tienen su evento registrado no produce ningún duplicado -- es
// exactamente el mecanismo de "reintento seguro" que pidió Roberto: si un enganche puntual falló (quedó
// su error en whatsapp_errores), este barrido lo vuelve a intentar automáticamente en la siguiente carga
// del resumen diario, sin ninguna acción manual.
function reconciliarEventosPrincipales(db){
  try{
    const activos = db.prepare(`SELECT * FROM siniestros WHERE (archivado IS NULL OR archivado = 0) AND estatus_general != 'Cerrado'`).all();
    for(const s of activos){
      try{ evaluarYRegistrarCicloPrincipal(db, s); }
      catch(e){ registrarError(db, { contexto:'reconciliarEventosPrincipales:ciclo', siniestroId: s.id, error:e }); }
      try{ procesarRefaccionesCompletas(db, s.id); }
      catch(e){ registrarError(db, { contexto:'reconciliarEventosPrincipales:refacciones', siniestroId: s.id, error:e }); }
    }
  } catch(e){ registrarError(db, { contexto:'reconciliarEventosPrincipales', error:e }); }
}

// ===================== Resolución de expediente por teléfono (para mensajes entrantes) =====================
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
  PLANTILLAS, EVENTOS_INTERNOS,
  esHorarioHabil, siguienteMomentoHabil, horasHabilesTranscurridas, horasNaturalesTranscurridas,
  tieneIncidenciaDelicadaActiva, unidadEnTaller, refaccionesRealmenteDisponibles,
  registrarEvento, registrarEventoInterno, registrarConChequeoDelicada, registrarError,
  condicionDeBloqueoSigueActiva, revisarBloqueadosResueltos, resolverPendienteRevision,
  evaluarYRegistrarCicloPrincipal,
  procesarCreacionSiniestro, procesarTransicionSiniestro, procesarRefaccionesCompletas,
  etapaContinuidadActual, ultimoAncla, barrerContinuidadYPostventa, reconciliarEventosPrincipales,
  resolverExpedientePorTelefono,
};
