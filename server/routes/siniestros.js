const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios, archivarSiniestrosVencidos, calcularRutaAseguradora, sistemaValuacionSugerido } = require('../utils');
const router = express.Router();

const PLACEHOLDERS = ['', 'por confirmar', 'sin datos', 'n/a', 'na', 'pendiente', '-', 'xxx'];
function esGenerico(v){ return !v || PLACEHOLDERS.includes(String(v).trim().toLowerCase()); }
function calcularCompleto(row){
  return (!esGenerico(row.vehiculo) && !esGenerico(row.placas)) ? 1 : 0;
}

router.get('/', requireAuth, (req, res)=>{
  archivarSiniestrosVencidos(db);
  const { aseguradora, q, archivado } = req.query;
  let sql = 'SELECT * FROM siniestros WHERE 1=1';
  const params = [];
  if(aseguradora){ sql += ' AND aseguradora = ?'; params.push(aseguradora); }
  if(q){ sql += ' AND (numero LIKE ? OR placas LIKE ? OR vehiculo LIKE ?)'; const like = `%${q}%`; params.push(like,like,like); }
  // Módulo Alejandra (Fase 1): el módulo de Daniela (rol operativo) solo debe ver expedientes
  // relevantes para refacciones. 'por_definir' se sigue mostrando porque ella puede ser quien lo determine
  // al dar de alta el primer pedido. Solo se oculta lo marcado explícitamente como 'no'.
  if(req.session.user.rol === 'operativo'){ sql += " AND requiere_refacciones != 'no'"; }
  // Requerimiento de Daniela: archivar a los 3 meses de la entrega sin borrar nada, solo para no saturar
  // la vista diaria. Por default se ocultan los archivados; ?archivado=1 los muestra únicamente a ellos;
  // ?archivado=all muestra ambos (para búsqueda/historial).
  if(archivado === '1'){ sql += ' AND archivado = 1'; }
  else if(archivado !== 'all'){ sql += ' AND archivado = 0'; }
  sql += ' ORDER BY creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requireAuth, (req, res)=>{
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Siniestro no encontrado.' });
  res.json(s);
});

router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.numero || !String(b.numero).trim()) return res.status(400).json({ error:'El número de siniestro es obligatorio.' });
  const existente = db.prepare('SELECT * FROM siniestros WHERE numero = ?').get(String(b.numero).trim());
  if(existente) return res.status(409).json({ error:'Ya existe un siniestro con ese número (no se crean duplicados).', duplicado: existente });
  if(!b.aseguradora) return res.status(400).json({ error:'La aseguradora es obligatoria.' });
  // Módulo Alejandra (Fase 1): cuando ella da de alta el expediente desde recepción, los datos
  // básicos de contacto son obligatorios. No se exige a otros roles, para no alterar el flujo actual de Daniela.
  if(req.session.user.rol === 'atencion_cliente'){
    if(!b.cliente_nombre || !String(b.cliente_nombre).trim()) return res.status(400).json({ error:'El nombre del cliente es obligatorio.' });
    if(!b.cliente_telefono || !String(b.cliente_telefono).trim()) return res.status(400).json({ error:'El teléfono del cliente es obligatorio.' });
    if(!b.cliente_correo || !String(b.cliente_correo).trim()) return res.status(400).json({ error:'El correo del cliente es obligatorio.' });
  }
  const requiereRefacciones = ['si','no','por_definir'].includes(b.requiere_refacciones) ? b.requiere_refacciones : 'por_definir';

  const completo = calcularCompleto(b);
  const piezasIniciales = b.piezas_autorizadas_cambio!==undefined && b.piezas_autorizadas_cambio!=='' ? Number(b.piezas_autorizadas_cambio) : null;
  const rutaInicial = calcularRutaAseguradora(b.aseguradora, piezasIniciales);
  const sistemaValuacionInicial = (b.sistema_valuacion && String(b.sistema_valuacion).trim()) || sistemaValuacionSugerido(b.aseguradora);
  const info = db.prepare(`INSERT INTO siniestros (numero,aseguradora,vehiculo,anio_modelo,placas,vin,fecha_ingreso,ubicacion,responsable,estatus_general,notas,completo,creado_por,
      cliente_nombre,cliente_telefono,cliente_correo,cliente_notas,orden_admision,canal_origen,etapa_actual,prioridad,requiere_refacciones,
      ingreso_tipo,ingreso_seguro,piezas_autorizadas_cambio,aseguradora_ruta_refacciones,aseguradora_regla_aplicada,sistema_valuacion)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?)`)
    .run(String(b.numero).trim(), b.aseguradora, b.vehiculo||'', b.anio_modelo||'', b.placas||'', b.vin||'',
         b.fecha_ingreso || new Date().toISOString().slice(0,10), b.ubicacion||'Piso', b.responsable||req.session.user.nombre,
         b.estatus_general||'Abierto', b.notas||'', completo, req.session.user.id,
         b.cliente_nombre||'', b.cliente_telefono||'', b.cliente_correo||'', b.cliente_notas||'', b.orden_admision||'',
         b.canal_origen||'', b.etapa_actual||'Preingreso', b.prioridad||'', requiereRefacciones,
         b.ingreso_tipo||'', b.ingreso_seguro!==undefined?(b.ingreso_seguro?1:0):null, piezasIniciales, rutaInicial.ruta, rutaInicial.regla, sistemaValuacionInicial);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user,
    valor_nuevo: `Siniestro ${b.numero} (${b.aseguradora})` });

  // Módulo Alejandra (Fase 2): alta de expediente -> tarea automática de mensaje inicial (regla del punto 7 del documento).
  if(req.session.user.rol === 'atencion_cliente'){
    db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,responsable_id,fecha_limite,estado,origen,disparador,creado_por)
      VALUES (?,?,?,?,?,'pendiente','automatica','alta_expediente',?)`)
      .run(info.lastInsertRowid, 'mensaje', 'Enviar mensaje inicial: explicar el proceso y confirmar datos de recepción con el cliente.',
           req.session.user.id, new Date().toISOString().slice(0,10), req.session.user.id);
  }

  const creado = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...creado, advertencia: completo ? null : 'Faltan datos (vehículo/placas). Queda marcado como Pendiente de completar.' });
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Siniestro no encontrado.' });
  const campos = ['aseguradora','vehiculo','anio_modelo','placas','vin','fecha_ingreso','ubicacion','responsable','estatus_general','notas',
    'cliente_nombre','cliente_telefono','cliente_correo','cliente_notas','orden_admision','canal_origen','etapa_actual','prioridad',
    'requiere_refacciones','deducible','forma_pago','fecha_entrega_prevista','fecha_entrega_real','postventa_programada','postventa_completada',
    'estado_valuacion','estado_produccion','estado_calidad','ingreso_tipo','ingreso_seguro','piezas_autorizadas_cambio',
    // Documento Maestro / Fase B: recepción, admisión y revisión técnica (Orlando)
    'cita_fecha','grua_operador','grua_hora','fecha_admision','kilometraje','combustible_nivel','llaves_entregadas','pertenencias',
    'estado_admision','motivo_admision','estado_revision_tecnica','riesgo_seguridad','riesgo_seguridad_motivo','estado_evidencia',
    // Documento Maestro / Fase C: captura y armado de expediente (Vanessa)
    'estado_expediente','sistema_valuacion','expediente_folio',
    // Documento Maestro / Fase D: valuación y autorización
    'valuacion_folio','valuacion_version','valuacion_importe','valuacion_fecha_envio','valuacion_observaciones',
    'estado_autorizacion','autorizacion_fecha_envio','autorizacion_fecha_respuesta','autorizador','autorizacion_importe','autorizacion_restricciones'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  nuevo.completo = calcularCompleto(nuevo);

  // F-17/F-21 del documento maestro: una excepción o condición fuera de lo normal debe traer motivo,
  // igual que Daniela exige motivo de cancelación en pedidos. Mismo criterio aquí para admisión y riesgo.
  if(['condicionado','no_admitido'].includes(nuevo.estado_admision) && !(nuevo.motivo_admision && String(nuevo.motivo_admision).trim())){
    return res.status(400).json({ error:'Indica el motivo cuando la admisión queda condicionada o no admitida.' });
  }
  const riesgoActivo = nuevo.riesgo_seguridad===1 || nuevo.riesgo_seguridad===true || nuevo.riesgo_seguridad==='1';
  if(riesgoActivo && !(nuevo.riesgo_seguridad_motivo && String(nuevo.riesgo_seguridad_motivo).trim())){
    return res.status(400).json({ error:'Indica el motivo técnico cuando se marca riesgo de seguridad.' });
  }
  nuevo.riesgo_seguridad = riesgoActivo ? 1 : (nuevo.riesgo_seguridad ? 1 : 0);
  nuevo.llaves_entregadas = (nuevo.llaves_entregadas===1||nuevo.llaves_entregadas===true||nuevo.llaves_entregadas==='1') ? 1 : (nuevo.llaves_entregadas ? 1 : 0);

  // Documento Maestro / Fase C, tabla 9: "criterio de salida: expediente digital validado y listo para
  // valuación." No se puede marcar listo si hay documentos faltantes o ilegibles pendientes (misma lógica
  // que el cierre condicionado de Daniela: el sistema bloquea, no solo advierte).
  if(nuevo.estado_expediente === 'listo_para_valuacion'){
    const pendientes = db.prepare(`SELECT tipo_documento FROM documentos_expediente WHERE siniestro_id = ? AND estado IN ('faltante','no_legible')`).all(req.params.id);
    if(pendientes.length){
      return res.status(400).json({ error:'No se puede marcar el expediente como listo para valuación: hay documentos faltantes o no legibles.',
        detalle: pendientes.map(p=>p.tipo_documento) });
    }
  }

  // Documento Maestro / Fase D, tabla 10: "criterio de salida: valuación enviada y resolución registrada."
  const ESTADOS_VALUACION_CON_ENVIO = ['enviada','observada','ajustada','autorizada_parcial','autorizada_total','rechazada'];
  if(ESTADOS_VALUACION_CON_ENVIO.includes(nuevo.estado_valuacion) && !(nuevo.valuacion_fecha_envio && String(nuevo.valuacion_fecha_envio).trim())){
    return res.status(400).json({ error:'Indica la fecha de envío de la valuación antes de marcarla en este estado.' });
  }
  // Tabla 11: "criterio de salida: alcance autorizado y restricciones conocidas." Autorizada/parcial exige
  // quién autorizó y cuándo respondió (mismos datos que pide la tabla: "fecha envío/respuesta, autorizador").
  if(['autorizada','parcial'].includes(nuevo.estado_autorizacion)){
    if(!(nuevo.autorizacion_fecha_respuesta && String(nuevo.autorizacion_fecha_respuesta).trim())){
      return res.status(400).json({ error:'Indica la fecha de respuesta de la autorización.' });
    }
    if(!(nuevo.autorizador && String(nuevo.autorizador).trim())){
      return res.status(400).json({ error:'Indica quién autorizó (ajustador/plataforma/propietario).' });
    }
  }

  // Documento Maestro / Fase D: recalcular la ruta de refacciones cada vez que cambie la aseguradora
  // o el número de piezas autorizadas a cambio (regla GNP 1-3 = autosurtido obligatorio).
  const ruta = calcularRutaAseguradora(nuevo.aseguradora, nuevo.piezas_autorizadas_cambio);
  nuevo.aseguradora_ruta_refacciones = ruta.ruta;
  nuevo.aseguradora_regla_aplicada = ruta.regla;

  db.prepare(`UPDATE siniestros SET aseguradora=?,vehiculo=?,anio_modelo=?,placas=?,vin=?,fecha_ingreso=?,ubicacion=?,responsable=?,estatus_general=?,notas=?,completo=?,
      cliente_nombre=?,cliente_telefono=?,cliente_correo=?,cliente_notas=?,orden_admision=?,canal_origen=?,etapa_actual=?,prioridad=?,
      requiere_refacciones=?,deducible=?,forma_pago=?,fecha_entrega_prevista=?,fecha_entrega_real=?,postventa_programada=?,postventa_completada=?,
      estado_valuacion=?,estado_produccion=?,estado_calidad=?,ingreso_tipo=?,ingreso_seguro=?,piezas_autorizadas_cambio=?,
      aseguradora_ruta_refacciones=?,aseguradora_regla_aplicada=?,
      cita_fecha=?,grua_operador=?,grua_hora=?,fecha_admision=?,kilometraje=?,combustible_nivel=?,llaves_entregadas=?,pertenencias=?,
      estado_admision=?,motivo_admision=?,estado_revision_tecnica=?,riesgo_seguridad=?,riesgo_seguridad_motivo=?,estado_evidencia=?,
      estado_expediente=?,sistema_valuacion=?,expediente_folio=?,
      valuacion_folio=?,valuacion_version=?,valuacion_importe=?,valuacion_fecha_envio=?,valuacion_observaciones=?,
      estado_autorizacion=?,autorizacion_fecha_envio=?,autorizacion_fecha_respuesta=?,autorizador=?,autorizacion_importe=?,autorizacion_restricciones=?,
      actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.aseguradora, nuevo.vehiculo, nuevo.anio_modelo, nuevo.placas, nuevo.vin, nuevo.fecha_ingreso, nuevo.ubicacion, nuevo.responsable, nuevo.estatus_general, nuevo.notas, nuevo.completo,
      nuevo.cliente_nombre, nuevo.cliente_telefono, nuevo.cliente_correo, nuevo.cliente_notas, nuevo.orden_admision, nuevo.canal_origen, nuevo.etapa_actual, nuevo.prioridad,
      nuevo.requiere_refacciones, nuevo.deducible, nuevo.forma_pago, nuevo.fecha_entrega_prevista, nuevo.fecha_entrega_real, nuevo.postventa_programada, nuevo.postventa_completada,
      nuevo.estado_valuacion, nuevo.estado_produccion, nuevo.estado_calidad, nuevo.ingreso_tipo, nuevo.ingreso_seguro, nuevo.piezas_autorizadas_cambio,
      nuevo.aseguradora_ruta_refacciones, nuevo.aseguradora_regla_aplicada,
      nuevo.cita_fecha, nuevo.grua_operador, nuevo.grua_hora, nuevo.fecha_admision, nuevo.kilometraje, nuevo.combustible_nivel, nuevo.llaves_entregadas, nuevo.pertenencias,
      nuevo.estado_admision, nuevo.motivo_admision, nuevo.estado_revision_tecnica, nuevo.riesgo_seguridad, nuevo.riesgo_seguridad_motivo, nuevo.estado_evidencia,
      nuevo.estado_expediente, nuevo.sistema_valuacion, nuevo.expediente_folio,
      nuevo.valuacion_folio, nuevo.valuacion_version, nuevo.valuacion_importe, nuevo.valuacion_fecha_envio, nuevo.valuacion_observaciones,
      nuevo.estado_autorizacion, nuevo.autorizacion_fecha_envio, nuevo.autorizacion_fecha_respuesta, nuevo.autorizador, nuevo.autorizacion_importe, nuevo.autorizacion_restricciones,
      req.params.id);
  auditarCambios(db, { entidad_tipo:'siniestro', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id));
});


// Requerimientos de Daniela — Registrar entrega de la unidad.
// Permitido a Daniela (operativo), la persona de seguimiento a clientes (atencion_cliente) y admin.
router.patch('/:id/entrega', requireAuth, requireRole('operativo','atencion_cliente','admin'), (req, res)=>{
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Siniestro no encontrado.' });
  const fecha = req.body.fecha_entrega_real || new Date().toISOString().slice(0,10);
  // Registrar/editar la entrega es una decisión fresca: si antes se había bloqueado el archivo automático, se reactiva.
  db.prepare("UPDATE siniestros SET fecha_entrega_real=?, no_auto_archivar=0, actualizado_en=datetime('now') WHERE id=?").run(fecha, s.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: s.id, accion:'entrega_registrada', campo:'fecha_entrega_real',
    valor_anterior: s.fecha_entrega_real, valor_nuevo: fecha, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(s.id));
});

// Requerimientos de Daniela — Cierre de siniestro condicionado.
// Solo puede cerrarse cuando todos los pedidos están en un estado terminal (Recibido completo / Cancelado)
// y la unidad ya fue entregada (fecha_entrega_real capturada). Permitido a Daniela (operativo), Jefe y admin.
const ESTATUS_TERMINALES_PEDIDO = ['Recibido completo','Cancelado'];
router.patch('/:id/cerrar', requireAuth, requireRole('operativo','jefe','admin'), (req, res)=>{
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Siniestro no encontrado.' });

  const pedidos = db.prepare('SELECT numero, estatus_operativo FROM pedidos WHERE siniestro_id = ?').all(s.id);
  const pendientes = pedidos.filter(p => !ESTATUS_TERMINALES_PEDIDO.includes(p.estatus_operativo));
  const problemas = [];
  if(pendientes.length){
    problemas.push(`Pedidos sin recibir/cancelar: ${pendientes.map(p=>p.numero).join(', ')}`);
  }
  if(!s.fecha_entrega_real){
    problemas.push('Falta registrar la fecha de entrega de la unidad.');
  }
  if(problemas.length){
    return res.status(400).json({ error:'No se puede cerrar el siniestro todavía.', detalle: problemas });
  }

  db.prepare("UPDATE siniestros SET estatus_general='Cerrado', actualizado_en=datetime('now') WHERE id=?").run(s.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: s.id, accion:'cierre', campo:'estatus_general',
    valor_anterior: s.estatus_general, valor_nuevo: 'Cerrado', usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(s.id));
});


// Desarchivar manualmente (correcciones/consultas puntuales). Mismo permiso que cerrar/administrar.
router.patch('/:id/desarchivar', requireAuth, requireRole('operativo','jefe','admin'), (req, res)=>{
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Siniestro no encontrado.' });
  db.prepare("UPDATE siniestros SET archivado=0, archivado_en=NULL, no_auto_archivar=1 WHERE id=?").run(s.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: s.id, accion:'desarchivado_manual', usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(s.id));
});

module.exports = router;
