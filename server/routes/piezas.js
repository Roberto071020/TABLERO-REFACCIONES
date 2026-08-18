const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria, auditarCambios, nowUTC, verificarRefaccionesCompletas } = require('../utils');
const router = express.Router();

const ESTATUS_PIEZA = ['Sin proveedor','Asignada','Confirmada','Facturada','En tránsito','Entregada por proveedor','Recibida físicamente','Devuelta','Incorrecta/dañada','Cancelada'];
const CERRADAS = ['Recibida físicamente','Cancelada'];

router.get('/', requireAuth, (req, res)=>{
  const { pedido_id, estatus } = req.query;
  let sql = 'SELECT * FROM piezas WHERE 1=1';
  const params = [];
  if(pedido_id){ sql += ' AND pedido_id = ?'; params.push(pedido_id); }
  if(estatus){ sql += ' AND estatus = ?'; params.push(estatus); }
  sql += ' ORDER BY id';
  res.json(db.prepare(sql).all(...params));
});

// F-01: alta real de piezas para un pedido.
router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.pedido_id) return res.status(400).json({ error:'La pieza debe ligarse a un pedido.' });
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(b.pedido_id);
  if(!pedido) return res.status(400).json({ error:'El pedido indicado no existe.' });
  if(!b.descripcion || !String(b.descripcion).trim()) return res.status(400).json({ error:'La descripción de la pieza es obligatoria.' });
  const estatus = ESTATUS_PIEZA.includes(b.estatus) ? b.estatus : (b.proveedor_id ? 'Asignada' : 'Sin proveedor');

  const info = db.prepare(`INSERT INTO piezas (pedido_id,proveedor_id,descripcion,numero_parte,tipo,cantidad,precio,fecha_prometida,estatus,observaciones)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(b.pedido_id, b.proveedor_id||null, b.descripcion.trim(), b.numero_parte||'', b.tipo||'Original', b.cantidad||1, b.precio||0, b.fecha_prometida||'', estatus, b.observaciones||'');
  registrarAuditoria(db, { entidad_tipo:'pieza', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:b.descripcion });
  res.status(201).json(db.prepare('SELECT * FROM piezas WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/:id', requireAuth, (req, res)=>{
  const z = db.prepare('SELECT * FROM piezas WHERE id = ?').get(req.params.id);
  if(!z) return res.status(404).json({ error:'Pieza no encontrada.' });
  res.json(z);
});

// F-06: edición real de piezas.
router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM piezas WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Pieza no encontrada.' });
  if(req.body.estatus && !ESTATUS_PIEZA.includes(req.body.estatus)) return res.status(400).json({ error:'Estatus de pieza inválido.' });
  const campos = ['proveedor_id','descripcion','numero_parte','tipo','cantidad','precio','fecha_prometida','estatus','observaciones'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  db.prepare(`UPDATE piezas SET proveedor_id=?,descripcion=?,numero_parte=?,tipo=?,cantidad=?,precio=?,fecha_prometida=?,estatus=?,observaciones=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.proveedor_id, nuevo.descripcion, nuevo.numero_parte, nuevo.tipo, nuevo.cantidad, nuevo.precio, nuevo.fecha_prometida, nuevo.estatus, nuevo.observaciones, req.params.id);
  auditarCambios(db, { entidad_tipo:'pieza', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM piezas WHERE id = ?').get(req.params.id));
});

// Marca llegada física del proveedor, SIN aceptarla todavía como correcta (paso intermedio pedido por Daniela).
router.post('/:id/entregar', requireAuth, (req, res)=>{
  const pieza = db.prepare('SELECT * FROM piezas WHERE id = ?').get(req.params.id);
  if(!pieza) return res.status(404).json({ error:'Pieza no encontrada.' });
  db.prepare(`UPDATE piezas SET estatus='Entregada por proveedor', actualizado_en=datetime('now') WHERE id=?`).run(req.params.id);
  registrarAuditoria(db, { entidad_tipo:'pieza', entidad_id:req.params.id, accion:'entrega_proveedor', campo:'estatus', valor_anterior:pieza.estatus, valor_nuevo:'Entregada por proveedor', usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM piezas WHERE id = ?').get(req.params.id));
});

// F-10/F-11: recepción física ligada al usuario autenticado (no texto libre) y BLOQUEADA si hay una incidencia abierta.
router.post('/:id/recibir', requireAuth, (req, res)=>{
  const pieza = db.prepare('SELECT * FROM piezas WHERE id = ?').get(req.params.id);
  if(!pieza) return res.status(404).json({ error:'Pieza no encontrada.' });
  const incidenciaAbierta = db.prepare(`SELECT * FROM incidencias WHERE pieza_id = ? AND estado IN ('abierta','en_proceso') ORDER BY id DESC LIMIT 1`).get(req.params.id);
  if(incidenciaAbierta){
    return res.status(409).json({ error:'No se puede marcar como recibida: hay una incidencia abierta sobre esta pieza. Resuélvela primero.', incidencia: incidenciaAbierta });
  }
  db.prepare(`UPDATE piezas SET estatus='Recibida físicamente', fecha_recepcion=datetime('now'), recibido_por=?, actualizado_en=datetime('now') WHERE id=?`)
    .run(req.session.user.id, req.params.id);
  registrarAuditoria(db, { entidad_tipo:'pieza', entidad_id:req.params.id, accion:'recepcion_fisica', campo:'estatus', valor_anterior:pieza.estatus, valor_nuevo:'Recibida físicamente', usuario:req.session.user });

  // Recalcula el estatus operativo del pedido según cómo queden todas sus piezas.
  const zs = db.prepare('SELECT estatus FROM piezas WHERE pedido_id = ?').all(pieza.pedido_id);
  const todasCerradas = zs.every(z => CERRADAS.includes(z.estatus));
  const algunaCerrada = zs.some(z => CERRADAS.includes(z.estatus));
  const pedidoAnterior = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pieza.pedido_id);
  let nuevoEstatus = pedidoAnterior.estatus_operativo;
  if(todasCerradas) nuevoEstatus = 'Recibido completo';
  else if(algunaCerrada) nuevoEstatus = 'Recibido parcial';
  if(nuevoEstatus !== pedidoAnterior.estatus_operativo){
    db.prepare(`UPDATE pedidos SET estatus_operativo=?, actualizado_en=datetime('now') WHERE id=?`).run(nuevoEstatus, pieza.pedido_id);
    registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id:pieza.pedido_id, accion:'cierre_automatico', campo:'estatus_operativo', valor_anterior:pedidoAnterior.estatus_operativo, valor_nuevo:nuevoEstatus, usuario:req.session.user });
  }
  // Módulo Alejandra (Fase 5): si con esto TODO el expediente queda con sus refacciones resueltas, avisarle.
  verificarRefaccionesCompletas(db, pedidoAnterior.siniestro_id, req.session.user);
  res.json(db.prepare('SELECT * FROM piezas WHERE id = ?').get(req.params.id));
});

module.exports = router;
module.exports.ESTATUS_PIEZA = ESTATUS_PIEZA;
module.exports.CERRADAS = CERRADAS;
