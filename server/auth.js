const bcrypt = require('bcryptjs');
const db = require('./db');
const { registrarAuditoria } = require('./utils');

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

module.exports = { requireAuth, requireRole, login, logout, me, crearUsuario };
