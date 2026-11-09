// Ventanilla de solo lectura (4-nov-2026) para que un asistente programado fuera del tablero (por ejemplo,
// una tarea de Claude) pueda leer el reporte de arranque del día SIN usuario ni contraseña de nadie del equipo.
//
// Seguridad:
//   - Solo existe si se configura la variable de entorno REPORTE_TOKEN en Render (clave larga y aleatoria).
//     Sin ella responde 503 y no expone nada.
//   - La clave viaja en el encabezado "Authorization: Bearer <clave>" (no en la URL, para que no quede en logs).
//   - Solo regresa el reporte de arranque; no permite leer expedientes completos ni modificar nada.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { calcularReporteArranque } = require('../reporteArranque');
const router = express.Router();

function claveValida(recibida){
  const esperada = process.env.REPORTE_TOKEN;
  if(!esperada || !recibida) return false;
  const a = crypto.createHash('sha256').update(String(recibida)).digest();
  const b = crypto.createHash('sha256').update(String(esperada)).digest();
  return crypto.timingSafeEqual(a, b);
}

router.get('/reporte-arranque', (req, res)=>{
  if(!process.env.REPORTE_TOKEN) return res.status(503).json({ error:'La ventanilla externa no está activada (falta REPORTE_TOKEN).' });
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if(!claveValida(token)) return res.status(401).json({ error:'Clave inválida.' });
  const r = calcularReporteArranque(db);
  const formato = req.query.formato;
  if(formato === 'texto') return res.type('text/plain; charset=utf-8').send(r.texto);
  res.json(r);
});

// 9-nov-2026 (Roberto): corte de las 3 de la tarde -- lo que sigue pendiente de hoy, por persona. Misma clave.
router.get('/corte-tarde', (req, res)=>{
  if(!process.env.REPORTE_TOKEN) return res.status(503).json({ error:'La ventanilla externa no está activada (falta REPORTE_TOKEN).' });
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if(!claveValida(token)) return res.status(401).json({ error:'Clave inválida.' });
  const r = require('../corteTarde').calcularCorteTarde(db);
  if(req.query.formato === 'texto') return res.type('text/plain; charset=utf-8').send(r.texto);
  res.json(r);
});

module.exports = router;
