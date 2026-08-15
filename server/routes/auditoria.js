const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const router = express.Router();

// F-22: bitácora de solo lectura. A propósito no existen rutas PATCH/DELETE — es inmutable por diseño.
router.get('/', requireAuth, (req, res)=>{
  const { entidad_tipo, entidad_id, limit } = req.query;
  let sql = 'SELECT * FROM auditoria WHERE 1=1'; const params=[];
  if(entidad_tipo){ sql += ' AND entidad_tipo=?'; params.push(entidad_tipo); }
  if(entidad_id){ sql += ' AND entidad_id=?'; params.push(entidad_id); }
  sql += ' ORDER BY id DESC LIMIT ?'; params.push(Math.min(Number(limit)||200, 1000));
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
