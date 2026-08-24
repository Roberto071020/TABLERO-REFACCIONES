// Daños y evidencia (Documento Maestro, módulo de Orlando — revisión técnica, secciones 5.3/5.4).
// Un renglón por hallazgo/zona. No existe DELETE: el documento maestro prohíbe eliminar registros
// para corregir errores ("anular/corregir con trazabilidad"); las correcciones se hacen con PATCH
// y quedan en auditoria igual que en siniestros/pedidos.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['orlando','vanessa','admin','jefe'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  let sql = `SELECT de.*, u.nombre as autor_nombre, a.nombre_original as archivo_nombre
             FROM danos_evidencia de
             LEFT JOIN usuarios u ON u.id = de.autor_id
             LEFT JOIN archivos a ON a.id = de.archivo_id
             WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND de.siniestro_id = ?'; params.push(siniestro_id); }
  sql += ' ORDER BY de.creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'El hallazgo debe ligarse a un expediente.' });
  if(!b.zona_pieza || !String(b.zona_pieza).trim()) return res.status(400).json({ error:'Indica la zona o pieza afectada.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(b.visibilidad && !['visible','oculto'].includes(b.visibilidad)) return res.status(400).json({ error:'Visibilidad inválida.' });
  if(b.archivo_id){
    const archivo = db.prepare('SELECT id FROM archivos WHERE id = ?').get(b.archivo_id);
    if(!archivo) return res.status(400).json({ error:'El archivo/foto indicado no existe.' });
  }

  const info = db.prepare(`INSERT INTO danos_evidencia
      (siniestro_id,zona_pieza,tipo_dano,visibilidad,relacionado,severidad,operacion_preliminar,observaciones,archivo_id,autor_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, String(b.zona_pieza).trim(), b.tipo_dano||'', b.visibilidad||'visible',
         b.relacionado===false||b.relacionado===0||b.relacionado==='0' ? 0 : 1,
         b.severidad||'', b.operacion_preliminar||'', b.observaciones||'', b.archivo_id||null, req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'dano_evidencia', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user,
    valor_nuevo: `${b.zona_pieza} (${b.visibilidad||'visible'})` });
  res.status(201).json(db.prepare(`SELECT de.*, u.nombre as autor_nombre FROM danos_evidencia de LEFT JOIN usuarios u ON u.id=de.autor_id WHERE de.id=?`).get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM danos_evidencia WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Hallazgo no encontrado.' });
  const campos = ['zona_pieza','tipo_dano','visibilidad','relacionado','severidad','operacion_preliminar','observaciones','archivo_id'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.visibilidad && !['visible','oculto'].includes(nuevo.visibilidad)) return res.status(400).json({ error:'Visibilidad inválida.' });

  db.prepare(`UPDATE danos_evidencia SET zona_pieza=?,tipo_dano=?,visibilidad=?,relacionado=?,severidad=?,operacion_preliminar=?,observaciones=?,archivo_id=?,
      actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.zona_pieza, nuevo.tipo_dano, nuevo.visibilidad, nuevo.relacionado?1:0, nuevo.severidad, nuevo.operacion_preliminar, nuevo.observaciones, nuevo.archivo_id||null, req.params.id);
  auditarCambios(db, { entidad_tipo:'dano_evidencia', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare(`SELECT de.*, u.nombre as autor_nombre FROM danos_evidencia de LEFT JOIN usuarios u ON u.id=de.autor_id WHERE de.id=?`).get(req.params.id));
});

module.exports = router;
