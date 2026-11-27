// ===================== Juntar unidades duplicadas (27-nov-2026) =====================
// Roberto (27-nov-2026), al ver que el Arona, el Versa 2017 y el Focus 2016 de Mapfre estaban dos veces en el tablero
// (una de la recepción de Ale con el número sin la terminación de Mapfre y otra del expediente/LIBRETA): "Hazlo"
// (juntarlas). La unidad DESTINO (la buena, con el número de la LIBRETA) se queda; la DUPLICADA:
//   - le pasa todo lo que cuelga de ella (fotos, inventario, OT, pedidos, tareas, avisos al cliente, WhatsApp, patio…),
//   - llena en la buena los datos de recepción que ésta no tenga (teléfono, correo, fecha de admisión, llaves…),
//   - queda archivada como "Fusionado" con una nota hacia la buena. No se borra nada; todo queda en la auditoría.
const DATOS_RECEPCION = ['cliente_nombre','cliente_telefono','cliente_correo','cliente_notas','fecha_admision','ingreso_tipo','ingreso_seguro',
  'llaves_entregadas','requiere_dado_seguridad','dado_seguridad_colocado','grupo_whatsapp_creado','orden_admision','canal_origen',
  'tipo_reparacion','vin','anio_modelo','cita_fecha','reingreso_recibido_en','encuesta_estado'];

const vacio = v => v === null || v === undefined || String(v).trim() === '' || v === 0;

function columnas(db, tabla){ return db.prepare(`SELECT name FROM pragma_table_info(?)`).all(tabla).map(c => c.name); }

function fusionar(db, duplicadaId, destinoId, usuario, registrarAuditoria){
  const dup = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(duplicadaId);
  const dst = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(destinoId);
  if(!dup || !dst) throw new Error('Unidad no encontrada.');
  if(dup.id === dst.id) throw new Error('Es la misma unidad.');
  const movidos = {};
  db.exec('BEGIN');
  try{
    // 1) Todo lo que cuelga de la duplicada pasa a la buena. OR IGNORE: si choca con algo único que ya tiene la buena
    //    (p. ej. el mismo hito), se queda en la duplicada archivada, sin perderse.
    const tablas = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name != 'siniestros'`).all().map(t => t.name);
    for(const t of tablas){
      const cols = columnas(db, t);
      if(cols.includes('siniestro_id')){
        const n = db.prepare(`UPDATE OR IGNORE ${t} SET siniestro_id = ? WHERE siniestro_id = ?`).run(dst.id, dup.id).changes;
        if(n) movidos[t] = n;
      }
      if(cols.includes('entidad_tipo') && cols.includes('entidad_id') && t !== 'auditoria'){
        const n = db.prepare(`UPDATE OR IGNORE ${t} SET entidad_id = ? WHERE entidad_tipo = 'siniestro' AND entidad_id = ?`).run(dst.id, dup.id).changes;
        if(n) movidos[t] = (movidos[t] || 0) + n;
      }
    }
    // 2) Datos de recepción que la buena no tenga.
    const colsS = columnas(db, 'siniestros');
    const llenar = {};
    for(const c of DATOS_RECEPCION){
      if(colsS.includes(c) && vacio(dst[c]) && !vacio(dup[c])) llenar[c] = dup[c];
    }
    // Si los nombres no coinciden y nos quedamos con el de la buena, el contacto de recepción queda en la nota.
    let nota = String(dst.notas || '');
    if(!vacio(dst.cliente_nombre) && !vacio(dup.cliente_nombre) && String(dst.cliente_nombre).trim().toUpperCase() !== String(dup.cliente_nombre).trim().toUpperCase()){
      nota += (nota ? '\n' : '') + `Contacto registrado en recepción: ${dup.cliente_nombre}${dup.cliente_telefono ? ' (' + dup.cliente_telefono + ')' : ''}.`;
    }
    nota += (nota ? '\n' : '') + `${new Date().toISOString().slice(0,10)}: se juntó con la unidad duplicada ${dup.numero} (recepción).`;
    llenar.notas = nota;
    if(colsS.includes('fecha_hora_disponible_revision') && dup.fecha_hora_disponible_revision
      && (!dst.fecha_hora_disponible_revision || dup.fecha_hora_disponible_revision < dst.fecha_hora_disponible_revision)){
      llenar.fecha_hora_disponible_revision = dup.fecha_hora_disponible_revision; // la fecha real en que estuvo lista para revisión
    }
    const sets = Object.keys(llenar);
    db.prepare(`UPDATE siniestros SET ${sets.map(c => c + ' = ?').join(', ')}, actualizado_en = datetime('now') WHERE id = ?`).run(...sets.map(c => llenar[c]), dst.id);
    // 3) La duplicada queda archivada como historial.
    db.prepare(`UPDATE siniestros SET archivado = 1, archivado_en = datetime('now'), estatus_general = 'Fusionado',
      notas = trim(COALESCE(notas,'') || char(10) || ?), actualizado_en = datetime('now') WHERE id = ?`)
      .run(`Duplicada: se juntó en ${dst.numero} (id ${dst.id}).`, dup.id);
    registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:dst.id, accion:'fusion', valor_anterior: dup.numero,
      valor_nuevo:`Se juntó la duplicada ${dup.numero}: ${JSON.stringify(movidos)}; datos: ${sets.filter(c => c !== 'notas').join(', ') || 'ninguno'}`, usuario });
    registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:dup.id, accion:'fusion', valor_nuevo:`Juntada en ${dst.numero}`, usuario });
    db.exec('COMMIT');
  }catch(e){ db.exec('ROLLBACK'); throw e; }
  return { destino: db.prepare('SELECT * FROM siniestros WHERE id = ?').get(dst.id), movidos };
}

module.exports = { fusionar };
