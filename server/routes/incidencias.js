const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const TIPOS = ['incorrecta','danada','incompleta','devolucion','cancelacion','fecha_incumplida'];
const ACCIONES = ['cambio','recoleccion','garantia','reembolso'];
const TIPO_A_ESTATUS_PIEZA = {
  incorrecta: 'Incorrecta/dañada', danada: 'Incorrecta/dañada', incompleta: 'Incorrecta/dañada',
  devolucion: 'Devuelta', cancelacion: 'Cancelada', fecha_incumplida: 'Entrega vencida'
};

router.get('/', requireAuth, (req, res)=>{
  const { estado, pieza_id } = req.query;
  let sql = `SELECT i.*, z.descripcion as pieza_descripcion, z.pedido_id, p.numero as pedido_numero, p.siniestro_id, s.numero as siniestro_numero
             FROM incidencias i
             JOIN piezas z ON z.id = i.pieza_id
             JOIN pedidos p ON p.id = z.pedido_id
             JOIN siniestros s ON s.id = p.siniestro_id
             WHERE 1=1`;
  const params = [];
  if(estado){ sql += ' AND i.estado = ?'; params.push(estado); }
  if(pieza_id){ sql += ' AND i.pieza_id = ?'; params.push(pieza_id); }
  sql += ' ORDER BY i.creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

// F-02: alta real de incidencia (pieza incorrecta/dañada/etc.), sin marcarla como recibida.
router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.pieza_id) return res.status(400).json({ error:'La incidencia debe ligarse a una pieza.' });
  const pieza = db.prepare('SELECT * FROM piezas WHERE id = ?').get(b.pieza_id);
  if(!pieza) return res.status(400).json({ error:'La pieza indicada no existe.' });
  if(!TIPOS.includes(b.tipo)) return res.status(400).json({ error:'Tipo de incidencia inválido. Usa: ' + TIPOS.join(', ') });
  if(b.accion_solicitada && !ACCIONES.includes(b.accion_solicitada)) return res.status(400).json({ error:'Acción solicitada inválida.' });

  const info = db.prepare(`INSERT INTO incidencias (pieza_id,tipo,descripcion,accion_solicitada,responsable,fecha_compromiso,estado,creado_por)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.pieza_id, b.tipo, b.descripcion||'', b.accion_solicitada||null, b.responsable||req.session.user.nombre, b.fecha_compromiso||'', 'abierta', req.session.user.id);

  // La pieza refleja la incidencia pero NUNCA se marca como recibida (criterio de prueba de Daniela).
  const nuevoEstatusPieza = TIPO_A_ESTATUS_PIEZA[b.tipo] || 'Incorrecta/dañada';
  db.prepare(`UPDATE piezas SET estatus=?, actualizado_en=datetime('now') WHERE id=?`).run(nuevoEstatusPieza, b.pieza_id);
  registrarAuditoria(db, { entidad_tipo:'incidencia', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:`${b.tipo} en pieza ${pieza.descripcion}` });
  registrarAuditoria(db, { entidad_tipo:'pieza', entidad_id:b.pieza_id, accion:'incidencia_registrada', campo:'estatus', valor_anterior:pieza.estatus, valor_nuevo:nuevoEstatusPieza, usuario:req.session.user });

  // El pedido se marca 'Con incidencia' pero sigue existiendo en todas las vistas (F-03).
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pieza.pedido_id);
  db.prepare(`UPDATE pedidos SET estatus_operativo='Con incidencia', actualizado_en=datetime('now') WHERE id=?`).run(pieza.pedido_id);
  registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id:pieza.pedido_id, accion:'cambio_por_incidencia', campo:'estatus_operativo', valor_anterior:pedido.estatus_operativo, valor_nuevo:'Con incidencia', usuario:req.session.user });

  res.status(201).json(db.prepare('SELECT * FROM incidencias WHERE id = ?').get(info.lastInsertRowid));
});

// F-11: cerrar la incidencia (requiere resolución explícita); solo entonces la pieza puede marcarse recibida después.
router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM incidencias WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Incidencia no encontrada.' });
  const b = req.body;
  if(b.estado && !['abierta','en_proceso','resuelta','cancelada'].includes(b.estado)) return res.status(400).json({ error:'Estado inválido.' });
  if(b.estado === 'resuelta' && !b.resolucion){
    return res.status(400).json({ error:'Para cerrar la incidencia como resuelta debes describir la resolución (pieza correcta confirmada, cómo y cuándo).' });
  }
  const nuevo = { ...anterior };
  ['tipo','descripcion','accion_solicitada','responsable','fecha_compromiso','estado','resolucion'].forEach(c=>{ if(b[c] !== undefined) nuevo[c] = b[c]; });
  const fechaResolucion = (b.estado === 'resuelta' || b.estado === 'cancelada') ? new Date().toISOString().slice(0,19).replace('T',' ') : anterior.fecha_resolucion;
  db.prepare(`UPDATE incidencias SET tipo=?,descripcion=?,accion_solicitada=?,responsable=?,fecha_compromiso=?,estado=?,resolucion=?,fecha_resolucion=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.tipo, nuevo.descripcion, nuevo.accion_solicitada, nuevo.responsable, nuevo.fecha_compromiso, nuevo.estado, nuevo.resolucion, fechaResolucion, req.params.id);
  auditarCambios(db, { entidad_tipo:'incidencia', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM incidencias WHERE id = ?').get(req.params.id));
});

module.exports = router;
