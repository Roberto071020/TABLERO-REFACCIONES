// Actualización rápida de unidades (4-nov-2026) -- ver server/actualizacionUnidades.js.
// Solo propietario/jefe: cambia datos de muchos expedientes a la vez.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { analizar, aplicar, limpiarSalida } = require('../actualizacionUnidades');
const router = express.Router();

router.post('/validar', requireAuth, requireRole('admin','jefe'), (req, res)=>{
  const r = analizar(db, req.body && req.body.texto);
  if(r.error) return res.status(400).json({ error: r.error });
  res.json(limpiarSalida(r));
});

router.post('/confirmar', requireAuth, requireRole('admin','jefe'), (req, res)=>{
  const r = aplicar(db, req.body && req.body.texto, req.session.user);
  if(r.error) return res.status(400).json({ error: r.error });
  res.json(limpiarSalida(r));
});

module.exports = router;
