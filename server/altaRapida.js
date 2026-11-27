// ===================== Alta rápida para todos y "No reparar" (27-nov-2026) =====================
// Solicitud de Orlando (documento SOLICITUD_CAMBIOS_SC_CONTROL), aprobada por Roberto el 27-nov-2026.
//
// 1) ALTA RÁPIDA. Orlando: "habilitar el registro de unidades para mi perfil". Roberto: "¿consideras que todos
//    deberíamos poder registrar unidades? me dicen que muchas veces Ale no lo hace por no estar en su lugar".
//    Acordado: registra quien atiende al cliente o recibe la unidad (Orlando, Dani, Beto, Roberto; Ale con su
//    formulario de recepción). Reglas:
//      - Sin duplicados: si el siniestro ya existe no deja (ya existía); si las PLACAS coinciden con una unidad
//        activa, pregunta si es la misma antes de crear otra (puede ser otro siniestro del mismo carro).
//      - Registro corto: aseguradora, siniestro, vehículo, placas y si está en piso o en tránsito.
//      - Ale sigue siendo la dueña de la recepción: lo que registra otro le aparece a ella como
//        "Registrada por X: falta recibirla" hasta que la reciba (inventario/datos).
//
// 2) NO REPARAR. Orlando: "este Mustang, que al final no va a ingresar por siniestro, colocar alguna opción que diga
//    'unidad no reparar' y que haya un campo de texto libre para poder poner la explicación del porqué".
//    La unidad sale de todos los pendientes (se archiva, igual que un cierre) con su motivo, quién y cuándo.
//    Daniela o Roberto la pueden regresar a proceso si al final sí entra (botón "Regresar a proceso").
const { limpiarPlaca } = require('./volantes');

function asegurarColumnas(db){
  for(const [col, tipo] of [['alta_rapida_por','TEXT'], ['alta_rapida_en','TEXT'],
    ['no_reparar_motivo','TEXT'], ['no_reparar_en','TEXT'], ['no_reparar_por','TEXT']]){
    if(!db.prepare(`SELECT 1 FROM pragma_table_info('siniestros') WHERE name=?`).get(col)) db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${tipo}`);
  }
}

// Unidad ACTIVA (no archivada, no cerrada, no entregada) con las mismas placas y otro número de siniestro.
function buscarMismaPlaca(db, { placas, numero } = {}){
  const p = limpiarPlaca(placas);
  // Solo placas reales (5-8 caracteres con letras y números): "Por confirmar", "SIN PLACAS", etc. no cuentan.
  if(!p || p.length < 5 || p.length > 8 || !/\d/.test(p) || !/[A-Z]/.test(p)) return null;
  const candidatas = db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas FROM siniestros
    WHERE archivado = 0 AND estatus_general != 'Cerrado' AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '')`).all();
  return candidatas.find(c => String(c.numero).trim() !== String(numero || '').trim() && limpiarPlaca(c.placas) === p) || null;
}

function mensajeMismaPlaca(c){
  return `Ya hay un ${c.vehiculo || 'vehículo'} con placas ${c.placas} en proceso (${c.aseguradora || ''}, siniestro ${c.numero}). ¿Es la misma unidad?`;
}

const ROLES_NO_REPARAR = ['orlando', 'vanessa', 'atencion_cliente', 'operativo', 'beto', 'jefe', 'admin'];

module.exports = { asegurarColumnas, buscarMismaPlaca, mensajeMismaPlaca, ROLES_NO_REPARAR };
