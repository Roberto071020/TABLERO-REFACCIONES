// Unidades detenidas y a quién le toca destrabarlas (10-nov-2026) -- ver server/detenidas.js.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { detenidasPara, MOTIVOS } = require('../detenidas');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.json({ detenidas: detenidasPara(db, req.session.user.rol), motivos: MOTIVOS });
});

module.exports = router;
