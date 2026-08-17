const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria } = require('../utils');
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
  res.status(201).json(db.prepare('SELECT * FROM archivos WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireAuth, (req, res)=>{
  const { entidad_tipo, entidad_id } = req.query;
  let sql = 'SELECT * FROM archivos WHERE 1=1'; const params=[];
  if(entidad_tipo){ sql += ' AND entidad_tipo=?'; params.push(entidad_tipo); }
  if(entidad_id){ sql += ' AND entidad_id=?'; params.push(entidad_id); }
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

module.exports = router;
