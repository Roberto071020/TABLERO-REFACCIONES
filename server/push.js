// ===================== Avisos push al celular (11-nov-2026) =====================
// Roberto (11-nov-2026): "Me pregunta Orlando como puede activar notificaciones push en su teléfono para que
// al tener algo por hacer en automático le avise" -> eligió la opción 1 (notificación push del tablero).
//
// Cómo funciona:
//   - En su pantalla de inicio, Orlando toca "Activar avisos en este celular". El navegador le pide permiso y
//     el tablero guarda la suscripción de ESE teléfono (tabla push_suscripciones).
//   - Cada 2 minutos el servidor revisa su lista de pendientes (la misma de su pantalla de inicio) y le manda
//     un aviso por cada cosa NUEVA. Lo que ya se avisó queda en push_avisados para no repetirlo.
//   - Al activar, lo que ya tenía pendiente se marca como avisado (ya lo está viendo en pantalla).
//   - Si llegan más de 3 cosas nuevas juntas, manda un solo aviso con el total (para no llenarle el celular).
//
// Claves: VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY viven en variables de entorno de Render (nunca en el repo).
// Sin ellas todo queda apagado y el botón no aparece.
const { calcularInicioOrlando } = require('./inicioOrlando');

const INTERVALO_MS = 2 * 60 * 1000;
const MAX_AVISOS_SUELTOS = 3;
const HORAS_URGENTE_REAUT = 4;

let webpush = null;
function configurado(){ return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY); }
function cliente(){
  if(!configurado()) return null;
  if(!webpush){
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://tablero-refacciones.onrender.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
  return webpush;
}

function asegurarTablas(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_suscripciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      dispositivo TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      ultimo_envio_en TEXT,
      ultimo_error TEXT
    );
    CREATE TABLE IF NOT EXISTS push_avisados (
      usuario_id INTEGER NOT NULL,
      clave TEXT NOT NULL,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (usuario_id, clave)
    );
  `);
}

// ---- Qué cuenta como "algo por hacer", por rol ----
// Solo lo que le llega de OTRA persona (lo que él mismo dejó a medias ya lo sabe): reautorizaciones (Roberto),
// unidades nuevas por revisar (Alejandra) y complementos por daño oculto (Beto).
function unidad(x){ return [x.vehiculo, x.placas, x.siniestro_numero].filter(Boolean).join(' · '); }
function pendientesOrlando(db){
  const d = calcularInicioOrlando(db);
  const lista = [];
  for(const c of d.reautorizar){
    lista.push({ clave:`reaut-${c.id}`, titulo:'🚨 Fotos editadas para reautorizar', cuerpo:`${unidad(c)}: ${c.pieza_operacion || c.causa || ''}. Tienes ${d.horas_reautorizacion} h.` });
    if(c.horas_restantes != null && c.horas_restantes >= 0 && c.horas_restantes <= HORAS_URGENTE_REAUT && !c.fotos_editadas){
      lista.push({ clave:`reaut-${c.id}-urgente`, titulo:`⏰ Quedan ${c.horas_restantes} h para la reautorización`, cuerpo:`${unidad(c)}: faltan las fotos editadas.` });
    }
  }
  for(const x of d.revisar) lista.push({ clave:`revisar-${x.siniestro_id}`, titulo:'🔍 Unidad nueva por revisar', cuerpo:unidad(x) });
  for(const c of d.complementos) lista.push({ clave:`comp-${c.id}`, titulo:'🛠️ Complemento por daño oculto', cuerpo:`${unidad(c)}: ${c.causa || ''}` });
  return lista;
}
const FUENTES = { orlando: pendientesOrlando };

function disponiblePara(rol){ return configurado() && !!FUENTES[rol]; }

function marcarAvisados(db, usuarioId, claves){
  const st = db.prepare('INSERT OR IGNORE INTO push_avisados (usuario_id, clave) VALUES (?, ?)');
  for(const k of claves) st.run(usuarioId, k);
}

// Al activar: lo que ya tiene pendiente no se avisa (ya lo ve en pantalla).
function marcarBase(db, usuario){
  const fuente = FUENTES[usuario.rol];
  if(!fuente) return;
  marcarAvisados(db, usuario.id, fuente(db).map(p => p.clave));
}

function guardarSuscripcion(db, usuario, sub, dispositivo){
  if(!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth){
    throw new Error('Suscripción inválida.');
  }
  db.prepare(`INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth, dispositivo) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET usuario_id=excluded.usuario_id, p256dh=excluded.p256dh, auth=excluded.auth, dispositivo=excluded.dispositivo, ultimo_error=NULL`)
    .run(usuario.id, sub.endpoint, String(sub.keys.p256dh), String(sub.keys.auth), String(dispositivo || '').slice(0, 200));
  marcarBase(db, usuario);
}

function quitarSuscripcion(db, usuarioId, endpoint){
  return db.prepare('DELETE FROM push_suscripciones WHERE usuario_id = ? AND endpoint = ?').run(usuarioId, String(endpoint || '')).changes;
}

// Manda un aviso a todos los celulares del usuario. `enviar` se puede reemplazar en pruebas.
async function enviarAUsuario(db, usuarioId, aviso, enviar){
  const subs = db.prepare('SELECT * FROM push_suscripciones WHERE usuario_id = ?').all(usuarioId);
  const payload = JSON.stringify({ titulo: aviso.titulo, cuerpo: aviso.cuerpo, tag: aviso.tag || aviso.clave || 'sc', url: '/' });
  let enviados = 0;
  for(const s of subs){
    try{
      await enviar({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      db.prepare(`UPDATE push_suscripciones SET ultimo_envio_en = datetime('now'), ultimo_error = NULL WHERE id = ?`).run(s.id);
      enviados++;
    }catch(e){
      // 404/410: el celular ya no acepta avisos (se desinstaló o se quitó el permiso) -> se borra.
      if(e && (e.statusCode === 404 || e.statusCode === 410)) db.prepare('DELETE FROM push_suscripciones WHERE id = ?').run(s.id);
      else db.prepare('UPDATE push_suscripciones SET ultimo_error = ? WHERE id = ?').run(String((e && e.message) || e).slice(0, 300), s.id);
    }
  }
  return enviados;
}

function enviarReal(sub, payload){ return cliente().sendNotification(sub, payload, { TTL: 12 * 3600, urgency: 'high' }); }

let corriendo = false;
async function barrido(db, { enviar = enviarReal } = {}){
  if(corriendo) return { omitido: true };
  corriendo = true;
  const resultado = { usuarios: 0, avisos: 0 };
  try{
    const usuarios = db.prepare(`SELECT DISTINCT u.id, u.rol FROM usuarios u JOIN push_suscripciones p ON p.usuario_id = u.id WHERE u.activo = 1`).all();
    for(const u of usuarios){
      const fuente = FUENTES[u.rol];
      if(!fuente) continue;
      resultado.usuarios++;
      const ya = new Set(db.prepare('SELECT clave FROM push_avisados WHERE usuario_id = ?').all(u.id).map(r => r.clave));
      const nuevos = fuente(db).filter(p => !ya.has(p.clave));
      if(!nuevos.length) continue;
      // Se marcan antes de enviar: si el envío falla no se reintenta en cada barrido (lo sigue viendo en pantalla).
      marcarAvisados(db, u.id, nuevos.map(p => p.clave));
      const avisos = nuevos.length > MAX_AVISOS_SUELTOS
        ? [{ titulo:`📋 Tienes ${nuevos.length} pendientes nuevos`, cuerpo: nuevos.slice(0, 3).map(p => p.titulo.replace(/^\S+\s/, '')).join(', ') + '…', tag:'resumen' }]
        : nuevos;
      for(const a of avisos){ resultado.avisos += (await enviarAUsuario(db, u.id, a, enviar)) ? 1 : 0; }
    }
  }catch(e){
    console.error('[push] barrido falló:', e && e.message);
  }finally{
    corriendo = false;
  }
  return resultado;
}

function iniciarAvisosPush(db){
  asegurarTablas(db);
  if(process.env.TEST_DB_PATH || !configurado()) return null;
  setTimeout(() => barrido(db), 30 * 1000);
  return setInterval(() => barrido(db), INTERVALO_MS);
}

module.exports = { asegurarTablas, iniciarAvisosPush, barrido, enviarAUsuario, guardarSuscripcion, quitarSuscripcion, disponiblePara, configurado, pendientesOrlando, enviarReal };
