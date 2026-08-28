const express = require('express');
const session = require('express-session');
const path = require('path');
const multer = require('multer');

const db = require('./db');
const SqliteSessionStore = require('./sqliteSessionStore');
require('./seed'); // idempotente: crea usuarios/proveedores/caso de prueba solo si no existen
require('./enriquecerDesdeLibreta').enriquecerDesdeLibreta(); // idempotente: solo rellena campos vacíos en expedientes ya existentes
require('./resetEmergenciaDaniela').resetEmergenciaDaniela(); // idempotente: corre una sola vez
require('./backup').programarRespaldosAutomaticos(db); // item 11 del triage: respaldo diario + rotación; no-op en pruebas
if(!process.env.TEST_DB_PATH){ require('./utils').limpiarDuplicadosCorreosPendientesExistentes(db); } // hallazgo de Daniela 26-ago-2026: limpieza unica de correos automaticos duplicados ya acumulados
if(!process.env.TEST_DB_PATH){ require('./utils').corregirBorradoresAutomaticosExistentes(db); } // hallazgo de Daniela 27-ago-2026: corrige destinatario/copia/cuerpo de los borradores automaticos ya existentes
if(!process.env.TEST_DB_PATH){ require('./utils').normalizarFechasCreacionPedidosExistentes(db); } // hallazgo real 27-ago-2026: normaliza fecha_creacion de pedidos importados en DD/MM/AAAA a ISO (la ventana operativa del 1-jun-2026 los ocultaba por error de formato)
if(!process.env.TEST_DB_PATH){ require('./utils').normalizarAseguradorasExistentes(db); } // hallazgo A-03 de Daniela 28-ago-2026: unifica variantes de nombre de aseguradora ya importadas
const { login, logout, me, crearUsuario, requireAuth, requireRole, resetPassword } = require('./auth');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(session({
  store: new SqliteSessionStore(db), // corrige "Sesión expirada" tras cada reinicio (antes: MemoryStore)
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
app.post('/api/auth/usuarios/:id/reset-password', requireAuth, requireRole('admin'), resetPassword);
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
app.use('/api/hitos', require('./routes/hitos'));
app.use('/api/mensajes-ia', require('./routes/mensajesIa'));
app.use('/api/carga-masiva', require('./routes/cargaMasiva'));
app.use('/api/danos-evidencia', require('./routes/danosEvidencia'));
app.use('/api/documentos-expediente', require('./routes/documentosExpediente'));
app.use('/api/ordenes-trabajo', require('./routes/ordenesTrabajo'));
app.use('/api/ot-operaciones', require('./routes/otOperaciones'));
app.use('/api/complementos', require('./routes/complementos'));
app.use('/api/retrabajos', require('./routes/retrabajos'));
app.use('/api/checklist-calidad', require('./routes/checklistCalidad'));
app.use('/api/mapeo-estatus-inpart', require('./routes/mapeoEstatusInpart'));
app.use('/api/respaldos', require('./routes/respaldos'));
app.use('/api/discrepancias-proveedor', require('./routes/discrepanciasProveedor'));
app.use('/api/vales-pendientes', require('./routes/valesPendientes'));

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
