const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { csvCell, csvTextForced, toLocal, verificarCorreosPendientes, archivarSiniestrosVencidos, sumarDiasHabiles } = require('../utils');
const router = express.Router();

const CERRADAS = ['Recibida físicamente','Cancelada'];

// F-05: la lista maestra parte de PEDIDOS (no de piezas), así un pedido sin piezas capturadas sigue siendo visible.
function obtenerFilasListaMaestra({ aseguradora, estatus, proveedor_id, q, incluir_archivados }){
  let sql = `SELECT p.id as pedido_id, p.numero as pedido_numero, p.estatus_operativo, p.fecha_prevista as pedido_fecha_prevista,
                    s.id as siniestro_id, s.numero as siniestro_numero, s.aseguradora, s.vehiculo, s.placas, s.archivado,
                    z.id as pieza_id, z.descripcion, z.estatus as pieza_estatus, z.fecha_prometida, z.proveedor_id,
                    pv.razon_social as proveedor_nombre
             FROM pedidos p
             JOIN siniestros s ON s.id = p.siniestro_id
             LEFT JOIN piezas z ON z.pedido_id = p.id
             LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
             WHERE 1=1`;
  const params = [];
  if(aseguradora){ sql += ' AND s.aseguradora = ?'; params.push(aseguradora); }
  if(proveedor_id){ sql += ' AND z.proveedor_id = ?'; params.push(proveedor_id); }
  if(estatus){ sql += ' AND z.estatus = ?'; params.push(estatus); }
  if(q){
    sql += ' AND (s.numero LIKE ? OR p.numero LIKE ? OR z.descripcion LIKE ? OR s.placas LIKE ? OR s.vehiculo LIKE ?)';
    const like = `%${q}%`; params.push(like,like,like,like,like);
  }
  // Requerimiento de Daniela: por default no satura la vista diaria con lo ya archivado (3+ meses entregado);
  // ?incluir_archivados=1 lo trae de vuelta para consultas de historial.
  if(incluir_archivados !== '1'){ sql += ' AND s.archivado = 0'; }
  sql += ' ORDER BY z.fecha_prometida IS NULL, z.fecha_prometida ASC';
  return db.prepare(sql).all(...params);
}

router.get('/lista-maestra', requireAuth, (req, res)=>{
  archivarSiniestrosVencidos(db);
  res.json(obtenerFilasListaMaestra(req.query));
});

// F-16 + F-17: exporta EXACTAMENTE lo que se ve filtrado (incluida la búsqueda de texto) y neutraliza fórmulas/inyección CSV.
router.get('/lista-maestra.csv', requireAuth, (req, res)=>{
  const filas = obtenerFilasListaMaestra(req.query);
  const header = ['Siniestro','Aseguradora','Pedido','Proveedor','Pieza','Estatus','Fecha prometida'];
  const lines = [header.map(csvCell).join(',')];
  filas.forEach(f=>{
    lines.push([
      csvTextForced(f.siniestro_numero),
      csvCell(f.aseguradora),
      csvTextForced(f.pedido_numero),
      csvCell(f.proveedor_nombre || ''),
      csvCell(f.descripcion || 'Pendiente de capturar piezas'),
      csvCell(f.pieza_estatus || 'Sin piezas'),
      csvCell(f.fecha_prometida || '')
    ].join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lista_maestra_refacciones.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// Exporta el listado base de expedientes (siniestros), incluidos los que todavía no tienen ningún
// pedido capturado — la lista maestra de pedidos no los muestra porque parte de un JOIN desde pedidos.
router.get('/siniestros.csv', requireAuth, (req, res)=>{
  archivarSiniestrosVencidos(db);
  const { aseguradora, q, archivado } = req.query;
  let sql = 'SELECT * FROM siniestros WHERE 1=1';
  const params = [];
  if(aseguradora){ sql += ' AND aseguradora = ?'; params.push(aseguradora); }
  if(q){ sql += ' AND (numero LIKE ? OR placas LIKE ? OR vehiculo LIKE ?)'; const like = `%${q}%`; params.push(like,like,like); }
  if(archivado === '1'){ sql += ' AND archivado = 1'; }
  else if(archivado !== 'all'){ sql += ' AND archivado = 0'; }
  sql += ' ORDER BY creado_en DESC';
  const filas = db.prepare(sql).all(...params);
  const header = ['Siniestro','Aseguradora','Vehiculo','Anio','Placas','VIN','Fecha ingreso','Responsable','Cliente','Telefono','Correo','Requiere refacciones','Completo','Archivado'];
  const lines = [header.map(csvCell).join(',')];
  filas.forEach(f=>{
    lines.push([
      csvTextForced(f.numero), csvCell(f.aseguradora), csvCell(f.vehiculo||''), csvCell(f.anio_modelo||''),
      csvTextForced(f.placas||''), csvTextForced(f.vin||''), csvCell(f.fecha_ingreso||''), csvCell(f.responsable||''),
      csvCell(f.cliente_nombre||''), csvTextForced(f.cliente_telefono||''), csvCell(f.cliente_correo||''),
      csvCell(f.requiere_refacciones||''), csvCell(f.completo?'Si':'No'), csvCell(f.archivado?'Si':'No')
    ].join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="expedientes_siniestros.csv"');
  res.send('\ufeff' + lines.join('\r\n'));
});

router.get('/resumen', requireAuth, (req, res)=>{
  verificarCorreosPendientes(db);
  archivarSiniestrosVencidos(db);
  const hoy = new Date().toISOString().slice(0,10);
  const pedidosNuevos = db.prepare(`SELECT COUNT(*) n FROM pedidos WHERE estatus_operativo='Nuevo'`).get().n;
  const piezasVencidas = db.prepare(`SELECT COUNT(*) n FROM piezas WHERE estatus NOT IN ('Recibida físicamente','Cancelada') AND fecha_prometida != '' AND fecha_prometida < ?`).get(hoy).n;
  const sinProveedor = db.prepare(`SELECT COUNT(*) n FROM piezas WHERE estatus='Sin proveedor'`).get().n;
  const recibidosParciales = db.prepare(`SELECT COUNT(*) n FROM pedidos WHERE estatus_operativo='Recibido parcial'`).get().n;
  // Requerimiento de Daniela: ahora refleja la bandeja real de correos preparados en espera de su aprobación.
  const correosPendientes = db.prepare(`SELECT COUNT(*) n FROM comunicaciones WHERE estado='pendiente_aprobacion'`).get().n;
  const cierresHoy = db.prepare(`SELECT COUNT(*) n FROM piezas WHERE fecha_recepcion LIKE ?`).get(hoy+'%').n;
  const incidenciasAbiertas = db.prepare(`SELECT COUNT(*) n FROM incidencias WHERE estado IN ('abierta','en_proceso')`).get().n;
  const pendientesCompletar = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE completo = 0`).get().n;
  const expedientesEnSeguimiento = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado = 0 AND estatus_general != 'Cerrado'`).get().n;
  const porAseguradora = db.prepare(`SELECT s.aseguradora, COUNT(DISTINCT p.id) abiertos FROM pedidos p JOIN siniestros s ON s.id=p.siniestro_id WHERE p.estatus_operativo NOT IN ('Cerrado') GROUP BY s.aseguradora`).all();

  // Requerimiento de Roberto: el resumen diario solo hablaba de refacciones — agregar el lado de
  // atención y seguimiento a clientes (módulo de Alejandra), para que también se vea de un vistazo.
  const tareasPendientes = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE estado IN ('pendiente','en_proceso')`).get().n;
  const tareasVencidas = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE estado IN ('pendiente','en_proceso') AND fecha_limite != '' AND fecha_limite < ?`).get(hoy).n;
  const mensajesIaPendientes = db.prepare(`SELECT COUNT(*) n FROM mensajes_ia WHERE estado = 'generado'`).get().n;
  const hitosListosSinEnviar = db.prepare(`SELECT COUNT(*) n FROM siniestro_hitos WHERE estado = 'generado'`).get().n;
  // Expedientes con más de 3 días sin ninguna comunicación registrada con el cliente (mismo umbral
  // que ya usa la bandeja de Clientes de Alejandra para "días sin actualización").
  const expedientesSinActualizar = db.prepare(`
    SELECT COUNT(*) n FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado' AND s.requiere_refacciones != 'no'
      AND julianday('now') - julianday(COALESCE(
        (SELECT MAX(creado_en) FROM eventos_cliente WHERE siniestro_id = s.id), s.creado_en
      )) > 3
  `).get().n;

  // Propuesta Orlando/Vanessa fusionados: panorama único que cubre revisión de daños + captura, para
  // que Orlando pueda operar ambas partes sin cambiar de usuario (Vanessa sigue activa mientras esté).
  const ovPendientesRevision = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND estado_revision_tecnica IS NULL`).get().n;
  const ovEnRevision = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND estado_revision_tecnica='en_revision'`).get().n;
  const ovEsperandoDesarme = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND estado_revision_tecnica='requiere_desarme'`).get().n;
  const ovComplementosPendientes = db.prepare(`SELECT COUNT(*) n FROM complementos WHERE decision='pendiente'`).get().n;
  const ovBorradoresPorCapturar = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND estado_revision_tecnica='revision_terminada' AND excel_capturado=0`).get().n;
  const ovFotosPorCompletar = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND excel_capturado=1 AND fotos_completas=0`).get().n;
  const ovListosParaEnviar = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND fotos_completas=1 AND enviado_propietario=0`).get().n;

  // Propuesta: panorama de Beto (6 tarjetas, pensado para celular con el mínimo de texto/toques).
  const betoReingresosSinRecibir = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND cita_fecha IS NOT NULL AND cita_fecha != '' AND cita_fecha < ? AND (fecha_admision IS NULL OR fecha_admision='')`).get(hoy).n;
  const manana = new Date(Date.now()+86400000).toISOString().slice(0,10);
  const betoPorVencer = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND fecha_entrega_prevista IN (?,?) AND (estado_produccion IS NULL OR estado_produccion != 'terminado')`).get(hoy, manana).n;
  const betoListasParaIniciar = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND (estado_produccion IS NULL OR estado_produccion='programado') AND estado_autorizacion IN ('autorizada','parcial')`).get().n;
  const haceSieteDias = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
  const betoOtRapidasSinAsignar = db.prepare(`
    SELECT COUNT(*) n FROM ordenes_trabajo ot WHERE ot.creado_en >= ?
      AND (SELECT COUNT(*) FROM ot_operaciones o WHERE o.ot_id = ot.id) <= 2
      AND NOT EXISTS (SELECT 1 FROM ot_operaciones o WHERE o.ot_id = ot.id AND o.estado != 'programado')
  `).get(haceSieteDias).n;
  const betoEnProcesoDesglose = db.prepare(`SELECT COALESCE(estado_produccion,'sin_iniciar') estado, COUNT(*) n FROM siniestros WHERE archivado=0 AND (estado_produccion IS NULL OR estado_produccion != 'terminado') AND estado_autorizacion IN ('autorizada','parcial') GROUP BY estado`).all();
  const betoVencidas = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND fecha_entrega_prevista != '' AND fecha_entrega_prevista IS NOT NULL AND fecha_entrega_prevista < ? AND (estado_produccion IS NULL OR estado_produccion != 'terminado')`).get(hoy).n;

  // Propuesta: 4 contadores nuevos para el panorama de Daniela (los otros 6 ya existían: pedidosNuevos,
  // piezasVencidas, sinProveedor, recibidosParciales, incidenciasAbiertas y cierresHoy = "recibidas hoy").
  const piezasPorConfirmar = db.prepare(`SELECT COUNT(*) n FROM piezas WHERE estatus='Asignada'`).get().n;
  const piezasMalSurtidas = db.prepare(`SELECT COUNT(*) n FROM incidencias WHERE tipo IN ('incorrecta','incompleta') AND estado IN ('abierta','en_proceso')`).get().n;
  const piezasEnDevolucion = db.prepare(`SELECT COUNT(*) n FROM piezas WHERE estatus='Devuelta'`).get().n;

  // Propuesta: contadores de Alejandra. "Por avisar autorización" y "refacciones por avisar" reutilizan
  // el mismo patrón de tareas automáticas ya existente (refacciones_completas) en vez de inventar un
  // mecanismo de seguimiento nuevo — es la forma en que ya se le notifica una tarea pendiente a Alejandra.
  const citasHoy = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND cita_fecha=?`).get(hoy).n;
  const entregasProgramadas = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND estado_entrega='cita_confirmada'`).get().n;
  const porAvisarAutorizacion = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE disparador='autorizacion_resuelta' AND estado IN ('pendiente','en_proceso')`).get().n;
  const refaccionesPorAvisar = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE disparador='refacciones_completas' AND estado IN ('pendiente','en_proceso')`).get().n;

  res.json({ pedidosNuevos, piezasVencidas, sinProveedor, recibidosParciales, correosPendientes, cierresHoy, incidenciasAbiertas, pendientesCompletar, expedientesEnSeguimiento, porAseguradora,
    tareasPendientes, tareasVencidas, mensajesIaPendientes, hitosListosSinEnviar, expedientesSinActualizar,
    ovPendientesRevision, ovEnRevision, ovEsperandoDesarme, ovComplementosPendientes, ovBorradoresPorCapturar, ovFotosPorCompletar, ovListosParaEnviar,
    betoReingresosSinRecibir, betoPorVencer, betoListasParaIniciar, betoOtRapidasSinAsignar, betoEnProcesoDesglose, betoVencidas,
    piezasPorConfirmar, piezasMalSurtidas, piezasEnDevolucion,
    citasHoy, entregasProgramadas, porAvisarAutorizacion, refaccionesPorAvisar });
});

// F-20: la búsqueda global regresa una LISTA de coincidencias agrupadas, no abre automáticamente la primera.
router.get('/buscar', requireAuth, (req, res)=>{
  const q = String(req.query.q||'').trim();
  if(!q) return res.json({ siniestros:[], pedidos:[], proveedores:[] });
  const like = `%${q}%`;
  const siniestros = db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas FROM siniestros WHERE numero LIKE ? OR placas LIKE ? OR vehiculo LIKE ? LIMIT 20`).all(like,like,like);
  const pedidos = db.prepare(`SELECT p.id, p.numero, s.numero as siniestro_numero, s.id as siniestro_id FROM pedidos p JOIN siniestros s ON s.id=p.siniestro_id WHERE p.numero LIKE ? LIMIT 20`).all(like);
  const proveedores = db.prepare(`SELECT id, razon_social, correo FROM proveedores WHERE razon_social LIKE ? LIMIT 20`).all(like);
  res.json({ siniestros, pedidos, proveedores, tipoDetectado: /^018.*A$/i.test(q) ? 'siniestro (regla R-02)' : 'pedido/otro' });
});


// Vista enriquecida para el Kanban: todos los pedidos (F-03: ningún estatus se excluye) con resumen de piezas.
router.get('/kanban', requireAuth, (req, res)=>{
  archivarSiniestrosVencidos(db);
  const pedidos = db.prepare(`SELECT p.*, s.numero as siniestro_numero, s.aseguradora, s.vehiculo, s.id as siniestro_id
                               FROM pedidos p JOIN siniestros s ON s.id = p.siniestro_id WHERE s.archivado = 0 ORDER BY p.creado_en DESC`).all();
  const hoy = new Date().toISOString().slice(0,10);
  const out = pedidos.map(p=>{
    const piezas = db.prepare('SELECT z.*, pv.razon_social as proveedor_nombre FROM piezas z LEFT JOIN proveedores pv ON pv.id = z.proveedor_id WHERE z.pedido_id = ?').all(p.id);
    const pendientes = piezas.filter(z => !CERRADAS.includes(z.estatus));
    const vencidas = pendientes.filter(z => z.fecha_prometida && z.fecha_prometida < hoy);
    const proveedores = [...new Set(piezas.map(z=>z.proveedor_nombre).filter(Boolean))];
    const incidenciasAbiertas = db.prepare(`SELECT COUNT(*) n FROM incidencias i JOIN piezas z ON z.id=i.pieza_id WHERE z.pedido_id=? AND i.estado IN ('abierta','en_proceso')`).get(p.id).n;
    return { ...p, totalPiezas: piezas.length, pendientes: pendientes.length, vencidas: vencidas.length, proveedores, incidenciasAbiertas };
  });
  res.json(out);
});

// Módulo Alejandra (Fase 2): bandeja de "Clientes" con indicadores de seguimiento por expediente.
router.get('/bandeja-clientes', requireAuth, (req, res)=>{
  const siniestros = db.prepare('SELECT * FROM siniestros ORDER BY creado_en DESC').all();
  const hoyMs = Date.now();
  const out = siniestros.map(s=>{
    const ultimoEvento = db.prepare('SELECT creado_en FROM eventos_cliente WHERE siniestro_id=? ORDER BY creado_en DESC LIMIT 1').get(s.id);
    const referencia = ultimoEvento ? ultimoEvento.creado_en : s.creado_en;
    const diasSinActualizacion = referencia ? Math.floor((hoyMs - new Date(referencia.replace(' ','T')+'Z').getTime()) / 86400000) : null;
    const tareasPendientes = db.prepare("SELECT COUNT(*) n FROM tareas WHERE siniestro_id=? AND estado IN ('pendiente','en_proceso')").get(s.id).n;
    const hoy = new Date().toISOString().slice(0,10);
    const tareasVencidas = db.prepare("SELECT COUNT(*) n FROM tareas WHERE siniestro_id=? AND estado IN ('pendiente','en_proceso') AND fecha_limite != '' AND fecha_limite < ?").get(s.id, hoy).n;
    return { ...s, dias_sin_actualizacion: diasSinActualizacion, tareas_pendientes: tareasPendientes, tareas_vencidas: tareasVencidas };
  });
  res.json(out);
});


// Documento Maestro / Fase B — bandeja de revisión técnica de Orlando: expedientes admitidos que
// todavía no tienen revisión terminada, con el conteo de hallazgos ya capturados y el flag de riesgo.
router.get('/bandeja-tecnica', requireAuth, (req, res)=>{
  const siniestros = db.prepare(`SELECT * FROM siniestros WHERE archivado = 0
    AND (estado_revision_tecnica IS NULL OR estado_revision_tecnica != 'revision_terminada')
    ORDER BY creado_en DESC`).all();
  const out = siniestros.map(s=>{
    const hallazgos = db.prepare('SELECT COUNT(*) n FROM danos_evidencia WHERE siniestro_id=?').get(s.id).n;
    const ocultos = db.prepare("SELECT COUNT(*) n FROM danos_evidencia WHERE siniestro_id=? AND visibilidad='oculto'").get(s.id).n;
    return { ...s, hallazgos, hallazgos_ocultos: ocultos };
  });
  res.json(out);
});


// Documento Maestro / Fase C — bandeja de armado de expediente de Vanessa: expedientes admitidos que
// todavía no están listos para valuación, con el conteo de documentos por estado.
router.get('/bandeja-expediente', requireAuth, (req, res)=>{
  const siniestros = db.prepare(`SELECT * FROM siniestros WHERE archivado = 0
    AND (estado_expediente IS NULL OR estado_expediente != 'listo_para_valuacion')
    ORDER BY creado_en DESC`).all();
  const out = siniestros.map(s=>{
    const total = db.prepare('SELECT COUNT(*) n FROM documentos_expediente WHERE siniestro_id=?').get(s.id).n;
    const faltantes = db.prepare("SELECT COUNT(*) n FROM documentos_expediente WHERE siniestro_id=? AND estado IN ('faltante','no_legible')").get(s.id).n;
    return { ...s, documentos_total: total, documentos_faltantes: faltantes };
  });
  res.json(out);
});


// Documento Maestro / Fase D — bandeja de valuación/autorización: expedientes cuyo checklist documental
// ya está listo (Fase C) y que todavía no tienen una autorización total o rechazo definitivo.
router.get('/bandeja-valuacion', requireAuth, (req, res)=>{
  const siniestros = db.prepare(`SELECT * FROM siniestros WHERE archivado = 0 AND estado_expediente = 'listo_para_valuacion'
    AND (estado_autorizacion IS NULL OR estado_autorizacion NOT IN ('autorizada','rechazada'))
    ORDER BY creado_en DESC`).all();
  // Pendiente de confirmación resuelto por Roberto (24-ago-2026): 3 días hábiles sin respuesta de la
  // aseguradora, igual para las 8, dispara la alerta "sin respuesta" de la tabla 4 del documento maestro.
  // Es una alerta informativa (badge), no bloquea nada ni cambia el estado por sí sola.
  const hoy = new Date().toISOString().slice(0,10);
  const out = siniestros.map(s=>{
    let autorizacionVencida = false;
    if(s.autorizacion_fecha_envio && (!s.estado_autorizacion || ['en_autorizacion','por_aclarar'].includes(s.estado_autorizacion))){
      const vencimiento = sumarDiasHabiles(s.autorizacion_fecha_envio, 3);
      autorizacionVencida = hoy > vencimiento;
    }
    return { ...s, autorizacion_vencida: autorizacionVencida };
  });
  res.json(out);
});


// Documento Maestro / Fase E — bandeja de producción de Beto: expedientes autorizados que todavía no
// tienen estado_produccion='terminado', con el conteo de operaciones bloqueadas y retrabajos abiertos.
router.get('/bandeja-produccion', requireAuth, (req, res)=>{
  const siniestros = db.prepare(`SELECT * FROM siniestros WHERE archivado = 0
    AND estado_autorizacion IN ('autorizada','parcial')
    AND (estado_produccion IS NULL OR estado_produccion != 'terminado')
    ORDER BY creado_en DESC`).all();
  const out = siniestros.map(s=>{
    const bloqueadas = db.prepare(`SELECT COUNT(*) n FROM ot_operaciones op
      JOIN ordenes_trabajo ot ON ot.id = op.ot_id WHERE ot.siniestro_id = ? AND op.estado = 'detenido'`).get(s.id).n;
    const retrabajosAbiertos = db.prepare(`SELECT COUNT(*) n FROM retrabajos WHERE siniestro_id = ? AND estado != 'cerrado'`).get(s.id).n;
    const complementosPendientes = db.prepare(`SELECT COUNT(*) n FROM complementos WHERE siniestro_id = ? AND decision = 'pendiente'`).get(s.id).n;
    return { ...s, operaciones_bloqueadas: bloqueadas, retrabajos_abiertos: retrabajosAbiertos, complementos_pendientes: complementosPendientes };
  });
  res.json(out);
});


// Documento Maestro / Fase F — bandeja de calidad/entrega: expedientes con producción terminada que
// todavía no tienen calidad liberada, o liberados que aún no se han entregado.
router.get('/bandeja-calidad', requireAuth, (req, res)=>{
  const siniestros = db.prepare(`SELECT * FROM siniestros WHERE archivado = 0 AND estado_produccion = 'terminado'
    AND (estado_calidad IS NULL OR estado_calidad != 'liberado' OR fecha_entrega_real IS NULL OR fecha_entrega_real = '')
    ORDER BY creado_en DESC`).all();
  const out = siniestros.map(s=>{
    const rechazados = db.prepare(`SELECT COUNT(*) n FROM checklist_calidad WHERE siniestro_id=? AND resultado='rechazado'`).get(s.id).n;
    const retrabajosCriticos = db.prepare(`SELECT COUNT(*) n FROM retrabajos WHERE siniestro_id=? AND severidad='critica' AND estado != 'cerrado'`).get(s.id).n;
    return { ...s, checklist_rechazados: rechazados, retrabajos_criticos: retrabajosCriticos };
  });
  res.json(out);
});


// Propuesta: orden sugerido de trabajo para Beto (sección 4) — se calcula solo con datos que ya existen
// (fecha promesa, fecha de asignación de OT, refacciones completas); Beto no captura nada adicional.
router.get('/panorama-beto', requireAuth, (req, res)=>{
  const hoy = new Date().toISOString().slice(0,10);
  const manana = new Date(Date.now()+86400000).toISOString().slice(0,10);
  const siniestros = db.prepare(`SELECT * FROM siniestros WHERE archivado=0 AND estado_autorizacion IN ('autorizada','parcial')
    AND (estado_produccion IS NULL OR estado_produccion != 'terminado') ORDER BY creado_en DESC`).all();

  const out = siniestros.map(s=>{
    const ots = db.prepare(`SELECT * FROM ordenes_trabajo WHERE siniestro_id = ? ORDER BY creado_en DESC`).all(s.id);
    const otMasReciente = ots[0] || null;
    let otRapidaSinTocar = false;
    if(otMasReciente){
      const ops = db.prepare(`SELECT estado FROM ot_operaciones WHERE ot_id = ?`).all(otMasReciente.id);
      otRapidaSinTocar = ops.length > 0 && ops.length <= 2 && ops.every(o => o.estado === 'programado');
    }
    const pedidos = db.prepare(`SELECT id FROM pedidos WHERE siniestro_id = ?`).all(s.id);
    let refaccionesCompletas = s.requiere_refacciones !== 'si';
    if(!refaccionesCompletas && pedidos.length){
      refaccionesCompletas = pedidos.every(p=>{
        const piezas = db.prepare(`SELECT estatus FROM piezas WHERE pedido_id = ?`).all(p.id);
        return piezas.length > 0 && piezas.every(z => z.estatus === 'Recibida físicamente');
      });
    }
    const enPiso = !s.estado_produccion || s.estado_produccion === 'programado';
    const vencidaOProxima = s.fecha_entrega_prevista && (s.fecha_entrega_prevista <= manana);

    let prioridad = 4, motivo = 'En proceso normal, dentro de fecha.';
    if(vencidaOProxima){ prioridad = 1; motivo = s.fecha_entrega_prevista < hoy ? 'Vencida.' : 'Vence hoy o mañana.'; }
    else if(otRapidaSinTocar){ prioridad = 2; motivo = 'Reparación rápida recién asignable, sin tocar.'; }
    else if(enPiso && refaccionesCompletas){ prioridad = 3; motivo = 'Lista para iniciar: refacciones completas.'; }

    return { id:s.id, numero:s.numero, vehiculo:s.vehiculo, placas:s.placas, aseguradora:s.aseguradora,
      fecha_entrega_prevista:s.fecha_entrega_prevista, estado_produccion:s.estado_produccion,
      ot_numero: otMasReciente ? otMasReciente.numero : null, prioridad, motivo };
  });

  out.sort((a,b)=> a.prioridad - b.prioridad || (a.fecha_entrega_prevista||'9999').localeCompare(b.fecha_entrega_prevista||'9999'));
  res.json(out);
});

module.exports = router;
