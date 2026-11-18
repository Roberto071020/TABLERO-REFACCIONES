// Modificación 3 (Modificaciones_Tablero_SC_Control.docx, 28-ago-2026), para Alejandra/Daniela: cuando
// el vehículo se entrega con una pieza pendiente (ej. un emblema) se da un vale al cliente, pero no hay
// seguimiento formal: se olvida, pasan meses, la pieza puede perderse o el proveedor nunca la surtió, y
// solo se detecta cuando el cliente pregunta. Este registro se revisa periódicamente igual que las
// refacciones normales.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();
const V = require('../valesPendientes');

// 18-nov-2026 (Roberto): "lo puede cerrar cualquiera de oficina o incluso Beto" -> toda la oficina y Beto.
const ROLES_EDICION = V.ROLES_VALE;

// 18-nov-2026: apartado "Entregadas con pendiente" (ver server/valesPendientes.js).
router.get('/apartado', requireAuth, (req, res)=>{
  res.json({ vales: V.listarEntregadasConPendiente(db) });
});

// 18-nov-2026: "Ya se instaló" -- cierra el vale; la unidad vuelve a seguir su archivo normal.
router.post('/:id/resolver', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const v = db.prepare('SELECT * FROM vales_pendientes WHERE id = ?').get(req.params.id);
  if(!v) return res.status(404).json({ error:'Vale no encontrado.' });
  if(v.estado !== 'pendiente') return res.status(400).json({ error:'Este vale ya estaba cerrado.' });
  db.prepare(`UPDATE vales_pendientes SET estado='surtido', resuelto_en=datetime('now'), resuelto_por=?, notas=CASE WHEN ? != '' THEN TRIM(COALESCE(notas,'') || ' ' || ?) ELSE notas END, actualizado_en=datetime('now') WHERE id=?`)
    .run(req.session.user.id, String(req.body.nota || '').trim(), String(req.body.nota || '').trim(), v.id);
  registrarAuditoria(db, { entidad_tipo:'vale_pendiente', entidad_id:v.id, accion:'vale_resuelto', campo:'estado', valor_anterior:'pendiente', valor_nuevo:'Resuelto: ' + v.pieza_pendiente, usuario:req.session.user });
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:v.siniestro_id, accion:'vale_resuelto', valor_nuevo:'Se instaló lo pendiente: ' + v.pieza_pendiente, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM vales_pendientes WHERE id = ?').get(v.id));
});

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id, estado } = req.query;
  let sql = `SELECT v.*, s.numero as siniestro_numero, s.vehiculo, s.placas
             FROM vales_pendientes v JOIN siniestros s ON s.id = v.siniestro_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND v.siniestro_id = ?'; params.push(siniestro_id); }
  if(estado && estado !== 'todos'){ sql += ' AND v.estado = ?'; params.push(estado); }
  else if(!estado){ sql += " AND v.estado = 'pendiente'"; } // por default solo lo que sigue pendiente de revisión periódica
  // estado=todos -- sin filtro, para ver el historial completo del expediente (surtidos/cancelados incluidos)
  sql += ' ORDER BY v.fecha_estimada_llegada IS NULL, v.fecha_estimada_llegada ASC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'El vale debe ligarse a un expediente.' });
  const siniestro = db.prepare('SELECT id, fecha_entrega_real FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(!b.pieza_pendiente || !String(b.pieza_pendiente).trim()) return res.status(400).json({ error:'Indica qué pieza quedó pendiente.' });

  const info = db.prepare(`INSERT INTO vales_pendientes (siniestro_id,pieza_pendiente,fecha_entrega_vehiculo,fecha_estimada_llegada,estado,notas,creado_por)
    VALUES (?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, String(b.pieza_pendiente).trim(), b.fecha_entrega_vehiculo || siniestro.fecha_entrega_real || '', b.fecha_estimada_llegada||'', 'pendiente', b.notas||'', req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'vale_pendiente', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:b.pieza_pendiente });
  res.status(201).json(db.prepare('SELECT * FROM vales_pendientes WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM vales_pendientes WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Vale no encontrado.' });
  const campos = ['pieza_pendiente','fecha_entrega_vehiculo','fecha_estimada_llegada','estado','notas'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.estado && !['pendiente','surtido','cancelado'].includes(nuevo.estado)) return res.status(400).json({ error:'Estado inválido.' });

  db.prepare(`UPDATE vales_pendientes SET pieza_pendiente=?,fecha_entrega_vehiculo=?,fecha_estimada_llegada=?,estado=?,notas=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.pieza_pendiente, nuevo.fecha_entrega_vehiculo, nuevo.fecha_estimada_llegada, nuevo.estado, nuevo.notas, req.params.id);
  auditarCambios(db, { entidad_tipo:'vale_pendiente', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM vales_pendientes WHERE id = ?').get(req.params.id));
});

module.exports = router;
