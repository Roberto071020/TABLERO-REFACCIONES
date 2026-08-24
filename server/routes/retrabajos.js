// Retrabajos (Documento Maestro, sección 9): nacen de una no conformidad detectada en control de
// calidad o producción. Un expediente no debe pasar a "listo para entrega" con retrabajos críticos
// abiertos (esa validación se aplica en Fase F, al registrar la entrega).
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['beto','orlando','admin','jefe'];
const SEVERIDADES = ['leve','media','critica'];
const ESTADOS = ['abierto','en_correccion','reinspeccion','cerrado'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id, estado } = req.query;
  let sql = `SELECT r.*, u.nombre as autor_nombre FROM retrabajos r LEFT JOIN usuarios u ON u.id = r.autor_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND r.siniestro_id = ?'; params.push(siniestro_id); }
  if(estado){ sql += ' AND r.estado = ?'; params.push(estado); }
  sql += ' ORDER BY r.creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'El retrabajo debe ligarse a un expediente.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(!b.origen || !String(b.origen).trim()) return res.status(400).json({ error:'Describe el origen (la no conformidad) del retrabajo.' });
  if(b.severidad && !SEVERIDADES.includes(b.severidad)) return res.status(400).json({ error:'Severidad inválida.' });
  if(b.ot_operacion_id){
    const op = db.prepare('SELECT id FROM ot_operaciones WHERE id = ?').get(b.ot_operacion_id);
    if(!op) return res.status(400).json({ error:'La operación de OT indicada no existe.' });
  }

  const info = db.prepare(`INSERT INTO retrabajos (siniestro_id,ot_operacion_id,origen,categoria,severidad,responsable,horas,costo,correccion,autor_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, b.ot_operacion_id||null, String(b.origen).trim(), b.categoria||'', b.severidad||'media', b.responsable||'',
         b.horas!=null&&b.horas!==''?Number(b.horas):null, b.costo!=null&&b.costo!==''?Number(b.costo):null, b.correccion||'', req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'retrabajo', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:b.origen });
  res.status(201).json(db.prepare(`SELECT r.*, u.nombre as autor_nombre FROM retrabajos r LEFT JOIN usuarios u ON u.id=r.autor_id WHERE r.id=?`).get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM retrabajos WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Retrabajo no encontrado.' });
  const campos = ['origen','categoria','severidad','responsable','horas','costo','correccion','estado','fecha_reinspeccion'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.severidad && !SEVERIDADES.includes(nuevo.severidad)) return res.status(400).json({ error:'Severidad inválida.' });
  if(nuevo.estado && !ESTADOS.includes(nuevo.estado)) return res.status(400).json({ error:'Estado inválido.' });
  if(nuevo.estado === 'cerrado' && !(nuevo.correccion && String(nuevo.correccion).trim())){
    return res.status(400).json({ error:'Registra la corrección aplicada antes de cerrar el retrabajo.' });
  }

  db.prepare(`UPDATE retrabajos SET origen=?,categoria=?,severidad=?,responsable=?,horas=?,costo=?,correccion=?,estado=?,fecha_reinspeccion=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.origen, nuevo.categoria, nuevo.severidad, nuevo.responsable, nuevo.horas, nuevo.costo, nuevo.correccion, nuevo.estado, nuevo.fecha_reinspeccion, req.params.id);
  auditarCambios(db, { entidad_tipo:'retrabajo', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare(`SELECT r.*, u.nombre as autor_nombre FROM retrabajos r LEFT JOIN usuarios u ON u.id=r.autor_id WHERE r.id=?`).get(req.params.id));
});

module.exports = router;
