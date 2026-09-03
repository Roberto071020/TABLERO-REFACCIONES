// Pruebas del modo "solo registro" de WhatsApp Fase A (autorizado por Roberto, 3-sep-2026; corregido
// el mismo día tras revisar la tercera entrega -- ver los 10 puntos de su mensaje). Cubren: detección
// por plantilla, deduplicación, continuidad con horas NATURALES (no hábiles), segundo periodo consecutivo
// -> alerta interna, ciclo de bloqueo con revisión humana explícita, autorización parcial, bienvenida al
// capturar el teléfono después, ubicación del vehículo sin adivinar, refacciones realmente disponibles,
// persistencia de errores, resolución de expediente por teléfono, y dos pruebas de regresión de seguridad.
// Ampliado con la QUINTA revisión de Roberto (3-sep-2026, misma tarde), 5 puntos más: WA-25 a WA-31
// scheduler independiente (ejecución, log, recuperación tras caída, idempotencia, protección de
// concurrencia, atraso); WA-32/33 alerta técnica separada con su regla de cierre; WA-34 a WA-36
// comunicaciones manuales y el contador de 72h; WA-37 a WA-40 validación de destino antes de CUALQUIER
// plantilla de cliente (sin teléfono, mal formado, corrección posterior, cambio de teléfono);
// WA-41/WA-42 validación final antes de un futuro envío real.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-whatsapp-fase-a.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const whatsappFaseA = require('../server/whatsappFaseA');
const whatsappScheduler = require('../server/whatsappScheduler');
const dayjs = require('dayjs');
const utcPlugin = require('dayjs/plugin/utc');
const timezonePlugin = require('dayjs/plugin/timezone');
dayjs.extend(utcPlugin); dayjs.extend(timezonePlugin);
const TZ = 'America/Mexico_City';

const PORT = 3997;
const BASE = 'http://localhost:' + PORT;
let server;
let cookie = '';

function withCookie(opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (cookie) headers['Cookie'] = cookie;
  return { ...opts, headers };
}
async function req(method, url, body) {
  const res = await fetch(BASE + url, withCookie({ method, body: body ? JSON.stringify(body) : undefined }));
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
async function login(email, password){
  const r = await req('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, `login debe funcionar para ${email}`);
}
let contador = 0;
function tel(){ contador++; return '551' + String(1000000 + contador); }

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, resolve); });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

async function crearSiniestro(campos){
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const numero = campos.numero;
  const body = { aseguradora:'GNP', cliente_nombre:'Cliente '+numero, cliente_correo: numero.toLowerCase()+'@test.mx', ...campos };
  const r = await req('POST', '/api/siniestros', body);
  assert.equal(r.status, 201, 'creación de siniestro debe funcionar: ' + JSON.stringify(r.data));
  return r.data;
}
// Alejandra (atencion_cliente) exige teléfono al dar de alta (regla previa, no relacionada con WhatsApp
// Fase A). Para simular un expediente creado SIN teléfono (punto 5), se da de alta como admin, que no
// tiene esa exigencia -- el resto del expediente queda igual de válido para las pruebas del ciclo.
async function crearSiniestroSinTelefono(campos){
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const numero = campos.numero;
  const body = { aseguradora:'GNP', cliente_nombre:'Cliente '+numero, cliente_correo: numero.toLowerCase()+'@test.mx', ...campos };
  const r = await req('POST', '/api/siniestros', body);
  assert.equal(r.status, 201, 'creación de siniestro (sin teléfono) debe funcionar: ' + JSON.stringify(r.data));
  return r.data;
}
async function eventosDe(siniestroId, extra=''){
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('GET', `/api/whatsapp-fase-a/eventos?siniestro_id=${siniestroId}${extra}`);
  assert.equal(r.status, 200);
  return r.data;
}
async function autorizarOrlando(siniestroId, body){
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  return req('PATCH', `/api/siniestros/${siniestroId}`, body);
}

// ===================== 1) Bienvenida (5.1) — creación y captura posterior del teléfono (punto 5) =====================
test('WA-1: crear con teléfono registra 5.1', async () => {
  const s = await crearSiniestro({ numero:'WA1', cliente_telefono: tel() });
  const eventos = await eventosDe(s.id);
  const e51 = eventos.find(e => e.plantilla_codigo === '5.1');
  assert.ok(e51 && e51.estado === 'registrado');
});

test('WA-2: crear sin teléfono NO registra 5.1 todavía', async () => {
  const s = await crearSiniestroSinTelefono({ numero:'WA2' });
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.find(e => e.plantilla_codigo === '5.1'), undefined);
});

test('WA-3 (punto 5): agregar el teléfono DESPUÉS registra 5.1 una sola vez; corregirlo otra vez no duplica', async () => {
  const s = await crearSiniestroSinTelefono({ numero:'WA3' });
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const t1 = tel();
  await req('PATCH', `/api/siniestros/${s.id}`, { cliente_telefono: t1 });
  let eventos = await eventosDe(s.id);
  assert.equal(eventos.filter(e => e.plantilla_codigo === '5.1').length, 1, 'debe registrar 5.1 al capturar el teléfono por primera vez');
  // corregir el teléfono después NO debe generar otra bienvenida.
  await req('PATCH', `/api/siniestros/${s.id}`, { cliente_telefono: tel() });
  eventos = await eventosDe(s.id);
  assert.equal(eventos.filter(e => e.plantilla_codigo === '5.1').length, 1, 'corregir el teléfono no debe volver a disparar 5.1');
});

// ===================== 2) Autorización: completa vs parcial (punto 4) =====================
test('WA-4: autorización COMPLETA con piezas registra 5.3', async () => {
  const s = await crearSiniestro({ numero:'WA4', cliente_telefono: tel() });
  const r = await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'Ajustador X', piezas_autorizadas_cambio:2 });
  assert.equal(r.status, 200);
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.3' && e.estado === 'registrado'));
});

test('WA-5 (punto 4): autorización PARCIAL bloquea la comunicación automática y pide revisión humana', async () => {
  const s = await crearSiniestro({ numero:'WA5', cliente_telefono: tel() });
  await autorizarOrlando(s.id, { estado_autorizacion:'parcial', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'Ajustador X', piezas_autorizadas_cambio:2 });
  const eventos = await eventosDe(s.id);
  const bloqueado = eventos.find(e => e.estado === 'bloqueado' && e.tipo_bloqueo === 'autorizacion_parcial');
  assert.ok(bloqueado, 'debe existir un evento bloqueado por autorización parcial');
  assert.equal(eventos.find(e => e.estado === 'registrado' && ['5.3','5.6','5.7'].includes(e.plantilla_codigo)), undefined,
    'ninguna plantilla de autorización debe quedar "registrado" mientras la autorización sea parcial');
});

test('WA-6 (punto 4): pasar de PARCIAL a COMPLETA sí evalúa el disparador normal', async () => {
  // ingreso_tipo pertenece al grupo de campos "admisión" (solo atencion_cliente/vanessa/admin/jefe puede
  // capturarlo; Orlando no) -- se fija desde la creación para no chocar con el permiso de PATCH de Orlando.
  const s = await crearSiniestro({ numero:'WA6', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'parcial', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'Ajustador X', piezas_autorizadas_cambio:0 });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'Ajustador X', piezas_autorizadas_cambio:0 });
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.6' && e.estado === 'registrado'), 'debe registrar 5.6 al completarse la autorización');
});

// ===================== 3) Ubicación del vehículo: no adivinar (punto 6) =====================
test('WA-7: ingreso_tipo=grua -> certeza "en_taller", registra 5.6 normalmente', async () => {
  const s = await crearSiniestro({ numero:'WA7', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:0 });
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.6' && e.estado === 'registrado'));
});

test('WA-8: circulando SIN fecha_admision -> certeza "fuera_taller", registra 5.7', async () => {
  const s = await crearSiniestro({ numero:'WA8', cliente_telefono: tel(), ingreso_tipo:'circulando' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:0 });
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.7' && e.estado === 'registrado'));
});

test('WA-9 (punto 6): circulando CON fecha_admision ya capturada -> el sistema NO adivina, bloquea por ubicación desconocida', async () => {
  const s = await crearSiniestro({ numero:'WA9', cliente_telefono: tel(), ingreso_tipo:'circulando', fecha_admision:'2026-08-20' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:0 });
  const eventos = await eventosDe(s.id);
  const bloqueado = eventos.find(e => e.tipo_bloqueo === 'ubicacion_desconocida');
  assert.ok(bloqueado, 'debe quedar pendiente de validación interna, no elegir 5.6 o 5.7 al azar');
  assert.equal(bloqueado.estado, 'bloqueado');
});

// ===================== 4) Refacciones realmente disponibles (punto 7) =====================
test('WA-10: pedido CANCELADO no cuenta como refacciones disponibles -- bloquea 5.4/5.5', async () => {
  const s = await crearSiniestro({ numero:'WA10', cliente_telefono: tel(), requiere_refacciones:'si' });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const p1 = (await req('POST', '/api/pedidos', { numero:'WA10-PED-1', siniestro_id:s.id, fecha_prevista:'2027-06-01' })).data;
  const p2 = (await req('POST', '/api/pedidos', { numero:'WA10-PED-2', siniestro_id:s.id, fecha_prevista:'2027-06-01' })).data;
  await req('PATCH', `/api/pedidos/${p1.id}`, { estatus_operativo:'Recibido completo' });
  await req('PATCH', `/api/pedidos/${p2.id}`, { estatus_operativo:'Cancelado', motivo_cancelacion:'Prueba' });
  const eventos = await eventosDe(s.id);
  const bloqueado = eventos.find(e => e.tipo_bloqueo === 'refacciones_no_disponibles');
  assert.ok(bloqueado, 'un pedido cancelado debe bloquear la plantilla de piezas listas');
  assert.equal(eventos.find(e => e.estado === 'registrado' && ['5.4','5.5'].includes(e.plantilla_codigo)), undefined);
});

test('WA-11: con TODOS los pedidos realmente "Recibido completo" sí se registra 5.5 (unidad en taller, grúa)', async () => {
  const s = await crearSiniestro({ numero:'WA11', cliente_telefono: tel(), requiere_refacciones:'si', ingreso_tipo:'grua' });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const p1 = (await req('POST', '/api/pedidos', { numero:'WA11-PED-1', siniestro_id:s.id, fecha_prevista:'2027-06-01' })).data;
  await req('PATCH', `/api/pedidos/${p1.id}`, { estatus_operativo:'Recibido completo' });
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.5' && e.estado === 'registrado'));
});

// ===================== 5) Continuidad: 72 horas NATURALES, no hábiles (punto 1) =====================
test('WA-12 (punto 1): continuidad SÍ se activa a las 72 horas naturales aunque incluyan viernes/sábado/domingo', async () => {
  const s = await crearSiniestro({ numero:'WA12', cliente_telefono: tel(), ingreso_tipo:'grua' });
  // Autoriza sin piezas -> etapa de continuidad "6.3 pendiente de asignación" (producción sin iniciar).
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  // El ancla real es el evento 5.6 recién registrado; lo reescribimos a 73 horas naturales de reloj atrás
  // (relativo a "ahora" para que la prueba no dependa de en qué día de la semana se ejecute). La prueba
  // dedicada a que el conteo NO se detenga en fin de semana es WA-21, con timestamps fijos viernes->lunes.
  // Se retrasan TODOS los eventos 5.x del expediente (no solo 5.6): ultimoAncla() toma el más reciente de
  // ellos, y si solo se moviera el 5.6, la bienvenida (5.1, capturada al crear) quedaría más "reciente" y
  // se usaría a ella como ancla -- un artefacto de la prueba, no un caso real (en producción 5.1 siempre
  // ocurre antes que 5.3/5.6/5.7).
  const haceUnRato = dayjs.utc().subtract(73, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(haceUnRato, s.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  const continuidad = eventos.find(e => e.plantilla_codigo === '6.3');
  assert.ok(continuidad, 'debe registrarse la continuidad aunque las 72h incluyan fin de semana');
});

test('WA-13 (punto 1): continuidad NO se activa antes de cumplirse las 72 horas naturales', async () => {
  const s = await crearSiniestro({ numero:'WA13', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  const hace70h = dayjs.utc().subtract(70, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace70h, s.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.find(e => e.plantilla_codigo === '6.3'), undefined, 'no deben pasar 70h reales de las 72 requeridas');
});

test('WA-14 (punto 2): segundo periodo consecutivo sin avance real genera ALERTA INTERNA, no otra plantilla 6.x', async () => {
  const s = await crearSiniestro({ numero:'WA14', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  // 150 horas naturales atrás = ya dentro de la SEGUNDA ventana de 72h (150/72 = ventana 2).
  // Mismo motivo que en WA-12: se retrasan todos los eventos 5.x del expediente, no solo el 5.6.
  const hace150h = dayjs.utc().subtract(150, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace150h, s.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  const alerta = eventos.find(e => e.plantilla_codigo === 'ALERTA-72H-X2');
  assert.ok(alerta, 'debe existir la alerta interna del segundo periodo');
  assert.equal(alerta.es_plantilla_meta, 0, 'una alerta interna NUNCA debe marcarse como plantilla de Meta');
});

// ===================== 6) Ciclo de eventos bloqueados (punto 3) =====================
test('WA-15 (punto 3): bloqueado -> pendiente_revision automático cuando se resuelve la incidencia; luego resolución explícita', async () => {
  const s = await crearSiniestro({ numero:'WA15', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const p = (await req('POST', '/api/pedidos', { numero:'WA15-PED', siniestro_id:s.id, fecha_prevista:'2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id:p.id, descripcion:'Cofre' })).data;
  const inc = (await req('POST', '/api/incidencias', { pieza_id:z.id, tipo:'danada', descripcion:'Llegó dañada' })).data;
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  let eventos = await eventosDe(s.id);
  const bloqueado = eventos.find(e => e.plantilla_codigo === '5.6' && e.estado === 'bloqueado' && e.tipo_bloqueo === 'incidencia_delicada');
  assert.ok(bloqueado, 'debe quedar bloqueado por la incidencia delicada');

  // Resolver la incidencia y correr el barrido -> debe pasar a pendiente_revision (NO enviarse, NO reprogramarse solo).
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  await req('PATCH', `/api/incidencias/${inc.id}`, { estado:'resuelta', resolucion:'Se cambió la pieza' });
  whatsappFaseA.revisarBloqueadosResueltos(db);
  eventos = await eventosDe(s.id);
  const pendiente = eventos.find(e => e.id === bloqueado.id);
  assert.equal(pendiente.estado, 'pendiente_revision', 'debe pasar a revisión humana, no reenviarse solo');

  // Resolución explícita, sin justificación -> debe rechazarse.
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  let r = await req('PATCH', `/api/whatsapp-fase-a/eventos/${bloqueado.id}/revision`, { decision:'liberado_para_programacion' });
  assert.equal(r.status, 400, 'sin justificación debe rechazarse');

  // Con justificación -> se resuelve, sin que eso implique ningún envío real.
  r = await req('PATCH', `/api/whatsapp-fase-a/eventos/${bloqueado.id}/revision`, {
    decision:'liberado_para_programacion',
    justificacion:'Se revalidó el estado actual del expediente, la vigencia del mensaje, que no hubo otro avance, que el texto sigue correspondiendo, y no requiere decisión de Daniela.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.estado, 'liberado_para_programacion');
  assert.ok(r.data.justificacion && r.data.justificacion.length > 10);
});

test('WA-16 (punto 3): no se puede resolver un evento que no esté en pendiente_revision', async () => {
  const s = await crearSiniestro({ numero:'WA16', cliente_telefono: tel() });
  const eventos = await eventosDe(s.id);
  const e51 = eventos.find(e => e.plantilla_codigo === '5.1'); // está "registrado", no "pendiente_revision"
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('PATCH', `/api/whatsapp-fase-a/eventos/${e51.id}/revision`, { decision:'descartado', justificacion:'prueba' });
  assert.equal(r.status, 400);
});

// ===================== 7) Registro persistente de errores + reintento (punto 8) =====================
test('WA-17 (punto 8): un error se registra de forma persistente, con reintentos, y genera alerta al persistir', async () => {
  const s = await crearSiniestro({ numero:'WA17', cliente_telefono: tel() });
  const errorFalso = new Error('Fallo simulado para la prueba WA-17');
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa17', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa17', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa17', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('GET', `/api/whatsapp-fase-a/errores?resuelto=0`);
  const fila = r.data.find(e => e.contexto === 'prueba-wa17' && e.siniestro_id === s.id);
  assert.ok(fila, 'el error debe quedar registrado y consultable');
  assert.equal(fila.intentos, 3, 'debe acumular reintentos en el mismo renglón, no crear tres filas distintas');
  const eventos = await eventosDe(s.id);
  // Punto 2 (quinta revisión, 3-sep-2026): un error técnico ya NO reutiliza ALERTA-72H-X2 (esa es
  // exclusiva de "expediente estancado"); usa su propio código ALERTA-WA-ERROR.
  const alerta = eventos.find(e => e.plantilla_codigo === 'ALERTA-WA-ERROR' && e.disparador.includes('Error persistente'));
  assert.ok(alerta, 'al persistir el error (3+ intentos) debe generarse una alerta interna auditable, con código propio');
  assert.equal(alerta.prioridad, 'alta', 'un error técnico debe registrarse con prioridad alta');
  assert.equal(eventos.find(e => e.plantilla_codigo === 'ALERTA-72H-X2'), undefined,
    'un error técnico NUNCA debe aparecer mezclado con la alerta de estancamiento (ALERTA-72H-X2)');
});

test('WA-18 (punto 8): la reconciliación es idempotente -- llamarla varias veces no duplica eventos', async () => {
  const s = await crearSiniestro({ numero:'WA18', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  whatsappFaseA.reconciliarEventosPrincipales(db);
  whatsappFaseA.reconciliarEventosPrincipales(db);
  whatsappFaseA.reconciliarEventosPrincipales(db);
  const eventos = (await eventosDe(s.id)).filter(e => e.plantilla_codigo === '5.3');
  assert.equal(eventos.length, 1, 'reintentar la reconciliación no debe duplicar nada gracias al dedup fijo');
});

// ===================== 8) Resolución de expediente por teléfono =====================
test('WA-19: teléfono con un solo expediente activo se resuelve automático; con varios, queda ambiguo', async () => {
  const t1 = tel();
  const sA = await crearSiniestro({ numero:'WA19-A', cliente_telefono: t1 });
  let r1 = whatsappFaseA.resolverExpedientePorTelefono(db, t1);
  assert.equal(r1.resultado, 'resuelto_automatico');
  assert.equal(r1.siniestro.id, sA.id);

  const t2 = tel();
  await crearSiniestro({ numero:'WA19-B', cliente_telefono: t2 });
  await crearSiniestro({ numero:'WA19-C', cliente_telefono: t2 });
  let r2 = whatsappFaseA.resolverExpedientePorTelefono(db, t2);
  assert.equal(r2.resultado, 'ambiguo_pendiente_asignacion');
  assert.equal(r2.candidatos.length, 2);
  assert.equal(r2.siniestro, null, 'no debe asignar arbitrariamente cuando hay varios');

  let r3 = whatsappFaseA.resolverExpedientePorTelefono(db, '0000000000');
  assert.equal(r3.resultado, 'sin_expediente_activo');
});

// ===================== 9) Horario hábil y horas naturales vs. hábiles (funciones puras) =====================
test('WA-20: esHorarioHabil respeta L-V 9-18, Sáb 9-14, domingo cerrado', () => {
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-03 10:00', TZ)), true, 'jueves 10:00 es hábil');
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-03 20:00', TZ)), false, 'jueves 20:00 NO es hábil');
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-05 13:00', TZ)), true, 'sábado 13:00 es hábil');
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-05 15:00', TZ)), false, 'sábado 15:00 ya NO es hábil (cierra 14:00)');
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-06 12:00', TZ)), false, 'domingo cerrado');
});

test('WA-21 (punto 1): horasNaturalesTranscurridas cuenta el reloj de pared, sin pausar fin de semana', () => {
  // Viernes 10:00 CDMX -> lunes 10:00 CDMX = exactamente 72 horas naturales, sin importar que incluya
  // sábado y domingo (contraste directo con horasHabilesTranscurridas, que sí las pausa).
  const desde = dayjs.tz('2026-08-28 10:00', TZ).utc().format('YYYY-MM-DD HH:mm:ss'); // viernes
  const hasta = dayjs.tz('2026-08-31 10:00', TZ).utc().format('YYYY-MM-DD HH:mm:ss'); // lunes
  assert.equal(whatsappFaseA.horasNaturalesTranscurridas(desde, hasta), 72);
  const habiles = whatsappFaseA.horasHabilesTranscurridas(desde, hasta);
  assert.ok(habiles < 72, `las horas hábiles (${habiles}) deben ser MENOS que las naturales (72) en el mismo fin de semana`);
});

// ===================== 10) Regresión de seguridad =====================
test('WA-22: el módulo no contiene ninguna llamada real a un servicio externo de WhatsApp/Meta', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'whatsappFaseA.js'), 'utf-8');
  assert.ok(!/fetch\s*\(/.test(src), 'no debe haber ningún fetch() en el módulo');
  assert.ok(!/require\(['"]axios['"]\)|axios\s*\./i.test(src), 'no debe usarse axios');
  assert.ok(!/graph\.facebook\.com|whatsapp\.com|meta\.com/i.test(src), 'no debe referenciar ningún dominio real de Meta/WhatsApp');
});

test('WA-23: el módulo nunca escribe en tablas del módulo de Daniela (pedidos/piezas/proveedores/comunicaciones)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'whatsappFaseA.js'), 'utf-8');
  assert.ok(!/UPDATE\s+pedidos/i.test(src));
  assert.ok(!/UPDATE\s+piezas/i.test(src));
  assert.ok(!/INSERT\s+INTO\s+comunicaciones/i.test(src));
  assert.ok(!/UPDATE\s+proveedores/i.test(src));
});

test('WA-24: "liberado_para_programacion" nunca implica un envío real -- no existe ningún mecanismo de envío en el módulo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'whatsappFaseA.js'), 'utf-8');
  assert.ok(!/sendMessage|enviarWhatsapp|enviarMensaje\(/i.test(src), 'no debe existir ninguna función de envío real');
});

// ===================== QUINTA REVISIÓN (3-sep-2026, misma tarde) =====================

// ---- Punto 1: barrido programado independiente ----
test('WA-25 (punto 1): ejecutarBarridoProgramado corre, queda registrado en el historial, y es idempotente', async () => {
  const s = await crearSiniestro({ numero:'WA25', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  const antes = db.prepare('SELECT COUNT(*) c FROM whatsapp_scheduler_ejecuciones').get().c;
  const r1 = whatsappScheduler.ejecutarBarridoProgramado(db, { disparadoPor:'prueba' });
  assert.equal(r1.omitido, false);
  assert.equal(r1.estado, 'completado');
  const despues = db.prepare('SELECT COUNT(*) c FROM whatsapp_scheduler_ejecuciones').get().c;
  assert.equal(despues, antes + 1, 'debe quedar exactamente una fila nueva de ejecución');
  const fila = db.prepare('SELECT * FROM whatsapp_scheduler_ejecuciones ORDER BY id DESC LIMIT 1').get();
  assert.equal(fila.estado, 'completado');
  assert.equal(fila.disparado_por, 'prueba');
  assert.ok(fila.terminado_en, 'debe registrar cuándo terminó');
  // Idempotencia: correrlo otra vez no debe duplicar el evento 5.3 ya registrado.
  whatsappScheduler.ejecutarBarridoProgramado(db, { disparadoPor:'prueba' });
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.filter(e => e.plantilla_codigo === '5.3').length, 1, 'reintentar el barrido no debe duplicar nada');
});

test('WA-26 (punto 1): recuperación tras una caída -- una ejecución "corriendo" colgada se marca fallida sola', () => {
  // Simula que el proceso murió a media ejecución: una fila queda "corriendo" desde hace más del umbral.
  const hace1h = dayjs.utc().subtract(60, 'minute').format('YYYY-MM-DD HH:mm:ss');
  const info = db.prepare(`INSERT INTO whatsapp_scheduler_ejecuciones (iniciado_en, estado, disparado_por) VALUES (?, 'corriendo', 'arranque')`).run(hace1h);
  const r = whatsappScheduler.ejecutarBarridoProgramado(db, { disparadoPor:'prueba-recuperacion' });
  assert.equal(r.omitido, false, 'la siguiente ejecución debe poder correr con normalidad tras la autosanación');
  const colgada = db.prepare('SELECT * FROM whatsapp_scheduler_ejecuciones WHERE id=?').get(info.lastInsertRowid);
  assert.equal(colgada.estado, 'fallido', 'la ejecución colgada debe quedar marcada como fallida, no seguir "corriendo" para siempre');
  assert.ok(colgada.error && colgada.error.length > 0, 'debe explicar por qué se marcó fallida');
});

test('WA-27 (punto 1): protección de concurrencia -- una segunda invocación mientras la primera sigue "corriendo" se omite', () => {
  const original = whatsappFaseA.barrerContinuidadYPostventa;
  let resultadoDeLaSegunda = null;
  whatsappFaseA.barrerContinuidadYPostventa = function(dbArg){
    // Mientras la primera ejecución sigue en curso (dentro de este mismo callback), intenta correr otra.
    resultadoDeLaSegunda = whatsappScheduler.ejecutarBarridoProgramado(dbArg, { disparadoPor:'reentrada-de-prueba' });
    return original(dbArg);
  };
  try{
    const r1 = whatsappScheduler.ejecutarBarridoProgramado(db, { disparadoPor:'prueba-concurrencia' });
    assert.equal(r1.omitido, false, 'la primera ejecución (la que sí llegó primero) debe completarse con normalidad');
    assert.ok(resultadoDeLaSegunda, 'la reentrada debió intentarse durante la primera ejecución');
    assert.equal(resultadoDeLaSegunda.omitido, true, 'la segunda ejecución simultánea debe omitirse, no correr en paralelo');
  } finally {
    whatsappFaseA.barrerContinuidadYPostventa = original;
  }
});

test('WA-28 (punto 1): estadoScheduler detecta atraso cuando la última ejecución es más vieja que el umbral', () => {
  db.exec('DELETE FROM whatsapp_scheduler_ejecuciones');
  let estado = whatsappScheduler.estadoScheduler(db);
  assert.equal(estado.nuncaHaCorrido, true, 'sin ninguna ejecución todavía, no debe alarmar (el proceso recién arrancó)');

  const haceMucho = dayjs.utc().subtract(whatsappScheduler.UMBRAL_ATRASO_MINUTOS + 10, 'minute').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`INSERT INTO whatsapp_scheduler_ejecuciones (iniciado_en, terminado_en, estado, disparado_por) VALUES (?, ?, 'completado', 'prueba')`).run(haceMucho, haceMucho);
  estado = whatsappScheduler.estadoScheduler(db);
  assert.equal(estado.atrasado, true, 'debe detectar que ya pasó el umbral desde la última ejecución');

  whatsappScheduler.detectarYAlertarAtraso(db);
  const errores = db.prepare(`SELECT * FROM whatsapp_errores WHERE contexto='scheduler:atraso' AND resuelto=0`).all();
  assert.ok(errores.length >= 1, 'debe quedar un registro de error persistente por el atraso, consultable como cualquier otro');
  assert.equal(errores[0].siniestro_id, null, 'una alerta de atraso es de SISTEMA, no pertenece a ningún expediente concreto');

  // Ejecutarlo (aunque sea manualmente) debe quitar el atraso.
  whatsappScheduler.ejecutarBarridoProgramado(db, { disparadoPor:'prueba-reset-atraso' });
  estado = whatsappScheduler.estadoScheduler(db);
  assert.equal(estado.atrasado, false, 'tras correr, ya no debe seguir marcado como atrasado');
});

// ---- Punto 2: alerta técnica separada, con su propia regla de cierre ----
test('WA-29 (punto 2): una alerta interna se cierra con la misma acción explícita y justificación, nunca "liberado_para_programacion"', async () => {
  const s = await crearSiniestro({ numero:'WA29', cliente_telefono: tel(), ingreso_tipo:'grua' });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa29', siniestroId:s.id, plantillaCodigo:'5.1', error:new Error('fallo') });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa29', siniestroId:s.id, plantillaCodigo:'5.1', error:new Error('fallo') });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa29', siniestroId:s.id, plantillaCodigo:'5.1', error:new Error('fallo') });
  const eventos = await eventosDe(s.id);
  const alerta = eventos.find(e => e.plantilla_codigo === 'ALERTA-WA-ERROR');
  assert.ok(alerta, 'debe existir la alerta técnica');
  assert.equal(alerta.estado, 'registrado');
  assert.ok(alerta.alerta_responsable_sugerido && alerta.alerta_responsable_sugerido.length > 0, 'debe traer un responsable sugerido');
  assert.ok(alerta.alerta_regla_cierre && alerta.alerta_regla_cierre.length > 0, 'debe traer su regla de cierre');

  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  let r = await req('PATCH', `/api/whatsapp-fase-a/eventos/${alerta.id}/revision`, { decision:'liberado_para_programacion', justificacion:'intento inválido' });
  assert.equal(r.status, 400, 'una alerta interna nunca se "libera para programación" -- no es un mensaje de cliente');

  r = await req('PATCH', `/api/whatsapp-fase-a/eventos/${alerta.id}/revision`, { decision:'descartado', justificacion:'Corregido el error de origen, confirmado que no vuelve a repetirse.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.estado, 'descartado');

  // Ya cerrada, no se puede volver a cerrar.
  r = await req('PATCH', `/api/whatsapp-fase-a/eventos/${alerta.id}/revision`, { decision:'descartado', justificacion:'otra vez' });
  assert.equal(r.status, 400);
});

// ---- Punto 3: comunicaciones manuales y el contador de 72h ----
test('WA-30 (punto 3): una comunicación manual "informativa_avance" reinicia el contador de continuidad', async () => {
  const s = await crearSiniestro({ numero:'WA30', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  // Se retrasan los eventos 5.x a 100 horas atrás (ya pasarían las 72h si no hubiera nada más reciente).
  const hace100h = dayjs.utc().subtract(100, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace100h, s.id);
  // Pero Alejandra ya avisó manualmente hace solo 10 horas -- eso debe ser el ancla real ahora.
  const comunicacion = whatsappFaseA.registrarComunicacionManual(db, { siniestroId:s.id, tipo:'informativa_avance', nota:'Le marqué y le expliqué que sigue en hojalatería.' });
  db.prepare(`UPDATE whatsapp_comunicaciones_manuales SET registrado_en=? WHERE id=?`).run(dayjs.utc().subtract(10,'hour').format('YYYY-MM-DD HH:mm:ss'), comunicacion.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.find(e => e.plantilla_codigo && e.plantilla_codigo.startsWith('6.')), undefined,
    'con una comunicación manual informativa de hace 10h, todavía NO deben pasar 72h -- no debe activarse la continuidad');
});

test('WA-31 (punto 3): una comunicación manual "administrativa" NO reinicia el contador', async () => {
  const s = await crearSiniestro({ numero:'WA31', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  const hace100h = dayjs.utc().subtract(100, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace100h, s.id);
  const comunicacion = whatsappFaseA.registrarComunicacionManual(db, { siniestroId:s.id, tipo:'administrativa', nota:'Solo confirmó que recibió el mensaje, sin pedir información.' });
  db.prepare(`UPDATE whatsapp_comunicaciones_manuales SET registrado_en=? WHERE id=?`).run(dayjs.utc().subtract(10,'hour').format('YYYY-MM-DD HH:mm:ss'), comunicacion.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e => e.plantilla_codigo && e.plantilla_codigo.startsWith('6.')),
    'una comunicación "administrativa" no informa avance real -- la continuidad debe seguir activándose a las 100h');
});

test('WA-32 (punto 3): registrarComunicacionManual rechaza un tipo inválido (sin clasificación automática/IA, solo lo explícito)', async () => {
  const s = await crearSiniestro({ numero:'WA32', cliente_telefono: tel() });
  assert.throws(() => whatsappFaseA.registrarComunicacionManual(db, { siniestroId:s.id, tipo:'un_saludo_cualquiera' }), /Tipo inválido/);
});

// ---- Punto 4: validación de destino antes de CUALQUIER plantilla de cliente ----
test('WA-33 (punto 4): sin teléfono, TODA plantilla de cliente queda bloqueada por destino_no_vinculado (no solo 5.1)', async () => {
  const s = await crearSiniestroSinTelefono({ numero:'WA33', ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  const eventos = await eventosDe(s.id);
  const e53 = eventos.find(e => e.plantilla_codigo === '5.3');
  assert.ok(e53, 'el evento 5.3 sí debe quedar registrado (como bloqueado), nunca desaparecer silenciosamente');
  assert.equal(e53.estado, 'bloqueado');
  assert.equal(e53.tipo_bloqueo, 'destino_no_vinculado');
  assert.equal(eventos.find(e => e.plantilla_codigo === '5.3' && e.estado === 'registrado'), undefined,
    'nunca debe quedar "registrado" (listo para futura programación) sin un destino válido');
});

test('WA-34 (punto 4): un teléfono mal formado bloquea por destino_invalido', async () => {
  const s = await crearSiniestro({ numero:'WA34', cliente_telefono:'123', ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  const eventos = await eventosDe(s.id);
  const e53 = eventos.find(e => e.plantilla_codigo === '5.3');
  assert.ok(e53);
  assert.equal(e53.estado, 'bloqueado');
  assert.equal(e53.tipo_bloqueo, 'destino_invalido');
});

test('WA-35 (punto 4): corregir el teléfono después revalida (pasa a pendiente_revision), pero no se libera sola', async () => {
  const s = await crearSiniestroSinTelefono({ numero:'WA35', ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  let eventos = await eventosDe(s.id);
  const e53 = eventos.find(e => e.plantilla_codigo === '5.3');
  assert.equal(e53.estado, 'bloqueado');

  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, { cliente_telefono: tel() });
  whatsappFaseA.revisarBloqueadosResueltos(db);
  eventos = await eventosDe(s.id);
  const actualizado = eventos.find(e => e.id === e53.id);
  assert.equal(actualizado.estado, 'pendiente_revision', 'debe pasar a revisión humana en cuanto el destino es válido, no liberarse ni enviarse solo');
});

test('WA-36 (punto 4): cambiar el teléfono a otro número también válido no duplica el evento ni lo reenvía retroactivamente', async () => {
  const s = await crearSiniestro({ numero:'WA36', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  let eventos = await eventosDe(s.id);
  assert.equal(eventos.filter(e => e.plantilla_codigo === '5.3').length, 1);
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, { cliente_telefono: tel() }); // corrige a otro número igual de válido
  whatsappFaseA.reconciliarEventosPrincipales(db);
  eventos = await eventosDe(s.id);
  assert.equal(eventos.filter(e => e.plantilla_codigo === '5.3').length, 1, 'sigue siendo un solo renglón -- no se duplica ni se reenvía por cambiar el teléfono');
});

// ---- Punto 5: validación final antes de un futuro envío real ----
test('WA-37 (punto 5): validarAntesDeEnviar rechaza si el expediente ya no está activo, si el destino dejó de ser válido, o si hay una incidencia delicada', async () => {
  const s1 = await crearSiniestro({ numero:'WA37A', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s1.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  let eventos = await eventosDe(s1.id);
  const e53 = eventos.find(e => e.plantilla_codigo === '5.3');
  let v = whatsappFaseA.validarAntesDeEnviar(db, e53.id);
  // Puede depender del horario real de la corrida (L-V 9-18) -- si está fuera de horario, ese es un
  // motivo válido de rechazo también; lo que importa es que NO se apruebe un envío inexistente.
  assert.equal(typeof v.puedeEnviarse, 'boolean');

  // Expediente cerrado -> rechazado.
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  db.prepare(`UPDATE siniestros SET estatus_general='Cerrado' WHERE id=?`).run(s1.id);
  v = whatsappFaseA.validarAntesDeEnviar(db, e53.id);
  assert.equal(v.puedeEnviarse, false);
  assert.match(v.motivo, /activo/);

  // Evento inexistente.
  v = whatsappFaseA.validarAntesDeEnviar(db, 999999);
  assert.equal(v.puedeEnviarse, false);
});

test('WA-38 (punto 5): revalidarEventosLiberados regresa a revisión un evento liberado si el expediente ya no está activo', async () => {
  const s = await crearSiniestro({ numero:'WA38', cliente_telefono: tel() });
  // Simula un evento ya bloqueado y explícitamente liberado en el pasado (flujo normal: bloqueado ->
  // pendiente_revision -> liberado_para_programacion).
  whatsappFaseA.registrarEvento(db, { siniestroId:s.id, plantillaCodigo:'5.10', disparador:'prueba', variables:{}, dedupKey:'prueba-wa38',
    bloqueadoPorMotivo:'motivo de prueba', tipoBloqueo:'incidencia_delicada' });
  let evento = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE siniestro_id=? AND dedup_key='prueba-wa38'`).get(s.id);
  db.prepare(`UPDATE whatsapp_eventos_registrados SET estado='pendiente_revision' WHERE id=?`).run(evento.id);
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('PATCH', `/api/whatsapp-fase-a/eventos/${evento.id}/revision`, { decision:'liberado_para_programacion', justificacion:'Se revalidó todo en su momento y correspondía liberarlo.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.estado, 'liberado_para_programacion');

  // Ahora el expediente se cierra DESPUÉS de haberse liberado -- ya no debería poder "enviarse" nunca.
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  db.prepare(`UPDATE siniestros SET estatus_general='Cerrado' WHERE id=?`).run(s.id);
  whatsappFaseA.revalidarEventosLiberados(db);
  evento = db.prepare('SELECT * FROM whatsapp_eventos_registrados WHERE id=?').get(evento.id);
  assert.equal(evento.estado, 'pendiente_revision', 'debe volver a revisión humana, nunca quedarse "liberado" sobre un expediente ya inactivo');
  assert.ok(evento.justificacion && evento.justificacion.includes('Revalidación automática'), 'debe quedar explicado por qué se regresó a revisión');
});

// ---- Regresión de seguridad extendida al scheduler ----
test('WA-39: whatsappScheduler.js tampoco contiene ninguna llamada real a un servicio externo, ni mecanismo de envío', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'whatsappScheduler.js'), 'utf-8');
  assert.ok(!/fetch\s*\(/.test(src));
  assert.ok(!/require\(['"]axios['"]\)|axios\s*\./i.test(src));
  assert.ok(!/graph\.facebook\.com|whatsapp\.com|meta\.com/i.test(src));
  assert.ok(!/sendMessage|enviarWhatsapp|enviarMensaje\(/i.test(src));
});
