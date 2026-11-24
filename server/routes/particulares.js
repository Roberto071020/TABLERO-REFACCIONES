// 24-nov-2026: apartado de Particulares (ver server/particulares.js).
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const P = require('../particulares');
const router = express.Router();

const ROLES = ['beto','atencion_cliente','operativo','admin','jefe'];
const responder = (res, e) => res.status(e.status || 500).json({ error: e.message || 'Error.' });

router.get('/', requireAuth, requireRole(...ROLES), (req, res) => {
  res.json({ unidades: P.listar(db), historial: req.query.historial ? P.listar(db, { historial:true }) : undefined });
});

// Beto lo da de alta con el cliente enfrente (también Alejandra y Roberto).
router.post('/', requireAuth, requireRole('beto','atencion_cliente','admin','jefe'), (req, res) => {
  try{
    const p = P.crear(db, req.body || {}, req.session.user);
    registrarAuditoria(db, { entidad_tipo:'particular', entidad_id:p.id, accion:'alta', valor_nuevo:`${p.vehiculo} · ${p.cliente_nombre} · ${p.trabajo} · $${p.monto}`, usuario:req.session.user });
    res.status(201).json(p);
  }catch(e){ responder(res, e); }
});

// Corregir datos (Beto, Alejandra o Roberto).
const EDITABLES = ['cliente_nombre','cliente_telefono','vehiculo','placas','trabajo','monto','piezas','notas'];
router.patch('/:id', requireAuth, requireRole('beto','atencion_cliente','admin','jefe'), (req, res) => {
  P.asegurarTabla(db);
  const p = db.prepare('SELECT * FROM particulares WHERE id = ?').get(req.params.id);
  if(!p) return res.status(404).json({ error:'No encontrada.' });
  const b = req.body || {};
  for(const c of EDITABLES){
    if(b[c] === undefined) continue;
    let v = c === 'monto' ? Number(String(b[c]).replace(/[$,\s]/g, '')) : String(b[c]).trim();
    if(c === 'monto' && (isNaN(v) || v <= 0)) return res.status(400).json({ error:'El monto no es válido.' });
    if(c === 'placas') v = v.toUpperCase();
    if(String(p[c] ?? '') === String(v)) continue;
    db.prepare(`UPDATE particulares SET ${c} = ?, actualizado_en = datetime('now') WHERE id = ?`).run(v, p.id);
    registrarAuditoria(db, { entidad_tipo:'particular', entidad_id:p.id, accion:'edicion', campo:c, valor_anterior:p[c], valor_nuevo:v, usuario:req.session.user });
  }
  res.json(P.obtener(db, p.id));
});

router.post('/:id/accion', requireAuth, requireRole(...ROLES), (req, res) => {
  P.asegurarTabla(db);
  const p = db.prepare('SELECT * FROM particulares WHERE id = ?').get(req.params.id);
  if(!p) return res.status(404).json({ error:'No encontrada.' });
  const a = String((req.body || {}).accion || '');
  if(!P.puede(req.session.user.rol, a)) return res.status(403).json({ error:'Este paso no te toca.' });
  try{
    const cambios = P.accion(db, p, a, req.body || {});
    const campos = Object.keys(cambios);
    if(campos.length){
      db.prepare(`UPDATE particulares SET ${campos.map(c => c + ' = ?').join(', ')}, actualizado_en = datetime('now') WHERE id = ?`).run(...campos.map(c => cambios[c]), p.id);
      for(const c of campos) registrarAuditoria(db, { entidad_tipo:'particular', entidad_id:p.id, accion:a, campo:c, valor_anterior:p[c], valor_nuevo:cambios[c], usuario:req.session.user });
    }
    res.json(P.obtener(db, p.id));
  }catch(e){ responder(res, e); }
});

// 24-nov-2026. Roberto: "sería bueno que se tomaran las fotos de los daños ya que algunas veces cuando regresa tiene un
// daño adicional en la misma pieza". Mismo formato que las fotos de la unidad (el celular manda foto + miniatura).
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { UPLOAD_DIR } = require('../fotos');
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive:true });
const IMAGENES = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp', 'image/heic':'.heic', 'image/heif':'.heic' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `part-${Date.now()}-${Math.round(Math.random()*1e9)}${file.fieldname === 'miniatura' ? '-mini' : ''}${IMAGENES[file.mimetype] || '.jpg'}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => IMAGENES[file.mimetype] ? cb(null, true) : cb(new Error('Solo se aceptan fotos.'))
});
router.post('/:id/fotos', requireAuth, requireRole(...ROLES), upload.fields([{ name:'foto', maxCount:1 }, { name:'miniatura', maxCount:1 }]), (req, res) => {
  const foto = req.files && req.files.foto && req.files.foto[0];
  const mini = req.files && req.files.miniatura && req.files.miniatura[0];
  const borrar = () => { for(const l of Object.values(req.files || {})) for(const f of l) fs.unlink(f.path, () => {}); };
  if(!foto){ borrar(); return res.status(400).json({ error:'No se recibió ninguna foto.' }); }
  P.asegurarTabla(db);
  const p = db.prepare('SELECT id FROM particulares WHERE id = ?').get(req.params.id);
  if(!p){ borrar(); return res.status(404).json({ error:'No encontrada.' }); }
  const info = db.prepare(`INSERT INTO particulares_fotos (particular_id, nombre_almacenado, miniatura, mime, tamano, subido_por) VALUES (?,?,?,?,?,?)`)
    .run(p.id, foto.filename, mini ? mini.filename : null, foto.mimetype, foto.size + (mini ? mini.size : 0), req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'particular', entidad_id:p.id, accion:'foto_subida', valor_nuevo:'Foto del daño', usuario:req.session.user });
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});
router.get('/fotos/:fid', requireAuth, requireRole(...ROLES), (req, res) => {
  P.asegurarTabla(db);
  const f = db.prepare('SELECT * FROM particulares_fotos WHERE id = ? AND eliminado = 0').get(req.params.fid);
  if(!f) return res.status(404).json({ error:'Foto no encontrada.' });
  const nombre = (req.query.mini && f.miniatura) ? f.miniatura : f.nombre_almacenado;
  const ruta = path.join(UPLOAD_DIR, nombre);
  if(!fs.existsSync(ruta)) return res.status(404).json({ error:'La foto ya no está disponible.' });
  if(req.query.descargar) res.setHeader('Content-Disposition', `attachment; filename="particular_${f.particular_id}_dano_${f.id}${path.extname(nombre) || '.jpg'}"`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(nombre.endsWith('.jpg') ? 'image/jpeg' : (f.mime || 'image/jpeg')).sendFile(ruta);
});

module.exports = router;
