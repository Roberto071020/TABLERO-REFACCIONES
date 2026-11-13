// ===================== Inicio de Daniela (6-nov-2026) =====================
// Mismo principio que el inicio de Beto y de Alejandra: una sola pantalla de celular que dice QUÉ hacer hoy,
// EN QUÉ ORDEN y CON QUÉ BOTÓN. Proceso confirmado por Roberto (6-nov-2026):
//   1) Recibir piezas      -> el proveedor las entregó y falta revisar si llegaron bien (por unidad).
//   2) Reclamar vencidas    -> ya pasó la fecha prometida, hasta 30 días (agrupadas por proveedor).
//   3) Confirmar fechas     -> piezas asignadas sin fecha confirmada del proveedor (por proveedor).
//   4) Aprobar correos      -> borradores automáticos para proveedores.
//   5) Mal surtidas         -> incidencias abiertas y piezas devueltas/incorrectas (por pieza).
//   6) Pedidos sin piezas   -> pedidos nuevos sin ninguna pieza capturada.
//   Al final: "Revisa: ¿siguen pendientes?" (vencidas hace más de 30 días, casi siempre datos viejos),
//   "Revisa cuando tengas tiempo" (vales, discrepancias, correos incompletos, expedientes sin placas) y
//   "Ya llegaron (últimos 7 días)" cerrada, por si una pieza sale mal surtida.
// Solo aparece lo que sigue en proceso: una unidad que no sale aquí tiene sus refacciones completas.
// Aplica la misma ventana operativa que el resto de refacciones (pedidos desde el 1-jun-2026).
const { VENTANA_OPERATIVA_DESDE } = require('./utils');

const DIAS_VENCIDA_VIEJA = 30;
const DIAS_YA_LLEGARON = 7;
const DIAS_CORREO_VIEJO = 7;
// Línea base del lunes 9-nov-2026: los correos por aprobar con más de 7 días se archivan (sin enviarse ni
// borrarse: estado 'archivado'). Se puede adelantar con POST /api/inicio-daniela/linea-base (solo admin).
const LINEA_BASE_DESDE = process.env.LINEA_BASE_DANIELA || '2026-11-09';
const MARCADOR_LINEA_BASE = 'linea_base_correos_daniela';
const CERRADAS = ['Recibida físicamente', 'Cancelada'];

function hoyMX(){ return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10); }
function diasEntre(a, b){ return Math.floor((Date.parse(b) - Date.parse(a)) / 86400000); }

function archivarCorreosViejos(db, { usuario = null } = {}){
  const r = db.prepare(`UPDATE comunicaciones SET estado='archivado' WHERE estado='pendiente_aprobacion' AND fecha_envio < datetime('now', ?)`)
    .run(`-${DIAS_CORREO_VIEJO} days`);
  const { registrarAuditoria } = require('./utils');
  registrarAuditoria(db, { entidad_tipo:'sistema', entidad_id:0, accion: MARCADOR_LINEA_BASE,
    valor_nuevo: `${r.changes} correo(s) de más de ${DIAS_CORREO_VIEJO} días archivados sin enviar`, usuario });
  return { archivados: Number(r.changes) };
}
function archivarCorreosSiToca(db){
  if(hoyMX() < LINEA_BASE_DESDE) return null;
  if(db.prepare(`SELECT 1 FROM auditoria WHERE accion=? LIMIT 1`).get(MARCADOR_LINEA_BASE)) return null;
  return archivarCorreosViejos(db);
}

function calcularInicioDaniela(db){
  try{ require('./revisionPiezas').asegurarEsquema(db); }catch(e){}
  try{ archivarCorreosSiToca(db); }catch(e){ /* nunca debe impedir ver la pantalla */ }
  const hoy = hoyMX();
  const ventana = VENTANA_OPERATIVA_DESDE;

  const piezas = db.prepare(`
    SELECT z.id, z.descripcion, z.numero_parte, z.estatus, z.fecha_prometida, z.proveedor_id, z.pedido_id, z.fecha_recepcion,
      z.revisada_en, (SELECT nombre FROM usuarios WHERE id = z.revisada_por) AS revisada_por_nombre, -- 12-nov-2026: revisión del auxiliar de refacciones
      p.numero AS pedido_numero, p.siniestro_id, s.numero AS siniestro_numero, s.vehiculo, s.placas, s.aseguradora,
      pv.razon_social AS proveedor, pv.telefono AS proveedor_telefono, pv.correo AS proveedor_correo
    FROM piezas z
    JOIN pedidos p ON p.id = z.pedido_id
    JOIN siniestros s ON s.id = p.siniestro_id
    LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
    WHERE s.archivado = 0 AND p.estatus_operativo NOT IN ('Cancelado','Cerrado') AND p.fecha_creacion >= ?
      AND z.estatus NOT IN ('Recibida físicamente','Cancelada')`).all(ventana);
  const incidencias = new Map();
  for(const i of db.prepare(`SELECT id, pieza_id, tipo, descripcion, accion_solicitada, fecha_compromiso, fotos FROM incidencias WHERE estado IN ('abierta','en_proceso') ORDER BY id DESC`).all()){
    let fotos = []; try{ fotos = JSON.parse(i.fotos || '[]'); }catch(e){}
    if(!incidencias.has(i.pieza_id)) incidencias.set(i.pieza_id, { ...i, fotos });
  }

  const noLlego = new Set(db.prepare(`SELECT pieza_id FROM discrepancias_proveedor WHERE no_llego = 1 AND estado = 'abierta' AND pieza_id IS NOT NULL`).all().map(r => r.pieza_id));
  const recibir = [], mal = [], viejas = [];
  const vencidasPorProv = new Map(), confirmarPorProv = new Map();
  const agrupar = (mapa, z, extra) => {
    const k = z.proveedor_id || 0;
    if(!mapa.has(k)) mapa.set(k, { proveedor_id: z.proveedor_id, proveedor: z.proveedor || 'Proveedor sin capturar',
      telefono: z.proveedor_telefono || '', correo: z.proveedor_correo || '', piezas: [] });
    mapa.get(k).piezas.push({ ...z, ...extra });
  };
  for(const z of piezas){
    const inc = incidencias.get(z.id);
    if(inc || z.estatus === 'Incorrecta/dañada' || z.estatus === 'Devuelta'){ mal.push({ ...z, incidencia: inc || null }); continue; }
    // 13-nov-2026: si el auxiliar reportó que no ha llegado (aunque el proveedor la dio por entregada), Daniela lo ve.
    if(z.estatus === 'Entregada por proveedor'){ recibir.push({ ...z, no_llego: noLlego.has(z.id) }); continue; }
    const fp = z.fecha_prometida ? String(z.fecha_prometida).slice(0, 10) : '';
    if(fp && fp < hoy){
      const dias = diasEntre(fp, hoy);
      if(dias > DIAS_VENCIDA_VIEJA) viejas.push({ ...z, dias_vencida: dias });
      else agrupar(vencidasPorProv, z, { dias_vencida: dias });
      continue;
    }
    if(z.estatus === 'Asignada') agrupar(confirmarPorProv, z, {});
  }
  const ordenarGrupos = (grupos, campo) => [...grupos.values()]
    .map(g => ({ ...g, piezas: g.piezas.sort((a, b) => (b[campo] || 0) - (a[campo] || 0)) }))
    .sort((a, b) => ((b.piezas[0][campo] || 0) - (a.piezas[0][campo] || 0)) || (b.piezas.length - a.piezas.length));
  const vencidas = ordenarGrupos(vencidasPorProv, 'dias_vencida');
  const confirmar = ordenarGrupos(confirmarPorProv, 'id');

  // Recibir: agrupadas por unidad (es como llegan físicamente al taller).
  const recibirPorUnidad = new Map();
  for(const z of recibir){
    if(!recibirPorUnidad.has(z.siniestro_id)) recibirPorUnidad.set(z.siniestro_id, { siniestro_id: z.siniestro_id, siniestro_numero: z.siniestro_numero,
      vehiculo: z.vehiculo, placas: z.placas, aseguradora: z.aseguradora, piezas: [] });
    recibirPorUnidad.get(z.siniestro_id).piezas.push(z);
  }

  const correos = db.prepare(`
    SELECT c.id, c.asunto, c.disparador, c.fecha_envio, c.incompleto, c.siniestro_id, s.numero AS siniestro_numero, s.vehiculo,
      pv.razon_social AS proveedor, p.numero AS pedido_numero
    FROM comunicaciones c JOIN pedidos p ON p.id = c.pedido_id JOIN siniestros s ON s.id = c.siniestro_id
    LEFT JOIN proveedores pv ON pv.id = c.proveedor_id
    WHERE c.estado = 'pendiente_aprobacion' AND p.fecha_creacion >= ?
    ORDER BY c.incompleto ASC, c.fecha_envio DESC`).all(ventana);

  const pedidosSinPiezas = db.prepare(`
    SELECT p.id AS pedido_id, p.numero AS pedido_numero, p.fecha_creacion, s.id AS siniestro_id, s.numero AS siniestro_numero, s.vehiculo, s.placas, s.aseguradora
    FROM pedidos p JOIN siniestros s ON s.id = p.siniestro_id
    WHERE s.archivado = 0 AND p.estatus_operativo NOT IN ('Cancelado','Cerrado') AND p.fecha_creacion >= ?
      AND NOT EXISTS (SELECT 1 FROM piezas z WHERE z.pedido_id = p.id)
    ORDER BY p.fecha_creacion ASC`).all(ventana);

  const yaLlegaron = db.prepare(`
    SELECT z.id, z.descripcion, z.fecha_recepcion, p.siniestro_id, s.numero AS siniestro_numero, s.vehiculo, s.placas, pv.razon_social AS proveedor
    FROM piezas z JOIN pedidos p ON p.id = z.pedido_id JOIN siniestros s ON s.id = p.siniestro_id LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
    WHERE z.estatus = 'Recibida físicamente' AND z.fecha_recepcion >= datetime('now', ?)
    ORDER BY z.fecha_recepcion DESC LIMIT 200`).all(`-${DIAS_YA_LLEGARON} days`);

  const revisa = {
    vales: db.prepare(`SELECT COUNT(*) n FROM vales_pendientes WHERE estado='pendiente'`).get().n,
    discrepancias: db.prepare(`SELECT COUNT(*) n FROM discrepancias_proveedor WHERE estado='abierta'`).get().n,
    correos_incompletos: correos.filter(c => c.incompleto).length,
    sin_placas: db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE completo = 0 AND archivado = 0`).get().n,
  };

  const numeros = {
    por_recibir: recibir.length,
    vencidas: vencidas.reduce((n, g) => n + g.piezas.length, 0),
    por_confirmar: confirmar.reduce((n, g) => n + g.piezas.length, 0),
    correos: correos.length,
    mal_surtidas: mal.length,
    pedidos_sin_piezas: pedidosSinPiezas.length,
    vencidas_viejas: viejas.length,
  };
  return { hoy, numeros, recibir: [...recibirPorUnidad.values()], vencidas, confirmar, correos, mal,
    pedidos_sin_piezas: pedidosSinPiezas, viejas: viejas.sort((a, b) => b.dias_vencida - a.dias_vencida), ya_llegaron: yaLlegaron, revisa };
}

module.exports = { calcularInicioDaniela, archivarCorreosViejos, archivarCorreosSiToca, DIAS_VENCIDA_VIEJA, DIAS_CORREO_VIEJO, CERRADAS };
