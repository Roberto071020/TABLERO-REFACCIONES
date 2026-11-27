// Unidades por retirar del taller (27-nov-2026) -- ver server/retiros.js.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const R = require('../retiros');
const router = express.Router();

router.get('/', requireAuth, requireRole(...R.ROLES_RETIRO), (req, res) => {
  res.json({ unidades: R.porRetirar(db), dias_rojo: R.DIAS_ROJO });
});

router.post('/:id/retirada', requireAuth, requireRole(...R.ROLES_RETIRO), (req, res) => {
  const s = db.prepare('SELECT id, estatus_general, retirada_en FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Unidad no encontrada.' });
  if(!['Pérdida total', 'No reparar'].includes(s.estatus_general)) return res.status(400).json({ error:'Esta unidad no es pérdida total ni "No reparar".' });
  if(s.retirada_en) return res.status(400).json({ error:'Ya estaba marcada como retirada.' });
  const quien = String(req.session.user.nombre || '').split(' ')[0];
  db.prepare(`UPDATE siniestros SET retirada_en = datetime('now'), retirada_por = ?, actualizado_en = datetime('now') WHERE id = ?`).run(quien, s.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'retirada_taller', campo:'retirada_en', valor_anterior:null,
    valor_nuevo:`Retirada del taller (${s.estatus_general})`, usuario:req.session.user });
  res.json({ ok: true });
});

module.exports = router;
