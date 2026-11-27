// ===================== Unidades por retirar del taller (27-nov-2026) =====================
// Roberto (27-nov-2026), al marcar el Aveo 0190327494A como "No reparar" con la unidad en piso: "dejar un recordatorio
// para que indiquen hasta que se retire la unidad del CDR, sería bueno igual saber esto con las PT para saber qué
// unidades debemos exigir sean retiradas". Propuesta aprobada por Roberto:
//   - Lista "Por retirar del taller": pérdidas totales y "No reparar" que siguen en PISO, sin entrega ni retiro.
//   - Días en el taller desde que se marcó (PT: cuando se archivó; No reparar: cuando se marcó). Desde 3 días, en rojo.
//   - Botón "Ya se retiró" (fecha y quién) que la saca de la lista.
//   - La ven Alejandra, Daniela y Roberto en su inicio.
const DIAS_ROJO = 3;
const ROLES_RETIRO = ['atencion_cliente', 'operativo', 'jefe', 'admin'];

function asegurarColumnas(db){
  for(const [col, tipo] of [['retirada_en','TEXT'], ['retirada_por','TEXT']]){
    if(!db.prepare(`SELECT 1 FROM pragma_table_info('siniestros') WHERE name=?`).get(col)) db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${tipo}`);
  }
}

function aMs(v){ if(!v) return NaN; const t = String(v); return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); }

function porRetirar(db){
  const ahora = Date.now();
  return db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas, cliente_nombre, estatus_general, no_reparar_motivo,
      COALESCE(NULLIF(no_reparar_en,''), NULLIF(archivado_en,''), actualizado_en) AS desde
    FROM siniestros
    WHERE estatus_general IN ('Pérdida total', 'No reparar') AND ubicacion LIKE 'Piso%'
      AND (retirada_en IS NULL OR retirada_en = '') AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '')
    ORDER BY desde ASC`).all().map(s => {
      const dias = Math.max(0, Math.floor((ahora - aMs(s.desde)) / 86400000)) || 0;
      return { ...s, tipo: s.estatus_general === 'No reparar' ? 'No reparar' : 'Pérdida total', dias, rojo: dias >= DIAS_ROJO };
    });
}

module.exports = { asegurarColumnas, porRetirar, DIAS_ROJO, ROLES_RETIRO };
