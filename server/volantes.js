// ===================== Alta por volante (19-nov-2026) =====================
// Roberto: ANA e Inbursa le mandan el volante de reparación cuando le asignan una unidad. Con él se da de alta la
// unidad ANTES de que llegue (en tránsito), con los datos del volante. "Debe quedar por confirmar la información
// con Alejandra o quien reciba en taller por si se debe cambiar algo", "que no se confunda", "ni que se duplique la
// información", y "que de alguna manera se le explique brevemente qué quiere decir alta por volante".
//   - volante_origen:        aseguradora que mandó el volante (ANA, Inbursa…). Marca la unidad como "alta por volante".
//   - volante_vigencia:      hasta cuándo vale el volante (5 días hábiles).
//   - volante_confirmado_en: cuándo se confirmaron los datos con la unidad física. Vacío = pendiente de confirmar.
// Revisión de duplicados (Roberto: "¿qué pasaría si la unidad ingresa en otra fecha por otro siniestro?"): solo se
// compara contra unidades por volante PENDIENTES de confirmar y activas; nunca bloquea, solo pregunta.
const EXPLICACION = 'Alta por volante: la aseguradora nos asignó esta unidad y la dimos de alta con los datos del volante del ajustador, antes de que llegue. Cuando llegue, confirma esos datos con la unidad y el cliente.';

function asegurarColumnas(db){
  for(const [col, tipo] of [['volante_origen','TEXT'], ['volante_vigencia','TEXT'], ['volante_confirmado_en','TEXT']]){
    if(!db.prepare(`SELECT 1 FROM pragma_table_info('siniestros') WHERE name=?`).get(col)) db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${tipo}`);
  }
}

const limpiarPlaca = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pendiente = s => !!(s && s.volante_origen && !s.volante_confirmado_en);

// Unidad por volante pendiente (activa) con las mismas placas o VIN, de otro número de siniestro.
function buscarCoincidencia(db, { placas, vin, numero, excluirId } = {}){
  const p = limpiarPlaca(placas), v = limpiarPlaca(vin);
  if((!p || p.length < 5 || /^(SP|PENDIENTE)$/.test(p)) && (!v || v.length < 11)) return null;
  const candidatas = db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas, vin, volante_origen, volante_vigencia FROM siniestros
    WHERE volante_origen IS NOT NULL AND volante_origen != '' AND (volante_confirmado_en IS NULL OR volante_confirmado_en = '')
      AND archivado = 0 AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '')`).all();
  return candidatas.find(c => c.id !== excluirId && String(c.numero).trim() !== String(numero || '').trim()
    && ((p.length >= 5 && limpiarPlaca(c.placas) === p) || (v.length >= 11 && limpiarPlaca(c.vin) === v))) || null;
}

function mensajeCoincidencia(c){
  return `Ya hay un ${c.vehiculo || 'vehículo'} ${c.placas || ''} asignado por volante de ${c.volante_origen} (siniestro ${c.numero}) que no ha llegado. ¿Es la misma unidad?`;
}

module.exports = { EXPLICACION, asegurarColumnas, buscarCoincidencia, mensajeCoincidencia, pendiente, limpiarPlaca };
