// Carga de órdenes de trabajo por Claude (5-nov-2026). Roberto adjunta las OT en una conversación con Claude
// y Claude las coloca en el expediente correcto; Beto las ve en su pantalla de Producción y en la ficha.
//
// Seguridad (ventanilla de ESCRITURA acotada):
//   - Solo existe si se configura CARGA_OT_TOKEN en Render (clave larga, distinta de REPORTE_TOKEN).
//   - Solo puede: buscar un expediente por número/placas y SUBIR un archivo tipo "Orden de trabajo" (PDF o foto)
//     a un expediente que YA existe. No crea, no edita ni borra nada más.
//   - Cada carga queda en la auditoría como "Claude (carga de OT)".
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { registrarAuditoria } = require('../utils');
const router = express.Router();

const UPLOAD_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, '..', '..', 'uploads');
if(!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive:true });
const PERMITIDOS = ['application/pdf','image/jpeg','image/png','image/webp','image/heic'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, f, cb) => cb(null, UPLOAD_DIR),
    filename: (req, f, cb) => cb(null, `ot-${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(f.originalname) || '.pdf'}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, f, cb) => PERMITIDOS.includes(f.mimetype) ? cb(null, true) : cb(new Error('Solo PDF o foto.'))
});

const USUARIO = { id: null, nombre: 'Claude (carga de OT)' };

function autorizado(req, res, next){
  const esperada = process.env.CARGA_OT_TOKEN;
  if(!esperada) return res.status(503).json({ error:'La carga de OT no está activada (falta CARGA_OT_TOKEN).' });
  const auth = req.get('authorization') || '';
  const recibida = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const a = crypto.createHash('sha256').update(recibida).digest(), b = crypto.createHash('sha256').update(esperada).digest();
  if(!recibida || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error:'Clave inválida.' });
  next();
}
const limpio = t => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Busca expedientes por número de siniestro o placas (exacto o parcial, sin importar guiones/espacios).
function buscar(q){
  const c = limpio(q);
  if(c.length < 4) return [];
  const filas = db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas, estado_produccion, archivado FROM siniestros`).all();
  const exactos = filas.filter(s => limpio(s.numero) === c || limpio(s.placas) === c);
  if(exactos.length) return exactos;
  return filas.filter(s => limpio(s.numero).includes(c) || (c.length >= 6 && c.includes(limpio(s.numero)) && limpio(s.numero).length >= 6)).slice(0, 10);
}

router.get('/buscar-siniestro', autorizado, (req, res)=>{
  const r = buscar(req.query.q).map(s => ({ ...s,
    ots: db.prepare(`SELECT id, nombre_original, creado_en FROM archivos WHERE entidad_tipo='siniestro' AND entidad_id=? AND tipo='Orden de trabajo' AND eliminado=0 ORDER BY id`).all(s.id) }));
  res.json(r);
});

router.post('/ot', autorizado, upload.single('archivo'), (req, res)=>{
  const f = req.file;
  if(!f) return res.status(400).json({ error:'No llegó el archivo de la OT.' });
  const quitar = () => fs.unlink(f.path, ()=>{});
  const id = Number(req.body.siniestro_id);
  const s = id ? db.prepare('SELECT id, numero, vehiculo, placas FROM siniestros WHERE id = ?').get(id) : null;
  if(!s){ quitar(); return res.status(404).json({ error:'No existe ese expediente en el tablero.' }); }
  // Evita subir dos veces la misma OT (mismo contenido).
  const hash = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
  const previas = db.prepare(`SELECT id, nombre_almacenado FROM archivos WHERE entidad_tipo='siniestro' AND entidad_id=? AND tipo='Orden de trabajo' AND eliminado=0`).all(s.id);
  for(const p of previas){
    try{
      const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(UPLOAD_DIR, p.nombre_almacenado))).digest('hex');
      if(h === hash){ quitar(); return res.json({ duplicada:true, archivo_id:p.id, siniestro:s }); }
    }catch(e){}
  }
  const nombre = req.body.nombre || f.originalname || `OT_${s.numero}.pdf`;
  const info = db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, nombre_original, nombre_almacenado, mime, tamano, subido_por)
    VALUES ('siniestro', ?, 'Orden de trabajo', ?, ?, ?, ?, NULL)`).run(s.id, nombre, f.filename, f.mimetype, f.size);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'ot_cargada', valor_nuevo:nombre, usuario:USUARIO });
  res.status(201).json({ archivo_id:Number(info.lastInsertRowid), siniestro:s });
});

module.exports = router;
