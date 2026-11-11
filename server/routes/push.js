// Avisos push al celular (11-nov-2026) -- ver server/push.js. Roberto: "para que al tener algo por hacer en
// automático le avise" (pedido de Orlando).
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const push = require('../push');
const router = express.Router();

push.asegurarTablas(db);

router.get('/estado', requireAuth, (req, res) => {
  const u = req.session.user;
  const disponible = push.disponiblePara(u.rol);
  const n = db.prepare('SELECT COUNT(*) n FROM push_suscripciones WHERE usuario_id = ?').get(u.id).n;
  res.json({ disponible, clave_publica: disponible ? process.env.VAPID_PUBLIC_KEY : null, celulares: n });
});

router.post('/suscribir', requireAuth, (req, res) => {
  const u = req.session.user;
  if(!push.disponiblePara(u.rol)) return res.status(400).json({ error:'Los avisos todavía no están disponibles para tu usuario.' });
  try{
    push.guardarSuscripcion(db, u, req.body && req.body.subscription, req.get('user-agent'));
  }catch(e){ return res.status(400).json({ error: e.message }); }
  res.json({ ok:true });
});

router.post('/quitar', requireAuth, (req, res) => {
  res.json({ ok:true, quitadas: push.quitarSuscripcion(db, req.session.user.id, req.body && req.body.endpoint) });
});

router.post('/prueba', requireAuth, async (req, res) => {
  const u = req.session.user;
  if(!push.disponiblePara(u.rol)) return res.status(400).json({ error:'Los avisos todavía no están disponibles para tu usuario.' });
  const enviados = await push.enviarAUsuario(db, u.id, { titulo:'✅ Avisos activados', cuerpo:'Así te va a avisar SC Control cuando tengas algo por hacer.', tag:'prueba' }, push.enviarReal);
  if(!enviados) return res.status(400).json({ error:'No se pudo mandar el aviso de prueba. Vuelve a activar los avisos en este celular.' });
  res.json({ ok:true, enviados });
});

module.exports = router;
