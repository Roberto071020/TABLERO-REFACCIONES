// Inicio de Orlando (6-nov-2026) -- ver server/inicioOrlando.js. También aquí la lista de calidad pendiente
// que usan los inicios de Beto (todas) y de los demás (solo las de 1 día o más), ver server/calidadPendiente.js.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { calcularInicioOrlando } = require('../inicioOrlando');
const { unidadesPorRevisarCalidad, HORAS_APOYO } = require('../calidadPendiente');
const router = express.Router();

router.get('/', requireAuth, requireRole('orlando', 'vanessa', 'admin', 'jefe'), (req, res)=>{
  res.json(calcularInicioOrlando(db));
});

// ?apoyo=1 -> solo las que llevan 1 día o más terminadas sin revisar (para Alejandra, Daniela y Orlando).
router.get('/calidad-pendiente', requireAuth, (req, res)=>{
  res.json(unidadesPorRevisarCalidad(db, { minHoras: req.query.apoyo === '1' ? HORAS_APOYO : 0 }));
});

module.exports = router;
