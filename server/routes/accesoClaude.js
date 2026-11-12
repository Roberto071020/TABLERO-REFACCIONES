// ===================== Acceso completo de Claude (12-nov-2026) =====================
// Roberto (12-nov-2026): "Agrega la opción y haz lo necesario para que puedas realizar todo lo que yo te pida sin
// restricciones". Hasta hoy Claude solo tenía ventanillas acotadas (subir OT, importador de unidades, consultas) y
// cosas como el motivo de una unidad detenida o sustituir una OT las tenía que hacer alguien en pantalla.
//
// Cómo funciona: con la clave CLAUDE_TOKEN (variable de entorno de Render, nunca en el repo), Claude usa EXACTAMENTE
// las mismas rutas que usa la pantalla (/api/siniestros, /api/archivos, /api/piezas, ...) bajo /api/externo/claude/,
// como un usuario administrador llamado "Claude (por indicación de Roberto)". Así aplica las mismas reglas del
// negocio que cualquier persona y cada cambio queda en la auditoría con ese nombre.
//
// Lo único que queda fuera, a propósito: usuarios y contraseñas (/auth) y descargar respaldos completos de la base.
// Sin CLAUDE_TOKEN responde 503.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

const NOMBRE = 'Claude (por indicación de Roberto)';
const EMAIL = 'claude@sistema.sc';
let usuario = null;
// Usuario propio (inactivo: nadie puede iniciar sesión con él) para que la auditoría y los "creado por" tengan id.
function usuarioClaude(){
  if(usuario) return usuario;
  let u = db.prepare('SELECT id, nombre, rol FROM usuarios WHERE email = ?').get(EMAIL);
  if(!u){
    const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
    const info = db.prepare(`INSERT INTO usuarios (nombre, email, password_hash, rol, activo) VALUES (?,?,?,?,0)`).run(NOMBRE, EMAIL, hash, 'admin');
    u = { id: Number(info.lastInsertRowid), nombre: NOMBRE, rol: 'admin' };
  }
  usuario = { id: u.id, nombre: NOMBRE, email: EMAIL, rol: 'admin' };
  return usuario;
}

function claveValida(recibida){
  const esperada = process.env.CLAUDE_TOKEN;
  if(!esperada || !recibida) return false;
  const a = crypto.createHash('sha256').update(String(recibida)).digest();
  const b = crypto.createHash('sha256').update(String(esperada)).digest();
  return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if(!process.env.CLAUDE_TOKEN) return res.status(503).json({ error:'El acceso de Claude no está activado (falta CLAUDE_TOKEN).' });
  const auth = req.get('authorization') || '';
  if(!claveValida(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '')) return res.status(401).json({ error:'Clave inválida.' });
  // Esta ruta se monta ANTES de la sesión (server/index.js): la "sesión" es solo este objeto, no se guarda ni manda cookie.
  req.session = { user: usuarioClaude() };
  next();
});

// Mismas rutas que la pantalla (ver server/index.js). Fuera: /auth y /respaldos.
const RUTAS = {
  siniestros:'siniestros', pedidos:'pedidos', piezas:'piezas', incidencias:'incidencias', proveedores:'proveedores',
  comunicaciones:'comunicaciones', archivos:'archivos', auditoria:'auditoria', reportes:'reportes', 'eventos-cliente':'eventosCliente',
  tareas:'tareas', hitos:'hitos', 'carga-masiva':'cargaMasiva', 'danos-evidencia':'danosEvidencia',
  'documentos-expediente':'documentosExpediente', 'ordenes-trabajo':'ordenesTrabajo', 'ot-operaciones':'otOperaciones',
  complementos:'complementos', retrabajos:'retrabajos', 'checklist-calidad':'checklistCalidad', 'discrepancias-proveedor':'discrepanciasProveedor',
  'vales-pendientes':'valesPendientes', 'autosurtido-piezas':'autosurtidoPiezas', 'actualizacion-unidades':'actualizacionUnidades',
  fotos:'fotos', 'inicio-alejandra':'inicioAlejandra', 'inicio-daniela':'inicioDaniela', 'inicio-orlando':'inicioOrlando',
  'inicio-roberto':'inicioRoberto', detenidas:'detenidas', llegada:'llegada', calidad:'calidad', 'whatsapp-manual':'whatsappBandejaManual',
};
for(const [ruta, archivo] of Object.entries(RUTAS)) router.use('/' + ruta, require('./' + archivo));

module.exports = router;
