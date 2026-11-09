// Registro de entrada del personal (9-nov-2026) -- ver server/asistencia.js.
const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const A = require('../asistencia');
const router = express.Router();

// ¿Esta persona tiene que registrarse hoy y ya lo hizo?
router.get('/estado', requireAuth, (req, res) => {
  const u = req.session.user;
  const { fecha } = A.ahoraMX();
  const taller = A.leerTaller(db);
  // Mientras Roberto no marque la ubicación del taller, nadie queda bloqueado.
  const requiere = A.requiereRegistro(u.rol) && !!taller;
  const r = db.prepare(`SELECT hora_local, retardo FROM asistencia WHERE usuario_id = ? AND fecha = ?`).get(u.id, fecha);
  res.json({ fecha, requiere, registrado: !!r, hora: r ? r.hora_local : null, retardo: r ? !!r.retardo : false,
    taller_configurado: !!taller, hora_entrada: A.HORA_ENTRADA });
});

router.post('/entrada', requireAuth, (req, res) => {
  const u = req.session.user;
  if(!A.requiereRegistro(u.rol)) return res.status(400).json({ error:'Tu usuario no necesita registrar entrada.' });
  const { fecha, hora } = A.ahoraMX();
  const ya = db.prepare(`SELECT hora_local, retardo FROM asistencia WHERE usuario_id = ? AND fecha = ?`).get(u.id, fecha);
  if(ya) return res.json({ ok:true, hora: ya.hora_local, retardo: !!ya.retardo, ya_registrado: true });
  const v = A.validarEntrada(A.leerTaller(db), req.body || {});
  if(!v.ok){
    // Queda constancia de los intentos rechazados (por ejemplo, desde fuera del taller).
    registrarAuditoria(db, { entidad_tipo:'asistencia', entidad_id: u.id, accion:'entrada_rechazada', campo: v.distancia != null ? 'distancia_m' : null,
      valor_nuevo: v.distancia != null ? v.distancia : v.error, usuario: u });
    return res.status(400).json({ error: v.error });
  }
  const foto = A.guardarFoto(fecha, u.id, v.buf);
  const retardo = A.esRetardo(hora) ? 1 : 0;
  try{
    const info = db.prepare(`INSERT INTO asistencia (usuario_id, usuario_nombre, fecha, hora_local, retardo, lat, lng, precision_m, distancia_m, foto_ruta, ip, dispositivo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(u.id, u.nombre, fecha, hora, retardo, v.lat, v.lng, v.precision, v.distancia, foto,
      String(req.ip || ''), String(req.get('user-agent') || '').slice(0, 200));
    registrarAuditoria(db, { entidad_tipo:'asistencia', entidad_id: info.lastInsertRowid, accion:'entrada', campo:'hora_local', valor_nuevo: hora, usuario: u });
  }catch(e){
    if(!String(e).includes('UNIQUE')) throw e; // doble toque: ya quedó registrada
  }
  res.json({ ok:true, hora, retardo: !!retardo });
});

// Roberto marca la ubicación del taller desde su celular, estando ahí.
router.post('/taller', requireAuth, requireRole('admin'), (req, res) => {
  const lat = Number(req.body && req.body.lat), lng = Number(req.body && req.body.lng), precision = Number(req.body && req.body.precision);
  if(!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error:'Ubicación inválida.' });
  const anterior = A.leerTaller(db);
  A.guardarTaller(db, { lat, lng, precision: Number.isFinite(precision) ? Math.round(precision) : null });
  registrarAuditoria(db, { entidad_tipo:'configuracion', entidad_id: 0, accion:'edicion', campo:'taller_ubicacion',
    valor_anterior: anterior ? `${anterior.lat},${anterior.lng}` : null, valor_nuevo: `${lat},${lng}`, usuario: req.session.user });
  res.json({ ok:true, precision: Number.isFinite(precision) ? Math.round(precision) : null });
});

router.get('/hoy', requireAuth, requireRole('admin', 'jefe'), (req, res) => {
  res.json(A.entradasDeHoy(db));
});

router.get('/:id/foto', requireAuth, (req, res) => {
  const r = db.prepare(`SELECT usuario_id, foto_ruta FROM asistencia WHERE id = ?`).get(req.params.id);
  if(!r || !r.foto_ruta) return res.status(404).json({ error:'Sin foto.' });
  const u = req.session.user;
  if(!['admin', 'jefe'].includes(u.rol) && u.id !== r.usuario_id) return res.status(403).json({ error:'No tienes permiso.' });
  const p = A.rutaFoto(r.foto_ruta);
  if(!p || !fs.existsSync(p)) return res.status(404).json({ error:'Sin foto.' });
  res.type('image/jpeg').sendFile(p);
});

module.exports = router;
