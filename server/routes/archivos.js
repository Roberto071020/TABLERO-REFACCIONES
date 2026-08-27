const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, verificarDisponibleParaRevision } = require('../utils');
const router = express.Router();

const UPLOAD_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, '..', '..', 'uploads');
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive:true });

const ALLOWED_MIME = ['application/pdf','image/jpeg','image/png','image/webp','image/heic'];
const storage = multer.diskStorage({
  destination: (req,file,cb)=> cb(null, UPLOAD_DIR),
  filename: (req,file,cb)=> cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req,file,cb)=>{
    if(!ALLOWED_MIME.includes(file.mimetype)) return cb(new Error('Tipo de archivo no permitido. Solo PDF o imágenes (jpg, png, webp, heic).'));
    cb(null, true);
  }
});

// F-19: guarda el archivo real en disco (no solo el nombre) con metadatos en base de datos.
router.post('/', requireAuth, upload.single('archivo'), (req, res)=>{
  if(!req.file) return res.status(400).json({ error:'No se recibió ningún archivo.' });
  const { entidad_tipo, entidad_id, tipo } = req.body;
  if(!['siniestro','pedido','pieza','incidencia'].includes(entidad_tipo)) return res.status(400).json({ error:'entidad_tipo inválido.' });
  const info = db.prepare(`INSERT INTO archivos (entidad_tipo,entidad_id,tipo,nombre_original,nombre_almacenado,mime,tamano,subido_por)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(entidad_tipo, entidad_id, tipo||'Evidencia', req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'archivo', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:req.file.originalname });

  // Propuesta de Orlando (sección 3.1): la orden de admisión y el inventario fotográfico/físico son,
  // junto con llaves y dado de seguridad, requisitos para que el vehículo quede disponible para revisión.
  if(entidad_tipo === 'siniestro' && (tipo === 'inventario_fisico' || tipo === 'orden_admision')){
    verificarDisponibleParaRevision(db, entidad_id, req.session.user);
  }

  res.status(201).json(db.prepare('SELECT * FROM archivos WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireAuth, (req, res)=>{
  const { entidad_tipo, entidad_id, incluir_eliminados } = req.query;
  let sql = 'SELECT * FROM archivos WHERE 1=1'; const params=[];
  if(entidad_tipo){ sql += ' AND entidad_tipo=?'; params.push(entidad_tipo); }
  if(entidad_id){ sql += ' AND entidad_id=?'; params.push(entidad_id); }
  // Item 7 del triage (REQ-018): por default no se muestran los archivos eliminados (papelera),
  // igual que "archivado" en siniestros — siguen existiendo, solo no estorban la vista normal.
  if(!incluir_eliminados) sql += ' AND eliminado = 0';
  sql += ' ORDER BY creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id/descargar', requireAuth, (req, res)=>{
  const a = db.prepare('SELECT * FROM archivos WHERE id = ?').get(req.params.id);
  if(!a) return res.status(404).json({ error:'Archivo no encontrado.' });
  const filePath = path.join(UPLOAD_DIR, a.nombre_almacenado);
  if(!fs.existsSync(filePath)) return res.status(404).json({ error:'El archivo ya no está disponible en disco.' });
  res.download(filePath, a.nombre_original);
});

// Item 7 del triage (REQ-018): sustituir el archivo (ej. una versión corregida del mismo documento).
// El archivo anterior NO se borra del disco: queda en archivos_versiones_anteriores, recuperable.
router.patch('/:id/sustituir', requireAuth, upload.single('archivo'), (req, res)=>{
  const a = db.prepare('SELECT * FROM archivos WHERE id = ?').get(req.params.id);
  if(!a){ if(req.file) fs.unlink(path.join(UPLOAD_DIR, req.file.filename), ()=>{}); return res.status(404).json({ error:'Archivo no encontrado.' }); }
  if(!req.file) return res.status(400).json({ error:'No se recibió ningún archivo de reemplazo.' });
  db.prepare(`INSERT INTO archivos_versiones_anteriores (archivo_id,version,nombre_original,nombre_almacenado,mime,tamano,reemplazado_por)
    VALUES (?,?,?,?,?,?,?)`).run(a.id, a.version, a.nombre_original, a.nombre_almacenado, a.mime, a.tamano, req.session.user.id);
  db.prepare(`UPDATE archivos SET nombre_original=?, nombre_almacenado=?, mime=?, tamano=?, version=version+1 WHERE id=?`)
    .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, a.id);
  registrarAuditoria(db, { entidad_tipo:'archivo', entidad_id:a.id, accion:'sustitucion', usuario:req.session.user,
    valor_anterior:`v${a.version}: ${a.nombre_original}`, valor_nuevo:`v${a.version+1}: ${req.file.originalname}` });
  res.json(db.prepare('SELECT * FROM archivos WHERE id = ?').get(a.id));
});

// Item 7 del triage (REQ-018): eliminación recuperable (papelera), nunca borrado físico inmediato —
// mismo criterio que el resto del sistema (SEG-007: evitar borrado irreversible).
router.delete('/:id', requireAuth, (req, res)=>{
  const a = db.prepare('SELECT * FROM archivos WHERE id = ?').get(req.params.id);
  if(!a) return res.status(404).json({ error:'Archivo no encontrado.' });
  if(a.eliminado) return res.status(400).json({ error:'Este archivo ya está en la papelera.' });
  db.prepare(`UPDATE archivos SET eliminado=1, eliminado_en=datetime('now'), eliminado_por=? WHERE id=?`).run(req.session.user.id, a.id);
  registrarAuditoria(db, { entidad_tipo:'archivo', entidad_id:a.id, accion:'eliminacion', usuario:req.session.user, valor_anterior:a.nombre_original });
  res.json({ ok:true });
});

router.post('/:id/restaurar', requireAuth, (req, res)=>{
  const a = db.prepare('SELECT * FROM archivos WHERE id = ?').get(req.params.id);
  if(!a) return res.status(404).json({ error:'Archivo no encontrado.' });
  if(!a.eliminado) return res.status(400).json({ error:'Este archivo no está en la papelera.' });
  db.prepare(`UPDATE archivos SET eliminado=0, eliminado_en=NULL, eliminado_por=NULL WHERE id=?`).run(a.id);
  registrarAuditoria(db, { entidad_tipo:'archivo', entidad_id:a.id, accion:'restauracion', usuario:req.session.user, valor_nuevo:a.nombre_original });
  res.json(db.prepare('SELECT * FROM archivos WHERE id = ?').get(a.id));
});

module.exports = router;
