// Puntos 5-6 del documento PORTAL SC (Orlando, 8-sep-2026): tabla de piezas de autosurtido. Cada fila es
// una pieza a comprar: descripción, costo, tiempo de entrega y proveedor (nombre + origen -- Radec,
// Grimex, Agencia o Mercado Libre; si es Mercado Libre, proveedor_link guarda el link del producto, que
// el equipo manda a Roberto por WhatsApp -- eso queda FUERA del sistema, es un paso manual del equipo,
// nunca un envío automático). "Requisitada" (para que el expediente sea visible en el tablero de
// Autosurtidos de Daniela) significa que pieza, costo, tiempo_entrega y proveedor_nombre están completos
// -- ver requisitosCompletos() más abajo.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

// Quién puede capturar/editar piezas de autosurtido: Vanessa y Orlando (Orlando absorbe temporalmente la
// captura de Vanessa, mismo criterio que el resto del expediente digital), más admin/jefe.
const ROLES_EDICION = ['vanessa','orlando','admin','jefe'];

function requisitosCompletos(fila){
  return !!(fila.pieza && String(fila.pieza).trim()
    && fila.costo !== null && fila.costo !== undefined && String(fila.costo).trim() !== ''
    && fila.tiempo_entrega && String(fila.tiempo_entrega).trim()
    && fila.proveedor_nombre && String(fila.proveedor_nombre).trim());
}

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  if(!siniestro_id) return res.status(400).json({ error:'Indica siniestro_id.' });
  const filas = db.prepare('SELECT * FROM autosurtido_piezas WHERE siniestro_id = ? ORDER BY id ASC').all(siniestro_id);
  res.json(filas.map(f=>({ ...f, requisitada: requisitosCompletos(f) })));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'La pieza debe ligarse a un expediente.' });
  const siniestro = db.prepare('SELECT id, tipo_reparacion FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(siniestro.tipo_reparacion !== 'AUTO_SURTIDO') return res.status(400).json({ error:'Este expediente no está marcado como Auto surtido (revisión técnica de Orlando).' });
  if(b.proveedor_origen && !['Radec','Grimex','Agencia','Mercado Libre','Otro'].includes(b.proveedor_origen)){
    return res.status(400).json({ error:'Origen de proveedor inválido.' });
  }
  const info = db.prepare(`INSERT INTO autosurtido_piezas (siniestro_id,pieza,costo,tiempo_entrega,proveedor_origen,proveedor_nombre,proveedor_link,creado_por)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, b.pieza||'', (b.costo===''||b.costo===undefined)?null:Number(b.costo), b.tiempo_entrega||null,
         b.proveedor_origen||null, b.proveedor_nombre||null, b.proveedor_link||null, req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'autosurtido_pieza', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo: b.pieza||'(sin descripción)' });
  const fila = db.prepare('SELECT * FROM autosurtido_piezas WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...fila, requisitada: requisitosCompletos(fila) });
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM autosurtido_piezas WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Pieza no encontrada.' });
  if(req.body.proveedor_origen && !['Radec','Grimex','Agencia','Mercado Libre','Otro'].includes(req.body.proveedor_origen)){
    return res.status(400).json({ error:'Origen de proveedor inválido.' });
  }
  const campos = ['pieza','costo','tiempo_entrega','proveedor_origen','proveedor_nombre','proveedor_link'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.costo === '' || nuevo.costo === undefined) nuevo.costo = null;
  else if(nuevo.costo !== null) nuevo.costo = Number(nuevo.costo);

  db.prepare(`UPDATE autosurtido_piezas SET pieza=?,costo=?,tiempo_entrega=?,proveedor_origen=?,proveedor_nombre=?,proveedor_link=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.pieza, nuevo.costo, nuevo.tiempo_entrega, nuevo.proveedor_origen, nuevo.proveedor_nombre, nuevo.proveedor_link, req.params.id);
  auditarCambios(db, { entidad_tipo:'autosurtido_pieza', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  const fila = db.prepare('SELECT * FROM autosurtido_piezas WHERE id = ?').get(req.params.id);
  res.json({ ...fila, requisitada: requisitosCompletos(fila) });
});

router.delete('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const fila = db.prepare('SELECT * FROM autosurtido_piezas WHERE id = ?').get(req.params.id);
  if(!fila) return res.status(404).json({ error:'Pieza no encontrada.' });
  db.prepare('DELETE FROM autosurtido_piezas WHERE id = ?').run(req.params.id);
  registrarAuditoria(db, { entidad_tipo:'autosurtido_pieza', entidad_id: req.params.id, accion:'eliminacion', usuario:req.session.user, valor_anterior: fila.pieza||'(sin descripción)' });
  res.json({ ok:true });
});

router.requisitosCompletos = requisitosCompletos;
module.exports = router;
