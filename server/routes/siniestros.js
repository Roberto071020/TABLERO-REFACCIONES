const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const PLACEHOLDERS = ['', 'por confirmar', 'sin datos', 'n/a', 'na', 'pendiente', '-', 'xxx'];
function esGenerico(v){ return !v || PLACEHOLDERS.includes(String(v).trim().toLowerCase()); }
function calcularCompleto(row){
  return (!esGenerico(row.vehiculo) && !esGenerico(row.placas)) ? 1 : 0;
}

router.get('/', requireAuth, (req, res)=>{
  const { aseguradora, q } = req.query;
  let sql = 'SELECT * FROM siniestros WHERE 1=1';
  const params = [];
  if(aseguradora){ sql += ' AND aseguradora = ?'; params.push(aseguradora); }
  if(q){ sql += ' AND (numero LIKE ? OR placas LIKE ? OR vehiculo LIKE ?)'; const like = `%${q}%`; params.push(like,like,like); }
  // Módulo Alejandra (Fase 1): el módulo de Daniela (rol operativo) solo debe ver expedientes
  // relevantes para refacciones. 'por_definir' se sigue mostrando porque ella puede ser quien lo determine
  // al dar de alta el primer pedido. Solo se oculta lo marcado explícitamente como 'no'.
  if(req.session.user.rol === 'operativo'){ sql += " AND requiere_refacciones != 'no'"; }
  sql += ' ORDER BY creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requireAuth, (req, res)=>{
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Siniestro no encontrado.' });
  res.json(s);
});

router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.numero || !String(b.numero).trim()) return res.status(400).json({ error:'El número de siniestro es obligatorio.' });
  const existente = db.prepare('SELECT * FROM siniestros WHERE numero = ?').get(String(b.numero).trim());
  if(existente) return res.status(409).json({ error:'Ya existe un siniestro con ese número (no se crean duplicados).', duplicado: existente });
  if(!b.aseguradora) return res.status(400).json({ error:'La aseguradora es obligatoria.' });
  // Módulo Alejandra (Fase 1): cuando ella da de alta el expediente desde recepción, los datos
  // básicos de contacto son obligatorios. No se exige a otros roles, para no alterar el flujo actual de Daniela.
  if(req.session.user.rol === 'atencion_cliente'){
    if(!b.cliente_nombre || !String(b.cliente_nombre).trim()) return res.status(400).json({ error:'El nombre del cliente es obligatorio.' });
    if(!b.cliente_telefono || !String(b.cliente_telefono).trim()) return res.status(400).json({ error:'El teléfono del cliente es obligatorio.' });
    if(!b.cliente_correo || !String(b.cliente_correo).trim()) return res.status(400).json({ error:'El correo del cliente es obligatorio.' });
  }
  const requiereRefacciones = ['si','no','por_definir'].includes(b.requiere_refacciones) ? b.requiere_refacciones : 'por_definir';

  const completo = calcularCompleto(b);
  const info = db.prepare(`INSERT INTO siniestros (numero,aseguradora,vehiculo,anio_modelo,placas,vin,fecha_ingreso,ubicacion,responsable,estatus_general,notas,completo,creado_por,
      cliente_nombre,cliente_telefono,cliente_correo,cliente_notas,orden_admision,canal_origen,etapa_actual,prioridad,requiere_refacciones)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`)
    .run(String(b.numero).trim(), b.aseguradora, b.vehiculo||'', b.anio_modelo||'', b.placas||'', b.vin||'',
         b.fecha_ingreso || new Date().toISOString().slice(0,10), b.ubicacion||'Piso', b.responsable||req.session.user.nombre,
         b.estatus_general||'Abierto', b.notas||'', completo, req.session.user.id,
         b.cliente_nombre||'', b.cliente_telefono||'', b.cliente_correo||'', b.cliente_notas||'', b.orden_admision||'',
         b.canal_origen||'', b.etapa_actual||'', b.prioridad||'', requiereRefacciones);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user,
    valor_nuevo: `Siniestro ${b.numero} (${b.aseguradora})` });
  const creado = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...creado, advertencia: completo ? null : 'Faltan datos (vehículo/placas). Queda marcado como Pendiente de completar.' });
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Siniestro no encontrado.' });
  const campos = ['aseguradora','vehiculo','anio_modelo','placas','vin','fecha_ingreso','ubicacion','responsable','estatus_general','notas',
    'cliente_nombre','cliente_telefono','cliente_correo','cliente_notas','orden_admision','canal_origen','etapa_actual','prioridad',
    'requiere_refacciones','deducible','forma_pago','fecha_entrega_prevista','fecha_entrega_real','postventa_programada','postventa_completada'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  nuevo.completo = calcularCompleto(nuevo);
  db.prepare(`UPDATE siniestros SET aseguradora=?,vehiculo=?,anio_modelo=?,placas=?,vin=?,fecha_ingreso=?,ubicacion=?,responsable=?,estatus_general=?,notas=?,completo=?,
      cliente_nombre=?,cliente_telefono=?,cliente_correo=?,cliente_notas=?,orden_admision=?,canal_origen=?,etapa_actual=?,prioridad=?,
      requiere_refacciones=?,deducible=?,forma_pago=?,fecha_entrega_prevista=?,fecha_entrega_real=?,postventa_programada=?,postventa_completada=?,
      actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.aseguradora, nuevo.vehiculo, nuevo.anio_modelo, nuevo.placas, nuevo.vin, nuevo.fecha_ingreso, nuevo.ubicacion, nuevo.responsable, nuevo.estatus_general, nuevo.notas, nuevo.completo,
      nuevo.cliente_nombre, nuevo.cliente_telefono, nuevo.cliente_correo, nuevo.cliente_notas, nuevo.orden_admision, nuevo.canal_origen, nuevo.etapa_actual, nuevo.prioridad,
      nuevo.requiere_refacciones, nuevo.deducible, nuevo.forma_pago, nuevo.fecha_entrega_prevista, nuevo.fecha_entrega_real, nuevo.postventa_programada, nuevo.postventa_completada,
      req.params.id);
  auditarCambios(db, { entidad_tipo:'siniestro', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id));
});

module.exports = router;
