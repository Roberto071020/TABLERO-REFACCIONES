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

  const completo = calcularCompleto(b);
  const info = db.prepare(`INSERT INTO siniestros (numero,aseguradora,vehiculo,anio_modelo,placas,vin,fecha_ingreso,ubicacion,responsable,estatus_general,notas,completo,creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(b.numero).trim(), b.aseguradora, b.vehiculo||'', b.anio_modelo||'', b.placas||'', b.vin||'',
         b.fecha_ingreso || new Date().toISOString().slice(0,10), b.ubicacion||'Piso', b.responsable||req.session.user.nombre,
         b.estatus_general||'Abierto', b.notas||'', completo, req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user,
    valor_nuevo: `Siniestro ${b.numero} (${b.aseguradora})` });
  const creado = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...creado, advertencia: completo ? null : 'Faltan datos (vehículo/placas). Queda marcado como Pendiente de completar.' });
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Siniestro no encontrado.' });
  const campos = ['aseguradora','vehiculo','anio_modelo','placas','vin','fecha_ingreso','ubicacion','responsable','estatus_general','notas'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  nuevo.completo = calcularCompleto(nuevo);
  db.prepare(`UPDATE siniestros SET aseguradora=?,vehiculo=?,anio_modelo=?,placas=?,vin=?,fecha_ingreso=?,ubicacion=?,responsable=?,estatus_general=?,notas=?,completo=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.aseguradora, nuevo.vehiculo, nuevo.anio_modelo, nuevo.placas, nuevo.vin, nuevo.fecha_ingreso, nuevo.ubicacion, nuevo.responsable, nuevo.estatus_general, nuevo.notas, nuevo.completo, req.params.id);
  auditarCambios(db, { entidad_tipo:'siniestro', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id));
});

module.exports = router;
