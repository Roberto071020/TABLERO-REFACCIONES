// "Ya llegó" (10-nov-2026, Roberto): Beto (o Alejandra/Roberto) registra que una unidad que estaba circulando o
// citada a reingreso YA está en el patio, para poder trabajarla sin esperar a que se capture la recepción.
// Pasa la unidad a Piso y marca la llegada de hoy; si la cita era otro día, la cita queda en la fecha real de llegada.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const router = express.Router();

function hoyMX(){ return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10); }

router.post('/:id', requireAuth, requireRole('beto', 'atencion_cliente', 'admin', 'jefe'), (req, res) => {
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Unidad no encontrada.' });
  const hoy = hoyMX();
  const cambios = { ubicacion:'Piso', reingreso_recibido_en: hoy };
  if(s.cita_fecha && String(s.cita_fecha).slice(0, 10) !== hoy) cambios.cita_fecha = hoy;
  db.prepare(`UPDATE siniestros SET ${Object.keys(cambios).map(k => k + ' = ?').join(', ')}, actualizado_en = datetime('now') WHERE id = ?`)
    .run(...Object.values(cambios), s.id);
  for(const [campo, valor] of Object.entries(cambios)){
    if(String(s[campo] || '') !== String(valor)) registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'llegada_patio', campo,
      valor_anterior: s[campo], valor_nuevo: valor, usuario: req.session.user });
  }
  res.json({ ok:true, ...cambios });
});

module.exports = router;
