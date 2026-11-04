// Fotos de la unidad (4-nov-2026) -- ver server/fotos.js. Cualquier usuario con sesión puede subir, ver y
// descargar fotos (pedido de Roberto: "que todos las puedan ver y descargar a sus equipos").
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const F = require('../fotos');
const router = express.Router();

F.asegurarEsquemaFotos(db);
if(!fs.existsSync(F.UPLOAD_DIR)) fs.mkdirSync(F.UPLOAD_DIR, { recursive:true });

const IMAGENES = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const EXT = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp', 'image/heic':'.heic', 'image/heif':'.heic' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, F.UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `foto-${Date.now()}-${Math.round(Math.random()*1e9)}${file.fieldname === 'miniatura' ? '-mini' : ''}${EXT[file.mimetype] || '.jpg'}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if(!IMAGENES.includes(file.mimetype)) return cb(new Error('Solo se aceptan fotos (jpg, png, webp, heic).'));
    cb(null, true);
  }
});

function borrarSubidos(req){
  for(const lista of Object.values(req.files || {})) for(const f of lista) fs.unlink(f.path, ()=>{});
}

// Sube UNA foto (el celular manda varias, una tras otra, para mostrar avance y no perder todo si falla una).
router.post('/', requireAuth, upload.fields([{ name:'foto', maxCount:1 }, { name:'miniatura', maxCount:1 }]), (req, res)=>{
  const foto = req.files && req.files.foto && req.files.foto[0];
  const mini = req.files && req.files.miniatura && req.files.miniatura[0];
  if(!foto){ borrarSubidos(req); return res.status(400).json({ error:'No se recibió ninguna foto.' }); }
  const siniestroId = Number(req.body.siniestro_id);
  const etapa = String(req.body.etapa || '');
  const s = db.prepare('SELECT id, numero FROM siniestros WHERE id = ?').get(siniestroId);
  if(!s){ borrarSubidos(req); return res.status(404).json({ error:'La unidad no existe.' }); }
  if(!F.ETAPAS_FOTO.includes(etapa)){ borrarSubidos(req); return res.status(400).json({ error:'Etapa de foto no válida.' }); }
  const info = db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, etapa, nombre_original, nombre_almacenado, miniatura, mime, tamano, subido_por)
    VALUES ('siniestro', ?, 'foto', ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.id, etapa, foto.originalname || 'foto.jpg', foto.filename, mini ? mini.filename : null, foto.mimetype, foto.size + (mini ? mini.size : 0), req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'foto_subida', campo:'etapa', valor_nuevo: F.ETIQUETA_ETAPA_FOTO[etapa], usuario:req.session.user });
  res.status(201).json({ id: Number(info.lastInsertRowid), etapa });
});

// Lista de fotos de una unidad: las nuevas (tipo 'foto', con etapa) y cualquier imagen subida antes como archivo
// (inventario, evidencia de operaciones de OT, etc.), que aparece en "Otras".
function fotosDeUnidad(siniestroId, etapa){
  let sql = `SELECT a.id, COALESCE(a.etapa, 'otra') etapa, a.tipo, a.nombre_original, a.mime, a.tamano, a.creado_en, a.subido_por,
      (a.miniatura IS NOT NULL) tiene_miniatura, u.nombre subido_por_nombre
    FROM archivos a LEFT JOIN usuarios u ON u.id = a.subido_por
    WHERE a.entidad_tipo='siniestro' AND a.entidad_id=? AND a.eliminado=0 AND a.mime LIKE 'image/%'`;
  const params = [siniestroId];
  if(etapa){ sql += ` AND COALESCE(a.etapa,'otra') = ?`; params.push(etapa); }
  return db.prepare(sql + ' ORDER BY a.creado_en ASC, a.id ASC').all(...params);
}

router.get('/', requireAuth, (req, res)=>{
  const siniestroId = Number(req.query.siniestro_id);
  if(!siniestroId) return res.status(400).json({ error:'Falta siniestro_id.' });
  const fotos = fotosDeUnidad(siniestroId);
  const usuario = req.session.user;
  const puedeBorrarTodo = ['admin','jefe'].includes(usuario.rol);
  res.json({
    etapas: F.ETAPAS_FOTO.map(e => ({ etapa:e, etiqueta:F.ETIQUETA_ETAPA_FOTO[e], obligatoria:F.ETAPAS_CON_FOTO_OBLIGATORIA.includes(e) || e === 'terminado' })),
    fotos: fotos.map(f => ({ ...f, tiene_miniatura: !!f.tiene_miniatura, puede_borrar: puedeBorrarTodo || f.subido_por === usuario.id }))
  });
});

function archivoImagen(id){
  return db.prepare(`SELECT * FROM archivos WHERE id = ? AND mime LIKE 'image/%' AND eliminado = 0`).get(id);
}

// Ver la foto dentro de la página (no como descarga). ?mini=1 regresa la miniatura si existe.
router.get('/:id/imagen', requireAuth, (req, res)=>{
  const a = archivoImagen(req.params.id);
  if(!a) return res.status(404).json({ error:'Foto no encontrada.' });
  const nombre = (req.query.mini && a.miniatura) ? a.miniatura : a.nombre_almacenado;
  const p = path.join(F.UPLOAD_DIR, nombre);
  if(!fs.existsSync(p)) return res.status(404).json({ error:'La foto ya no está disponible.' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(nombre.endsWith('.jpg') ? 'image/jpeg' : a.mime).sendFile(p);
});

function nombreDescarga(s, a, n){
  const ext = path.extname(a.nombre_almacenado) || '.jpg';
  const etiqueta = F.ETIQUETA_ETAPA_FOTO[a.etapa || 'otra'] || 'Foto';
  return `${s.numero}_${etiqueta}_${String(n).padStart(2,'0')}${ext}`.replace(/[\\/:*?"<>|\s]+/g, '_');
}

router.get('/:id/descargar', requireAuth, (req, res)=>{
  const a = archivoImagen(req.params.id);
  if(!a) return res.status(404).json({ error:'Foto no encontrada.' });
  const s = db.prepare('SELECT numero FROM siniestros WHERE id = ?').get(a.entidad_id) || { numero:'unidad' };
  const p = path.join(F.UPLOAD_DIR, a.nombre_almacenado);
  if(!fs.existsSync(p)) return res.status(404).json({ error:'La foto ya no está disponible.' });
  const misma = fotosDeUnidad(a.entidad_id, a.etapa || 'otra');
  res.download(p, nombreDescarga(s, a, misma.findIndex(x => x.id === a.id) + 1));
});

// Todas las fotos de la unidad (o de una etapa) en un solo .zip, organizadas por carpeta de etapa.
router.get('/zip', requireAuth, (req, res)=>{
  const siniestroId = Number(req.query.siniestro_id);
  const s = db.prepare('SELECT id, numero FROM siniestros WHERE id = ?').get(siniestroId);
  if(!s) return res.status(404).json({ error:'La unidad no existe.' });
  const fotos = fotosDeUnidad(s.id, req.query.etapa || null);
  const contador = {};
  const entradas = [];
  for(const f of fotos){
    const a = db.prepare('SELECT * FROM archivos WHERE id = ?').get(f.id);
    const p = path.join(F.UPLOAD_DIR, a.nombre_almacenado);
    if(!fs.existsSync(p)) continue;
    const etapa = a.etapa || 'otra';
    contador[etapa] = (contador[etapa] || 0) + 1;
    const orden = String(F.ETAPAS_FOTO.indexOf(etapa) + 1).padStart(2, '0');
    entradas.push({ nombre: `${orden}_${F.ETIQUETA_ETAPA_FOTO[etapa]}/${nombreDescarga(s, a, contador[etapa])}`,
      datos: fs.readFileSync(p), fecha: new Date(String(a.creado_en).replace(' ', 'T') + 'Z') });
  }
  if(!entradas.length) return res.status(404).json({ error:'Esta unidad todavía no tiene fotos.' });
  const zip = F.crearZip(entradas);
  const nombre = `Fotos_${s.numero}${req.query.etapa ? '_' + F.ETIQUETA_ETAPA_FOTO[req.query.etapa] : ''}.zip`.replace(/[\\/:*?"<>|\s]+/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(zip);
});

// Quitar una foto (subida por error). Va a la papelera de Archivos; solo quien la subió o el propietario/jefe.
router.delete('/:id', requireAuth, (req, res)=>{
  const a = archivoImagen(req.params.id);
  if(!a) return res.status(404).json({ error:'Foto no encontrada.' });
  if(!(['admin','jefe'].includes(req.session.user.rol) || a.subido_por === req.session.user.id)){
    return res.status(403).json({ error:'Solo quien subió la foto o el propietario pueden quitarla.' });
  }
  db.prepare(`UPDATE archivos SET eliminado=1, eliminado_en=datetime('now'), eliminado_por=? WHERE id=?`).run(req.session.user.id, a.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:a.entidad_id, accion:'foto_eliminada', valor_anterior:a.nombre_original, usuario:req.session.user });
  res.json({ ok:true });
});

// Espacio usado del disco (para el propietario/jefe).
router.get('/espacio', requireAuth, requireRole('admin','jefe'), (req, res)=>{
  const u = F.usoDisco();
  const fotos = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(tamano),0) b FROM archivos WHERE mime LIKE 'image/%' AND purgado_en IS NULL AND eliminado = 0`).get();
  const ultima = db.prepare(`SELECT * FROM fotos_limpieza ORDER BY id DESC LIMIT 1`).get() || null;
  res.json({ disco: u, fotos: fotos.n, fotos_bytes: fotos.b, ultima_limpieza: ultima });
});

module.exports = router;
