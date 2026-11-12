// Checklist de calidad digital por OT (12-nov-2026) -- ver server/calidadDigital.js. Roberto: "que ese checklist se
// tuviera de manera digital dentro de SC Control y se pudiera contestar ahí mismo desde el teléfono".
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const C = require('../calidadDigital');
const router = express.Router();

C.asegurarTablas(db);
// Mismos roles que ya podían capturar el checklist (server/routes/checklistCalidad.js).
const ROLES = ['beto','orlando','atencion_cliente','operativo','vanessa','admin','jefe'];

router.get('/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT id, numero, vehiculo, placas, aseguradora, estado_calidad FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Expediente no encontrado.' });
  res.json({ siniestro: s, ...C.revisionDe(db, s.id) });
});

router.post('/:id', requireAuth, requireRole(...ROLES), (req, res) => {
  const s = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Expediente no encontrado.' });
  try{
    const r = C.guardarRevision(db, s.id, req.body && req.body.respuestas, req.session.user);
    registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'revision_calidad', campo:'calidad_respuestas',
      valor_nuevo: r.todo_bien ? 'Todo cumple' : `No cumple: ${r.no_cumple.map(x => x.observacion).join(' | ')}`.slice(0, 500), usuario:req.session.user });
    res.json(r);
  }catch(e){ res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
