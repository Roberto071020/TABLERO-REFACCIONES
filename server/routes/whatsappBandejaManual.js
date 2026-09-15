// ===================== WhatsApp -- bandeja manual asistida (rama aislada whatsapp-bandeja-manual) =====
// Endpoints de la nueva pantalla "WhatsApp". Consultar pendientes/en-proceso/enviados/resumen: cualquier
// usuario autenticado (todos los roles). Reclamar/confirmar (las únicas acciones que "mueven" un mensaje):
// solo atencion_cliente (Alejandra), vanessa y operativo (Daniela) -- Roberto conserva visibilidad de
// admin pero no envía en esta primera versión, por instrucción explícita.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
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

// ===================== Limpieza administrativa de una corrida de piloto (ficticia) =====================
// Punto 3 de la revisión del plan de despliegue (Roberto, 15-sep-2026): ruta transaccional, solo admin,
// para limpiar EXCLUSIVAMENTE una corrida de piloto identificada por piloto_run_id + la lista exacta de
// expedientes que esa corrida tocó -- ver server/whatsappBandejaManual.js#limpiarCorridaFicticia para el
// orden exacto (historial -> envíos -> Fase A -> expedientes opcional) y las razones de ese orden.
router.post('/piloto/limpiar', requireAuth, requireRole('admin'), (req, res)=>{
  const { runId, numeros, eliminarExpedientes } = req.body || {};
  const r = bandeja.limpiarCorridaFicticia(db, { runId, numeros, eliminarExpedientes: eliminarExpedientes === true });
  if(!r.ok){
    return res.status(r.status || 400).json({
      error: r.error, esperados: r.esperados, recibidos: r.recibidos, faltan: r.faltan, sobran: r.sobran,
    });
  }
  registrarAuditoria(db, {
    entidad_tipo: 'sistema', entidad_id: null, accion: 'whatsapp_piloto_limpiado',
    valor_nuevo: JSON.stringify({
      runId: r.runId, numeros: r.numeros, eliminarExpedientes: eliminarExpedientes === true,
      historialBorrados: r.historialBorrados, enviosBorrados: r.enviosBorrados, eventosBorrados: r.eventosBorrados,
      comunicacionesBorradas: r.comunicacionesBorradas, erroresBorrados: r.erroresBorrados, expedientesBorrados: r.expedientesBorrados,
    }),
    usuario: req.session.user,
  });
  res.json(r);
});

module.exports = router;
