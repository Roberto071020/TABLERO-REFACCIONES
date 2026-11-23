const bcrypt = require('bcryptjs');
const db = require('./db');
const { registrarAuditoria } = require('./utils');
const crypto = require('crypto');

function requireAuth(req, res, next){
  if(!req.session || !req.session.user) return res.status(401).json({ error:'No autenticado. Inicia sesión.' });
  next();
}
function requireRole(...roles){
  return (req, res, next)=>{
    if(!req.session || !req.session.user) return res.status(401).json({ error:'No autenticado.' });
    if(!roles.includes(req.session.user.rol)) return res.status(403).json({ error:'No tienes permiso para esta acción.' });
    next();
  };
}

function login(req, res){
  const { email, password } = req.body;
  if(!email || !password) return res.status(400).json({ error:'Email y contraseña requeridos.' });
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(String(email).toLowerCase().trim());
  if(!u || !bcrypt.compareSync(password, u.password_hash)){
    return res.status(401).json({ error:'Credenciales incorrectas.' });
  }
  req.session.user = { id:u.id, nombre:u.nombre, email:u.email, rol:u.rol };
  registrarAuditoria(db, { entidad_tipo:'usuario', entidad_id:u.id, accion:'login', usuario:req.session.user });
  res.json({ user: req.session.user });
}
function logout(req, res){
  const user = req.session.user;
  if(user) registrarAuditoria(db, { entidad_tipo:'usuario', entidad_id:user.id, accion:'logout', usuario:user });
  req.session.destroy(()=> res.json({ ok:true }));
}
function me(req, res){
  if(!req.session || !req.session.user) return res.status(401).json({ error:'No autenticado.' });
  res.json({ user: req.session.user });
}

// Solo un admin existente puede crear usuarios nuevos (roles de la sección 3 de la especificación).
function crearUsuario(req, res){
  const { nombre, email, password, rol } = req.body;
  if(!nombre || !email || !password) return res.status(400).json({ error:'Nombre, email y contraseña son obligatorios.' });
  const rolesValidos = ['operativo','jefe','consulta','admin'];
  const rolFinal = rolesValidos.includes(rol) ? rol : 'operativo';
  const hash = bcrypt.hashSync(password, 10);
  try{
    const info = db.prepare('INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (?,?,?,?)')
      .run(nombre, String(email).toLowerCase().trim(), hash, rolFinal);
    registrarAuditoria(db, { entidad_tipo:'usuario', entidad_id:info.lastInsertRowid, accion:'alta', usuario:req.session.user });
    res.status(201).json({ id: info.lastInsertRowid, nombre, email, rol: rolFinal });
  }catch(e){
    if(String(e).includes('UNIQUE')) return res.status(409).json({ error:'Ya existe un usuario con ese email.' });
    res.status(500).json({ error:'No se pudo crear el usuario.' });
  }
}

// Solo un admin puede resetear la contraseña de otro usuario (ej. Daniela cambió la suya y ya no la recuerda).
// Genera una temporal legible y la regresa una sola vez; el usuario debe cambiarla en su siguiente login.
function resetPassword(req, res){
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if(!u) return res.status(404).json({ error:'Usuario no encontrado.' });
  const temporal = 'SC-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '!';
  const hash = bcrypt.hashSync(temporal, 10);
  db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hash, u.id);
  registrarAuditoria(db, { entidad_tipo:'usuario', entidad_id:u.id, accion:'password_reseteada_por_admin', usuario:req.session.user });
  res.json({ ok:true, email:u.email, password_temporal: temporal });
}

// 23-nov-2026. Roberto: "Adrián de refacciones ya no trabaja con nosotros" -> botón "Dar de baja" en Entradas de hoy.
// El usuario queda inactivo (no puede entrar y su sesión abierta se cierra); su historial y auditoría se conservan.
function darDeBaja(req, res){
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if(!u) return res.status(404).json({ error:'Usuario no encontrado.' });
  if(u.id === req.session.user.id) return res.status(400).json({ error:'No puedes darte de baja a ti mismo.' });
  if(['admin','jefe'].includes(u.rol)) return res.status(400).json({ error:'Este usuario no se puede dar de baja desde aquí.' });
  if(!u.activo) return res.json({ ok:true, ya_estaba:true });
  db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(u.id);
  registrarAuditoria(db, { entidad_tipo:'usuario', entidad_id:u.id, accion:'baja', usuario:req.session.user });
  res.json({ ok:true });
}
// Si a alguien lo dieron de baja con la sesión abierta, en su siguiente acción se le cierra.
function cerrarSiInactivo(req, res, next){
  const s = req.session && req.session.user;
  if(!s || !s.id || typeof req.session.destroy !== 'function') return next(); // la "sesión" del acceso de Claude no es real
  const u = db.prepare('SELECT activo FROM usuarios WHERE id = ?').get(s.id);
  if(u && u.activo) return next();
  req.session.destroy(() => res.status(401).json({ error:'Sesión expirada. Vuelve a iniciar sesión.' }));
}

module.exports = { requireAuth, requireRole, login, logout, me, crearUsuario, resetPassword, darDeBaja, cerrarSiInactivo };
