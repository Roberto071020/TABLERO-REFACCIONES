// ===================== Revisión de calidad pendiente (6-nov-2026) =====================
// Roberto: "La revisión de calidad la debe hacer Beto, pero quisiera que todos la pudiéramos hacer".
// Hasta hoy, cuando Beto marcaba una unidad como Terminada desaparecía de su pantalla y nada le recordaba
// la revisión de calidad. Esta lista alimenta:
//   - el inicio de Beto (todas, es su responsabilidad),
//   - el inicio de Alejandra, Daniela y Orlando (solo las que llevan 1 día o más terminadas sin revisar,
//     como apoyo para que no se queden detenidas).
const HORAS_APOYO = 24;

function aMs(v){ if(!v) return NaN; const t = String(v); return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); }

function unidadesPorRevisarCalidad(db, { minHoras = 0 } = {}){
  const filas = db.prepare(`SELECT s.id, s.numero, s.vehiculo, s.placas, s.aseguradora, s.cliente_nombre, s.estado_calidad, s.fecha_entrega_prevista, s.actualizado_en
    FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado' AND s.estado_produccion = 'terminado'
      AND (s.estado_calidad IS NULL OR s.estado_calidad != 'liberado')
      AND (s.fecha_entrega_real IS NULL OR s.fecha_entrega_real = '')`).all();
  const ahora = Date.now();
  return filas.map(s => {
    const a = db.prepare(`SELECT fecha FROM auditoria WHERE entidad_tipo='siniestro' AND entidad_id=? AND campo='estado_produccion' AND valor_nuevo='terminado' ORDER BY id DESC LIMIT 1`).get(s.id);
    const terminadoEn = (a && a.fecha) || s.actualizado_en;
    const horas = Math.max(0, Math.floor((ahora - aMs(terminadoEn)) / 3600000)) || 0;
    const rechazados = db.prepare(`SELECT dimension, hallazgo FROM checklist_calidad WHERE siniestro_id=? AND resultado='rechazado'`).all(s.id);
    return { ...s, terminado_en: terminadoEn, horas_terminada: horas, rechazados };
  }).filter(s => s.horas_terminada >= minHoras)
    .sort((x, y) => y.horas_terminada - x.horas_terminada);
}

module.exports = { unidadesPorRevisarCalidad, HORAS_APOYO };
