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

// ---- 12-nov-2026: avisos para todo el equipo. Roberto: "Los demás también me están pidiendo las notificaciones
// push" -> aprobó la lista por persona ("Si, nada fuera de días u horarios laborales"). Igual que con Orlando, solo
// lo NUEVO que le llega de otra persona.
const RECIENTE = "datetime('now','-3 days')";
// Expediente completo enviado por Roberto (autorizada, OT y proveedores asignados) -> Alejandra y Daniela.
function expedientesCompletos(db, quien){
  return db.prepare(`SELECT id AS siniestro_id, numero AS siniestro_numero, vehiculo, placas FROM siniestros
    WHERE archivado = 0 AND expediente_completo_enviado_en IS NOT NULL AND expediente_completo_enviado_en != ''
      AND replace(substr(expediente_completo_enviado_en,1,19),'T',' ') >= ${RECIENTE}`).all()
    .map(x => ({ clave:`expc-${x.siniestro_id}`, titulo:'📂 Expediente completo', cuerpo:`${unidad(x)}: ${quien}` }));
}
function pendientesAlejandra(db){
  const { calcularInicioAlejandra } = require('./inicioAlejandra');
  const lista = [];
  for(const t of calcularInicioAlejandra(db).tarjetas){
    const u = unidad({ vehiculo: t.vehiculo, placas: t.placas, siniestro_numero: t.numero });
    if(t.tipo === 'aviso' && t.codigo === '5.11') lista.push({ clave:`lista-${t.id}`, titulo:'✅ Unidad lista para entregar', cuerpo:`${u}: avísale al cliente que puede pasar por ella.` });
    if(t.tipo === 'reingreso') lista.push({ clave:`reing-${t.tarea_id || t.id}`, titulo:'📅 Agendar reingreso', cuerpo:`${u}: ya llegaron sus piezas.` });
  }
  return lista.concat(expedientesCompletos(db, 'avísale al cliente y coordina su entrada a producción.'));
}
function pendientesDaniela(db){
  const { calcularInicioDaniela } = require('./inicioDaniela');
  const d = calcularInicioDaniela(db);
  const lista = [];
  for(const g of d.recibir){
    const ids = g.piezas.map(z => z.id).sort((a, b) => a - b).join('.');
    lista.push({ clave:`rec-${g.siniestro_id}-${ids}`, titulo:'📦 Piezas entregadas por el proveedor', cuerpo:`${unidad(g)}: ${g.piezas.length} pieza(s) por revisar.` });
  }
  for(const z of d.mal){
    lista.push({ clave:`mal-${z.id}-${z.incidencia ? z.incidencia.id : z.estatus}`, titulo:'⚠️ Pieza mal surtida', cuerpo:`${z.descripcion || 'Pieza'} · ${unidad(z)}` });
  }
  return lista.concat(expedientesCompletos(db, 'da seguimiento a sus pedidos.'));
}
function pendientesBeto(db){
  const { calcularPanoramaBeto } = require('./panoramaBeto');
  const lista = [];
  for(const x of calcularPanoramaBeto(db)){
    if((x.prioridad === 3 || x.prioridad === 3.5) && !x.estado_produccion){
      lista.push({ clave:`iniciar-${x.id}`, titulo:'🔧 Unidad lista para iniciar', cuerpo:`${unidad({ vehiculo:x.vehiculo, placas:x.placas, siniestro_numero:x.numero })}: ${x.motivo}` });
    }
  }
  db.prepare(`SELECT s.id, s.numero AS siniestro_numero, s.vehiculo, s.placas,
      (SELECT MAX(a.id) FROM auditoria a WHERE a.entidad_tipo='siniestro' AND a.entidad_id=s.id AND a.campo='estado_calidad' AND a.valor_nuevo='rechazado_a_retrabajo') AS aud
    FROM siniestros s WHERE s.archivado = 0 AND s.estado_calidad = 'rechazado_a_retrabajo'`).all()
    .forEach(x => lista.push({ clave:`calrech-${x.id}-${x.aud || 0}`, titulo:'↩️ Calidad: hay algo por corregir', cuerpo: unidad(x) }));
  db.prepare(`SELECT c.id, c.causa, c.pieza_operacion, s.numero AS siniestro_numero, s.vehiculo, s.placas FROM complementos c JOIN siniestros s ON s.id = c.siniestro_id
    WHERE c.tipo = 'dano_oculto' AND c.decision IN ('autorizado','parcial') AND s.archivado = 0
      AND COALESCE(c.decision_en, c.actualizado_en) >= ${RECIENTE}`).all()
    .forEach(c => lista.push({ clave:`compaut-${c.id}`, titulo:'👍 Complemento autorizado', cuerpo:`${unidad(c)}: ${c.pieza_operacion || c.causa || ''}` }));
  return lista;
}
function pendientesRoberto(db){
  const { calcularInicioRoberto, LIMITE_COMPLEMENTO } = require('./inicioRoberto');
  const d = calcularInicioRoberto(db, { alertas: false });
  const u = x => unidad({ vehiculo: x.vehiculo, placas: x.placas, siniestro_numero: x.numero });
  const lista = [];
  d.por_valuar.forEach(x => lista.push({ clave:`valuar-${x.id}`, titulo:'🧮 Expediente listo para valuar', cuerpo: u(x) }));
  d.complementos.forEach(c => lista.push({ clave:`compd-${c.complemento_id}`, titulo:`💲 Complemento de más de $${LIMITE_COMPLEMENTO.toLocaleString('es-MX')}`, cuerpo:`${u(c)}: necesita tu decisión.` }));
  d.reautorizaciones.forEach(c => {
    if(c.horas_restantes < 0) lista.push({ clave:`reautv-${c.complemento_id}`, titulo:'🚨 Reautorización vencida', cuerpo:`${u(c)}: Orlando no mandó las fotos editadas.` });
    else lista.push({ clave:`reaut6-${c.complemento_id}`, titulo:`⏰ Reautorización vence en ${c.horas_restantes} h`, cuerpo:`${u(c)}: ${c.pieza_operacion || ''}` });
  });
  db.prepare(`SELECT id, numero AS siniestro_numero, vehiculo, placas, encuesta_comentarios FROM siniestros
    WHERE encuesta_estado = 'no_solicitar' AND fecha_entrega_real >= date('now','-15 days')`).all()
    .forEach(x => lista.push({ clave:`inconf-${x.id}`, titulo:'😕 Cliente GNP inconforme en la entrega', cuerpo:`${unidad(x)}: ${String(x.encuesta_comentarios || '').replace(/^Inconforme en la entrega: /, '')}` }));
  return lista;
}
// 12-nov-2026 (personal de patio, ver server/patio.js): lo que reporta el técnico le llega a quien le toca
// (Daniela: pieza; Orlando: daño oculto; Beto: "terminé" y falta material) y al técnico, cuando Beto le asigna una unidad.
const P = require('./patio');
const conPatio = (fuente, extra) => db => { let l = fuente(db); try{ l = l.concat(extra(db)); }catch(e){} return l; };
function pendientesTecnico(db, usuario){ try{ return P.pushTecnico(db, usuario); }catch(e){ return []; } }
pendientesTecnico.porUsuario = true; // la lista cambia por persona, no por rol
const FUENTES = { orlando: conPatio(pendientesOrlando, P.pushOrlando), atencion_cliente: pendientesAlejandra, operativo: conPatio(pendientesDaniela, P.pushDaniela),
  beto: conPatio(pendientesBeto, P.pushBeto), admin: pendientesRoberto, jefe: pendientesRoberto, tecnico: pendientesTecnico };

// ---- Horario laboral (12-nov-2026, Roberto: "nada fuera de días u horarios laborales"; eligió L-V 9-7, Sáb 9-2).
// Fuera de horario no se manda nada; lo que surja se avisa al abrir (agrupado si son más de 3).
// Veracruz = America/Mexico_City, UTC-6 todo el año (sin horario de verano desde 2022).
const HORARIO = { 1:[9,19], 2:[9,19], 3:[9,19], 4:[9,19], 5:[9,19], 6:[9,14] }; // 0 = domingo: cerrado
function enHorarioLaboral(fecha = new Date()){
  const mx = new Date(fecha.getTime() - 6 * 3600000);
  const h = HORARIO[mx.getUTCDay()];
  if(!h) return false;
  const hora = mx.getUTCHours() + mx.getUTCMinutes() / 60;
  return hora >= h[0] && hora < h[1];
}

function disponiblePara(rol){ return configurado() && !!FUENTES[rol]; }

function marcarAvisados(db, usuarioId, claves){
  const st = db.prepare('INSERT OR IGNORE INTO push_avisados (usuario_id, clave) VALUES (?, ?)');
  for(const k of claves) st.run(usuarioId, k);
}

// Al activar: lo que ya tiene pendiente no se avisa (ya lo ve en pantalla).
function marcarBase(db, usuario){
  const fuente = FUENTES[usuario.rol];
  if(!fuente) return;
  marcarAvisados(db, usuario.id, fuente(db, usuario).map(p => p.clave));
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
async function barrido(db, { enviar = enviarReal, ahora = new Date() } = {}){
  if(corriendo) return { omitido: true };
  if(!enHorarioLaboral(ahora)) return { fuera_de_horario: true };
  corriendo = true;
  const resultado = { usuarios: 0, avisos: 0 };
  try{
    const usuarios = db.prepare(`SELECT DISTINCT u.id, u.rol FROM usuarios u JOIN push_suscripciones p ON p.usuario_id = u.id WHERE u.activo = 1`).all();
    const porRol = {}; // la misma lista sirve para todos los usuarios del mismo rol en este barrido
    for(const u of usuarios){
      const fuente = FUENTES[u.rol];
      if(!fuente) continue;
      resultado.usuarios++;
      const ya = new Set(db.prepare('SELECT clave FROM push_avisados WHERE usuario_id = ?').all(u.id).map(r => r.clave));
      let todos;
      try{ todos = fuente.porUsuario ? fuente(db, u) : (porRol[u.rol] || (porRol[u.rol] = fuente(db))); }catch(e){ console.error('[push] pendientes de', u.rol, e && e.message); continue; }
      const nuevos = todos.filter(p => !ya.has(p.clave));
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

module.exports = { asegurarTablas, iniciarAvisosPush, barrido, enviarAUsuario, guardarSuscripcion, quitarSuscripcion, disponiblePara, configurado, enviarReal,
  enHorarioLaboral, FUENTES, pendientesOrlando, pendientesAlejandra, pendientesDaniela, pendientesBeto, pendientesRoberto };
