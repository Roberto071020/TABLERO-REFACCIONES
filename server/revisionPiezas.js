// ===================== Revisión de piezas por el auxiliar de refacciones (12-nov-2026) =====================
// Roberto: "En cuanto al auxiliar de refacciones él es quien apoya a Dani para revisar los componentes que van
// llegando así como también le indica cuando alguno llega roto o equivocado". Decidido ese día:
//   - Ve TODAS las piezas pendientes (no solo las que Daniela marcó), agrupadas por unidad, con buscador.
//   - ✅ Llegó bien  -> la pieza pasa a "Entregada por proveedor" con la marca "Revisada por <él>". Daniela la
//                       confirma con su botón de siempre ("Daniela confirma").
//   - ⚠️ Llegó mal   -> rota / equivocada / incompleta, foto obligatoria y nota opcional. Se registra la
//                       incidencia (igual que cuando Daniela usa "Llegó mal") con las fotos, y le llega a Daniela.
const { VENTANA_OPERATIVA_DESDE, registrarAuditoria } = require('./utils');

const PUESTO = 'Auxiliar de refacciones';
const TIPOS_MAL = {
  danada:     { etiqueta:'Llegó rota o dañada', icono:'💥' },
  incorrecta: { etiqueta:'Llegó equivocada',    icono:'🔄' },
  incompleta: { etiqueta:'Llegó incompleta',    icono:'🧩' },
};

function asegurarEsquema(db){
  const cols = db.prepare(`PRAGMA table_info(piezas)`).all().map(c => c.name);
  if(!cols.includes('revisada_por')) db.exec(`ALTER TABLE piezas ADD COLUMN revisada_por INTEGER`);
  if(!cols.includes('revisada_en')) db.exec(`ALTER TABLE piezas ADD COLUMN revisada_en TEXT`);
  const ci = db.prepare(`PRAGMA table_info(incidencias)`).all().map(c => c.name);
  if(!ci.includes('fotos')) db.exec(`ALTER TABLE incidencias ADD COLUMN fotos TEXT`);
}

function esAuxiliar(db, usuario){
  if(!usuario) return false;
  if(['admin', 'jefe'].includes(usuario.rol)) return true;
  const u = db.prepare(`SELECT puesto FROM usuarios WHERE id = ? AND rol = 'tecnico'`).get(usuario.id);
  return !!(u && u.puesto === PUESTO);
}
function nombreCorto(n){ const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[1][0]}.` : p[0] || ''; }

// Piezas que todavía no se reciben ni se reportan mal, agrupadas por unidad.
function piezasPendientes(db){
  const filas = db.prepare(`
    SELECT z.id, z.descripcion, z.numero_parte, z.estatus, z.fecha_prometida, z.revisada_en,
      (SELECT nombre FROM usuarios WHERE id = z.revisada_por) AS revisada_por_nombre,
      p.siniestro_id, s.numero AS siniestro_numero, s.vehiculo, s.placas, pv.razon_social AS proveedor
    FROM piezas z JOIN pedidos p ON p.id = z.pedido_id JOIN siniestros s ON s.id = p.siniestro_id
    LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
    WHERE s.archivado = 0 AND p.estatus_operativo NOT IN ('Cancelado','Cerrado') AND p.fecha_creacion >= ?
      AND z.estatus NOT IN ('Recibida físicamente','Cancelada','Incorrecta/dañada','Devuelta')
      AND NOT EXISTS (SELECT 1 FROM incidencias i WHERE i.pieza_id = z.id AND i.estado IN ('abierta','en_proceso'))`).all(VENTANA_OPERATIVA_DESDE);
  const porUnidad = new Map();
  for(const z of filas){
    if(!porUnidad.has(z.siniestro_id)) porUnidad.set(z.siniestro_id, { siniestro_id: z.siniestro_id, numero: z.siniestro_numero, vehiculo: z.vehiculo, placas: z.placas, piezas: [] });
    porUnidad.get(z.siniestro_id).piezas.push({ id: z.id, descripcion: z.descripcion, numero_parte: z.numero_parte, proveedor: z.proveedor, estatus: z.estatus,
      fecha_prometida: z.fecha_prometida, revisada: !!z.revisada_en, revisada_por: z.revisada_por_nombre ? nombreCorto(z.revisada_por_nombre) : null });
  }
  // Primero lo que el proveedor ya entregó y falta revisar; luego por fecha prometida más cercana.
  const clave = u => {
    const sinRevisar = u.piezas.some(z => z.estatus === 'Entregada por proveedor' && !z.revisada) ? 0 : 1;
    const fechas = u.piezas.map(z => z.fecha_prometida).filter(Boolean).sort();
    return [sinRevisar, fechas[0] || '9999'];
  };
  return [...porUnidad.values()].sort((a, b) => { const x = clave(a), y = clave(b); return x[0] - y[0] || String(x[1]).localeCompare(String(y[1])); });
}

function error(msg, status = 400){ return Object.assign(new Error(msg), { status }); }
function cargarPieza(db, id){
  const z = db.prepare(`SELECT z.*, p.siniestro_id FROM piezas z JOIN pedidos p ON p.id = z.pedido_id WHERE z.id = ?`).get(id);
  if(!z) throw error('Pieza no encontrada.', 404);
  if(['Recibida físicamente', 'Cancelada'].includes(z.estatus)) throw error('Esta pieza ya está cerrada.');
  return z;
}

function llegoBien(db, { piezaId, usuario }){
  const z = cargarPieza(db, piezaId);
  if(db.prepare(`SELECT 1 FROM incidencias WHERE pieza_id = ? AND estado IN ('abierta','en_proceso')`).get(z.id)) throw error('Esta pieza ya tiene un reporte abierto. Avísale a Daniela.');
  db.prepare(`UPDATE piezas SET estatus = 'Entregada por proveedor', revisada_por = ?, revisada_en = datetime('now'), actualizado_en = datetime('now') WHERE id = ?`).run(usuario.id, z.id);
  registrarAuditoria(db, { entidad_tipo:'pieza', entidad_id: z.id, accion:'revisada_auxiliar', campo:'estatus', valor_anterior: z.estatus,
    valor_nuevo: 'Entregada por proveedor (revisada: llegó bien)', usuario });
  return { ok: true };
}

function llegoMal(db, { piezaId, usuario, tipo, nota, fotos }){
  const z = cargarPieza(db, piezaId);
  const t = TIPOS_MAL[tipo];
  if(!t) throw error('Elige qué pasó con la pieza.');
  const lista = (Array.isArray(fotos) ? fotos : []).map(Number).filter(Boolean);
  const validas = lista.length ? db.prepare(`SELECT id FROM archivos WHERE id IN (${lista.map(() => '?').join(',')}) AND entidad_tipo='siniestro' AND entidad_id = ?
      AND tipo='foto' AND subido_por = ? AND eliminado = 0`).all(...lista, z.siniestro_id, usuario.id).map(r => r.id) : [];
  if(!validas.length) throw error('Toma al menos una foto de la pieza.');
  nota = String(nota || '').trim().slice(0, 200);
  const descripcion = `${t.etiqueta}. Reporta ${nombreCorto(usuario.nombre)}${nota ? ': ' + nota : ''}`;
  // Mismo efecto que dar de alta la incidencia desde la pantalla de Daniela (server/routes/incidencias.js).
  const info = db.prepare(`INSERT INTO incidencias (pieza_id, tipo, descripcion, responsable, fecha_compromiso, estado, creado_por, fotos)
    VALUES (?,?,?,?,'','abierta',?,?)`).run(z.id, tipo, descripcion, usuario.nombre, usuario.id, JSON.stringify(validas));
  db.prepare(`UPDATE piezas SET estatus = 'Incorrecta/dañada', revisada_por = ?, revisada_en = datetime('now'), actualizado_en = datetime('now') WHERE id = ?`).run(usuario.id, z.id);
  registrarAuditoria(db, { entidad_tipo:'incidencia', entidad_id: info.lastInsertRowid, accion:'alta', usuario, valor_nuevo:`${tipo} en pieza ${z.descripcion}` });
  registrarAuditoria(db, { entidad_tipo:'pieza', entidad_id: z.id, accion:'incidencia_registrada', campo:'estatus', valor_anterior: z.estatus, valor_nuevo:'Incorrecta/dañada', usuario });
  const pedido = db.prepare('SELECT estatus_operativo FROM pedidos WHERE id = ?').get(z.pedido_id);
  db.prepare(`UPDATE pedidos SET estatus_operativo = 'Con incidencia', actualizado_en = datetime('now') WHERE id = ?`).run(z.pedido_id);
  registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id: z.pedido_id, accion:'cambio_por_incidencia', campo:'estatus_operativo', valor_anterior: pedido && pedido.estatus_operativo, valor_nuevo:'Con incidencia', usuario });
  return { ok: true, incidencia_id: Number(info.lastInsertRowid) };
}

module.exports = { PUESTO, TIPOS_MAL, asegurarEsquema, esAuxiliar, piezasPendientes, llegoBien, llegoMal, nombreCorto };
