// ===================== Inicio de Orlando (6-nov-2026) =====================
// Mismo principio que Beto, Alejandra y Daniela: una pantalla de celular que dice QUÉ hacer, EN QUÉ ORDEN
// y CON QUÉ BOTÓN. Proceso confirmado por Roberto (6-nov-2026):
//   1) Fotos editadas para reautorizar -> piezas que la aseguradora no autorizó; plazo de 24 h (Roberto
//      las solicita desde Valuación). Lo primero, en rojo, con las horas que quedan.
//   2) Revisar unidades nuevas         -> disponibles para revisión (Alejandra ya las recibió), la más vieja primero.
//   3) Terminar las que esperaban desarme.
//   4) Complementos por daño oculto     -> los que salen en producción (Beto u Orlando los registran).
//   5) Captura (antes Vanessa)          -> una tarjeta por unidad con el siguiente paso: capturado en Excel ->
//                                          fotos y carpeta completas -> enviado a Roberto.
// Para no llenarle la pantalla con datos viejos, revisión y captura solo consideran unidades que todavía no
// tienen autorización ni producción iniciada (si ya se autorizó, esa parte ya se hizo).
const HORAS_REAUTORIZACION = 24;

// Acepta 'YYYY-MM-DD HH:MM:SS' (UTC, como lo guarda SQLite) o ISO completo.
function aMs(v){ if(!v) return NaN; const t = String(v); return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); }
const SIN_AVANZAR = `(s.estado_autorizacion IS NULL OR s.estado_autorizacion = '' OR s.estado_autorizacion IN ('en_autorizacion','por_aclarar'))
  AND (s.estado_produccion IS NULL OR s.estado_produccion = '')`;

function calcularInicioOrlando(db){
  const ahora = Date.now();
  const base = 's.id AS siniestro_id, s.numero AS siniestro_numero, s.vehiculo, s.placas, s.aseguradora, s.cliente_nombre';

  const reautorizar = db.prepare(`SELECT c.id, c.pieza_operacion, c.causa, c.fecha_limite, c.estado, c.creado_en, c.actualizado_en, c.reincidencia, c.con_daniela, c.con_daniela_nota, c.con_daniela_desde, ${base}
    FROM complementos c JOIN siniestros s ON s.id = c.siniestro_id
    WHERE c.tipo = 'no_autorizado_inicial' AND c.decision = 'pendiente' AND c.estado IN ('detectado','documentando') AND s.archivado = 0
    ORDER BY c.fecha_limite ASC`).all().map(c => {
      const fotos = db.prepare(`SELECT COUNT(*) n FROM archivos WHERE entidad_tipo='siniestro' AND entidad_id=? AND tipo='foto' AND etapa='reautorizacion' AND eliminado=0 AND creado_en >= ?`)
        .get(c.siniestro_id, String(c.creado_en)).n;
      // 13-nov-2026: con Daniela el reloj está detenido (horas_restantes = null).
      return { ...c, horas_restantes: c.fecha_limite && !c.con_daniela ? Math.round((aMs(c.fecha_limite) - ahora) / 3600000) : null, fotos_editadas: fotos };
    });

  const revisar = db.prepare(`SELECT ${base}, s.estado_revision_tecnica, s.fecha_hora_disponible_revision, s.ingreso_tipo
    FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado' AND s.fecha_hora_disponible_revision IS NOT NULL
      AND (s.valuacion_fecha_envio IS NULL OR s.valuacion_fecha_envio = '')
      AND (s.estado_revision_tecnica IS NULL OR s.estado_revision_tecnica = '' OR s.estado_revision_tecnica = 'en_revision')
      AND ${SIN_AVANZAR}
    ORDER BY s.fecha_hora_disponible_revision ASC`).all()
    .map(s => ({ ...s, dias_esperando: Math.max(0, Math.floor((ahora - aMs(s.fecha_hora_disponible_revision)) / 86400000)) || 0 }));

  const desarme = db.prepare(`SELECT ${base}, s.actualizado_en
    FROM siniestros s WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado' AND s.estado_revision_tecnica = 'requiere_desarme'
    ORDER BY s.actualizado_en ASC`).all();

  const complementos = db.prepare(`SELECT c.id, c.causa, c.pieza_operacion, c.estado, c.creado_en, ${base}, s.estado_produccion
    FROM complementos c JOIN siniestros s ON s.id = c.siniestro_id
    WHERE c.tipo = 'dano_oculto' AND c.decision = 'pendiente' AND c.estado IN ('detectado','documentando') AND s.archivado = 0
    ORDER BY c.creado_en ASC`).all();

  const captura = db.prepare(`SELECT ${base}, s.excel_capturado, s.fotos_completas, s.enviado_propietario, s.revision_tecnica_terminada_en
    FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado' AND s.estado_revision_tecnica = 'revision_terminada'
      AND COALESCE(s.enviado_propietario, 0) = 0 AND (s.valuacion_fecha_envio IS NULL OR s.valuacion_fecha_envio = '')
      -- 13-nov-2026 (Orlando): "para que no me afecte en el indicador los autosurtidos para envío a valuación, ya que
      -- esos se valúan al ingreso de la unidad a reparar" -> autosurtido sin reingreso no va a captura.
      AND NOT (COALESCE(s.tipo_reparacion,'') = 'AUTO_SURTIDO' AND COALESCE(s.autosurtido_reingreso_en,'') = '')
      AND ${SIN_AVANZAR}
    ORDER BY s.revision_tecnica_terminada_en ASC`).all()
    .map(s => ({ ...s, paso: !s.excel_capturado ? 'excel' : !s.fotos_completas ? 'fotos' : 'enviar' }));

  // 13-nov-2026 (Orlando): "que me permita editar los expedientes ya que estén revisados por si cambia de tipo de
  // reparación" -> sus revisiones de los últimos 15 días que todavía no se entregan.
  const revisadas = db.prepare(`SELECT ${base}, s.tipo_reparacion, s.revision_tecnica_terminada_en
    FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado' AND s.estado_revision_tecnica = 'revision_terminada'
      AND s.revision_tecnica_terminada_en >= datetime('now','-15 days')
      AND (s.fecha_entrega_real IS NULL OR s.fecha_entrega_real = '')
    ORDER BY s.revision_tecnica_terminada_en DESC`).all();

  const numeros = {
    reautorizar: reautorizar.length,
    revisar: revisar.length,
    desarme: desarme.length,
    complementos: complementos.length + reautorizar.length,
    por_enviar: captura.length,
  };
  return { numeros, reautorizar, revisar, desarme, complementos, captura, revisadas, horas_reautorizacion: HORAS_REAUTORIZACION };
}

module.exports = { calcularInicioOrlando };
