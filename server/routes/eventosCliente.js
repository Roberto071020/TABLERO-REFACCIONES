// Bitácora de comunicaciones con el CLIENTE (módulo Alejandra). Separada de "comunicaciones",
// que sigue siendo exclusivamente proveedor↔taller y no se toca aquí.
// Es un registro cronológico e inmutable: no existen rutas PATCH/DELETE (mismo criterio que auditoria).
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const router = express.Router();

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  let sql = `SELECT ec.*, u.nombre as autor_nombre FROM eventos_cliente ec LEFT JOIN usuarios u ON u.id = ec.autor_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND ec.siniestro_id = ?'; params.push(siniestro_id); }
  sql += ' ORDER BY ec.creado_en DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'El evento debe ligarse a un expediente.' });
  if(!['entrante','saliente'].includes(b.direccion)) return res.status(400).json({ error:'La dirección debe ser "entrante" o "saliente".' });
  if(!b.mensaje || !String(b.mensaje).trim()) return res.status(400).json({ error:'Describe el mensaje o el resultado del contacto.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });

  const info = db.prepare(`INSERT INTO eventos_cliente (siniestro_id,direccion,canal,tipo_evento,autor_id,mensaje,adjuntos,resultado,compromiso,proxima_accion)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, b.direccion, b.canal||'', b.tipo_evento||'', req.session.user.id, String(b.mensaje).trim(),
         b.adjuntos||'', b.resultado||'', b.compromiso||'', b.proxima_accion||'');
  res.status(201).json(db.prepare('SELECT ec.*, u.nombre as autor_nombre FROM eventos_cliente ec LEFT JOIN usuarios u ON u.id=ec.autor_id WHERE ec.id=?').get(info.lastInsertRowid));
});

module.exports = router;
