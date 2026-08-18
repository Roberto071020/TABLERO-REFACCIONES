const express = require('express');
const session = require('express-session');
const path = require('path');
const multer = require('multer');

const db = require('./db');
require('./seed'); // idempotente: crea usuarios/proveedores/caso de prueba solo si no existen
const { login, logout, me, crearUsuario, requireAuth, requireRole } = require('./auth');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto-en-produccion',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*12, sameSite:'lax' } // 12 horas
}));

// ---- Auth ----
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', me);
app.post('/api/auth/usuarios', requireAuth, requireRole('admin'), crearUsuario);
app.get('/api/auth/usuarios', requireAuth, requireRole('admin','jefe'), (req,res)=>{
  res.json(db.prepare('SELECT id,nombre,email,rol,activo,creado_en FROM usuarios ORDER BY nombre').all());
});
app.patch('/api/auth/password', requireAuth, (req,res)=>{
  const { actual, nueva } = req.body;
  if(!actual || !nueva || nueva.length < 8) return res.status(400).json({ error:'Contraseña actual y nueva (mínimo 8 caracteres) son obligatorias.' });
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.session.user.id);
  if(!bcrypt.compareSync(actual, u.password_hash)) return res.status(401).json({ error:'La contraseña actual no es correcta.' });
  const hash = bcrypt.hashSync(nueva, 10);
  db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hash, u.id);
  res.json({ ok:true });
});

// ---- Recursos ----
app.use('/api/siniestros', require('./routes/siniestros'));
app.use('/api/pedidos', require('./routes/pedidos'));
app.use('/api/piezas', require('./routes/piezas'));
app.use('/api/incidencias', require('./routes/incidencias'));
app.use('/api/proveedores', require('./routes/proveedores'));
app.use('/api/comunicaciones', require('./routes/comunicaciones'));
app.use('/api/archivos', require('./routes/archivos'));
app.use('/api/auditoria', require('./routes/auditoria'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/eventos-cliente', require('./routes/eventosCliente'));
app.use('/api/tareas', require('./routes/tareas'));

// ---- Frontend estático ----
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((req, res, next)=>{
  if(req.method !== 'GET') return next();
  if(req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---- Manejo de errores (incluye multer: tipo/tamaño de archivo) ----
app.use((err, req, res, next)=>{
  if(err instanceof multer.MulterError || err.message){
    return res.status(400).json({ error: err.message || 'Solicitud inválida.' });
  }
  console.error(err);
  res.status(500).json({ error:'Error interno del servidor.' });
});

const PORT = process.env.PORT || 3000;
if(require.main === module){
  app.listen(PORT, ()=> console.log(`Tablero de Refacciones escuchando en http://localhost:${PORT}`));
}
module.exports = app;
