// Inicio de Roberto (7-nov-2026) -- ver server/inicioRoberto.js.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { calcularInicioRoberto } = require('../inicioRoberto');
const router = express.Router();

router.get('/', requireAuth, requireRole('admin', 'jefe'), (req, res)=>{
  res.json(calcularInicioRoberto(db));
});

module.exports = router;
