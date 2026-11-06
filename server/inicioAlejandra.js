// ===================== Inicio de Alejandra (5-nov-2026) =====================
// Roberto: "lo mismo que Beto, para Alejandra" -- una sola pantalla de celular que le dice QUÉ hacer hoy,
// EN QUÉ ORDEN y CON QUÉ BOTÓN. Proceso confirmado por Roberto (5-nov-2026):
//   1) Entregar hoy      -> unidades liberadas por calidad (y ya avisadas), o prometidas para hoy sin estar listas.
//   2) Recibir unidad    -> citas de hoy (o atrasadas) que todavía no llegan: primera llegada y reingresos.
//   3) Agendar reingreso -> unidades circulando con el 90% de piezas (tarea automática reingreso_90pct).
//   4) Avisar al cliente -> el mensaje de WhatsApp (plantilla 5.x acordada) que corresponde a la etapa
//                           actual y que todavía no se le ha mandado.
//   5) Dar seguimiento   -> más de 3 días sin ningún aviso al cliente: plantilla de continuidad 6.x.
// Una tarjeta por unidad, con la acción más importante. Este cálculo NO depende del piloto de WhatsApp
// Fase A (whatsapp_config): usa sus funciones de etapa y el texto exacto de las plantillas, pero el
// registro de "ya se avisó" es la bitácora de comunicaciones con el cliente (eventos_cliente), la misma
// que ya usaba el contador de "+3 días". Un envío confirmado en la bandeja de WhatsApp también cuenta.
const whatsappFaseA = require('./whatsappFaseA');
const bandeja = require('./whatsappBandejaManual');

const DIAS_SEGUIMIENTO = 3;
// Ajustes del 6-nov-2026 (Roberto, tras ver la pantalla con datos reales: 168 por avisar y 109 seguimientos):
//  - Línea base: el primer día de uso (lunes 9-nov-2026) todo lo que ya estaba por avisar se da por avisado;
//    desde ahí solo aparecen las unidades que avancen de etapa. Se puede adelantar/repetir con la ruta
//    POST /api/inicio-alejandra/linea-base (solo admin). La fecha se puede cambiar con LINEA_BASE_ALEJANDRA.
//  - Seguimiento: máximo 10 al día, primero las que llevan más tiempo sin aviso.
//  - Sin teléfono (o sin vehículo): no cuentan en los números; van en su propia sección al final.
//  - Citas con más de 7 días de atraso: sección aparte para confirmar si el cliente todavía viene.
const LINEA_BASE_DESDE = process.env.LINEA_BASE_ALEJANDRA || '2026-11-09';
const MARCADOR_LINEA_BASE = 'linea_base_avisos_alejandra';
const MAX_SEGUIMIENTOS_DIA = 10;
const DIAS_CITA_VIEJA = 7;
const LIMITE_POSTVENTA_DIAS = 7; // 5.12 solo para entregas recientes (no reconstruye entregas viejas).

// Fecha local del taller (Veracruz, America/Mexico_City, UTC-6 sin horario de verano desde 2022).
function hoyMX(){
  return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
}
function fecha10(v){ return v ? String(v).slice(0, 10) : ''; }
function vacio(v){ return v === null || v === undefined || String(v).trim() === ''; }
function enTransito(s){
  return /^tr/i.test(String(s.ubicacion || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

// Código de plantilla 5.x que corresponde HOY a la unidad (o null si no aplica ningún aviso).
function codigoAvisoActual(db, s, hoy){
  const etapa = whatsappFaseA.etapaCicloPrincipalActual(db, s);
  if(!etapa) return null;
  if(etapa === 'postventa'){
    if(s.encuesta_estado === 'respondida') return null;
    const entrega = fecha10(s.fecha_entrega_real);
    const dias = Math.floor((Date.parse(hoy) - Date.parse(entrega)) / 86400000);
    return (dias >= 2 && dias <= LIMITE_POSTVENTA_DIAS) ? '5.12' : null;
  }
  if(etapa === 'piezas_listas' || etapa === 'autorizado_sin_piezas'){
    let lugar = whatsappFaseA.unidadEnTaller(db, s.id);
    if(lugar === 'desconocido'){
      if(enTransito(s)) lugar = 'fuera_taller';
      else if(!vacio(s.reingreso_recibido_en)) lugar = 'en_taller';
      else lugar = s.ingreso_tipo === 'circulando' ? 'fuera_taller' : 'en_taller';
    }
    if(etapa === 'piezas_listas') return lugar === 'fuera_taller' ? '5.4' : '5.5';
    return lugar === 'fuera_taller' ? '5.7' : '5.6';
  }
  return etapa; // '5.1' ... '5.11'
}

function yaSeAviso(db, siniestroId, codigo){
  const bitacora = db.prepare(`SELECT 1 FROM eventos_cliente WHERE siniestro_id=? AND tipo_evento=?`).get(siniestroId, 'aviso:' + codigo);
  if(bitacora) return true;
  const enBandeja = db.prepare(`SELECT 1 FROM whatsapp_envios_manuales WHERE siniestro_id=? AND plantilla_codigo=? AND estado='enviado'`).get(siniestroId, codigo);
  return !!enBandeja;
}

// Último momento (UTC, 'YYYY-MM-DD HH:MM:SS') en que se le escribió al cliente, por cualquier vía registrada.
function ultimoAvisoUTC(db, s){
  // La línea base no cuenta como aviso real: no se le escribió al cliente.
  const a = db.prepare(`SELECT MAX(creado_en) m FROM eventos_cliente WHERE siniestro_id=? AND direccion='saliente' AND COALESCE(resultado,'') != 'linea_base'`).get(s.id).m;
  const b = db.prepare(`SELECT MAX(confirmado_en) m FROM whatsapp_envios_manuales WHERE siniestro_id=? AND estado='enviado'`).get(s.id).m;
  const candidatos = [a, b].filter(Boolean).map(String).sort();
  return candidatos.length ? candidatos[candidatos.length - 1] : null;
}

function datosMensaje(s, codigo){
  const tel = whatsappFaseA.normalizarTelefonoMX(s.cliente_telefono);
  const texto = codigo ? bandeja.renderTexto(codigo, { nombre: s.cliente_nombre || '', vehiculo: s.vehiculo || '' }) : null;
  const plantilla = codigo && whatsappFaseA.PLANTILLAS[codigo];
  return {
    codigo, plantilla_nombre: plantilla ? plantilla.nombre : null,
    texto, falta_vehiculo: !!codigo && !texto && !!bandeja.PLANTILLAS_TEXTO[codigo],
    telefono: tel.valido ? tel.local : null,
  };
}

// Qué avisarle, dicho en palabras de Alejandra (no el nombre técnico de la plantilla).
const QUE_AVISAR = { '5.1':'Mándale la bienvenida', '5.2':'Avísale que su presupuesto ya se envió a la aseguradora',
  '5.3':'Avísale que ya autorizaron y estamos consiguiendo las piezas', '5.4':'Avísale que ya llegaron sus piezas y hay que agendar su regreso',
  '5.5':'Avísale que ya llegaron sus piezas y empieza la reparación', '5.6':'Avísale que ya autorizaron su reparación',
  '5.7':'Avísale que ya autorizaron y hay que agendar su regreso', '5.8':'Avísale que ya entró a hojalatería', '5.9':'Avísale que ya pasó a pintura',
  '5.10':'Avísale que está en revisión de calidad', '5.11':'Ya está lista: avísale que puede pasar por ella', '5.12':'Pregúntale cómo le fue con su unidad' };

const ETAPA_PROD = { programado:'Sin iniciar', mecanica:'Mecánica', en_laminado:'Hojalatería', preparacion:'Preparación', pintura:'Pintura',
  armado:'Armado', pulido:'Pulido', lavado:'Lavado', detenido:'Detenida', terminado:'Terminada' };

// Regresa la tarjeta (una sola acción) para la unidad, o null si hoy no le toca nada a Alejandra.
function tarjetaDeUnidad(db, s, hoy, contexto){
  const base = {
    id: s.id, numero: s.numero, vehiculo: s.vehiculo || '', placas: s.placas || '', aseguradora: s.aseguradora || '',
    cliente_nombre: s.cliente_nombre || '', fecha_entrega_prevista: s.fecha_entrega_prevista || '',
  };
  const entregada = !vacio(s.fecha_entrega_real);

  // 1) ENTREGAS
  if(!entregada && s.estado_calidad === 'liberado'){
    if(!yaSeAviso(db, s.id, '5.11')){
      return { ...base, tipo:'aviso', orden:1, color:'rojo', motivo:'Ya está lista: avísale al cliente que puede pasar por ella', ...datosMensaje(s, '5.11') };
    }
    return { ...base, tipo:'entrega', lista:true, orden:1, color:'rojo', deducible_aplica: s.deducible_aplica,
      motivo: fecha10(s.fecha_entrega_prevista) && fecha10(s.fecha_entrega_prevista) < hoy ? 'Lista para entregar (la fecha prometida ya pasó)' : 'Lista para entregar' };
  }
  if(!entregada && !vacio(s.fecha_entrega_prevista) && fecha10(s.fecha_entrega_prevista) <= hoy){
    const avisadoHoy = db.prepare(`SELECT 1 FROM eventos_cliente WHERE siniestro_id=? AND tipo_evento=?`).get(s.id, 'aviso:retraso:' + hoy);
    if(!avisadoHoy){
      const etapa = ETAPA_PROD[s.estado_produccion] || 'Sin iniciar';
      const vencida = fecha10(s.fecha_entrega_prevista) < hoy;
      const tel = whatsappFaseA.normalizarTelefonoMX(s.cliente_telefono);
      return { ...base, tipo:'retraso', lista:false, orden:1, color:'rojo', telefono: tel.valido ? tel.local : null,
        motivo: `${vencida ? 'Se pasó la fecha de entrega' : 'Se prometió para hoy'} y todavía no está lista (${etapa}). Escríbele al cliente.` };
    }
  }

  // 2) CITAS (primera llegada o reingreso) que todavía no llegan.
  const cita = fecha10(s.cita_fecha);
  if(!entregada && cita && cita <= hoy){
    const llegoPrimera = !vacio(s.fecha_admision) && fecha10(s.fecha_admision) >= cita;
    const llegoReingreso = !vacio(s.reingreso_recibido_en) && fecha10(s.reingreso_recibido_en) >= cita;
    if(!llegoPrimera && !llegoReingreso){
      const esReingreso = !vacio(s.fecha_admision);
      const diasAtraso = Math.floor((Date.parse(hoy) - Date.parse(cita)) / 86400000);
      if(diasAtraso > DIAS_CITA_VIEJA){
        const tel = whatsappFaseA.normalizarTelefonoMX(s.cliente_telefono);
        return { ...base, tipo:'cita_vieja', orden:6, color:'gris', es_reingreso: esReingreso, cita_fecha: cita, dias_atraso: diasAtraso,
          telefono: tel.valido ? tel.local : null,
          motivo: `${esReingreso ? 'Reingreso' : 'Primera llegada'}: tenía cita el ${cita} (hace ${diasAtraso} días) y nunca se registró` };
      }
      return { ...base, tipo:'cita', orden:2, color: cita < hoy ? 'ambar' : 'azul', es_reingreso: esReingreso, cita_fecha: cita,
        ingreso_tipo: s.ingreso_tipo || '',
        motivo: (esReingreso ? 'Reingreso' : 'Primera llegada') + (cita < hoy ? ` — tenía cita el ${cita} y no se ha registrado` : ' — cita hoy') };
    }
  }

  // 3) AGENDAR REINGRESO (90% de piezas, unidad circulando, sin cita futura).
  const tareaReingreso = contexto.tareasReingreso.get(s.id);
  if(!entregada && tareaReingreso && !(cita && cita >= hoy)){
    const tel = whatsappFaseA.normalizarTelefonoMX(s.cliente_telefono);
    return { ...base, tipo:'reingreso', orden:3, color:'verde', tarea_id: tareaReingreso.id, telefono: tel.valido ? tel.local : null,
      motivo: String(tareaReingreso.descripcion || 'Ya llegó el 90% de las piezas: agenda la cita de reingreso.').replace(/^Ya se recibió/, 'Ya llegó') };
  }

  // 4) AVISAR AL CLIENTE (plantilla de la etapa actual, aún no enviada).
  const codigo = codigoAvisoActual(db, s, hoy);
  const sinLlegar = codigo === '5.1' && vacio(s.fecha_admision); // la bienvenida va cuando la unidad ya llegó.
  if(codigo && !sinLlegar && !yaSeAviso(db, s.id, codigo)){
    const plantilla = whatsappFaseA.PLANTILLAS[codigo];
    return { ...base, tipo:'aviso', orden:4, color:'ambar', motivo: QUE_AVISAR[codigo] || ('Avísale: ' + (plantilla ? plantilla.nombre.toLowerCase() : 'nuevo avance')), ...datosMensaje(s, codigo) };
  }

  // 5) SEGUIMIENTO (+3 días sin aviso).
  if(!entregada && !(cita && cita > hoy)){
    const continuidad = whatsappFaseA.etapaContinuidadActual(db, s);
    if(continuidad){
      const ultimo = ultimoAvisoUTC(db, s) || (vacio(s.fecha_admision) ? s.creado_en : fecha10(s.fecha_admision) + ' 12:00:00');
      const dias = ultimo ? (Date.now() - Date.parse(String(ultimo).replace(' ', 'T') + 'Z')) / 86400000 : 0;
      if(dias > DIAS_SEGUIMIENTO){
        return { ...base, tipo:'seguimiento', orden:5, color:'gris', dias_sin_aviso: Math.floor(dias),
          motivo: `${Math.floor(dias)} días sin avisarle nada`, ...datosMensaje(s, continuidad) };
      }
    }
  }
  return null;
}

// Da por avisado todo lo que HOY está pendiente de avisar (sin escribirle al cliente). Regresa cuántos marcó.
function aplicarLineaBase(db, { usuario = null } = {}){
  const hoy = hoyMX();
  const activos = db.prepare(`SELECT * FROM siniestros WHERE archivado=0 AND estatus_general != 'Cerrado' AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '')`).all();
  let marcados = 0;
  const insertar = db.prepare(`INSERT INTO eventos_cliente (siniestro_id,direccion,canal,tipo_evento,autor_id,mensaje,resultado) VALUES (?,?,?,?,?,?,?)`);
  for(const s of activos){
    try{
      const codigo = s.estado_calidad === 'liberado' ? '5.11' : codigoAvisoActual(db, s, hoy);
      if(!codigo || (codigo === '5.1' && vacio(s.fecha_admision)) || yaSeAviso(db, s.id, codigo)) continue;
      insertar.run(s.id, 'saliente', 'sistema', 'aviso:' + codigo, usuario ? usuario.id : null,
        'Línea base de arranque: la unidad ya estaba en esta etapa al empezar a usar el inicio de Alejandra (se da por avisado).', 'linea_base');
      marcados++;
    }catch(e){ /* una unidad con datos raros no detiene la línea base */ }
  }
  const { registrarAuditoria } = require('./utils');
  registrarAuditoria(db, { entidad_tipo:'sistema', entidad_id:0, accion: MARCADOR_LINEA_BASE, valor_nuevo: `${marcados} aviso(s) dados por avisados`, usuario });
  return { marcados };
}
function aplicarLineaBaseSiToca(db){
  if(hoyMX() < LINEA_BASE_DESDE) return null;
  const ya = db.prepare(`SELECT 1 FROM auditoria WHERE accion=? LIMIT 1`).get(MARCADOR_LINEA_BASE);
  if(ya) return null;
  return aplicarLineaBase(db);
}

function calcularInicioAlejandra(db){
  try{ aplicarLineaBaseSiToca(db); }catch(e){ /* nunca debe impedir ver la pantalla */ }
  const hoy = hoyMX();
  const tareasReingreso = new Map();
  for(const t of db.prepare(`SELECT id, siniestro_id, descripcion FROM tareas WHERE disparador='reingreso_90pct' AND estado IN ('pendiente','en_proceso') ORDER BY creado_en`).all()){
    if(!tareasReingreso.has(t.siniestro_id)) tareasReingreso.set(t.siniestro_id, t);
  }
  const activos = db.prepare(`SELECT * FROM siniestros WHERE archivado=0 AND estatus_general != 'Cerrado'`).all();
  const tarjetas = [];
  for(const s of activos){
    try{
      const t = tarjetaDeUnidad(db, s, hoy, { tareasReingreso });
      if(t) tarjetas.push(t);
    }catch(e){ /* una unidad con datos raros no debe tumbar la pantalla completa */ }
  }
  // Avisos y seguimientos que no se pueden mandar (sin teléfono o sin vehículo): sección aparte, sin contar.
  for(const t of tarjetas){
    if((t.tipo === 'aviso' || t.tipo === 'seguimiento') && (t.falta_vehiculo || !t.telefono)){
      t.tipo_original = t.tipo; t.tipo = 'sin_datos'; t.orden = 7; t.color = 'gris';
      t.falta = t.falta_vehiculo ? 'vehiculo' : 'telefono';
      t.motivo = (t.falta === 'vehiculo' ? 'Falta capturar el vehículo' : 'Falta el teléfono del cliente') + ' — luego: ' + t.motivo.charAt(0).toLowerCase() + t.motivo.slice(1);
    }
  }
  const llave = t => [t.orden, t.tipo === 'cita' ? (t.cita_fecha || '') : (t.fecha_entrega_prevista || '9999'), -(t.dias_sin_aviso || 0), t.numero];
  tarjetas.sort((a, b) => {
    const ka = llave(a), kb = llave(b);
    for(let i = 0; i < ka.length; i++){ if(ka[i] < kb[i]) return -1; if(ka[i] > kb[i]) return 1; }
    return 0;
  });
  // Seguimiento: máximo 10 al día (ya vienen ordenados de más a menos días sin aviso).
  const hechosHoy = db.prepare(`SELECT COUNT(*) n FROM eventos_cliente WHERE tipo_evento LIKE 'seguimiento:%'
    AND COALESCE(resultado,'') != 'linea_base' AND substr(datetime(creado_en,'-6 hours'),1,10)=?`).get(hoy).n;
  const cupo = Math.max(0, MAX_SEGUIMIENTOS_DIA - hechosHoy);
  const seguimientosPendientes = tarjetas.filter(t => t.tipo === 'seguimiento').length;
  let dejados = 0;
  const visibles = tarjetas.filter(t => t.tipo !== 'seguimiento' || (dejados++ < cupo));
  const numeros = {
    entregas: visibles.filter(t => t.tipo === 'entrega' || t.tipo === 'retraso').length,
    citas: visibles.filter(t => t.tipo === 'cita').length,
    avisos: visibles.filter(t => t.tipo === 'aviso').length,
    seguimiento: visibles.filter(t => t.tipo === 'seguimiento').length,
    reingresos: visibles.filter(t => t.tipo === 'reingreso').length,
    citas_viejas: visibles.filter(t => t.tipo === 'cita_vieja').length,
    sin_datos: visibles.filter(t => t.tipo === 'sin_datos').length,
    seguimientos_hechos_hoy: hechosHoy, seguimientos_pendientes: seguimientosPendientes,
  };
  return { hoy, numeros, tarjetas: visibles, max_seguimientos_dia: MAX_SEGUIMIENTOS_DIA };
}

// Al confirmar un aviso, cierra las tareas automáticas viejas que pedían exactamente ese aviso, para que
// no queden pendientes duplicados en otras pantallas.
const TAREAS_QUE_CIERRA = { '5.3':['autorizacion_resuelta'], '5.6':['autorizacion_resuelta'], '5.7':['autorizacion_resuelta'],
  '5.4':['refacciones_completas','autorizacion_resuelta'], '5.5':['refacciones_completas','autorizacion_resuelta'] };

function registrarAviso(db, { siniestroId, codigo, tipo, modo, usuario }){
  const s = db.prepare('SELECT * FROM siniestros WHERE id=?').get(siniestroId);
  if(!s) throw Object.assign(new Error('Unidad no encontrada.'), { status:404 });
  const esRetraso = codigo === 'retraso';
  if(!esRetraso && !whatsappFaseA.PLANTILLAS[codigo]) throw Object.assign(new Error('Mensaje no reconocido.'), { status:400 });
  const hoy = hoyMX();
  const tipoEvento = esRetraso ? 'aviso:retraso:' + hoy : (tipo === 'seguimiento' ? 'seguimiento:' : 'aviso:') + codigo;
  const texto = esRetraso ? 'Se le avisó al cliente que la unidad todavía no está lista.'
    : (modo === 'ya_avisado' ? 'Marcado como ya avisado (se le había avisado por otro medio).'
      : (bandeja.renderTexto(codigo, { nombre: s.cliente_nombre || '', vehiculo: s.vehiculo || '' }) || whatsappFaseA.PLANTILLAS[codigo].nombre));
  const info = db.prepare(`INSERT INTO eventos_cliente (siniestro_id,direccion,canal,tipo_evento,autor_id,mensaje,resultado) VALUES (?,?,?,?,?,?,?)`)
    .run(s.id, 'saliente', 'whatsapp', tipoEvento, usuario ? usuario.id : null, texto, modo === 'ya_avisado' ? 'ya_avisado' : 'enviado');
  for(const disparador of (TAREAS_QUE_CIERRA[codigo] || [])){
    db.prepare(`UPDATE tareas SET estado='completada', completado_en=?, completado_por=? WHERE siniestro_id=? AND disparador=? AND estado IN ('pendiente','en_proceso')`)
      .run(new Date().toISOString(), usuario ? usuario.id : null, s.id, disparador);
  }
  return { id: info.lastInsertRowid, tipo_evento: tipoEvento };
}

// "Recibir unidad": exige las fotos de recepción del día y, si es un reingreso, deja registrada la llegada
// (reingreso_recibido_en) para que Beto la vea en piso de inmediato. Los demás datos de recepción
// (kilometraje, gasolina, pertenencias, fecha de admisión) se guardan con el PATCH normal del expediente,
// que ya hace la auditoría y sella "disponible para revisión" para Orlando.
const FOTOS_MINIMAS_RECEPCION = 4;
function fotosRecepcionHoy(db, siniestroId){
  const hoy = hoyMX();
  return db.prepare(`SELECT COUNT(*) n FROM archivos WHERE entidad_tipo='siniestro' AND entidad_id=? AND tipo='foto' AND etapa='recepcion'
    AND eliminado=0 AND substr(datetime(creado_en,'-6 hours'),1,10)=?`).get(siniestroId, hoy).n;
}
function registrarLlegada(db, { siniestroId, usuario }){
  const s = db.prepare('SELECT * FROM siniestros WHERE id=?').get(siniestroId);
  if(!s) throw Object.assign(new Error('Unidad no encontrada.'), { status:404 });
  const fotos = fotosRecepcionHoy(db, s.id);
  if(fotos < FOTOS_MINIMAS_RECEPCION){
    throw Object.assign(new Error(`Faltan fotos de recepción: llevas ${fotos} de ${FOTOS_MINIMAS_RECEPCION} (frente, atrás y los dos lados).`), { status:400, codigo:'FOTOS_RECEPCION', fotos });
  }
  const esReingreso = !vacio(s.fecha_admision);
  if(esReingreso){
    const hoy = hoyMX();
    db.prepare(`UPDATE siniestros SET reingreso_recibido_en=?, actualizado_en=datetime('now') WHERE id=?`).run(hoy, s.id);
    const { registrarAuditoria } = require('./utils');
    registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'reingreso_recibido', campo:'reingreso_recibido_en',
      valor_anterior: s.reingreso_recibido_en, valor_nuevo: hoy, usuario });
  }
  return { es_reingreso: esReingreso, fotos };
}

module.exports = { aplicarLineaBase, aplicarLineaBaseSiToca, MAX_SEGUIMIENTOS_DIA, DIAS_CITA_VIEJA, calcularInicioAlejandra, registrarAviso, registrarLlegada, fotosRecepcionHoy, codigoAvisoActual, hoyMX,
  FOTOS_MINIMAS_RECEPCION, DIAS_SEGUIMIENTO };
