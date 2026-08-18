const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ESTATUS_OPERATIVO = ['Nuevo','Por revisar','Esperando proveedor','En tránsito','Entrega vencida','Recibido parcial','Recibido completo','Con incidencia','Cancelado','Cerrado'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id, estatus_operativo, aseguradora } = req.query;
  let sql = 'SELECT * FROM pedidos WHERE 1=1';
  const params = [];
  if(siniestro_id){ sql += ' AND siniestro_id = ?'; params.push(siniestro_id); }
  if(estatus_operativo){ sql += ' AND estatus_operativo = ?'; params.push(estatus_operativo); }
  if(aseguradora){ sql += ' AND aseguradora = ?'; params.push(aseguradora); }
  sql += ' ORDER BY creado_en DESC';
  // F-03: este endpoint NUNCA excluye estatus por defecto — el Kanban debe pintar TODOS los estatus, incluidos
  // 'Con incidencia', 'Entrega vencida' y 'Cancelado', para que un pedido jamás desaparezca de la vista.
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requireAuth, (req, res)=>{
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if(!p) return res.status(404).json({ error:'Pedido no encontrado.' });
  res.json(p);
});

router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.numero || !String(b.numero).trim()) return res.status(400).json({ error:'El número de pedido es obligatorio.' });
  if(!b.siniestro_id) return res.status(400).json({ error:'El pedido debe ligarse a un siniestro.' });
  const siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El siniestro indicado no existe.' });
  const existente = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(String(b.numero).trim());
  if(existente) return res.status(409).json({ error:'Ya existe un pedido con ese número (no se crean duplicados).', duplicado: existente });

  const fechaCreacion = b.fecha_creacion || new Date().toISOString().slice(0,10);
  const advertencias = [];
  if(b.fecha_prevista && b.fecha_prevista <= fechaCreacion) advertencias.push('La fecha prevista es igual o anterior a la fecha de alta; verifícala.');

  const info = db.prepare(`INSERT INTO pedidos (numero,cotizacion,siniestro_id,aseguradora,fecha_creacion,fecha_prevista,estatus_inpart,total,tipo_evaluacion,estatus_operativo,creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(b.numero).trim(), b.cotizacion||'', b.siniestro_id, b.aseguradora||siniestro.aseguradora, fechaCreacion, b.fecha_prevista||'',
         b.estatus_inpart||'Aguardando confirmación', b.total||0, b.tipo_evaluacion||'Inicial', 'Nuevo', req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:`Pedido ${b.numero} (siniestro ${siniestro.numero})` });

  // Módulo Alejandra (Fase 1): si el expediente maestro todavía no tenía definido si requiere refacciones,
  // el primer pedido que Daniela crea sobre él lo confirma automáticamente. Queda auditado como cualquier otro cambio.
  if(siniestro.requiere_refacciones === 'por_definir'){
    db.prepare("UPDATE siniestros SET requiere_refacciones='si', actualizado_en=datetime('now') WHERE id=?").run(siniestro.id);
    registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: siniestro.id, accion:'automatico', campo:'requiere_refacciones',
      valor_anterior:'por_definir', valor_nuevo:'si', usuario:req.session.user });
  }

  const creado = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...creado, advertencias });
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Pedido no encontrado.' });
  if(req.body.estatus_operativo && !ESTATUS_OPERATIVO.includes(req.body.estatus_operativo)){
    return res.status(400).json({ error:'Estatus operativo inválido.' });
  }
  const campos = ['cotizacion','aseguradora','fecha_creacion','fecha_prevista','estatus_inpart','total','tipo_evaluacion','estatus_operativo'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  db.prepare(`UPDATE pedidos SET cotizacion=?,aseguradora=?,fecha_creacion=?,fecha_prevista=?,estatus_inpart=?,total=?,tipo_evaluacion=?,estatus_operativo=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.cotizacion, nuevo.aseguradora, nuevo.fecha_creacion, nuevo.fecha_prevista, nuevo.estatus_inpart, nuevo.total, nuevo.tipo_evaluacion, nuevo.estatus_operativo, req.params.id);
  auditarCambios(db, { entidad_tipo:'pedido', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id));
});

module.exports = router;
