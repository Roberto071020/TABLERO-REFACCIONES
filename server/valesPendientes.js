// ===================== Entregadas con pendiente (18-nov-2026) =====================
// Roberto: "Hay que crear un apartado para estas unidades que se reparan y entregan dejando algo pendiente ya que
// seguramente está incluso facturado ... el cliente firma documentación de unidad terminada y se le entrega un vale
// solo por lo pendiente".
// Se apoya en el vale pendiente que ya existía (tabla vales_pendientes, Modificación 3 del 28-ago-2026):
//   - La unidad se registra como ENTREGADA (cuenta como terminada para indicadores y cobro).
//   - Mientras su vale siga pendiente: no se archiva sola, no se puede cerrar y sus fotos no se borran.
//   - Su cita para instalar lo pendiente le aparece a Alejandra como cualquier reingreso (y en el corte si no llega).
//   - Lo cierra cualquiera de oficina o Beto con "Ya se instaló" (Roberto: "lo puede cerrar cualquiera de oficina o
//     incluso Beto"). La foto del vale es opcional (etapa de foto 'vale').
const ZONA = 'America/Mexico_City';
function hoyMX(f = new Date()){ return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year:'numeric', month:'2-digit', day:'2-digit' }).format(f); }
const f10 = v => (v ? String(v).slice(0, 10) : '');

// Roles que pueden registrar, actualizar y cerrar vales: toda la oficina y Beto.
const ROLES_VALE = ['operativo', 'atencion_cliente', 'orlando', 'vanessa', 'beto', 'admin', 'jefe'];

// Mapa siniestro_id -> texto de lo pendiente (varios vales de la misma unidad se juntan con "; ").
function pendientesPorUnidad(db){
  const m = new Map();
  for(const v of db.prepare(`SELECT siniestro_id, pieza_pendiente FROM vales_pendientes WHERE estado = 'pendiente' ORDER BY id`).all()){
    m.set(v.siniestro_id, m.has(v.siniestro_id) ? m.get(v.siniestro_id) + '; ' + v.pieza_pendiente : v.pieza_pendiente);
  }
  return m;
}
function tieneValePendiente(db, siniestroId){
  return !!db.prepare(`SELECT 1 FROM vales_pendientes WHERE siniestro_id = ? AND estado = 'pendiente' LIMIT 1`).get(siniestroId);
}

// Estado de la cita para instalar lo pendiente.
function estadoCita(s, hoy){
  const cita = f10(s.cita_fecha);
  if(!cita) return { estado:'sin_cita', texto:'Sin cita para instalar' };
  const llego = f10(s.reingreso_recibido_en) && f10(s.reingreso_recibido_en) >= cita;
  if(llego) return { estado:'llego', texto:'Ya llegó: falta instalar' };
  if(cita === hoy) return { estado:'hoy', texto:'Cita hoy' };
  if(cita < hoy) return { estado:'no_llego', texto:`No llegó a su cita del ${cita}` };
  return { estado:'futura', texto:`Cita el ${cita}` };
}

// Cómo va la pieza: se toma de los pedidos de la unidad (sin pedido = no se sabe, p. ej. pieza de stock).
function estadoPieza(db, siniestroId){
  const f = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN z.estatus = 'Recibida físicamente' THEN 1 ELSE 0 END) rec
    FROM piezas z JOIN pedidos p ON p.id = z.pedido_id WHERE p.siniestro_id = ? AND z.estatus != 'Cancelada'`).get(siniestroId);
  if(!f || !f.total) return { estado:'sin_pedido', texto:'Sin pedido registrado' };
  if(f.rec === f.total) return { estado:'lista', texto:'Pieza en el taller' };
  return { estado:'en_camino', texto:`Pieza por llegar (${f.rec || 0} de ${f.total})` };
}

function listarEntregadasConPendiente(db, hoy = hoyMX()){
  const filas = db.prepare(`SELECT v.id, v.siniestro_id, v.pieza_pendiente, v.fecha_entrega_vehiculo, v.notas, v.creado_en,
      s.numero, s.vehiculo, s.placas, s.aseguradora, s.cliente_nombre, s.cliente_telefono, s.fecha_entrega_real,
      s.cita_fecha, s.reingreso_recibido_en, s.ubicacion
    FROM vales_pendientes v JOIN siniestros s ON s.id = v.siniestro_id
    WHERE v.estado = 'pendiente' ORDER BY v.id`).all();
  const orden = { no_llego:0, llego:1, hoy:2, sin_cita:3, futura:4 };
  return filas.map(v => {
    const entregada = f10(v.fecha_entrega_real) || f10(v.fecha_entrega_vehiculo);
    const dias = entregada ? Math.max(0, Math.floor((Date.parse(hoy) - Date.parse(entregada)) / 86400000)) : null;
    const fotos = db.prepare(`SELECT id FROM archivos WHERE entidad_tipo = 'siniestro' AND entidad_id = ? AND etapa = 'vale' AND purgado_en IS NULL ORDER BY id`)
      .all(v.siniestro_id).map(a => a.id);
    return { ...v, entregada, dias_desde_entrega: dias, cita: estadoCita(v, hoy), pieza: estadoPieza(db, v.siniestro_id), fotos };
  }).sort((a, b) => (orden[a.cita.estado] - orden[b.cita.estado]) || ((b.dias_desde_entrega || 0) - (a.dias_desde_entrega || 0)));
}

module.exports = { ROLES_VALE, pendientesPorUnidad, tieneValePendiente, listarEntregadasConPendiente, estadoCita, hoyMX };
