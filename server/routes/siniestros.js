const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios, archivarSiniestrosVencidos, calcularRutaAseguradora, sistemaValuacionSugerido, calcularSemaforo, verificarDisponibleParaRevision, requisitosAdmisionFaltantes } = require('../utils');
const router = express.Router();

const PLACEHOLDERS = ['', 'por confirmar', 'sin datos', 'n/a', 'na', 'pendiente', '-', 'xxx'];
function esGenerico(v){ return !v || PLACEHOLDERS.includes(String(v).trim().toLowerCase()); }
function calcularCompleto(row){
  return (!esGenerico(row.vehiculo) && !esGenerico(row.placas)) ? 1 : 0;
}

// Triage Daniela, item 10 (matriz de roles): el PATCH general de siniestros cubre campos de varios
// módulos especializados (admisión, técnica, expediente, valuación/autorización, producción, calidad,
// entrega, finiquito). El frontend ya oculta los botones de captura a quien no es el rol dueño de cada
// módulo, pero el backend no lo exigía: cualquier usuario autenticado podía escribir esos campos llamando
// la API directamente. Esto formaliza en el servidor la misma separación que ya existe en pantalla, para
// que "solo lectura" sea real y no solo una convención de la interfaz. Los campos generales del expediente
// (vehículo, placas, cliente, notas, etc.) siguen abiertos a cualquier usuario autenticado, como siempre.
const GRUPOS_CAMPOS_RESTRINGIDOS = [
  { campos:['cita_fecha','grua_operador','grua_hora','fecha_admision','kilometraje','combustible_nivel','llaves_entregadas','pertenencias','estado_admision','motivo_admision','ingreso_tipo','ingreso_seguro','requiere_dado_seguridad','dado_seguridad_colocado','grupo_whatsapp_creado'],
    roles:['atencion_cliente','vanessa','admin','jefe'], nombre:'admisión' },
  { campos:['estado_revision_tecnica','riesgo_seguridad','riesgo_seguridad_motivo','estado_evidencia'],
    roles:['orlando','admin','jefe'], nombre:'revisión técnica' },
  { campos:['fecha_borrador_captura','excel_capturado','excel_capturado_fecha','fotos_completas','fotos_completas_fecha','enviado_propietario','enviado_propietario_fecha'],
    roles:['orlando','vanessa','admin','jefe'], nombre:'captura y envío' },
  { campos:['estado_expediente','sistema_valuacion','expediente_folio','expediente_listo_fecha'],
    roles:['vanessa','admin','jefe'], nombre:'expediente digital' },
  { campos:['valuacion_folio','valuacion_version','valuacion_importe','valuacion_fecha_envio','valuacion_fecha_respuesta','valuacion_observaciones',
      'estado_autorizacion','autorizacion_fecha_envio','autorizacion_fecha_respuesta','autorizador','autorizacion_importe','autorizacion_restricciones',
      'piezas_autorizadas_cambio','estado_valuacion'],
    roles:['orlando','admin','jefe'], nombre:'valuación/autorización' },
  { campos:['estado_produccion'], roles:['beto','orlando','admin','jefe'], nombre:'producción' },
  { campos:['estado_calidad'], roles:['beto','orlando','admin','jefe'], nombre:'calidad' },
  { campos:['entrega_receptor','entrega_identificacion','entrega_kilometraje','entrega_combustible','entrega_llaves_entregadas','entrega_observacion','estado_entrega','deducible_pagado_confirmado_en','entrega_encuesta_gnp_solicitada'],
    roles:['beto','atencion_cliente','admin','jefe'], nombre:'entrega' },
  { campos:['finiquito_estado','finiquito_fecha','finiquito_observacion','encuesta_estado','encuesta_calificacion','encuesta_comentarios','postventa_resultado'],
    roles:['atencion_cliente','admin','jefe'], nombre:'finiquito/encuesta' }
];
function campoRestringidoSinPermiso(body, rol){
  for(const g of GRUPOS_CAMPOS_RESTRINGIDOS){
    if(g.campos.some(c=> body[c] !== undefined) && !g.roles.includes(rol)) return g.nombre;
  }
  return null;
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
  // Detalle de qué falta exactamente para quedar disponible para revisión (sección 3.1 de la propuesta
  // de Orlando) -- ya sellado (fecha_hora_disponible_revision) no hace falta recalcular nada.
  const admisionFaltantes = s.fecha_hora_disponible_revision ? [] : requisitosAdmisionFaltantes(db, s);
  res.json({ ...s, semaforo: calcularSemaforo(s), admision_faltantes: admisionFaltantes });
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
  const moduloSinPermiso = campoRestringidoSinPermiso(req.body, req.session.user.rol);
  if(moduloSinPermiso) return res.status(403).json({ error: `No tienes permiso para modificar campos de ${moduloSinPermiso}.` });
  const campos = ['aseguradora','vehiculo','anio_modelo','placas','vin','fecha_ingreso','ubicacion','responsable','estatus_general','notas',
    'cliente_nombre','cliente_telefono','cliente_correo','cliente_notas','orden_admision','canal_origen','etapa_actual','prioridad',
    'requiere_refacciones','deducible','forma_pago','fecha_entrega_prevista','fecha_entrega_real','postventa_programada','postventa_completada',
    'estado_valuacion','estado_produccion','estado_calidad','ingreso_tipo','ingreso_seguro','piezas_autorizadas_cambio',
    // Documento Maestro / Fase B: recepción, admisión y revisión técnica (Orlando)
    'cita_fecha','grua_operador','grua_hora','fecha_admision','kilometraje','combustible_nivel','llaves_entregadas','pertenencias',
    'estado_admision','motivo_admision','estado_revision_tecnica','riesgo_seguridad','riesgo_seguridad_motivo','estado_evidencia',
    'requiere_dado_seguridad','dado_seguridad_colocado','grupo_whatsapp_creado',
    // Documento Maestro / Fase C: captura y armado de expediente (Vanessa)
    'estado_expediente','sistema_valuacion','expediente_folio','expediente_listo_fecha',
    // Documento Maestro / Fase D: valuación y autorización
    'valuacion_folio','valuacion_version','valuacion_importe','valuacion_fecha_envio','valuacion_fecha_respuesta','valuacion_observaciones',
    'estado_autorizacion','autorizacion_fecha_envio','autorizacion_fecha_respuesta','autorizador','autorizacion_importe','autorizacion_restricciones',
    // Documento Maestro / Fase F: control de calidad, entrega, finiquito y encuesta
    'estado_calidad','entrega_receptor','entrega_identificacion','entrega_kilometraje','entrega_combustible','entrega_llaves_entregadas','entrega_observacion','estado_entrega',
    'finiquito_estado','finiquito_fecha','finiquito_observacion','encuesta_estado','encuesta_calificacion','encuesta_comentarios','postventa_resultado','deducible_pagado_confirmado_en','entrega_encuesta_gnp_solicitada',
    // Propuesta Orlando/Vanessa fusionados: Excel capturado, fotos/carpeta completas, enviado al propietario
    'fecha_borrador_captura','excel_capturado','excel_capturado_fecha','fotos_completas','fotos_completas_fecha','enviado_propietario','enviado_propietario_fecha'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  nuevo.completo = calcularCompleto(nuevo);

  // Propuesta Orlando/Vanessa: "quién registra la fecha de entrega del borrador a captura" — Roberto
  // confirmó que gana la primera vez que se registra, sin importar quién la mandó. Si ya tenía valor,
  // se ignora cualquier intento posterior de sobrescribirla (no error: transición sin fricción).
  if(anterior.fecha_borrador_captura){
    nuevo.fecha_borrador_captura = anterior.fecha_borrador_captura;
  }
  // Al marcar por primera vez Excel capturado / fotos completas / enviado al propietario, se sella la
  // fecha automáticamente si no se mandó una explícita — así ninguno de los dos tiene que capturarla aparte.
  const hoyISO = new Date().toISOString().slice(0,10);
  if(nuevo.excel_capturado && !anterior.excel_capturado && !nuevo.excel_capturado_fecha) nuevo.excel_capturado_fecha = hoyISO;
  if(nuevo.fotos_completas && !anterior.fotos_completas && !nuevo.fotos_completas_fecha) nuevo.fotos_completas_fecha = hoyISO;
  if(nuevo.enviado_propietario && !anterior.enviado_propietario && !nuevo.enviado_propietario_fecha) nuevo.enviado_propietario_fecha = hoyISO;
  // Roberto (28-ago-2026): sella sola la primera vez que el expediente queda listo para valuar, para
  // poder medir después cuánto tardó él mismo en capturarlo y enviarlo a evaluación (valuacion_fecha_envio).
  if(nuevo.estado_expediente === 'listo_para_valuacion' && anterior.estado_expediente !== 'listo_para_valuacion' && !nuevo.expediente_listo_fecha) nuevo.expediente_listo_fecha = hoyISO;
  nuevo.excel_capturado = nuevo.excel_capturado ? 1 : 0;
  nuevo.fotos_completas = nuevo.fotos_completas ? 1 : 0;
  nuevo.enviado_propietario = nuevo.enviado_propietario ? 1 : 0;

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

  // Propuesta de Orlando (sección 3.1): si el vehículo tiene daño de suspensión, se exige el dado de
  // seguridad como cuarto requisito antes de aparecer disponible para su revisión.
  nuevo.requiere_dado_seguridad = (nuevo.requiere_dado_seguridad===1||nuevo.requiere_dado_seguridad===true||nuevo.requiere_dado_seguridad==='1') ? 1 : (nuevo.requiere_dado_seguridad ? 1 : 0);
  nuevo.dado_seguridad_colocado = (nuevo.dado_seguridad_colocado===1||nuevo.dado_seguridad_colocado===true||nuevo.dado_seguridad_colocado==='1') ? 1 : (nuevo.dado_seguridad_colocado ? 1 : 0);

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

  // Documento Maestro / Fase F, tabla 16: "criterio de salida: checklist completo, defectos cerrados y
  // liberación registrada." No se puede liberar calidad con rubros rechazados pendientes.
  if(nuevo.estado_calidad === 'liberado'){
    const rechazados = db.prepare(`SELECT dimension FROM checklist_calidad WHERE siniestro_id = ? AND resultado = 'rechazado'`).all(req.params.id);
    if(rechazados.length){
      return res.status(400).json({ error:'No se puede liberar calidad: hay rubros del checklist rechazados sin corregir.',
        detalle: rechazados.map(r=>r.dimension) });
    }
  }
  // Finiquito firmado exige que la unidad ya se haya entregado.
  if(nuevo.finiquito_estado === 'firmado' && !nuevo.fecha_entrega_real){
    return res.status(400).json({ error:'No se puede firmar el finiquito antes de registrar la entrega de la unidad.' });
  }
  // Tabla 19: "cualquier incidencia convertida en tarea." Una inconformidad en el finiquito genera
  // automáticamente una tarea de seguimiento para Alejandra (mismo patrón que el resto de automatizaciones).
  const nuevaInconformidad = nuevo.finiquito_estado === 'inconformidad_abierta' && anterior.finiquito_estado !== 'inconformidad_abierta';

  // Propuesta: "unidades por avisar autorización" (panorama de Alejandra) — mismo patrón que
  // refacciones_completas: cuando la autorización se resuelve, se crea una tarea de aviso al cliente.
  const autorizacionReciénResuelta = ['autorizada','parcial'].includes(nuevo.estado_autorizacion) && !['autorizada','parcial'].includes(anterior.estado_autorizacion);

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
      requiere_dado_seguridad=?,dado_seguridad_colocado=?,grupo_whatsapp_creado=?,
      estado_expediente=?,sistema_valuacion=?,expediente_folio=?,expediente_listo_fecha=?,
      valuacion_folio=?,valuacion_version=?,valuacion_importe=?,valuacion_fecha_envio=?,valuacion_fecha_respuesta=?,valuacion_observaciones=?,
      estado_autorizacion=?,autorizacion_fecha_envio=?,autorizacion_fecha_respuesta=?,autorizador=?,autorizacion_importe=?,autorizacion_restricciones=?,
      entrega_receptor=?,entrega_identificacion=?,entrega_kilometraje=?,entrega_combustible=?,entrega_llaves_entregadas=?,entrega_observacion=?,estado_entrega=?,
      finiquito_estado=?,finiquito_fecha=?,finiquito_observacion=?,encuesta_estado=?,encuesta_calificacion=?,encuesta_comentarios=?,postventa_resultado=?,deducible_pagado_confirmado_en=?,entrega_encuesta_gnp_solicitada=?,
      fecha_borrador_captura=?,excel_capturado=?,excel_capturado_fecha=?,fotos_completas=?,fotos_completas_fecha=?,enviado_propietario=?,enviado_propietario_fecha=?,
      actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.aseguradora, nuevo.vehiculo, nuevo.anio_modelo, nuevo.placas, nuevo.vin, nuevo.fecha_ingreso, nuevo.ubicacion, nuevo.responsable, nuevo.estatus_general, nuevo.notas, nuevo.completo,
      nuevo.cliente_nombre, nuevo.cliente_telefono, nuevo.cliente_correo, nuevo.cliente_notas, nuevo.orden_admision, nuevo.canal_origen, nuevo.etapa_actual, nuevo.prioridad,
      nuevo.requiere_refacciones, nuevo.deducible, nuevo.forma_pago, nuevo.fecha_entrega_prevista, nuevo.fecha_entrega_real, nuevo.postventa_programada, nuevo.postventa_completada,
      nuevo.estado_valuacion, nuevo.estado_produccion, nuevo.estado_calidad, nuevo.ingreso_tipo, nuevo.ingreso_seguro, nuevo.piezas_autorizadas_cambio,
      nuevo.aseguradora_ruta_refacciones, nuevo.aseguradora_regla_aplicada,
      nuevo.cita_fecha, nuevo.grua_operador, nuevo.grua_hora, nuevo.fecha_admision, nuevo.kilometraje, nuevo.combustible_nivel, nuevo.llaves_entregadas, nuevo.pertenencias,
      nuevo.estado_admision, nuevo.motivo_admision, nuevo.estado_revision_tecnica, nuevo.riesgo_seguridad, nuevo.riesgo_seguridad_motivo, nuevo.estado_evidencia,
      nuevo.requiere_dado_seguridad, nuevo.dado_seguridad_colocado, nuevo.grupo_whatsapp_creado,
      nuevo.estado_expediente, nuevo.sistema_valuacion, nuevo.expediente_folio, nuevo.expediente_listo_fecha,
      nuevo.valuacion_folio, nuevo.valuacion_version, nuevo.valuacion_importe, nuevo.valuacion_fecha_envio, nuevo.valuacion_fecha_respuesta, nuevo.valuacion_observaciones,
      nuevo.estado_autorizacion, nuevo.autorizacion_fecha_envio, nuevo.autorizacion_fecha_respuesta, nuevo.autorizador, nuevo.autorizacion_importe, nuevo.autorizacion_restricciones,
      nuevo.entrega_receptor, nuevo.entrega_identificacion, nuevo.entrega_kilometraje, nuevo.entrega_combustible, nuevo.entrega_llaves_entregadas, nuevo.entrega_observacion, nuevo.estado_entrega,
      nuevo.finiquito_estado, nuevo.finiquito_fecha, nuevo.finiquito_observacion, nuevo.encuesta_estado, nuevo.encuesta_calificacion, nuevo.encuesta_comentarios, nuevo.postventa_resultado, nuevo.deducible_pagado_confirmado_en, (nuevo.entrega_encuesta_gnp_solicitada===undefined||nuevo.entrega_encuesta_gnp_solicitada===null||nuevo.entrega_encuesta_gnp_solicitada==='')?null:(nuevo.entrega_encuesta_gnp_solicitada?1:0),
      nuevo.fecha_borrador_captura, nuevo.excel_capturado, nuevo.excel_capturado_fecha, nuevo.fotos_completas, nuevo.fotos_completas_fecha, nuevo.enviado_propietario, nuevo.enviado_propietario_fecha,
      req.params.id);
  auditarCambios(db, { entidad_tipo:'siniestro', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  if(nuevaInconformidad){
    db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
      VALUES (?,?,?,?,'pendiente','automatica','inconformidad_finiquito',?)`)
      .run(req.params.id, 'seguimiento', 'Dar seguimiento a la inconformidad registrada en el finiquito.', new Date().toISOString().slice(0,10), req.session.user.id);
  }
  if(autorizacionReciénResuelta){
    const yaExiste = db.prepare(`SELECT id FROM tareas WHERE siniestro_id=? AND disparador='autorizacion_resuelta' AND estado IN ('pendiente','en_proceso')`).get(req.params.id);
    if(!yaExiste){
      db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
        VALUES (?,?,?,?,'pendiente','automatica','autorizacion_resuelta',?)`)
        .run(req.params.id, 'mensaje', 'Autorización resuelta: avisar al cliente y explicar el siguiente paso.', new Date().toISOString().slice(0,10), req.session.user.id);
    }
  }

  // Modificación 7 (Modificaciones_Tablero_SC_Control.docx): hoy Beto se entera del expediente autorizado
  // hasta que le imprimen y dejan la OT físicamente, sin contexto previo. En cuanto la autorización se
  // resuelve (equivalente digital a "Roberto lo libera"), se le avisa de una vez en el sistema -- no
  // depende de que alguien le entregue el papel.
  if(autorizacionReciénResuelta){
    const yaExisteAvisoBeto = db.prepare(`SELECT id FROM tareas WHERE siniestro_id=? AND disparador='ot_lista_beto' AND estado IN ('pendiente','en_proceso')`).get(req.params.id);
    if(!yaExisteAvisoBeto){
      db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
        VALUES (?,?,?,?,'pendiente','automatica','ot_lista_beto',?)`)
        .run(req.params.id, 'aviso', 'Expediente autorizado: ya puedes revisar la orden de trabajo y proveedores asignados, aunque todavía no llegue la hoja impresa.', new Date().toISOString().slice(0,10), req.session.user.id);
    }
  }

  // Propuesta de Orlando (sección 3.1): si este PATCH tocó algún requisito de admisión (llaves, dado de
  // seguridad, tipo de ingreso, fecha de admisión), reevalúa si el vehículo ya queda disponible para su
  // revisión. verificarDisponibleParaRevision es idempotente: si ya estaba sellado, no hace nada.
  const camposAdmisionTocados = ['llaves_entregadas','requiere_dado_seguridad','dado_seguridad_colocado','ingreso_tipo','fecha_admision'].some(c => req.body[c] !== undefined);
  if(camposAdmisionTocados){
    verificarDisponibleParaRevision(db, req.params.id, req.session.user);
  }

  // Propuesta de Orlando (sección 3.3): al cerrar su parte (Excel + orden de admisión + fotos listos =
  // estado_revision_tecnica='revision_terminada'), se sella la hora de cierre una sola vez y se avisa a
  // Roberto con una tarea visible en el expediente -- sin esperar a que Vanessa termine el expediente
  // digital, que sigue siendo el criterio real para la bandeja de valuación (no se toca esa compuerta).
  if(nuevo.estado_revision_tecnica === 'revision_terminada' && anterior.estado_revision_tecnica !== 'revision_terminada'){
    db.prepare("UPDATE siniestros SET fecha_hora_revision_concluida=datetime('now') WHERE id=? AND fecha_hora_revision_concluida IS NULL").run(req.params.id);
    const yaExisteAviso = db.prepare(`SELECT id FROM tareas WHERE siniestro_id=? AND disparador='revision_lista_para_evaluar'`).get(req.params.id);
    if(!yaExisteAviso){
      db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
        VALUES (?,?,?,?,'pendiente','automatica','revision_lista_para_evaluar',?)`)
        .run(req.params.id, 'mensaje', 'Orlando cerró su revisión: Excel, orden de admisión y fotos listos para evaluar.', new Date().toISOString().slice(0,10), req.session.user.id);
    }
  }

  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id));
});

// Proceso_Completo_Servicio_Cristian.docx (secciones 8-9): dos avisos propios de Roberto que hoy manda
// por correo y que quiere ver reflejados en el tablero, cada uno disparando tareas automáticas a quien
// corresponde -- mismo patrón que 'ot_lista_beto' / 'autorizacion_resuelta' (tareas visibles en la
// bitácora del expediente, no una bandeja personal). Ambas exclusivas de admin/jefe (el propietario).

// Sección 8: "ya está todo autorizado pero seguimos esperando que Impart asigne proveedor" -- avisa a
// Alejandra (para que informe al cliente que va en tiempo, aunque falte proveedor) y a Daniela (para
// que lo tenga en su radar de seguimiento).
router.patch('/:id/avisar-proveedores-pendientes', requireAuth, requireRole('admin','jefe'), (req, res)=>{
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Siniestro no encontrado.' });
  if(!['autorizada','parcial'].includes(s.estado_autorizacion)){
    return res.status(400).json({ error:'La valuación debe estar autorizada (total o parcial) antes de avisar que faltan proveedores.' });
  }
  if(s.proveedores_aviso_pendiente_en){
    return res.status(400).json({ error:'Ya se avisó de proveedores pendientes el ' + s.proveedores_aviso_pendiente_en.slice(0,16).replace('T',' ') + '.' });
  }
  const ahora = new Date().toISOString();
  db.prepare(`UPDATE siniestros SET proveedores_aviso_pendiente_en=? WHERE id=?`).run(ahora, req.params.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:req.params.id, accion:'aviso_proveedores_pendientes', usuario:req.session.user });
  db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
    VALUES (?,?,?,?,'pendiente','automatica','proveedores_pendientes_aviso',?)`)
    .run(req.params.id, 'mensaje', 'Valuación ya autorizada, todavía en espera de que se asignen proveedores. Alejandra: informar al cliente que va en tiempo. Daniela: dar seguimiento en Impart hasta que queden asignados.', ahora.slice(0,10), req.session.user.id);
  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id));
});

// Sección 9: el "suelta" del expediente completo (ya autorizado y con proveedor) -- reemplaza el
// correo que hoy manda Roberto a todo el equipo. Avisa a Alejandra (informar al cliente que ya se
// puede programar) y a Daniela (seguimiento del pedido en Impart).
router.patch('/:id/enviar-expediente-completo', requireAuth, requireRole('admin','jefe'), (req, res)=>{
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Siniestro no encontrado.' });
  if(!['autorizada','parcial'].includes(s.estado_autorizacion)){
    return res.status(400).json({ error:'La valuación debe estar autorizada (total o parcial) antes de enviar el expediente completo.' });
  }
  if(s.expediente_completo_enviado_en){
    return res.status(400).json({ error:'El expediente completo ya se envió el ' + s.expediente_completo_enviado_en.slice(0,16).replace('T',' ') + '.' });
  }
  const ahora = new Date().toISOString();
  db.prepare(`UPDATE siniestros SET expediente_completo_enviado_en=? WHERE id=?`).run(ahora, req.params.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:req.params.id, accion:'expediente_completo_enviado', usuario:req.session.user });
  db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
    VALUES (?,?,?,?,'pendiente','automatica','expediente_completo_enviado',?)`)
    .run(req.params.id, 'mensaje', 'Expediente completo: evaluación autorizada, orden de trabajo y proveedores ya asignados. Alejandra: informar al cliente y coordinar entrada a producción. Daniela: dar seguimiento a los pedidos en Impart.', ahora.slice(0,10), req.session.user.id);
  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id));
});


// Requerimientos de Daniela — Registrar entrega de la unidad.
// Permitido a Daniela (operativo), la persona de seguimiento a clientes (atencion_cliente) y admin.
router.patch('/:id/entrega', requireAuth, requireRole('operativo','atencion_cliente','admin'), (req, res)=>{
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Siniestro no encontrado.' });
  // Sección 9 del documento maestro: "el expediente no pasa a listo para entrega hasta que todos los
  // retrabajos críticos estén cerrados."
  const retrabajosCriticos = db.prepare(`SELECT origen FROM retrabajos WHERE siniestro_id = ? AND severidad = 'critica' AND estado != 'cerrado'`).all(s.id);
  if(retrabajosCriticos.length){
    return res.status(400).json({ error:'No se puede registrar la entrega: hay retrabajos críticos sin cerrar.', detalle: retrabajosCriticos.map(r=>r.origen) });
  }
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
