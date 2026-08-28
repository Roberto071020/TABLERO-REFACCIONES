// Modificación 2 (Modificaciones_Tablero_SC_Control.docx, 28-ago-2026), para Daniela: algunos
// proveedores marcan una pieza como "entregada" en Impart sin haberla enviado, solo para cumplir con el
// tiempo que mide el sistema. Cuando la falta se descubre, la aseguradora reclama por qué no se avisó a
// tiempo, aunque el sistema decía "entregado". Este registro deja respaldo documentado: fecha en que el
// sistema marcó entregado, fecha real de llegada (o "no llegó"), y si ya se avisó por correo.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['operativo','orlando','admin','jefe'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id, estado } = req.query;
  let sql = `SELECT d.*, s.numero as siniestro_numero, pv.razon_social as proveedor_nombre, z.descripcion as pieza_descripcion
             FROM discrepancias_proveedor d
             JOIN siniestros s ON s.id = d.siniestro_id
             LEFT JOIN proveedores pv ON pv.id = d.proveedor_id
             LEFT JOIN piezas z ON z.id = d.pieza_id
             WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND d.siniestro_id = ?'; params.push(siniestro_id); }
  if(estado){ sql += ' AND d.estado = ?'; params.push(estado); }
  sql += ' ORDER BY d.creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'La discrepancia debe ligarse a un expediente.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(!b.descripcion || !String(b.descripcion).trim()) return res.status(400).json({ error:'Describe la discrepancia (qué pieza, qué marcó el sistema).' });

  const info = db.prepare(`INSERT INTO discrepancias_proveedor
      (siniestro_id,pieza_id,proveedor_id,descripcion,fecha_marcado_entregado,fecha_real_llegada,no_llego,correo_enviado_en,correo_texto,estado,creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, b.pieza_id||null, b.proveedor_id||null, String(b.descripcion).trim(),
         b.fecha_marcado_entregado||'', b.fecha_real_llegada||'', b.no_llego?1:0, b.correo_enviado_en||'', b.correo_texto||'',
         'abierta', req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'discrepancia_proveedor', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:b.descripcion });
  res.status(201).json(db.prepare('SELECT * FROM discrepancias_proveedor WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM discrepancias_proveedor WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Discrepancia no encontrada.' });
  const campos = ['pieza_id','proveedor_id','descripcion','fecha_marcado_entregado','fecha_real_llegada','no_llego','correo_enviado_en','correo_texto','estado'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  nuevo.no_llego = nuevo.no_llego ? 1 : 0;
  if(nuevo.estado && !['abierta','resuelta'].includes(nuevo.estado)) return res.status(400).json({ error:'Estado inválido.' });

  db.prepare(`UPDATE discrepancias_proveedor SET pieza_id=?,proveedor_id=?,descripcion=?,fecha_marcado_entregado=?,fecha_real_llegada=?,no_llego=?,correo_enviado_en=?,correo_texto=?,estado=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.pieza_id||null, nuevo.proveedor_id||null, nuevo.descripcion, nuevo.fecha_marcado_entregado, nuevo.fecha_real_llegada, nuevo.no_llego, nuevo.correo_enviado_en, nuevo.correo_texto, nuevo.estado, req.params.id);
  auditarCambios(db, { entidad_tipo:'discrepancia_proveedor', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM discrepancias_proveedor WHERE id = ?').get(req.params.id));
});

module.exports = router;
