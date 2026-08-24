// Órdenes de trabajo (Documento Maestro, módulo de Beto — sección 5.8, tabla 12).
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['beto','orlando','admin','jefe'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  let sql = `SELECT ot.*, u.nombre as creado_por_nombre FROM ordenes_trabajo ot LEFT JOIN usuarios u ON u.id = ot.creado_por WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND ot.siniestro_id = ?'; params.push(siniestro_id); }
  sql += ' ORDER BY ot.creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'La OT debe ligarse a un expediente.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(!b.numero || !String(b.numero).trim()) return res.status(400).json({ error:'Indica el número de OT.' });

  const info = db.prepare(`INSERT INTO ordenes_trabajo (siniestro_id,numero,version,estado,alcance,notas,creado_por)
    VALUES (?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, String(b.numero).trim(), b.version||1, b.estado||'borrador', b.alcance||'', b.notas||'', req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'orden_trabajo', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user,
    valor_nuevo: `OT ${b.numero} v${b.version||1}` });
  res.status(201).json(db.prepare('SELECT * FROM ordenes_trabajo WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM ordenes_trabajo WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'OT no encontrada.' });
  const ESTADOS = ['borrador','emitida','actualizada','suspendida','terminada'];
  const campos = ['numero','version','estado','alcance','notas'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.estado && !ESTADOS.includes(nuevo.estado)) return res.status(400).json({ error:'Estado de OT inválido.' });

  db.prepare(`UPDATE ordenes_trabajo SET numero=?,version=?,estado=?,alcance=?,notas=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.numero, nuevo.version, nuevo.estado, nuevo.alcance, nuevo.notas, req.params.id);
  auditarCambios(db, { entidad_tipo:'orden_trabajo', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM ordenes_trabajo WHERE id = ?').get(req.params.id));
});

module.exports = router;
