// Revisión de piezas por el auxiliar de refacciones (12-nov-2026) -- ver server/revisionPiezas.js.
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria } = require('../utils');
const A = require('../asistencia');
const F = require('../fotos');
const R = require('../revisionPiezas');
const router = express.Router();

R.asegurarEsquema(db);
F.asegurarEsquemaFotos(db);
if(!fs.existsSync(F.UPLOAD_DIR)) fs.mkdirSync(F.UPLOAD_DIR, { recursive:true });

// Solo el auxiliar de refacciones (y Roberto). Igual que en patio: sin entrada del día no puede usarlo.
function soloAuxiliar(req, res, next){
  const u = req.session.user;
  if(!R.esAuxiliar(db, u)) return res.status(403).json({ error:'No tienes permiso para esta acción.' });
  if(A.requiereRegistro(u.rol) && A.leerTaller(db) && !db.prepare(`SELECT 1 FROM asistencia WHERE usuario_id = ? AND fecha = ?`).get(u.id, A.ahoraMX().fecha))
    return res.status(403).json({ error:'Primero registra tu entrada.', codigo:'SIN_ENTRADA' });
  next();
}
const manejar = fn => (req, res) => {
  try{ res.json(fn(req)); }
  catch(e){ if(!e.status) console.error('[revision-piezas]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'No se pudo guardar. Intenta de nuevo.' }); }
};

router.get('/', requireAuth, soloAuxiliar, (req, res) => res.json({ unidades: R.piezasPendientes(db), tipos: R.TIPOS_MAL }));
router.post('/:id/bien', requireAuth, soloAuxiliar, manejar(req => R.llegoBien(db, { piezaId: Number(req.params.id), usuario: req.session.user })));
router.post('/:id/mal', requireAuth, soloAuxiliar, manejar(req => R.llegoMal(db, { piezaId: Number(req.params.id), usuario: req.session.user,
  tipo: req.body && req.body.tipo, nota: req.body && req.body.nota, fotos: req.body && req.body.fotos })));

// Foto de la pieza (se guarda en las fotos de la unidad, sección "Pieza mal surtida").
const EXT = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp', 'image/heic':'.heic', 'image/heif':'.heic' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, F.UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `foto-${Date.now()}-${Math.round(Math.random()*1e9)}${file.fieldname === 'miniatura' ? '-mini' : ''}${EXT[file.mimetype] || '.jpg'}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => EXT[file.mimetype] ? cb(null, true) : cb(new Error('Solo se aceptan fotos.'))
});
router.post('/:id/foto', requireAuth, soloAuxiliar, upload.fields([{ name:'foto', maxCount:1 }, { name:'miniatura', maxCount:1 }]), (req, res) => {
  const foto = req.files && req.files.foto && req.files.foto[0];
  const mini = req.files && req.files.miniatura && req.files.miniatura[0];
  const borrar = () => { for(const l of Object.values(req.files || {})) for(const f of l) fs.unlink(f.path, () => {}); };
  const z = db.prepare(`SELECT z.id, p.siniestro_id FROM piezas z JOIN pedidos p ON p.id = z.pedido_id WHERE z.id = ?`).get(req.params.id);
  if(!foto || !z){ borrar(); return res.status(400).json({ error:'No se recibió la foto.' }); }
  const info = db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, etapa, nombre_original, nombre_almacenado, miniatura, mime, tamano, subido_por)
    VALUES ('siniestro', ?, 'foto', 'pieza_mal', ?, ?, ?, ?, ?, ?)`)
    .run(z.siniestro_id, foto.originalname || 'foto.jpg', foto.filename, mini ? mini.filename : null, foto.mimetype, foto.size + (mini ? mini.size : 0), req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: z.siniestro_id, accion:'foto_subida', campo:'etapa', valor_nuevo: F.ETIQUETA_ETAPA_FOTO.pieza_mal, usuario: req.session.user });
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

module.exports = router;
