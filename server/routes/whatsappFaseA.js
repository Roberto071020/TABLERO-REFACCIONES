// Endpoint de solo lectura / revisión explícita, exclusivo para admin, para verificar el modo "solo
// registro" de WhatsApp Fase A (autorizado por Roberto, 3-sep-2026, corregido el mismo día). No está
// enlazado desde ninguna pantalla del frontend -- es una herramienta de verificación/revisión, no un
// componente nuevo expuesto a ningún rol operativo. La acción de revisión (PATCH) NUNCA envía nada real:
// solo mueve un evento de "pendiente_revision" a "descartado" o "liberado_para_programacion", con
// justificación obligatoria (punto 3, cuarta entrega).
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const whatsappFaseA = require('../whatsappFaseA');
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

router.get('/errores', requireAuth, requireRole('admin'), (req, res)=>{
  const { resuelto, limit } = req.query;
  let sql = `SELECT er.*, s.numero AS siniestro_numero FROM whatsapp_errores er
             LEFT JOIN siniestros s ON s.id = er.siniestro_id WHERE 1=1`;
  const params = [];
  // Ojo: "resuelto=0" en query string es un string NO vacío ("0"), por lo tanto truthy en JS -- no se
  // puede usar `resuelto ? 1 : 0` (convertiría "0" en 1). Se compara explícitamente contra el string '0'.
  if(resuelto !== undefined){ sql += ' AND er.resuelto = ?'; params.push(resuelto === '0' || resuelto === 0 || resuelto === false ? 0 : 1); }
  sql += ' ORDER BY er.ultimo_intento_en DESC LIMIT ?';
  params.push(Math.min(Number(limit)||200, 1000));
  res.json(db.prepare(sql).all(...params));
});

// Acción explícita de revisión humana (punto 3). Requiere justificación. Nunca envía nada real.
router.patch('/eventos/:id/revision', requireAuth, requireRole('admin'), (req, res)=>{
  const { decision, justificacion } = req.body;
  try{
    const evento = whatsappFaseA.resolverPendienteRevision(db, {
      eventoId: req.params.id, decision, justificacion, usuarioId: req.session.user.id,
    });
    res.json(evento);
  } catch(e){
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
