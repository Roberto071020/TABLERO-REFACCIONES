// Complementos por daño oculto (Documento Maestro, tabla 15). Responsable principal: Orlando; Beto
// también puede registrar hallazgos que surgen durante producción (sección 5.11 / 9).
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['orlando','beto','admin','jefe'];
const DECISIONES = ['pendiente','autorizado','rechazado','parcial'];
const ESTADOS = ['detectado','documentando','enviado','en_autorizacion','autorizado','rechazado','incorporado_a_ot'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  let sql = `SELECT c.*, u.nombre as autor_nombre FROM complementos c LEFT JOIN usuarios u ON u.id = c.autor_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND c.siniestro_id = ?'; params.push(siniestro_id); }
  sql += ' ORDER BY c.creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'El complemento debe ligarse a un expediente.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(!b.causa || !String(b.causa).trim()) return res.status(400).json({ error:'Describe la causa del complemento (hallazgo de daño oculto).' });
  if(b.ot_id){
    const ot = db.prepare('SELECT id FROM ordenes_trabajo WHERE id = ?').get(b.ot_id);
    if(!ot) return res.status(400).json({ error:'La OT indicada no existe.' });
  }
  if(b.archivo_id){
    const archivo = db.prepare('SELECT id FROM archivos WHERE id = ?').get(b.archivo_id);
    if(!archivo) return res.status(400).json({ error:'El archivo/evidencia indicado no existe.' });
  }

  const info = db.prepare(`INSERT INTO complementos (siniestro_id,ot_id,causa,fecha,pieza_operacion,archivo_id,importe,folio,decision,impacto_dias,estado,autor_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, b.ot_id||null, String(b.causa).trim(), b.fecha||new Date().toISOString().slice(0,10), b.pieza_operacion||'',
         b.archivo_id||null, b.importe!=null&&b.importe!==''?Number(b.importe):null, b.folio||'', 'pendiente', b.impacto_dias||null, 'detectado', req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'complemento', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:b.causa });
  res.status(201).json(db.prepare(`SELECT c.*, u.nombre as autor_nombre FROM complementos c LEFT JOIN usuarios u ON u.id=c.autor_id WHERE c.id=?`).get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM complementos WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Complemento no encontrado.' });
  const campos = ['causa','fecha','pieza_operacion','archivo_id','importe','folio','decision','impacto_dias','estado','ot_id'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.decision && !DECISIONES.includes(nuevo.decision)) return res.status(400).json({ error:'Decisión inválida.' });
  if(nuevo.estado && !ESTADOS.includes(nuevo.estado)) return res.status(400).json({ error:'Estado inválido.' });
  // Alerta del documento (tabla 4/15): "daño trabajado sin autorización" — no se puede marcar incorporado
  // a OT si la decisión sigue pendiente o fue rechazada.
  if(nuevo.estado === 'incorporado_a_ot' && nuevo.decision !== 'autorizado' && nuevo.decision !== 'parcial'){
    return res.status(400).json({ error:'No se puede incorporar a la OT un complemento sin autorización (total o parcial).' });
  }
  // Límite de compra confirmado por Roberto (24-ago-2026): complementos superiores a $1,000 MXN no pueden
  // autorizarse desde el rol de Orlando/Beto; requieren admin o jefe (propietario/gerente, tabla 2).
  const LIMITE_AUTORIZACION_SIN_PROPIETARIO = 1000;
  const decisionCambiaAAutorizada = ['autorizado','parcial'].includes(nuevo.decision) && anterior.decision !== nuevo.decision;
  if(decisionCambiaAAutorizada && Number(nuevo.importe) > LIMITE_AUTORIZACION_SIN_PROPIETARIO && !['admin','jefe'].includes(req.session.user.rol)){
    return res.status(403).json({ error:`Complementos por más de $${LIMITE_AUTORIZACION_SIN_PROPIETARIO} MXN requieren autorización del propietario/gerente (admin o jefe).` });
  }

  db.prepare(`UPDATE complementos SET causa=?,fecha=?,pieza_operacion=?,archivo_id=?,importe=?,folio=?,decision=?,impacto_dias=?,estado=?,ot_id=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.causa, nuevo.fecha, nuevo.pieza_operacion, nuevo.archivo_id||null, nuevo.importe, nuevo.folio, nuevo.decision, nuevo.impacto_dias, nuevo.estado, nuevo.ot_id||null, req.params.id);
  auditarCambios(db, { entidad_tipo:'complemento', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare(`SELECT c.*, u.nombre as autor_nombre FROM complementos c LEFT JOIN usuarios u ON u.id=c.autor_id WHERE c.id=?`).get(req.params.id));
});

module.exports = router;
