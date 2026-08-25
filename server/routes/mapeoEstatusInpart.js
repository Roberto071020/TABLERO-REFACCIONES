const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const router = express.Router();

// Documento de Daniela, item 4: mapeo Inpart -> estatus interno EDITABLE (no hardcodeado en el código),
// porque Inpart puede usar textos distintos con el tiempo. Roles operativo/admin/jefe lo mantienen.

router.get('/', requireAuth, (req, res)=>{
  res.json(db.prepare('SELECT * FROM mapeo_estatus_inpart ORDER BY valor_inpart').all());
});

router.post('/', requireAuth, requireRole('operativo','admin','jefe'), (req, res)=>{
  const b = req.body;
  if(!b.valor_inpart || !String(b.valor_inpart).trim()) return res.status(400).json({ error:'El valor de Inpart es obligatorio.' });
  const existente = db.prepare('SELECT id FROM mapeo_estatus_inpart WHERE valor_inpart = ?').get(String(b.valor_inpart).trim());
  if(existente) return res.status(409).json({ error:'Ya existe un mapeo para ese valor de Inpart. Edítalo en vez de duplicarlo.' });
  const info = db.prepare(`INSERT INTO mapeo_estatus_inpart (valor_inpart,estatus_pieza,estatus_pedido) VALUES (?,?,?)`)
    .run(String(b.valor_inpart).trim(), b.estatus_pieza || null, b.estatus_pedido || null);
  registrarAuditoria(db, { entidad_tipo:'mapeo_estatus_inpart', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:`${b.valor_inpart} -> pieza:${b.estatus_pieza||'—'} / pedido:${b.estatus_pedido||'—'}` });
  res.status(201).json(db.prepare('SELECT * FROM mapeo_estatus_inpart WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole('operativo','admin','jefe'), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM mapeo_estatus_inpart WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Mapeo no encontrado.' });
  const nuevo = { ...anterior };
  ['estatus_pieza','estatus_pedido','activo'].forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  db.prepare(`UPDATE mapeo_estatus_inpart SET estatus_pieza=?,estatus_pedido=?,activo=? WHERE id=?`)
    .run(nuevo.estatus_pieza, nuevo.estatus_pedido, nuevo.activo, req.params.id);
  registrarAuditoria(db, { entidad_tipo:'mapeo_estatus_inpart', entidad_id: req.params.id, accion:'edicion', usuario:req.session.user,
    valor_anterior:`pieza:${anterior.estatus_pieza||'—'} / pedido:${anterior.estatus_pedido||'—'}`,
    valor_nuevo:`pieza:${nuevo.estatus_pieza||'—'} / pedido:${nuevo.estatus_pedido||'—'}` });
  res.json(db.prepare('SELECT * FROM mapeo_estatus_inpart WHERE id = ?').get(req.params.id));
});

module.exports = router;
