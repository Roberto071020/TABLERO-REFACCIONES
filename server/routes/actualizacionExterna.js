// Actualización de unidades por Claude (7-nov-2026). Roberto: "se me hace más fácil mandarte el archivo y tú
// haces lo demás". El equipo llena la plantilla, Roberto la adjunta en la conversación con Claude, y Claude:
//   1) la valida aquí (no guarda nada) y le muestra a Roberto qué va a cambiar;
//   2) solo con el visto bueno de Roberto la aplica (mismo motor y misma auditoría que la pantalla
//      "Actualizar unidades"; cada cambio queda como "Claude (actualización de unidades)").
// Seguridad (misma idea que la carga de OT):
//   - Solo existe si se configura ACTUALIZACION_TOKEN en Render (clave larga, distinta de las demás).
//   - Solo puede validar/aplicar la plantilla de unidades y deshacer un archivado masivo. Nada más.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { analizar, aplicar, limpiarSalida, revertirArchivado } = require('../actualizacionUnidades');
const router = express.Router();

const USUARIO = { id: null, nombre: 'Claude (actualización de unidades)' };

function autorizado(req, res, next){
  const esperada = process.env.ACTUALIZACION_TOKEN;
  if(!esperada) return res.status(503).json({ error:'La actualización externa no está activada (falta ACTUALIZACION_TOKEN).' });
  const auth = req.get('authorization') || '';
  const recibida = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const a = crypto.createHash('sha256').update(recibida).digest(), b = crypto.createHash('sha256').update(esperada).digest();
  if(!recibida || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error:'Clave inválida.' });
  next();
}

router.post('/unidades/validar', autorizado, (req, res)=>{
  const r = analizar(db, req.body && req.body.texto, { archivarFaltantes: !!(req.body && req.body.archivar_faltantes) });
  if(r.error) return res.status(400).json({ error: r.error });
  res.json(limpiarSalida(r));
});

router.post('/unidades/confirmar', autorizado, (req, res)=>{
  const r = aplicar(db, req.body && req.body.texto, USUARIO, { archivarFaltantes: !!(req.body && req.body.archivar_faltantes) });
  if(r.error) return res.status(400).json({ error: r.error });
  res.json(limpiarSalida(r));
});

router.post('/unidades/revertir-archivado', autorizado, (req, res)=>{
  const lote = String((req.body && req.body.lote) || '');
  if(!lote) return res.status(400).json({ error:'Falta el lote.' });
  res.json(revertirArchivado(db, lote, USUARIO));
});

module.exports = router;
