// Checklist de control de calidad (Documento Maestro, tabla 23; responsable: Beto coordina/libera,
// Orlando apoya lo técnico — tabla 16).
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['beto','orlando','admin','jefe'];
const DIMENSIONES = ['Alcance','Seguridad y función','Lámina/ajuste','Pintura/acabado','Armado','Presentación','Documentación'];
const RESULTADOS = ['pendiente','aprobado','rechazado'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  let sql = `SELECT cc.*, u.nombre as inspector_nombre FROM checklist_calidad cc LEFT JOIN usuarios u ON u.id = cc.inspector_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND cc.siniestro_id = ?'; params.push(siniestro_id); }
  sql += ' ORDER BY cc.id';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'El renglón de calidad debe ligarse a un expediente.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(!DIMENSIONES.includes(b.dimension)) return res.status(400).json({ error:'Dimensión de calidad inválida.' });
  if(b.resultado && !RESULTADOS.includes(b.resultado)) return res.status(400).json({ error:'Resultado inválido.' });
  if(b.resultado === 'rechazado' && !(b.hallazgo && String(b.hallazgo).trim())){
    return res.status(400).json({ error:'Describe el hallazgo antes de marcar este rubro como rechazado.' });
  }

  const info = db.prepare(`INSERT INTO checklist_calidad (siniestro_id,dimension,resultado,hallazgo,severidad,correccion,inspector_id,fecha)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, b.dimension, b.resultado||'pendiente', b.hallazgo||'', b.severidad||'', b.correccion||'', req.session.user.id, b.fecha||new Date().toISOString().slice(0,10));
  registrarAuditoria(db, { entidad_tipo:'checklist_calidad', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user,
    valor_nuevo: `${b.dimension}: ${b.resultado||'pendiente'}` });
  res.status(201).json(db.prepare(`SELECT cc.*, u.nombre as inspector_nombre FROM checklist_calidad cc LEFT JOIN usuarios u ON u.id=cc.inspector_id WHERE cc.id=?`).get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM checklist_calidad WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Renglón de calidad no encontrado.' });
  const campos = ['resultado','hallazgo','severidad','correccion','fecha'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.resultado && !RESULTADOS.includes(nuevo.resultado)) return res.status(400).json({ error:'Resultado inválido.' });
  // Alerta de la tabla 16: "defecto repetido" — un rechazo debe traer el hallazgo que lo motiva.
  if(nuevo.resultado === 'rechazado' && !(nuevo.hallazgo && String(nuevo.hallazgo).trim())){
    return res.status(400).json({ error:'Describe el hallazgo antes de marcar este rubro como rechazado.' });
  }

  db.prepare(`UPDATE checklist_calidad SET resultado=?,hallazgo=?,severidad=?,correccion=?,fecha=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.resultado, nuevo.hallazgo, nuevo.severidad, nuevo.correccion, nuevo.fecha, req.params.id);
  auditarCambios(db, { entidad_tipo:'checklist_calidad', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare(`SELECT cc.*, u.nombre as inspector_nombre FROM checklist_calidad cc LEFT JOIN usuarios u ON u.id=cc.inspector_id WHERE cc.id=?`).get(req.params.id));
});

module.exports = router;
