// Tareas y alertas del módulo de Alejandra: pendientes ligados a un expediente, manuales o automáticos.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria } = require('../utils');
const router = express.Router();

const ESTADOS = ['pendiente','en_proceso','completada','cancelada'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id, estado, responsable_id } = req.query;
  let sql = `SELECT t.*, u.nombre as responsable_nombre FROM tareas t LEFT JOIN usuarios u ON u.id = t.responsable_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND t.siniestro_id = ?'; params.push(siniestro_id); }
  if(estado){ sql += ' AND t.estado = ?'; params.push(estado); }
  if(responsable_id){ sql += ' AND t.responsable_id = ?'; params.push(responsable_id); }
  sql += " ORDER BY (t.fecha_limite IS NULL OR t.fecha_limite = ''), t.fecha_limite ASC, t.creado_en DESC";
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'La tarea debe ligarse a un expediente.' });
  if(!b.descripcion || !String(b.descripcion).trim()) return res.status(400).json({ error:'Describe la tarea.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });

  const info = db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,responsable_id,fecha_limite,estado,origen,disparador,creado_por)
    VALUES (?,?,?,?,?,'pendiente','manual',?,?)`)
    .run(b.siniestro_id, b.tipo||'', String(b.descripcion).trim(), b.responsable_id||req.session.user.id, b.fecha_limite||'', b.disparador||null, req.session.user.id);
  res.status(201).json(db.prepare('SELECT t.*, u.nombre as responsable_nombre FROM tareas t LEFT JOIN usuarios u ON u.id=t.responsable_id WHERE t.id=?').get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM tareas WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Tarea no encontrada.' });
  if(req.body.estado && !ESTADOS.includes(req.body.estado)) return res.status(400).json({ error:'Estado de tarea inválido.' });

  const nuevo = { ...anterior };
  ['descripcion','responsable_id','fecha_limite','estado'].forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });

  const completando = anterior.estado !== 'completada' && nuevo.estado === 'completada';
  const completadoEn = completando ? new Date().toISOString() : anterior.completado_en;
  const completadoPor = completando ? req.session.user.id : anterior.completado_por;

  db.prepare(`UPDATE tareas SET descripcion=?,responsable_id=?,fecha_limite=?,estado=?,completado_en=?,completado_por=? WHERE id=?`)
    .run(nuevo.descripcion, nuevo.responsable_id, nuevo.fecha_limite, nuevo.estado, completadoEn, completadoPor, req.params.id);
  registrarAuditoria(db, { entidad_tipo:'tarea', entidad_id: req.params.id, accion:'edicion', campo:'estado',
    valor_anterior: anterior.estado, valor_nuevo: nuevo.estado, usuario: req.session.user });
  res.json(db.prepare('SELECT t.*, u.nombre as responsable_nombre FROM tareas t LEFT JOIN usuarios u ON u.id=t.responsable_id WHERE t.id=?').get(req.params.id));
});

module.exports = router;
