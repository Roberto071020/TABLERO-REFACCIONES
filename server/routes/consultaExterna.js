// Ventanilla de SOLO LECTURA para reportes y estadísticas (9-nov-2026). Roberto: "Hazlo" — para que Claude pueda
// sacar reportes por aseguradora, tiempos, piezas, etc. sin pedirle archivos al equipo.
//
// Seguridad:
//   - Solo existe si se configura LECTURA_TOKEN en Render (clave larga y aleatoria). Sin ella responde 503.
//   - La clave viaja en "Authorization: Bearer <clave>", nunca en la URL.
//   - Las consultas corren en una conexión SEPARADA abierta en modo solo lectura: aunque alguien mandara un
//     INSERT/UPDATE/DELETE, la base lo rechaza. Además solo se aceptan SELECT/WITH de una sola instrucción.
//   - Tablas con contraseñas, sesiones o claves de servicios quedan bloqueadas (TABLAS_BLOQUEADAS).
//   - Máximo MAX_FILAS filas por consulta.
const express = require('express');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');
const router = express.Router();

const MAX_FILAS = 5000;
const TABLAS_BLOQUEADAS = ['usuarios', 'sesiones', 'google_drive_tokens', 'whatsapp_config'];
const PALABRAS_BLOQUEADAS = ['attach', 'detach', 'pragma', 'load_extension', 'vacuum'];

let lectura = null;
function conexionLectura(){
  if(!lectura) lectura = new DatabaseSync(db.location(), { readOnly: true });
  return lectura;
}

function claveValida(recibida){
  const esperada = process.env.LECTURA_TOKEN;
  if(!esperada || !recibida) return false;
  const a = crypto.createHash('sha256').update(String(recibida)).digest();
  const b = crypto.createHash('sha256').update(String(esperada)).digest();
  return crypto.timingSafeEqual(a, b);
}

function autorizar(req, res, next){
  if(!process.env.LECTURA_TOKEN) return res.status(503).json({ error:'La ventanilla de lectura no está activada (falta LECTURA_TOKEN).' });
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if(!claveValida(token)) return res.status(401).json({ error:'Clave inválida.' });
  next();
}

// Quita comentarios y textos entre comillas simples para revisar solo la estructura de la consulta.
function estructura(sql){
  return String(sql).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").toLowerCase();
}

function revisarConsulta(sql){
  if(!sql || typeof sql !== 'string' || !sql.trim()) return 'Falta la consulta (campo "sql").';
  if(sql.length > 20000) return 'La consulta es demasiado larga.';
  const e = estructura(sql).trim().replace(/;\s*$/, '');
  if(!/^(select|with)\b/.test(e)) return 'Solo se permiten consultas SELECT o WITH.';
  if(e.includes(';')) return 'Solo se permite una instrucción por consulta.';
  for(const p of PALABRAS_BLOQUEADAS) if(new RegExp('\\b' + p + '\\b').test(e)) return `No se permite "${p}".`;
  for(const t of TABLAS_BLOQUEADAS) if(new RegExp('\\b' + t + '\\b').test(e)) return `La tabla "${t}" no está disponible por seguridad.`;
  return null;
}

// Lista de tablas y columnas disponibles (sin las bloqueadas), para saber qué se puede consultar.
router.get('/lectura/esquema', autorizar, (req, res) => {
  const c = conexionLectura();
  const tablas = c.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
    .map(t => t.name).filter(n => !TABLAS_BLOQUEADAS.includes(n.toLowerCase()));
  const esquema = {};
  for(const t of tablas) esquema[t] = c.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(t).map(col => `${col.name} ${col.type}`.trim());
  res.json({ tablas: esquema, max_filas: MAX_FILAS });
});

router.post('/lectura/consulta', autorizar, (req, res) => {
  const sql = req.body && req.body.sql;
  const params = Array.isArray(req.body && req.body.params) ? req.body.params : [];
  const problema = revisarConsulta(sql);
  if(problema) return res.status(400).json({ error: problema });
  try{
    const stmt = conexionLectura().prepare(sql);
    const filas = [];
    let truncado = false;
    for(const fila of stmt.iterate(...params)){
      if(filas.length >= MAX_FILAS){ truncado = true; break; }
      filas.push(fila);
    }
    res.json({ filas, total: filas.length, truncado });
  }catch(e){
    res.status(400).json({ error: 'Error en la consulta: ' + e.message });
  }
});

module.exports = router;
module.exports.revisarConsulta = revisarConsulta;
