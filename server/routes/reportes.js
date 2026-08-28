const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { csvCell, csvTextForced, toLocal, verificarCorreosPendientes, archivarSiniestrosVencidos, sumarDiasHabiles, VENTANA_OPERATIVA_DESDE, aplicaVentanaOperativa, limiteRevisionGrua, esquemaSurtidoLabel, porcentajePiezasRecibidas } = require('../utils');
const router = express.Router();

const CERRADAS = ['Recibida físicamente','Cancelada'];

// F-05: la lista maestra parte de PEDIDOS (no de piezas), así un pedido sin piezas capturadas sigue siendo visible.
function obtenerFilasListaMaestra({ aseguradora, estatus, proveedor_id, q, incluir_archivados, ventana, orden }){
  let sql = `SELECT p.id as pedido_id, p.numero as pedido_numero, p.estatus_operativo, p.fecha_prevista as pedido_fecha_prevista,
                    s.id as siniestro_id, s.numero as siniestro_numero, s.aseguradora, s.vehiculo, s.placas, s.archivado,
                    s.aseguradora_ruta_refacciones,
                    z.id as pieza_id, z.descripcion, z.estatus as pieza_estatus, z.fecha_prometida, z.proveedor_id,
                    pv.razon_social as proveedor_nombre
             FROM pedidos p
             JOIN siniestros s ON s.id = p.siniestro_id
             LEFT JOIN piezas z ON z.pedido_id = p.id
             LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
             WHERE 1=1`;
  const params = [];
  // Ventana operativa (27-ago-2026): por default la lista maestra solo muestra pedidos desde el 1 de
  // junio de 2026 (la operación real del taller); ?ventana=todas regresa el historial completo.
  if(aplicaVentanaOperativa({ ventana })){ sql += ' AND p.fecha_creacion >= ?'; params.push(VENTANA_OPERATIVA_DESDE); }
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
  // Hallazgo A-01 (Informe_funcional_tablero_refacciones_para_Claude.docx): por default, lo más reciente
  // arriba (fecha de creación del pedido descendente) -- antes ordenaba por fecha prometida y dejaba los
  // pedidos recién creados hasta el final. ?orden=prometida conserva el criterio anterior para quien lo
  // prefiera, sin cambiar el orden predeterminado del resto del equipo.
  sql += orden === 'prometida' ? ' ORDER BY z.fecha_prometida IS NULL, z.fecha_prometida ASC' : ' ORDER BY p.fecha_creacion DESC, p.id DESC';
  // Modificación (Modificaciones_Tablero_SC_Control.docx, sección 2): "Esquema de surtido" visible en la
  // lista maestra de Daniela, para que el seguimiento correcto se aplique según la aseguradora en vez de
  // asumir Impart para todos. Traduce la ruta ya calculada (aseguradora_ruta_refacciones) a texto claro.
  return db.prepare(sql).all(...params).map(f => ({ ...f, esquema_surtido: esquemaSurtidoLabel(f.aseguradora_ruta_refacciones, f.aseguradora) }));
}

router.get('/lista-maestra', requireAuth, (req, res)=>{
  archivarSiniestrosVencidos(db);
  // Hallazgo M-03 (Informe Daniela): la lista maestra puede tener cientos/miles de filas -- se pagina en
  // el JSON de pantalla, pero el .csv sigue exportando TODO lo filtrado (sin paginar), como siempre.
  const todas = obtenerFilasListaMaestra(req.query);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const inicio = (page - 1) * pageSize;
  res.json({ total: todas.length, page, pageSize, filas: todas.slice(inicio, inicio + pageSize) });
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
  // Ventana operativa (27-ago-2026): ?ventana=todas regresa los contadores sin el corte del 1-jun-2026.
  const desdeVentanaResumen = aplicaVentanaOperativa(req.query) ? VENTANA_OPERATIVA_DESDE : '0001-01-01';
  const pedidosNuevos = db.prepare(`SELECT COUNT(*) n FROM pedidos WHERE estatus_operativo='Nuevo' AND fecha_creacion >= ?`).get(desdeVentanaResumen).n;
  const piezasVencidas = db.prepare(`SELECT COUNT(*) n FROM piezas z JOIN pedidos p ON p.id=z.pedido_id WHERE z.estatus NOT IN ('Recibida físicamente','Cancelada') AND z.fecha_prometida != '' AND z.fecha_prometida < ? AND p.fecha_creacion >= ?`).get(hoy, desdeVentanaResumen).n;
  const sinProveedor = db.prepare(`SELECT COUNT(*) n FROM piezas z JOIN pedidos p ON p.id=z.pedido_id WHERE z.estatus='Sin proveedor' AND p.fecha_creacion >= ?`).get(desdeVentanaResumen).n;
  // Triage documento de Daniela (DEF-016): "sinProveedor" solo contaba piezas ya capturadas sin proveedor,
  // pero un pedido sin NINGUNA pieza capturada todavía es un vacío más grande y no aparecía en ningún lado.
  const pedidosSinPiezas = db.prepare(`SELECT COUNT(*) n FROM pedidos p WHERE p.estatus_operativo NOT IN ('Cancelado','Cerrado') AND p.fecha_creacion >= ? AND NOT EXISTS (SELECT 1 FROM piezas z WHERE z.pedido_id = p.id)`).get(desdeVentanaResumen).n;
  const recibidosParciales = db.prepare(`SELECT COUNT(*) n FROM pedidos WHERE estatus_operativo='Recibido parcial' AND fecha_creacion >= ?`).get(desdeVentanaResumen).n;
  // Requerimiento de Daniela: ahora refleja la bandeja real de correos preparados en espera de su aprobación.
  const correosPendientes = db.prepare(`SELECT COUNT(*) n FROM comunicaciones c JOIN pedidos p ON p.id=c.pedido_id WHERE c.estado='pendiente_aprobacion' AND p.fecha_creacion >= ?`).get(desdeVentanaResumen).n;
  const cierresHoy = db.prepare(`SELECT COUNT(*) n FROM piezas z JOIN pedidos p ON p.id=z.pedido_id WHERE z.fecha_recepcion LIKE ? AND p.fecha_creacion >= ?`).get(hoy+'%', desdeVentanaResumen).n;
  const incidenciasAbiertas = db.prepare(`SELECT COUNT(*) n FROM incidencias i JOIN piezas z ON z.id=i.pieza_id JOIN pedidos p ON p.id=z.pedido_id WHERE i.estado IN ('abierta','en_proceso') AND p.fecha_creacion >= ?`).get(desdeVentanaResumen).n;
  const pendientesCompletar = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE completo = 0`).get().n;
  const expedientesEnSeguimiento = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado = 0 AND estatus_general != 'Cerrado'`).get().n;
  const porAseguradora = db.prepare(`SELECT s.aseguradora, COUNT(DISTINCT p.id) abiertos FROM pedidos p JOIN siniestros s ON s.id=p.siniestro_id WHERE p.estatus_operativo NOT IN ('Cerrado') AND p.fecha_creacion >= ? GROUP BY s.aseguradora`).all(desdeVentanaResumen);

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
  const piezasPorConfirmar = db.prepare(`SELECT COUNT(*) n FROM piezas z JOIN pedidos p ON p.id=z.pedido_id WHERE z.estatus='Asignada' AND p.fecha_creacion >= ?`).get(desdeVentanaResumen).n;
  const piezasMalSurtidas = db.prepare(`SELECT COUNT(*) n FROM incidencias i JOIN piezas z ON z.id=i.pieza_id JOIN pedidos p ON p.id=z.pedido_id WHERE i.tipo IN ('incorrecta','incompleta') AND i.estado IN ('abierta','en_proceso') AND p.fecha_creacion >= ?`).get(desdeVentanaResumen).n;
  const piezasEnDevolucion = db.prepare(`SELECT COUNT(*) n FROM piezas z JOIN pedidos p ON p.id=z.pedido_id WHERE z.estatus='Devuelta' AND p.fecha_creacion >= ?`).get(desdeVentanaResumen).n;

  // Propuesta: contadores de Alejandra. "Por avisar autorización" y "refacciones por avisar" reutilizan
  // el mismo patrón de tareas automáticas ya existente (refacciones_completas) en vez de inventar un
  // mecanismo de seguimiento nuevo — es la forma en que ya se le notifica una tarea pendiente a Alejandra.
  const citasHoy = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND cita_fecha=?`).get(hoy).n;
  const entregasProgramadas = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND estado_entrega='cita_confirmada'`).get().n;
  const porAvisarAutorizacion = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE disparador='autorizacion_resuelta' AND estado IN ('pendiente','en_proceso')`).get().n;
  const refaccionesPorAvisar = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE disparador='refacciones_completas' AND estado IN ('pendiente','en_proceso')`).get().n;

  // Modificaciones 2 y 3 (Modificaciones_Tablero_SC_Control.docx): igual que el resto de indicadores,
  // conteos simples de lo que necesita revisión periódica -- discrepancias con proveedores sin resolver
  // y vales pendientes de surtir que todavía no se le han dado seguimiento al cliente.
  const discrepanciasAbiertas = db.prepare(`SELECT COUNT(*) n FROM discrepancias_proveedor WHERE estado='abierta'`).get().n;
  const valesPendientesSinSurtir = db.prepare(`SELECT COUNT(*) n FROM vales_pendientes WHERE estado='pendiente'`).get().n;

  // Hallazgo M-04 (Informe Daniela): cuántos borradores automáticos quedaron sin destinatario válido y
  // necesitan que alguien los complete a mano antes de poder aprobarse -- antes esto se perdía entre los
  // demás correos pendientes; ahora tiene su propio contador con acceso directo a la cola ya filtrada.
  const correosIncompletos = db.prepare(`SELECT COUNT(*) n FROM comunicaciones c JOIN pedidos p ON p.id=c.pedido_id WHERE c.estado='pendiente_aprobacion' AND c.incompleto=1 AND p.fecha_creacion >= ?`).get(desdeVentanaResumen).n;

  // Proceso_Completo_Servicio_Cristian.docx (sección 7): solicitudes de reautorización por piezas no
  // autorizadas cuyo plazo de 24h ya venció sin resolverse -- son las que más riesgo tienen de que
  // Roberto pierda la ventana para pedirle al valuador que reconsidere.
  const complementosReautorizacionVencidos = db.prepare(`SELECT COUNT(*) n FROM complementos WHERE tipo='no_autorizado_inicial' AND decision='pendiente' AND fecha_limite < ?`).get(new Date().toISOString()).n;

  // Proceso_Completo_Servicio_Cristian.docx (secciones 5, 7, 8, 9): panorama propio de Roberto -- lo
  // que hoy hace por correo/Excel/CG y que quiere ver reflejado aquí: cuántos expedientes tiene listos
  // para valuar, cuántos están esperando respuesta de la evaluación remota, cuántos complementos siguen
  // abiertos, y a cuántos ya autorizados les falta avisar de proveedores o soltar el expediente completo.
  const rbListosParaValuar = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND estado_expediente='listo_para_valuacion' AND (valuacion_fecha_envio IS NULL OR valuacion_fecha_envio='')`).get().n;
  const rbEnEsperaEvaluacion = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND valuacion_fecha_envio IS NOT NULL AND valuacion_fecha_envio != '' AND estado_autorizacion NOT IN ('autorizada','parcial','rechazada')`).get().n;
  const rbComplementosAbiertos = db.prepare(`SELECT COUNT(*) n FROM complementos WHERE tipo='no_autorizado_inicial' AND decision='pendiente'`).get().n;
  const rbFaltaAvisoProveedores = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE archivado=0 AND estado_autorizacion IN ('autorizada','parcial') AND (proveedores_aviso_pendiente_en IS NULL OR proveedores_aviso_pendiente_en='') AND (expediente_completo_enviado_en IS NULL OR expediente_completo_enviado_en='')`).get().n;
  const rbListosExpedienteCompleto = db.prepare(`
    SELECT COUNT(*) n FROM siniestros s
    WHERE s.archivado=0 AND s.estado_autorizacion IN ('autorizada','parcial')
      AND (s.expediente_completo_enviado_en IS NULL OR s.expediente_completo_enviado_en='')
      AND NOT EXISTS (SELECT 1 FROM piezas z JOIN pedidos p ON p.id=z.pedido_id WHERE p.siniestro_id=s.id AND z.estatus='Sin proveedor')
  `).get().n;
  const rbTiempoPromedioValuarDias = db.prepare(`
    SELECT ROUND(AVG(julianday(valuacion_fecha_envio) - julianday(expediente_listo_fecha)),1) prom FROM siniestros
    WHERE expediente_listo_fecha IS NOT NULL AND expediente_listo_fecha != '' AND valuacion_fecha_envio IS NOT NULL AND valuacion_fecha_envio != ''
  `).get().prom;
  const rbTiempoPromedioComplementoOrlandoDias = db.prepare(`
    SELECT ROUND(AVG(julianday(decision_en) - julianday(creado_en)),1) prom FROM complementos
    WHERE tipo='no_autorizado_inicial' AND decision_en IS NOT NULL AND decision_en != ''
  `).get().prom;

  res.json({ pedidosNuevos, piezasVencidas, sinProveedor, pedidosSinPiezas, recibidosParciales, correosPendientes, cierresHoy, incidenciasAbiertas, pendientesCompletar, expedientesEnSeguimiento, porAseguradora,
    tareasPendientes, tareasVencidas, mensajesIaPendientes, hitosListosSinEnviar, expedientesSinActualizar,
    ovPendientesRevision, ovEnRevision, ovEsperandoDesarme, ovComplementosPendientes, ovBorradoresPorCapturar, ovFotosPorCompletar, ovListosParaEnviar,
    betoReingresosSinRecibir, betoPorVencer, betoListasParaIniciar, betoOtRapidasSinAsignar, betoEnProcesoDesglose, betoVencidas,
    piezasPorConfirmar, piezasMalSurtidas, piezasEnDevolucion,
    citasHoy, entregasProgramadas, porAvisarAutorizacion, refaccionesPorAvisar,
    discrepanciasAbiertas, valesPendientesSinSurtir, correosIncompletos, complementosReautorizacionVencidos,
    rbListosParaValuar, rbEnEsperaEvaluacion, rbComplementosAbiertos, rbFaltaAvisoProveedores, rbListosExpedienteCompleto, rbTiempoPromedioValuarDias, rbTiempoPromedioComplementoOrlandoDias });
});

// F-20: la búsqueda global regresa una LISTA de coincidencias agrupadas, no abre automáticamente la primera.
router.get('/buscar', requireAuth, (req, res)=>{
  const q = String(req.query.q||'').trim();
  if(!q) return res.json({ siniestros:[], pedidos:[], proveedores:[], piezas:[] });
  const like = `%${q}%`;
  // Propuesta Orlando/Vanessa/Beto: Beto necesita poder localizar el siniestro (y su OT adjunta) buscando por VIN, no solo numero/placas.
  const siniestros = db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas, vin FROM siniestros WHERE numero LIKE ? OR placas LIKE ? OR vehiculo LIKE ? OR vin LIKE ? LIMIT 20`).all(like,like,like,like);
  // Ventana operativa (27-ago-2026): los resultados de PEDIDOS y PIEZAS (datos de refacciones/InPart)
  // se acotan al 1 de junio de 2026 en adelante por default; los de SINIESTROS y PROVEEDORES no se
  // tocan porque otros roles (Alejandra, Orlando, Vanessa, Beto) usan esta misma búsqueda para navegar
  // a cualquier expediente, sin importar cuándo se creó su pedido de refacciones.
  const conVentana = aplicaVentanaOperativa(req.query);
  const pedidos = db.prepare(`SELECT p.id, p.numero, s.numero as siniestro_numero, s.id as siniestro_id FROM pedidos p JOIN siniestros s ON s.id=p.siniestro_id WHERE p.numero LIKE ?${conVentana ? ' AND p.fecha_creacion >= ?' : ''} LIMIT 20`).all(...(conVentana ? [like, VENTANA_OPERATIVA_DESDE] : [like]));
  // Triage documento de Daniela (REQ-023): la búsqueda global ahora también cubre proveedor por
  // contacto (no solo razón social) y pieza por descripción o número de parte.
  const proveedores = db.prepare(`SELECT id, razon_social, correo, contacto FROM proveedores WHERE razon_social LIKE ? OR contacto LIKE ? LIMIT 20`).all(like,like);
  const piezas = db.prepare(`
    SELECT z.id, z.descripcion, z.numero_parte, z.estatus, p.id as pedido_id, p.numero as pedido_numero, s.id as siniestro_id, s.numero as siniestro_numero
    FROM piezas z JOIN pedidos p ON p.id = z.pedido_id JOIN siniestros s ON s.id = p.siniestro_id
    WHERE (z.descripcion LIKE ? OR z.numero_parte LIKE ?)${conVentana ? ' AND p.fecha_creacion >= ?' : ''} LIMIT 20`).all(...(conVentana ? [like,like, VENTANA_OPERATIVA_DESDE] : [like,like]));
  res.json({ siniestros, pedidos, proveedores, piezas, tipoDetectado: /^018.*A$/i.test(q) ? 'siniestro (regla R-02)' : 'pedido/otro' });
});


// Hallazgo A-04 (Informe_funcional_tablero_refacciones_para_Claude.docx): las tarjetas de "Sin
// proveedor" en Inicio deben abrir exactamente lo que cuentan. Dos listas separadas porque son dos
// causas distintas: piezas ya capturadas sin proveedor asignado, y pedidos que todavía no tienen
// NINGUNA pieza capturada (ninguna de las dos aparecía completa en Kanban como "Prov.: -").
router.get('/piezas-sin-proveedor', requireAuth, (req, res)=>{
  const conVentana = aplicaVentanaOperativa(req.query);
  const filas = db.prepare(`SELECT z.id, z.descripcion, p.id as pedido_id, p.numero as pedido_numero, s.id as siniestro_id, s.numero as siniestro_numero
    FROM piezas z JOIN pedidos p ON p.id=z.pedido_id JOIN siniestros s ON s.id=p.siniestro_id
    WHERE z.estatus='Sin proveedor'${conVentana ? ' AND p.fecha_creacion >= ?' : ''} ORDER BY p.creado_en DESC`).all(...(conVentana ? [VENTANA_OPERATIVA_DESDE] : []));
  res.json(filas);
});
router.get('/pedidos-sin-piezas', requireAuth, (req, res)=>{
  const conVentana = aplicaVentanaOperativa(req.query);
  const filas = db.prepare(`SELECT p.id as pedido_id, p.numero as pedido_numero, s.id as siniestro_id, s.numero as siniestro_numero
    FROM pedidos p JOIN siniestros s ON s.id=p.siniestro_id
    WHERE p.estatus_operativo NOT IN ('Cancelado','Cerrado') AND NOT EXISTS (SELECT 1 FROM piezas z WHERE z.pedido_id = p.id)
    ${conVentana ? ' AND p.fecha_creacion >= ?' : ''} ORDER BY p.creado_en DESC`).all(...(conVentana ? [VENTANA_OPERATIVA_DESDE] : []));
  res.json(filas);
});

// Roberto (28-ago-2026): las tarjetas del panorama de Orlando/Vanessa en Inicio deben abrir exactamente
// lo que cuentan, mismo criterio que piezas-sin-proveedor/pedidos-sin-piezas de arriba. Empieza por
// "Pendientes de revisión" (mismo WHERE que ovPendientesRevision en /resumen).
router.get('/pendientes-revision-tecnica', requireAuth, (req, res)=>{
  const filas = db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas, ingreso_tipo, creado_en
    FROM siniestros WHERE archivado=0 AND estado_revision_tecnica IS NULL ORDER BY creado_en ASC`).all();
  res.json(filas);
});

// Hallazgo A-06 (Informe Daniela): vista dedicada de piezas ya recibidas físicamente, con quién y cuándo
// las recibió y a qué proveedor/pedido/siniestro pertenecen -- antes esta información existía en la BD
// (fecha_recepcion, recibido_por) pero no había ninguna pantalla que la expusiera junta.
router.get('/piezas-recibidas', requireAuth, (req, res)=>{
  const { desde, hasta, proveedor_id, q } = req.query;
  const conVentana = aplicaVentanaOperativa(req.query);
  let sql = `SELECT z.id, z.descripcion, z.numero_parte, z.fecha_recepcion,
                    u.nombre as recibido_por_nombre,
                    pr.id as proveedor_id, pr.razon_social as proveedor_nombre,
                    p.id as pedido_id, p.numero as pedido_numero,
                    s.id as siniestro_id, s.numero as siniestro_numero
             FROM piezas z
             JOIN pedidos p ON p.id = z.pedido_id
             JOIN siniestros s ON s.id = p.siniestro_id
             LEFT JOIN usuarios u ON u.id = z.recibido_por
             LEFT JOIN proveedores pr ON pr.id = z.proveedor_id
             WHERE z.estatus = 'Recibida físicamente' AND z.fecha_recepcion IS NOT NULL AND z.fecha_recepcion != ''`;
  const params = [];
  if(desde){ sql += ' AND z.fecha_recepcion >= ?'; params.push(desde); }
  if(hasta){ sql += ' AND z.fecha_recepcion <= ?'; params.push(hasta + ' 23:59:59'); }
  if(proveedor_id){ sql += ' AND z.proveedor_id = ?'; params.push(proveedor_id); }
  if(q){ sql += ' AND (s.numero LIKE ? OR p.numero LIKE ? OR z.descripcion LIKE ?)'; const like = `%${q}%`; params.push(like, like, like); }
  if(conVentana){ sql += ' AND p.fecha_creacion >= ?'; params.push(VENTANA_OPERATIVA_DESDE); }
  sql += ' ORDER BY z.fecha_recepcion DESC';
  res.json(db.prepare(sql).all(...params));
});

// Vista enriquecida para el Kanban: todos los pedidos (F-03: ningún estatus se excluye) con resumen de piezas.
router.get('/kanban', requireAuth, (req, res)=>{
  archivarSiniestrosVencidos(db);
  const conVentanaKanban = aplicaVentanaOperativa(req.query);
  const pedidos = db.prepare(`SELECT p.*, s.numero as siniestro_numero, s.aseguradora, s.vehiculo, s.id as siniestro_id
                               FROM pedidos p JOIN siniestros s ON s.id = p.siniestro_id WHERE s.archivado = 0${conVentanaKanban ? ' AND p.fecha_creacion >= ?' : ''} ORDER BY p.creado_en DESC`).all(...(conVentanaKanban ? [VENTANA_OPERATIVA_DESDE] : []));
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
// Propuesta de Orlando (sección 3.1, 27-ago-2026): la bandeja ahora solo muestra vehículos que ya
// cumplieron los requisitos reales de admisión de Alejandra (fecha_hora_disponible_revision sellada) --
// antes aparecían TODOS los no-terminados sin importar si ya estaban realmente disponibles para revisar.
router.get('/bandeja-tecnica', requireAuth, (req, res)=>{
  const siniestros = db.prepare(`SELECT * FROM siniestros WHERE archivado = 0
    AND (estado_revision_tecnica IS NULL OR estado_revision_tecnica != 'revision_terminada')
    AND fecha_hora_disponible_revision IS NOT NULL
    ORDER BY fecha_hora_disponible_revision ASC`).all();
  const ahoraISO = new Date().toISOString().slice(0,10);
  const out = siniestros.map(s=>{
    const hallazgos = db.prepare('SELECT COUNT(*) n FROM danos_evidencia WHERE siniestro_id=?').get(s.id).n;
    const ocultos = db.prepare("SELECT COUNT(*) n FROM danos_evidencia WHERE siniestro_id=? AND visibilidad='oculto'").get(s.id).n;
    // Indicador de tiempo (sección 4.3): 72 horas hábiles solo aplica -- y con mayor relevancia -- a los
    // que llegan en grúa; para "circulando" se muestra el tiempo transcurrido sin marcar vencimiento.
    let limiteRevision = null, vencido = false;
    if(s.ingreso_tipo === 'grua'){
      limiteRevision = limiteRevisionGrua(s.fecha_hora_disponible_revision);
      vencido = !!limiteRevision && ahoraISO > limiteRevision;
    }
    const diasDisponible = s.fecha_hora_disponible_revision
      ? Math.floor((Date.now() - new Date(String(s.fecha_hora_disponible_revision).replace(' ','T')+'Z').getTime()) / 86400000)
      : null;
    return { ...s, hallazgos, hallazgos_ocultos: ocultos, limite_revision_grua: limiteRevision, revision_vencida: vencido, dias_disponible_revision: diasDisponible };
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
    // Modificación 1 (Modificaciones_Tablero_SC_Control.docx): aviso de "listo para iniciar" en cuanto
    // haya piezas SUFICIENTES, aunque el expediente no esté 100% completo. No existe un catálogo de qué
    // pieza es "crítica" para arrancar, así que se usa una señal objetiva: 80%+ de las piezas del
    // expediente ya recibidas físicamente (sin llegar al 100% que ya cubre refaccionesCompletas arriba).
    const pctPiezas = s.requiere_refacciones === 'si' ? porcentajePiezasRecibidas(db, s.id) : null;
    const piezasSuficientes = !refaccionesCompletas && pctPiezas !== null && pctPiezas >= 0.8;
    const enPiso = !s.estado_produccion || s.estado_produccion === 'programado';
    const vencidaOProxima = s.fecha_entrega_prevista && (s.fecha_entrega_prevista <= manana);
    // Modificación 1(a): "reingreso citado con fecha de entrega" separado de "unidad en piso" -- hoy
    // Beto no distingue entre una unidad que ya está físicamente en el taller (fecha_admision capturada)
    // y una que solo tiene cita agendada para reingresar (circulando, todavía no llega).
    const reingresoCitado = s.ingreso_tipo === 'circulando' && s.cita_fecha && !s.fecha_admision;
    const situacion = reingresoCitado ? 'reingreso_citado' : (s.fecha_admision ? 'en_piso' : (enPiso ? 'en_piso' : 'en_proceso'));
    const diasEnTaller = s.creado_en ? Math.floor((Date.now() - new Date(s.creado_en.replace(' ','T')+'Z').getTime()) / 86400000) : null;

    let prioridad = 4, motivo = 'En proceso normal, dentro de fecha.';
    if(vencidaOProxima){ prioridad = 1; motivo = s.fecha_entrega_prevista < hoy ? 'Vencida.' : 'Vence hoy o mañana.'; }
    else if(otRapidaSinTocar){ prioridad = 2; motivo = 'Reparación rápida recién asignable, sin tocar.'; }
    else if(enPiso && refaccionesCompletas){ prioridad = 3; motivo = 'Lista para iniciar: refacciones completas.'; }
    else if(enPiso && piezasSuficientes){ prioridad = 3.5; motivo = `Piezas suficientes recibidas (${Math.round(pctPiezas*100)}%), aunque no esté al 100%.`; }

    return { id:s.id, numero:s.numero, vehiculo:s.vehiculo, placas:s.placas, aseguradora:s.aseguradora,
      fecha_entrega_prevista:s.fecha_entrega_prevista, estado_produccion:s.estado_produccion,
      ot_numero: otMasReciente ? otMasReciente.numero : null, prioridad, motivo,
      situacion, reingreso_citado: !!reingresoCitado, dias_en_taller: diasEnTaller };
  });

  // Modificación 1(c): orden por antigüedad/urgencia en vez de solo el orden físico en que llegan las
  // hojas -- dentro de la misma prioridad y fecha promesa, gana el expediente más antiguo (más días en
  // taller esperando), para que no se quede debajo del montón.
  out.sort((a,b)=> a.prioridad - b.prioridad || (a.fecha_entrega_prevista||'9999').localeCompare(b.fecha_entrega_prevista||'9999') || (b.dias_en_taller||0) - (a.dias_en_taller||0));
  res.json(out);
});

/* ===================== Propuesta de Alejandra: pantalla "Pendientes de hoy" (27-ago-2026) =====================
   Documento "SEGUIMIENTO TABLERO ALE.docx". Tres secciones sobre datos YA existentes (nada se
   inventa): rojo = necesita una acción hoy, amarillo = en espera de un tercero (informativo), verde
   = avanzando por su etapa de producción real (estado_produccion / estado_entrega, los mismos campos
   que ya usa Beto). No aplica la ventana operativa del 1-jun-2026 de refacciones: este panorama cubre
   TODO el expediente (admisión a entrega), no solo pedidos de InPart. */
router.get('/pendientes-hoy', requireAuth, (req, res)=>{
  archivarSiniestrosVencidos(db);

  // ROJO — requieren atención hoy.
  const complementosPendientes = db.prepare(`
    SELECT c.id, c.causa, c.fecha, s.id as siniestro_id, s.numero as siniestro_numero, s.vehiculo, s.placas
    FROM complementos c JOIN siniestros s ON s.id = c.siniestro_id
    WHERE c.decision = 'pendiente' ORDER BY c.creado_en ASC`).all();
  const autorizacionesPendientes = db.prepare(`
    SELECT id, numero, vehiculo, placas, aseguradora FROM siniestros
    WHERE archivado = 0 AND estado_expediente = 'listo_para_valuacion' AND (estado_autorizacion IS NULL OR estado_autorizacion = '')
    ORDER BY actualizado_en ASC`).all();
  const refaccionesRecibidas = db.prepare(`
    SELECT t.id, t.descripcion, t.fecha_limite, s.id as siniestro_id, s.numero as siniestro_numero, s.vehiculo, s.placas
    FROM tareas t JOIN siniestros s ON s.id = t.siniestro_id
    WHERE t.disparador = 'refacciones_completas' AND t.estado IN ('pendiente','en_proceso') ORDER BY t.creado_en ASC`).all();
  const clientesQueNecesitanAviso = db.prepare(`
    SELECT sh.id, ch.titulo as hito_titulo, s.id as siniestro_id, s.numero as siniestro_numero, s.vehiculo, s.placas
    FROM siniestro_hitos sh JOIN catalogo_hitos ch ON ch.id = sh.hito_id JOIN siniestros s ON s.id = sh.siniestro_id
    WHERE sh.estado = 'generado' AND s.archivado = 0 ORDER BY sh.actualizado_en ASC`).all();
  const citasQueRequierenConfirmacion = db.prepare(`
    SELECT id, numero, vehiculo, placas, fecha_entrega_prevista FROM siniestros
    WHERE archivado = 0 AND estado_entrega = 'listo' ORDER BY fecha_entrega_prevista ASC`).all();

  // AMARILLO — en espera de un tercero (informativo, no requiere acción todavía).
  const esperandoAseguradora = db.prepare(`
    SELECT id, numero, vehiculo, placas, aseguradora, estado_autorizacion FROM siniestros
    WHERE archivado = 0 AND estado_autorizacion IN ('en_autorizacion','por_aclarar') ORDER BY actualizado_en ASC`).all();
  const esperandoRefacciones = db.prepare(`
    SELECT DISTINCT s.id, s.numero, s.vehiculo, s.placas FROM siniestros s JOIN pedidos p ON p.siniestro_id = s.id
    WHERE s.archivado = 0 AND s.requiere_refacciones = 'si' AND p.estatus_operativo NOT IN ('Recibido completo','Cancelado','Cerrado')
    ORDER BY s.numero`).all();
  const esperandoAutorizacionComplemento = db.prepare(`
    SELECT c.id, c.causa, s.id as siniestro_id, s.numero as siniestro_numero, s.vehiculo, s.placas
    FROM complementos c JOIN siniestros s ON s.id = c.siniestro_id
    WHERE c.estado = 'en_autorizacion' ORDER BY c.actualizado_en ASC`).all();
  const esperandoRespuestaCliente = db.prepare(`
    SELECT s.id, s.numero, s.vehiculo, s.placas FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado'
      AND (SELECT ec.direccion FROM eventos_cliente ec WHERE ec.siniestro_id = s.id ORDER BY ec.creado_en DESC LIMIT 1) = 'saliente'
    ORDER BY s.numero`).all();

  // VERDE — avanzando (misma etapa real de producción/entrega que ya usa Beto).
  const enHojalateria = db.prepare(`SELECT id, numero, vehiculo, placas FROM siniestros WHERE archivado = 0 AND estado_produccion = 'en_laminado' ORDER BY numero`).all();
  const enPintura = db.prepare(`SELECT id, numero, vehiculo, placas FROM siniestros WHERE archivado = 0 AND estado_produccion = 'pintura' ORDER BY numero`).all();
  const enArmado = db.prepare(`SELECT id, numero, vehiculo, placas FROM siniestros WHERE archivado = 0 AND estado_produccion = 'armado' ORDER BY numero`).all();
  // Modificación 6: se agregan pulido y lavado como etapas propias (antes quedaban implícitas dentro de
  // "detallado y pulido" o no se distinguían), siguiendo el orden confirmado por Roberto.
  const enPulido = db.prepare(`SELECT id, numero, vehiculo, placas FROM siniestros WHERE archivado = 0 AND estado_produccion = 'pulido' ORDER BY numero`).all();
  const enLavado = db.prepare(`SELECT id, numero, vehiculo, placas FROM siniestros WHERE archivado = 0 AND estado_produccion = 'lavado' ORDER BY numero`).all();
  const listoParaEntrega = db.prepare(`SELECT id, numero, vehiculo, placas FROM siniestros WHERE archivado = 0 AND estado_entrega = 'cita_confirmada' ORDER BY numero`).all();

  res.json({
    rojo: {
      complementosPendientes, autorizacionesPendientes, refaccionesRecibidas, clientesQueNecesitanAviso, citasQueRequierenConfirmacion,
      total: complementosPendientes.length + autorizacionesPendientes.length + refaccionesRecibidas.length + clientesQueNecesitanAviso.length + citasQueRequierenConfirmacion.length
    },
    amarillo: {
      esperandoAseguradora, esperandoRefacciones, esperandoAutorizacionComplemento, esperandoRespuestaCliente,
      total: esperandoAseguradora.length + esperandoRefacciones.length + esperandoAutorizacionComplemento.length + esperandoRespuestaCliente.length
    },
    verde: {
      enHojalateria, enPintura, enArmado, enPulido, enLavado, listoParaEntrega,
      total: enHojalateria.length + enPintura.length + enArmado.length + enPulido.length + enLavado.length + listoParaEntrega.length
    }
  });
});

module.exports = router;
