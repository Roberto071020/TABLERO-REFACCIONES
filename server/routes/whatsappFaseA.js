// Endpoint de solo lectura, exclusivo para admin, para verificar el modo "solo registro" de WhatsApp
// Fase A (autorizado por Roberto, 3-sep-2026). No está enlazado desde ninguna pantalla del frontend --
// es una herramienta de verificación/depuración, no un componente nuevo expuesto a ningún rol operativo.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const router = express.Router();

router.get('/eventos', requireAuth, requireRole('admin'), (req, res)=>{
  const { siniestro_id, plantilla_codigo, estado, limit } = req.query;
  let sql = `SELECT e.*, s.numero AS siniestro_numero FROM whatsapp_eventos_registrados e
             JOIN siniestros s ON s.id = e.siniestro_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND e.siniestro_id = ?'; params.push(siniestro_id); }
  if(plantilla_codigo){ sql += ' AND e.plantilla_codigo = ?'; params.push(plantilla_codigo); }
  if(estado){ sql += ' AND e.estado = ?'; params.push(estado); }
  sql += ' ORDER BY e.creado_en DESC LIMIT ?';
  params.push(Math.min(Number(limit)||200, 1000));
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
