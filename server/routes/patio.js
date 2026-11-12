// Trabajo del personal de patio (12-nov-2026) -- ver server/patio.js.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, marcarHitoGeneradoAutomatico } = require('../utils');
const F = require('../fotos');
const P = require('../patio');
const router = express.Router();

P.asegurarTablasPatio(db);
F.asegurarEsquemaFotos(db);
if(!fs.existsSync(F.UPLOAD_DIR)) fs.mkdirSync(F.UPLOAD_DIR, { recursive:true });

const soloTecnico = requireRole('tecnico');
const manejar = fn => (req, res) => {
  try{ res.json(fn(req)); }
  catch(e){ if(!e.status) console.error('[patio]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'No se pudo guardar. Intenta de nuevo.' }); }
};

// ---------- Técnico ----------
router.get('/mis-trabajos', requireAuth, soloTecnico, (req, res) => {
  res.json({ trabajos: P.misTrabajos(db, req.session.user.id), motivos: P.MOTIVOS_PARO });
});
router.post('/:id/empece', requireAuth, soloTecnico, manejar(req =>
  P.empezar(db, { siniestroId: Number(req.params.id), usuario: req.session.user, registrarAuditoria, marcarHito: marcarHitoGeneradoAutomatico })));
router.post('/:id/termine', requireAuth, soloTecnico, manejar(req =>
  P.terminar(db, { siniestroId: Number(req.params.id), usuario: req.session.user, fotos: req.body && req.body.fotos })));
router.post('/:id/me-detuve', requireAuth, soloTecnico, manejar(req =>
  P.detener(db, { siniestroId: Number(req.params.id), usuario: req.session.user, motivo: req.body && req.body.motivo, nota: req.body && req.body.nota,
    fotos: req.body && req.body.fotos, registrarAuditoria })));
router.post('/:id/seguir', requireAuth, soloTecnico, manejar(req =>
  P.seguir(db, { siniestroId: Number(req.params.id), usuario: req.session.user })));

// OT de una unidad asignada a él (solo esa; no ve el resto del expediente).
router.get('/:id/ot', requireAuth, soloTecnico, (req, res) => {
  const ok = db.prepare(`SELECT 1 FROM patio_asignaciones WHERE siniestro_id = ? AND usuario_id = ? AND activo = 1`).get(req.params.id, req.session.user.id);
  if(!ok) return res.status(403).json({ error:'Esta unidad no está asignada a ti.' });
  const a = db.prepare(`SELECT * FROM archivos WHERE entidad_tipo='siniestro' AND entidad_id=? AND tipo='Orden de trabajo' AND eliminado=0 ORDER BY id DESC LIMIT 1`).get(req.params.id);
  const p = a && path.join(F.UPLOAD_DIR, a.nombre_almacenado);
  if(!p || !fs.existsSync(p)) return res.status(404).json({ error:'Esta unidad todavía no tiene OT.' });
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.nombre_original || 'OT.pdf')}`);
  res.type(a.mime || 'application/pdf').sendFile(p);
});

// Fotos del técnico: del trabajo terminado (etapa en que trabajó) o evidencia de un paro ('paro').
const EXT = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp', 'image/heic':'.heic', 'image/heif':'.heic' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, F.UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `foto-${Date.now()}-${Math.round(Math.random()*1e9)}${file.fieldname === 'miniatura' ? '-mini' : ''}${EXT[file.mimetype] || '.jpg'}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => EXT[file.mimetype] ? cb(null, true) : cb(new Error('Solo se aceptan fotos.'))
});
router.post('/:id/foto', requireAuth, soloTecnico, upload.fields([{ name:'foto', maxCount:1 }, { name:'miniatura', maxCount:1 }]), (req, res) => {
  const foto = req.files && req.files.foto && req.files.foto[0];
  const mini = req.files && req.files.miniatura && req.files.miniatura[0];
  const borrar = () => { for(const l of Object.values(req.files || {})) for(const f of l) fs.unlink(f.path, () => {}); };
  if(!foto){ borrar(); return res.status(400).json({ error:'No se recibió la foto.' }); }
  const u = req.session.user;
  const asig = db.prepare(`SELECT id FROM patio_asignaciones WHERE siniestro_id = ? AND usuario_id = ? AND activo = 1`).get(req.params.id, u.id);
  if(!asig){ borrar(); return res.status(403).json({ error:'Esta unidad no está asignada a ti.' }); }
  const t = db.prepare(`SELECT etapa FROM patio_trabajos WHERE asignacion_id = ? AND estado = 'en_curso' ORDER BY id DESC LIMIT 1`).get(asig.id);
  if(!t){ borrar(); return res.status(400).json({ error:'Primero toca "Empecé".' }); }
  const etapa = req.body && req.body.para === 'paro' ? 'paro' : t.etapa;
  const info = db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, etapa, nombre_original, nombre_almacenado, miniatura, mime, tamano, subido_por)
    VALUES ('siniestro', ?, 'foto', ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(req.params.id), etapa, foto.originalname || 'foto.jpg', foto.filename, mini ? mini.filename : null, foto.mimetype, foto.size + (mini ? mini.size : 0), u.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: Number(req.params.id), accion:'foto_subida', campo:'etapa', valor_nuevo: F.ETIQUETA_ETAPA_FOTO[etapa], usuario: u });
  res.status(201).json({ id: Number(info.lastInsertRowid), etapa });
});

// ---------- Beto (y Roberto) ----------
router.get('/beto', requireAuth, requireRole('beto', 'admin', 'jefe'), (req, res) => res.json(P.vistaBeto(db)));
router.post('/asignar', requireAuth, requireRole('beto', 'admin', 'jefe'), manejar(req => {
  const b = req.body || {};
  return P.asignar(db, { siniestroId: Number(b.siniestro_id), area: b.area, usuarioId: b.usuario_id ? Number(b.usuario_id) : null, usuario: req.session.user });
}));

module.exports = router;
