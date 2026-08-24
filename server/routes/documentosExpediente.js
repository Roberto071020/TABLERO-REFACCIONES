// Checklist documental del expediente (Documento Maestro, módulo de Vanessa — sección 5.5).
// Mismo criterio que danos_evidencia: no hay DELETE, las correcciones se hacen con PATCH y quedan
// en auditoria. Un documento puede ligarse a un archivo real ya subido por /api/archivos.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['vanessa','admin','jefe'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  let sql = `SELECT de.*, u.nombre as autor_nombre, a.nombre_original as archivo_nombre
             FROM documentos_expediente de
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
  if(!b.siniestro_id) return res.status(400).json({ error:'El documento debe ligarse a un expediente.' });
  if(!b.tipo_documento || !String(b.tipo_documento).trim()) return res.status(400).json({ error:'Indica el tipo de documento.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  const ESTADOS = ['faltante','recibido','no_legible','no_aplica'];
  if(b.estado && !ESTADOS.includes(b.estado)) return res.status(400).json({ error:'Estado de documento inválido.' });
  if(b.archivo_id){
    const archivo = db.prepare('SELECT id FROM archivos WHERE id = ?').get(b.archivo_id);
    if(!archivo) return res.status(400).json({ error:'El archivo indicado no existe.' });
  }

  const info = db.prepare(`INSERT INTO documentos_expediente (siniestro_id,tipo_documento,version,estado,folio,notas,archivo_id,autor_id)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, String(b.tipo_documento).trim(), b.version||1, b.estado||'faltante', b.folio||'', b.notas||'', b.archivo_id||null, req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'documento_expediente', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user,
    valor_nuevo: `${b.tipo_documento} (${b.estado||'faltante'})` });
  res.status(201).json(db.prepare(`SELECT de.*, u.nombre as autor_nombre FROM documentos_expediente de LEFT JOIN usuarios u ON u.id=de.autor_id WHERE de.id=?`).get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM documentos_expediente WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Documento no encontrado.' });
  const campos = ['tipo_documento','version','estado','folio','notas','archivo_id'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  const ESTADOS = ['faltante','recibido','no_legible','no_aplica'];
  if(nuevo.estado && !ESTADOS.includes(nuevo.estado)) return res.status(400).json({ error:'Estado de documento inválido.' });

  db.prepare(`UPDATE documentos_expediente SET tipo_documento=?,version=?,estado=?,folio=?,notas=?,archivo_id=?,
      actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.tipo_documento, nuevo.version, nuevo.estado, nuevo.folio, nuevo.notas, nuevo.archivo_id||null, req.params.id);
  auditarCambios(db, { entidad_tipo:'documento_expediente', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare(`SELECT de.*, u.nombre as autor_nombre FROM documentos_expediente de LEFT JOIN usuarios u ON u.id=de.autor_id WHERE de.id=?`).get(req.params.id));
});

module.exports = router;
