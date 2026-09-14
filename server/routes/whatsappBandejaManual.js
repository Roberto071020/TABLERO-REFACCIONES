// ===================== WhatsApp -- bandeja manual asistida (rama aislada whatsapp-bandeja-manual) =====
// Endpoints de la nueva pantalla "WhatsApp". Consultar pendientes/en-proceso/enviados/resumen: cualquier
// usuario autenticado (todos los roles). Reclamar/confirmar (las únicas acciones que "mueven" un mensaje):
// solo atencion_cliente (Alejandra), vanessa y operativo (Daniela) -- Roberto conserva visibilidad de
// admin pero no envía en esta primera versión, por instrucción explícita.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const bandeja = require('../whatsappBandejaManual');
const router = express.Router();

router.get('/resumen', requireAuth, (req, res)=>{
  bandeja.sincronizarBandeja(db);
  res.json(bandeja.resumen(db));
});

router.get('/pendientes', requireAuth, (req, res)=>{
  bandeja.sincronizarBandeja(db);
  res.json(bandeja.listarPendientes(db, { q: (req.query.q || '').trim() || undefined }));
});

router.get('/en-proceso', requireAuth, (req, res)=>{
  bandeja.sincronizarBandeja(db);
  res.json(bandeja.listarEnProceso(db, { q: (req.query.q || '').trim() || undefined }));
});

router.get('/enviados', requireAuth, (req, res)=>{
  res.json(bandeja.listarEnviados(db, { q: (req.query.q || '').trim() || undefined, limit: req.query.limit }));
});

router.get('/envios/:id', requireAuth, requireRole(...bandeja.ROLES_ENVIO), (req, res)=>{
  const r = bandeja.obtenerEnvioReservadoPropio(db, { envioId: Number(req.params.id), usuarioId: req.session.user.id });
  if(!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(r.envio);
});

router.post('/envios/:id/reclamar', requireAuth, requireRole(...bandeja.ROLES_ENVIO), (req, res)=>{
  const r = bandeja.reclamar(db, { envioId: Number(req.params.id), usuarioId: req.session.user.id });
  if(!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(r.envio);
});

router.post('/envios/:id/confirmar', requireAuth, requireRole(...bandeja.ROLES_ENVIO), (req, res)=>{
  const enviado = req.body && req.body.enviado === true;
  if(req.body && typeof req.body.enviado !== 'boolean'){
    return res.status(400).json({ error:'Indica enviado:true o enviado:false.' });
  }
  const r = bandeja.confirmar(db, { envioId: Number(req.params.id), usuarioId: req.session.user.id, enviado });
  if(!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ok:true });
});

module.exports = router;
