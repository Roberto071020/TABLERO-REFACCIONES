const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

router.get('/', requireAuth, (req, res)=>{
  res.json(db.prepare('SELECT * FROM proveedores ORDER BY razon_social').all());
});

router.get('/:id', requireAuth, (req, res)=>{
  const pv = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(req.params.id);
  if(!pv) return res.status(404).json({ error:'Proveedor no encontrado.' });
  const piezas = db.prepare('SELECT * FROM piezas WHERE proveedor_id = ?').all(req.params.id);
  const recibidas = piezas.filter(z=>z.estatus==='Recibida físicamente');
  let tiempoPromedioDias = null;
  if(recibidas.length){
    const dias = recibidas.map(z=>{
      const pedido = db.prepare('SELECT fecha_creacion FROM pedidos WHERE id = ?').get(z.pedido_id);
      const d1 = new Date(pedido.fecha_creacion), d2 = new Date((z.fecha_recepcion||'').slice(0,10) || pedido.fecha_creacion);
      return Math.max(0, Math.round((d2-d1)/86400000));
    });
    tiempoPromedioDias = +(dias.reduce((a,b)=>a+b,0)/dias.length).toFixed(1);
  }
  const comunicaciones = db.prepare('SELECT * FROM comunicaciones WHERE proveedor_id = ? ORDER BY fecha_envio DESC').all(req.params.id);
  res.json({ ...pv, piezas, tiempoPromedioDias, comunicaciones });
});

router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.razon_social || !String(b.razon_social).trim()) return res.status(400).json({ error:'La razón social es obligatoria.' });
  const existente = db.prepare('SELECT * FROM proveedores WHERE razon_social = ?').get(b.razon_social.trim());
  if(existente) return res.status(409).json({ error:'Ya existe un proveedor con ese nombre.' });
  const info = db.prepare(`INSERT INTO proveedores (razon_social,contacto,correo,telefono,telefono_alterno,aseguradoras,regla_especial) VALUES (?,?,?,?,?,?,?)`)
    .run(b.razon_social.trim(), b.contacto||'', b.correo||'', b.telefono||'', b.telefono_alterno||'', JSON.stringify(b.aseguradoras||[]), b.regla_especial||'');
  registrarAuditoria(db, { entidad_tipo:'proveedor', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:b.razon_social });
  res.status(201).json(db.prepare('SELECT * FROM proveedores WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Proveedor no encontrado.' });
  const nuevo = { ...anterior };
  ['contacto','correo','telefono','telefono_alterno','regla_especial','activo'].forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(req.body.aseguradoras !== undefined) nuevo.aseguradoras = JSON.stringify(req.body.aseguradoras);
  db.prepare(`UPDATE proveedores SET contacto=?,correo=?,telefono=?,telefono_alterno=?,regla_especial=?,activo=?,aseguradoras=? WHERE id=?`)
    .run(nuevo.contacto, nuevo.correo, nuevo.telefono, nuevo.telefono_alterno, nuevo.regla_especial, nuevo.activo, nuevo.aseguradoras, req.params.id);
  auditarCambios(db, { entidad_tipo:'proveedor', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM proveedores WHERE id = ?').get(req.params.id));
});
// Nota F-14: a propósito NO existe un endpoint de bloqueo permanente de correos por proveedor.
// La única exclusión posible es temporal y por envío — ver POST /api/comunicaciones/exclusiones (regla R-07).

module.exports = router;
