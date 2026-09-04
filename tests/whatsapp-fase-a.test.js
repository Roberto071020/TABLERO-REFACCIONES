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
const activacion = require('../server/whatsappFaseAActivacion');
const whatsappWebhook = require('../server/whatsappWebhook');
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
  // Séptima revisión (punto 1): el módulo nace INACTIVO por defecto. Todas las pruebas WA-1 a WA-47 fueron
  // escritas asumiendo que el módulo SIEMPRE procesa -- así que aquí, en un solo lugar, se activa el modo
  // "piloto_todos" sin fecha de corte para esta base de datos de pruebas exclusivamente. Las pruebas nuevas
  // de activación (WA-48+) manipulan la configuración por su cuenta y la restauran al terminar.
  activacion.establecerConfig(db, 'activo', '1');
  activacion.establecerConfig(db, 'piloto_todos', '1');
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
test('WA-10 (punto 4, sexta revisión): pedido CANCELADO genera ALERTA-PEDIDO-PROBLEMA (alerta interna), no bloquea 5.4/5.5 como mensaje de cliente', async () => {
  const s = await crearSiniestro({ numero:'WA10', cliente_telefono: tel(), requiere_refacciones:'si' });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const p1 = (await req('POST', '/api/pedidos', { numero:'WA10-PED-1', siniestro_id:s.id, fecha_prevista:'2027-06-01' })).data;
  const p2 = (await req('POST', '/api/pedidos', { numero:'WA10-PED-2', siniestro_id:s.id, fecha_prevista:'2027-06-01' })).data;
  await req('PATCH', `/api/pedidos/${p1.id}`, { estatus_operativo:'Recibido completo' });
  await req('PATCH', `/api/pedidos/${p2.id}`, { estatus_operativo:'Cancelado', motivo_cancelacion:'Prueba' });
  const eventos = await eventosDe(s.id);
  const alerta = eventos.find(e => e.plantilla_codigo === 'ALERTA-PEDIDO-PROBLEMA');
  assert.ok(alerta, 'un pedido cancelado debe generar la alerta interna de pedido con problema');
  assert.equal(alerta.es_plantilla_meta, 0, 'una alerta interna NUNCA debe marcarse como plantilla de Meta');
  assert.match(alerta.disparador, /WA10-PED-2/);
  assert.equal(eventos.find(e => e.estado === 'registrado' && ['5.4','5.5'].includes(e.plantilla_codigo)), undefined,
    'mientras haya un pedido con problema, tampoco debe registrarse 5.4/5.5 como si las refacciones ya estuvieran disponibles');
});

test('WA-10b (punto 4, sexta revisión): sin ningún pedido todavía, no se registra NADA (ni bloqueo ni alerta) -- evita ruido', async () => {
  const s = await crearSiniestro({ numero:'WA10B', cliente_telefono: tel(), requiere_refacciones:'si' });
  whatsappFaseA.procesarRefaccionesCompletas(db, s.id);
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.find(e => ['5.4','5.5','ALERTA-PEDIDO-PROBLEMA'].includes(e.plantilla_codigo)), undefined,
    'sin pedidos todavía no hay ninguna señal real que reportar');
});

test('WA-10c (punto 4, sexta revisión): pedido en trámite normal (sin problema, sin completar) tampoco genera ruido', async () => {
  const s = await crearSiniestro({ numero:'WA10C', cliente_telefono: tel(), requiere_refacciones:'si' });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  await req('POST', '/api/pedidos', { numero:'WA10C-PED-1', siniestro_id:s.id, fecha_prevista:'2027-06-01' });
  whatsappFaseA.procesarRefaccionesCompletas(db, s.id);
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.find(e => ['5.4','5.5','ALERTA-PEDIDO-PROBLEMA'].includes(e.plantilla_codigo)), undefined,
    'un pedido "Nuevo" (todavía en trámite normal) no es un problema real -- no debe generar nada');
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
  // Punto 8 (sexta revisión): ultimoAncla() ahora usa COALESCE(simulado_enviado_en, creado_en) -- hay que
  // retrasar también simulado_enviado_en, no solo creado_en, o el ancla real seguiría siendo "ahora".
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(haceUnRato, haceUnRato, s.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  const continuidad = eventos.find(e => e.plantilla_codigo === '6.3');
  assert.ok(continuidad, 'debe registrarse la continuidad aunque las 72h incluyan fin de semana');
});

test('WA-13 (punto 1): continuidad NO se activa antes de cumplirse las 72 horas naturales', async () => {
  const s = await crearSiniestro({ numero:'WA13', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  const hace70h = dayjs.utc().subtract(70, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace70h, hace70h, s.id);
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
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace150h, hace150h, s.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  const alerta = eventos.find(e => e.plantilla_codigo === 'ALERTA-72H-X2');
  assert.ok(alerta, 'debe existir la alerta interna del segundo periodo');
  assert.equal(alerta.es_plantilla_meta, 0, 'una alerta interna NUNCA debe marcarse como plantilla de Meta');

  // Punto 6 (sexta revisión): correr el barrido OTRA VEZ (mismo ciclo, mismo ancla) no debe duplicar la
  // alerta -- una sola por ciclo de estancamiento, sin importar cuántas veces se re-evalúe.
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos2 = await eventosDe(s.id);
  assert.equal(eventos2.filter(e => e.plantilla_codigo === 'ALERTA-72H-X2').length, 1,
    'una sola alerta por ciclo de estancamiento, aunque el barrido se repita y ya vayan varias ventanas de 72h');
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

  // Un teléfono con formato válido pero que no coincide con ningún expediente -- distinto de '0000000000'
  // (placeholder-like, ver normalizarTelefonoMX): ese caso ahora se cubre en WA-19b.
  let r3 = whatsappFaseA.resolverExpedientePorTelefono(db, tel());
  assert.equal(r3.resultado, 'sin_expediente_activo');
});

test('WA-19b (punto 3, sexta revisión): resolverExpedientePorTelefono normaliza igual que validarDestino -- +52/52 y formato distinto SÍ hacen match', async () => {
  const crudo = tel();
  const s = await crearSiniestro({ numero:'WA19D', cliente_telefono: crudo });
  const conPrefijo = '52' + crudo;
  let r = whatsappFaseA.resolverExpedientePorTelefono(db, conPrefijo);
  assert.equal(r.resultado, 'resuelto_automatico', 'un teléfono entrante con +52/52 debe encontrar el mismo expediente aunque el capturado no tenga el prefijo');
  assert.equal(r.siniestro.id, s.id);

  // Un valor claramente placeholder (mismo dígito repetido) nunca busca nada -- 'sin_telefono'.
  const rPlaceholder = whatsappFaseA.resolverExpedientePorTelefono(db, '5555555555');
  assert.equal(rPlaceholder.resultado, 'sin_telefono');
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

// ---- Punto 9 (sexta revisión): comunicación saliente detectada automáticamente (rediseño del punto 3) ----
test('WA-30 (punto 9): registrarComunicacionSaliente reinicia el contador de continuidad, sin que nadie clasifique nada', async () => {
  const s = await crearSiniestro({ numero:'WA30', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  // Se retrasan los eventos 5.x a 100 horas atrás (ya pasarían las 72h si no hubiera nada más reciente).
  const hace100h = dayjs.utc().subtract(100, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace100h, hace100h, s.id);
  // Simula lo que el futuro webhook "smb_message_echoes" de Coexistencia habría entregado -- sin que
  // nadie decida a mano si fue "informativa" o "administrativa" (ver el comentario completo en
  // whatsappFaseA.js): cualquier mensaje saliente manual cuenta como comunicación real.
  const comunicacion = whatsappFaseA.registrarComunicacionSaliente(db, { siniestroId:s.id, referenciaExterna:'wamid.TEST123' });
  db.prepare(`UPDATE whatsapp_comunicaciones_manuales SET registrado_en=? WHERE id=?`).run(dayjs.utc().subtract(10,'hour').format('YYYY-MM-DD HH:mm:ss'), comunicacion.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.find(e => e.plantilla_codigo && e.plantilla_codigo.startsWith('6.')), undefined,
    'con una comunicación saliente detectada hace 10h, todavía NO deben pasar 72h -- no debe activarse la continuidad');
});

test('WA-31 (punto 9): ya no existe ningún endpoint de captura manual -- el POST se retiró (sin agregar trabajo a Alejandra)', async () => {
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('POST', '/api/whatsapp-fase-a/comunicaciones-manuales', { siniestro_id:1, tipo:'informativa_avance' });
  assert.equal(r.status, 404, 'el endpoint de captura manual del punto 3 (quinta entrega) fue retirado deliberadamente en la sexta revisión');
});

test('WA-32 (punto 9): registrarComunicacionSaliente rechaza un siniestro inexistente, y ya no recibe ningún "tipo" que alguien tenga que decidir', async () => {
  assert.throws(() => whatsappFaseA.registrarComunicacionSaliente(db, { siniestroId:999999 }), /no encontrado/);
  const s = await crearSiniestro({ numero:'WA32', cliente_telefono: tel() });
  const c = whatsappFaseA.registrarComunicacionSaliente(db, { siniestroId:s.id });
  assert.equal(c.tipo, 'informativa_avance', 'toda comunicación saliente detectada cuenta como avance real -- ya no hay clasificación que decidir');
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

// ===================== SEXTA REVISIÓN (4-sep-2026): 11 hallazgos de Roberto sobre la rama =====================
// WA-40 punto 1 (autorización parcial no dispara ningún 6.x); WA-41/WA-42 punto 2 (vigencia por código de
// plantilla, más allá de continuidad); WA-43 punto 3 (validarDestino usa la misma normalización que la
// búsqueda entrante -- ver también WA-19b); WA-44/WA-45 punto 4 ya cubierto en WA-10/WA-10b/WA-10c; WA-44
// punto 6 (una sola alerta por ciclo, ya cubierto también en el segundo barrido de WA-14) -- se agrega
// aquí la prueba de que un ciclo NUEVO (tras avance real) sí genera una alerta nueva; WA-45 punto 7
// (recurrencia de un error tras resolverse); WA-46 punto 5 (cobertura ampliada de incidencia delicada);
// WA-47 punto 8 (simulado_enviado_en se guarda al registrar, y ultimoAncla lo usa).

test('WA-40 (punto 1, sexta revisión): autorización PARCIAL no dispara NINGÚN 6.x, ni siquiera tras 72h+', async () => {
  const s = await crearSiniestro({ numero:'WA40', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  await req('PATCH', `/api/siniestros/${s.id}`, { requiere_refacciones:'si' });
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_autorizacion:'parcial', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:1 });
  const siniestro = db.prepare('SELECT * FROM siniestros WHERE id=?').get(s.id);
  assert.equal(whatsappFaseA.etapaContinuidadActual(db, siniestro), null,
    'con autorización parcial, etapaContinuidadActual debe devolver null (antes devolvía 6.1 por error)');

  const hace100h = dayjs.utc().subtract(100, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace100h, hace100h, s.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.find(e => e.plantilla_codigo && e.plantilla_codigo.startsWith('6.')), undefined,
    'ningún 6.x debe registrarse mientras la autorización siga parcial, ni siquiera pasadas 72h+');
});

test('WA-41 (punto 2, sexta revisión): vigenciaPlantillaPrincipal detecta que 5.8 (hojalatería) ya no es vigente si el expediente avanzó a pintura', async () => {
  const s = await crearSiniestro({ numero:'WA41', cliente_telefono: tel() });
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!'); // estado_produccion es campo de "producción" (beto/orlando/admin/jefe)
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'en_laminado' });
  let siniestro = db.prepare('SELECT * FROM siniestros WHERE id=?').get(s.id);
  assert.equal(whatsappFaseA.vigenciaPlantillaPrincipal(db, siniestro, '5.8'), true, 'en hojalatería, 5.8 sí es vigente');

  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'pintura' });
  siniestro = db.prepare('SELECT * FROM siniestros WHERE id=?').get(s.id);
  assert.equal(whatsappFaseA.vigenciaPlantillaPrincipal(db, siniestro, '5.8'), false, 'una vez en pintura, 5.8 ya no es vigente');
  assert.equal(whatsappFaseA.vigenciaPlantillaPrincipal(db, siniestro, '5.9'), true, 'y 5.9 sí lo es ahora');
});

test('WA-42 (punto 2, sexta revisión): validarAntesDeEnviar rechaza un evento 5.x del ciclo principal cuya condición ya no aplica', async () => {
  const s = await crearSiniestro({ numero:'WA42', cliente_telefono: tel() });
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'en_laminado' });
  let eventos = await eventosDe(s.id);
  const e58 = eventos.find(e => e.plantilla_codigo === '5.8');
  assert.ok(e58, 'debe haberse registrado 5.8 al entrar a hojalatería');
  let v = whatsappFaseA.validarAntesDeEnviar(db, e58.id);
  assert.equal(typeof v.puedeEnviarse, 'boolean'); // puede depender del horario real de la corrida.

  // El expediente avanza a pintura -- el evento 5.8 ya registrado queda obsoleto.
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'pintura' });
  v = whatsappFaseA.validarAntesDeEnviar(db, e58.id);
  assert.equal(v.puedeEnviarse, false);
  assert.match(v.motivo, /ya no se cumple/);
});

test('WA-43 (punto 3, sexta revisión): validarDestino acepta el mismo abanico de formatos que normalizarTelefonoMX (espacios, guiones, +52)', async () => {
  const crudo = tel();
  const s1 = await crearSiniestro({ numero:'WA43A', cliente_telefono: `+52 ${crudo.slice(0,3)}-${crudo.slice(3,6)}-${crudo.slice(6)}` });
  const d1 = whatsappFaseA.validarDestino(db, s1.id);
  assert.equal(d1.valido, true, 'un teléfono con +52, espacios y guiones debe validarse igual que uno "limpio"');
  assert.equal(d1.telefonoNormalizado, crudo);
});

test('WA-44 (punto 6, sexta revisión): un ciclo NUEVO (tras avance real) sí genera una alerta ALERTA-72H-X2 nueva, distinta de la del ciclo anterior', async () => {
  const s = await crearSiniestro({ numero:'WA44', cliente_telefono: tel(), ingreso_tipo:'grua' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-01', autorizador:'X', piezas_autorizadas_cambio:0 });
  const hace150h = dayjs.utc().subtract(150, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace150h, hace150h, s.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  let eventos = await eventosDe(s.id);
  assert.equal(eventos.filter(e => e.plantilla_codigo === 'ALERTA-72H-X2').length, 1, 'primer ciclo: una alerta');

  // Avance real: una comunicación saliente detectada mueve el ancla (nuevo ciclo). Se usa un ancla
  // DISTINTA (145h, no 150h) a propósito: si se reutilizara el mismo timestamp, la clave de ciclo
  // ('ciclo:'+ancla+':'+codigo) sería idéntica a la del primer ciclo y esta prueba no probaría nada nuevo.
  whatsappFaseA.registrarComunicacionSaliente(db, { siniestroId:s.id, nota:'Nuevo avance real, mueve el ancla.' });
  const hace145h = dayjs.utc().subtract(145, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_comunicaciones_manuales SET registrado_en=? WHERE siniestro_id=?`).run(hace145h, s.id);
  whatsappFaseA.barrerContinuidadYPostventa(db);
  eventos = await eventosDe(s.id);
  assert.equal(eventos.filter(e => e.plantilla_codigo === 'ALERTA-72H-X2').length, 2,
    'un ciclo de estancamiento NUEVO (ancla distinta) debe generar una alerta nueva, no quedar deduplicado contra la del ciclo anterior');
});

test('WA-45 (punto 7, sexta revisión): un error que se resuelve y VUELVE a ocurrir genera una alerta ALERTA-WA-ERROR nueva', async () => {
  const s = await crearSiniestro({ numero:'WA45', cliente_telefono: tel() });
  const errorFalso = new Error('Fallo simulado para la prueba WA-45');
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa45', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa45', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa45', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  let eventos = await eventosDe(s.id);
  const primeraAlerta = eventos.find(e => e.plantilla_codigo === 'ALERTA-WA-ERROR');
  assert.ok(primeraAlerta, 'debe generarse la primera alerta al llegar a 3 intentos');

  // Se resuelve el error de origen (whatsapp_errores) -- acción manual, todavía sin endpoint dedicado.
  db.prepare(`UPDATE whatsapp_errores SET resuelto=1 WHERE contexto='prueba-wa45' AND siniestro_id=?`).run(s.id);

  // El MISMO tipo de error vuelve a ocurrir más adelante.
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa45', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa45', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa45', siniestroId:s.id, plantillaCodigo:'5.1', error: errorFalso });
  eventos = await eventosDe(s.id);
  const alertasError = eventos.filter(e => e.plantilla_codigo === 'ALERTA-WA-ERROR');
  assert.equal(alertasError.length, 2, 'la recurrencia tras resolverse debe generar una alerta NUEVA, no quedar deduplicada contra la primera');
  assert.notEqual(alertasError[0].id, alertasError[1].id);
});

test('WA-46 (punto 5, sexta revisión): un retrabajo CRÍTICO abierto también bloquea por incidencia delicada (no solo incidencias de piezas)', async () => {
  const s = await crearSiniestro({ numero:'WA46', cliente_telefono: tel() });
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), false);
  db.prepare(`INSERT INTO retrabajos (siniestro_id, severidad, estado, origen) VALUES (?, 'critica', 'abierto', 'prueba WA-46')`).run(s.id);
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), true, 'un retrabajo crítico abierto debe contar como situación delicada');

  db.prepare(`UPDATE retrabajos SET estado='cerrado' WHERE siniestro_id=?`).run(s.id);
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), false, 'una vez cerrado, ya no bloquea');

  db.prepare(`INSERT INTO complementos (siniestro_id, causa, decision) VALUES (?, 'prueba WA-46', 'pendiente')`).run(s.id);
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), true, 'un complemento con decisión pendiente también debe contar como situación delicada');
});

test('WA-47 (punto 8, sexta revisión): registrarEvento guarda detectado_en y simulado_enviado_en; ultimoAncla usa el simulado, no el crudo creado_en', async () => {
  const s = await crearSiniestro({ numero:'WA47', cliente_telefono: tel() });
  const eventos = await eventosDe(s.id);
  const e51 = eventos.find(e => e.plantilla_codigo === '5.1');
  const fila = db.prepare('SELECT * FROM whatsapp_eventos_registrados WHERE id=?').get(e51.id);
  assert.ok(fila.detectado_en, 'detectado_en debe quedar poblado al registrar');
  assert.ok(fila.simulado_enviado_en, 'simulado_enviado_en debe quedar poblado para un evento no bloqueado');
  assert.equal(fila.enviado_en, null, 'enviado_en debe quedar SIEMPRE null en modo solo registro');
  assert.equal(fila.entregado_en, null, 'entregado_en debe quedar SIEMPRE null en modo solo registro');
  assert.equal(fila.error_en, null, 'error_en debe quedar SIEMPRE null en modo solo registro');

  // Se desalinean a propósito creado_en (viejo) y simulado_enviado_en (reciente) para comprobar que
  // ultimoAncla usa el segundo, no el primero.
  const haceMucho = dayjs.utc().subtract(200, 'hour').format('YYYY-MM-DD HH:mm:ss');
  const haceUnRato = dayjs.utc().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE id=?`).run(haceMucho, haceUnRato, e51.id);
  const siniestro = db.prepare('SELECT * FROM siniestros WHERE id=?').get(s.id);
  const ancla = whatsappFaseA.ultimoAncla(db, s.id, siniestro.creado_en);
  assert.equal(ancla, haceUnRato, 'ultimoAncla debe usar simulado_enviado_en (reciente), no el crudo creado_en (viejo)');
});

// ===================== SÉPTIMA REVISIÓN (4-sep-2026): punto 1 -- activación controlada =====================
const crypto = require('node:crypto');
async function loginAdmin(){ await login('admin@serviciocristian.mx', 'ServicioCristian2026!'); }

test('WA-48 (punto 1, séptima revisión): con el módulo DESACTIVADO (activo=0), ningún expediente nuevo escribe una sola fila', async () => {
  activacion.establecerConfig(db, 'activo', '0');
  try{
    const s = await crearSiniestro({ numero:'WA48', cliente_telefono: tel() });
    const eventos = await eventosDe(s.id);
    assert.equal(eventos.length, 0, 'con el módulo desactivado no debe registrarse ni siquiera 5.1');
    const filasDirectas = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE siniestro_id=?').get(s.id).c;
    assert.equal(filasDirectas, 0);
    // Los barridos periódicos tampoco deben escribir nada mientras está apagado.
    whatsappFaseA.barrerContinuidadYPostventa(db);
    whatsappFaseA.reconciliarEventosPrincipales(db);
    const filasTrasBarrido = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE siniestro_id=?').get(s.id).c;
    assert.equal(filasTrasBarrido, 0, 'los barridos periódicos tampoco deben escribir nada con el módulo apagado');
  } finally {
    activacion.establecerConfig(db, 'activo', '1');
    activacion.establecerConfig(db, 'piloto_todos', '1');
  }
});

test('WA-49 (punto 1, séptima revisión): con piloto_todos=0, SOLO los expedientes en piloto_numeros se procesan -- el resto de la cartera queda intacta', async () => {
  activacion.establecerConfig(db, 'piloto_todos', '0');
  activacion.establecerConfig(db, 'piloto_numeros', 'WA49PILOTO');
  try{
    const dentro = await crearSiniestro({ numero:'WA49PILOTO', cliente_telefono: tel() });
    const fuera = await crearSiniestro({ numero:'WA49FUERA', cliente_telefono: tel() });
    const eventosDentro = await eventosDe(dentro.id);
    const eventosFuera = await eventosDe(fuera.id);
    assert.ok(eventosDentro.find(e => e.plantilla_codigo === '5.1'), 'el expediente EN la lista de piloto sí debe procesarse');
    assert.equal(eventosFuera.length, 0, 'un expediente FUERA de la lista de piloto (y sin modo "todos") no debe procesarse: no es "toda la cartera activa"');
  } finally {
    activacion.establecerConfig(db, 'piloto_todos', '1');
    activacion.establecerConfig(db, 'piloto_numeros', '');
  }
});

test('WA-50 (punto 1, séptima revisión): fecha_corte excluye reconstrucción automática de expedientes anteriores a la activación; la lista de piloto explícita ignora el corte', () => {
  activacion.establecerConfig(db, 'fecha_corte', '2026-09-10');
  try{
    const viejo = { numero:'WA50-VIEJO', creado_en:'2026-09-01 00:00:00' };
    const nuevo = { numero:'WA50-NUEVO', creado_en:'2026-09-15 00:00:00' };
    assert.equal(activacion.siniestroElegible(db, viejo), false, 'un expediente creado antes del corte no debe reconstruirse automáticamente (modo "todos")');
    assert.equal(activacion.siniestroElegible(db, nuevo), true, 'un expediente creado después del corte sí se procesa en modo "todos"');
    // La lista explícita de piloto (selección manual y deliberada) SIEMPRE gana, sin importar el corte.
    activacion.establecerConfig(db, 'piloto_numeros', 'WA50-VIEJO');
    assert.equal(activacion.siniestroElegible(db, viejo), true, 'estar en la lista explícita de piloto ignora la fecha de corte');
  } finally {
    activacion.establecerConfig(db, 'fecha_corte', '');
    activacion.establecerConfig(db, 'piloto_numeros', '');
  }
});

test('WA-51 (punto 1, séptima revisión): revertirDatosPiloto borra ÚNICAMENTE los datos del expediente indicado, sin tocar ningún otro', async () => {
  const a = await crearSiniestro({ numero:'WA51A', cliente_telefono: tel() });
  const b = await crearSiniestro({ numero:'WA51B', cliente_telefono: tel() });
  whatsappFaseA.registrarComunicacionSaliente(db, { siniestroId:a.id, nota:'prueba WA-51 A' });
  whatsappFaseA.registrarComunicacionSaliente(db, { siniestroId:b.id, nota:'prueba WA-51 B' });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa51', siniestroId:a.id, error:new Error('falso A') });
  whatsappFaseA.registrarError(db, { contexto:'prueba-wa51', siniestroId:b.id, error:new Error('falso B') });

  const antesA = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE siniestro_id=?').get(a.id).c;
  assert.ok(antesA > 0);

  const resultado = activacion.revertirDatosPiloto(db, ['WA51A']);
  assert.ok(resultado.eventosBorrados > 0);
  assert.ok(resultado.comunicacionesBorradas > 0);
  assert.ok(resultado.erroresBorrados > 0);

  const despuesA = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE siniestro_id=?').get(a.id).c;
  const comunicacionesA = db.prepare('SELECT COUNT(*) c FROM whatsapp_comunicaciones_manuales WHERE siniestro_id=?').get(a.id).c;
  const erroresA = db.prepare('SELECT COUNT(*) c FROM whatsapp_errores WHERE siniestro_id=?').get(a.id).c;
  assert.equal(despuesA, 0, 'el expediente revertido debe quedar sin eventos');
  assert.equal(comunicacionesA, 0, 'el expediente revertido debe quedar sin comunicaciones');
  assert.equal(erroresA, 0, 'el expediente revertido debe quedar sin errores');

  const despuesB = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE siniestro_id=?').get(b.id).c;
  const comunicacionesB = db.prepare('SELECT COUNT(*) c FROM whatsapp_comunicaciones_manuales WHERE siniestro_id=?').get(b.id).c;
  const erroresB = db.prepare('SELECT COUNT(*) c FROM whatsapp_errores WHERE siniestro_id=?').get(b.id).c;
  assert.ok(despuesB > 0, 'otro expediente no incluido en la reversión debe quedar intacto (eventos)');
  assert.ok(comunicacionesB > 0, 'otro expediente no incluido en la reversión debe quedar intacto (comunicaciones)');
  assert.ok(erroresB > 0, 'otro expediente no incluido en la reversión debe quedar intacto (errores)');
});

test('WA-52 (punto 1, séptima revisión): GET/PATCH /config y POST /config/revertir-piloto son admin-only, y PATCH aplica cambios reales', async () => {
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  let r = await req('GET', '/api/whatsapp-fase-a/config');
  assert.equal(r.status, 403, 'un usuario no-admin no debe poder leer la configuración de activación');

  await loginAdmin();
  r = await req('GET', '/api/whatsapp-fase-a/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.activo, '1');

  r = await req('PATCH', '/api/whatsapp-fase-a/config', { activo:'0' });
  assert.equal(r.status, 200);
  r = await req('GET', '/api/whatsapp-fase-a/config');
  assert.equal(r.data.activo, '0', 'PATCH debe aplicarse de inmediato, sin redeploy');

  // Restaurar antes de que el resto de la suite lo necesite activo.
  r = await req('PATCH', '/api/whatsapp-fase-a/config', { activo:'1', piloto_todos:'1' });
  assert.equal(r.status, 200);

  r = await req('POST', '/api/whatsapp-fase-a/config/revertir-piloto', { numeros:['NO-EXISTE-XYZ'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.eventosBorrados, 0);

  r = await req('PATCH', '/api/whatsapp-fase-a/config', { clave_invalida:'x' });
  assert.equal(r.status, 400, 'una PATCH sin ninguna clave válida debe rechazarse');
});

// ===================== SÉPTIMA REVISIÓN: punto 2 -- vigencia estricta por etapa (las 12 plantillas 5.x) =====================
test('WA-53 (punto 2, séptima revisión): recorrido completo del ciclo principal SIN piezas (5.1 -> 5.2 -> 5.6 -> 5.8 -> 5.9 -> 5.10 -> 5.11 -> postventa/5.12) -- cada etapa vuelve inválido el mensaje anterior', async () => {
  const s = await crearSiniestro({ numero:'WA53', cliente_telefono: tel(), ingreso_tipo:'grua' }); // grua => siempre en_taller
  let eventos = await eventosDe(s.id);
  const e51 = eventos.find(e => e.plantilla_codigo === '5.1');
  assert.ok(e51, 'debe registrar 5.1 al crear con teléfono');

  await loginAdmin();
  await req('PATCH', `/api/siniestros/${s.id}`, { valuacion_fecha_envio:'2026-09-03' });
  eventos = await eventosDe(s.id);
  const e52 = eventos.find(e => e.plantilla_codigo === '5.2');
  assert.ok(e52, 'debe registrar 5.2 al enviar la valuación');
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e51.id).puedeEnviarse, false, '5.1 ya no debe ser vigente una vez que se envió la valuación (etapa avanzó a 5.2)');

  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:0 });
  eventos = await eventosDe(s.id);
  const e56 = eventos.find(e => e.plantilla_codigo === '5.6');
  assert.ok(e56, 'debe registrar 5.6 (sin piezas, en taller) al autorizar');
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e52.id).puedeEnviarse, false, '5.2 ya no debe ser vigente una vez autorizado');

  await loginAdmin();
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'en_laminado' });
  eventos = await eventosDe(s.id);
  const e58 = eventos.find(e => e.plantilla_codigo === '5.8');
  assert.ok(e58, 'debe registrar 5.8 al entrar a hojalatería');
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e56.id).puedeEnviarse, false, '5.6 ya no debe ser vigente una vez iniciada la producción');

  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'pintura' });
  eventos = await eventosDe(s.id);
  const e59 = eventos.find(e => e.plantilla_codigo === '5.9');
  assert.ok(e59, 'debe registrar 5.9 al entrar a pintura');
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e58.id).puedeEnviarse, false, '5.8 ya no debe ser vigente una vez en pintura');

  await req('PATCH', `/api/siniestros/${s.id}`, { estado_calidad:'en_inspeccion' });
  eventos = await eventosDe(s.id);
  const e510 = eventos.find(e => e.plantilla_codigo === '5.10');
  assert.ok(e510, 'debe registrar 5.10 al entrar a inspección de calidad');
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e59.id).puedeEnviarse, false, '5.9 ya no debe ser vigente una vez en inspección de calidad');

  await req('PATCH', `/api/siniestros/${s.id}`, { estado_calidad:'liberado' });
  eventos = await eventosDe(s.id);
  const e511 = eventos.find(e => e.plantilla_codigo === '5.11');
  assert.ok(e511, 'debe registrar 5.11 al liberar calidad');
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e510.id).puedeEnviarse, false, '5.10 ya no debe ser vigente una vez liberada la calidad');

  await req('PATCH', `/api/siniestros/${s.id}`, { fecha_entrega_real: dayjs.utc().format('YYYY-MM-DD') });
  const siniestroEntregado = db.prepare('SELECT * FROM siniestros WHERE id=?').get(s.id);
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e511.id).puedeEnviarse, false, '5.11 ya no debe ser vigente una vez que se registró la entrega real');
  assert.equal(whatsappFaseA.vigenciaPlantillaPrincipal(db, siniestroEntregado, '5.12'), true, '5.12 (postventa) sí debe ser vigente justo después de la entrega, antes de la encuesta');
});

test('WA-54 (punto 2, séptima revisión): con piezas a cambio, 5.3 deja de ser vigente en cuanto las refacciones quedan realmente disponibles (5.4/5.5)', async () => {
  const s = await crearSiniestro({ numero:'WA54', cliente_telefono: tel(), ingreso_tipo:'circulando', requiere_refacciones:'si' });
  await autorizarOrlando(s.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  let eventos = await eventosDe(s.id);
  const e53 = eventos.find(e => e.plantilla_codigo === '5.3');
  assert.ok(e53, 'debe registrar 5.3 al autorizar con piezas');

  db.prepare(`INSERT INTO pedidos (numero, siniestro_id, estatus_operativo) VALUES ('WA54-PED', ?, 'En proceso de surtido')`).run(s.id);
  whatsappFaseA.procesarRefaccionesCompletas(db, s.id);
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e53.id).puedeEnviarse, true, '5.3 sigue vigente mientras las piezas no estén realmente disponibles');

  db.prepare(`UPDATE pedidos SET estatus_operativo='Recibido completo' WHERE numero='WA54-PED'`).run();
  whatsappFaseA.procesarRefaccionesCompletas(db, s.id);
  eventos = await eventosDe(s.id);
  const e54 = eventos.find(e => e.plantilla_codigo === '5.4');
  assert.ok(e54, 'debe registrar 5.4 (piezas listas, unidad fuera del taller) al completarse el pedido');
  assert.equal(whatsappFaseA.validarAntesDeEnviar(db, e53.id).puedeEnviarse, false, '5.3 ya no debe ser vigente una vez que las piezas están realmente disponibles');
});

test('WA-55 (punto 2, séptima revisión): 5.7 (sin piezas, fuera del taller) y 5.5 (piezas listas, en taller); un código desconocido siempre falla-seguro (bloquea)', async () => {
  const fuera = await crearSiniestro({ numero:'WA55A', cliente_telefono: tel(), ingreso_tipo:'circulando' });
  await autorizarOrlando(fuera.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:0 });
  let eventos = await eventosDe(fuera.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.7'), 'sin piezas y fuera del taller debe registrar 5.7');

  const enTaller = await crearSiniestro({ numero:'WA55B', cliente_telefono: tel(), ingreso_tipo:'grua', requiere_refacciones:'si' });
  await autorizarOrlando(enTaller.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'X', piezas_autorizadas_cambio:2 });
  db.prepare(`INSERT INTO pedidos (numero, siniestro_id, estatus_operativo) VALUES ('WA55B-PED', ?, 'Recibido completo')`).run(enTaller.id);
  whatsappFaseA.procesarRefaccionesCompletas(db, enTaller.id);
  eventos = await eventosDe(enTaller.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.5'), 'piezas listas y unidad en taller debe registrar 5.5');

  const siniestroEnTaller = db.prepare('SELECT * FROM siniestros WHERE id=?').get(enTaller.id);
  assert.equal(whatsappFaseA.vigenciaPlantillaPrincipal(db, siniestroEnTaller, '5.99'), false, 'un código de plantilla desconocido nunca debe autorizarse por defecto -- debe bloquear');
});

// ===================== SÉPTIMA REVISIÓN: punto 4 -- dos nuevas señales de incidencia delicada =====================
test('WA-56 (punto 4, séptima revisión): compromiso de fecha de entrega GNP vencido bloquea por incidencia delicada; cumplir la entrega lo libera', async () => {
  const s = await crearSiniestro({ numero:'WA56', cliente_telefono: tel() });
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), false);
  const ayer = dayjs.utc().subtract(1, 'day').format('YYYY-MM-DD');
  db.prepare(`UPDATE siniestros SET entrega_compromiso_gnp=1, fecha_entrega_prevista=? WHERE id=?`).run(ayer, s.id);
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), true, 'un compromiso de entrega ya vencido y sin entrega real debe bloquear');

  const manana = dayjs.utc().add(1, 'day').format('YYYY-MM-DD');
  db.prepare(`UPDATE siniestros SET fecha_entrega_prevista=? WHERE id=?`).run(manana, s.id);
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), false, 'un compromiso todavía no vencido no debe bloquear');

  db.prepare(`UPDATE siniestros SET fecha_entrega_prevista=?, fecha_entrega_real=? WHERE id=?`).run(ayer, ayer, s.id);
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), false, 'si ya se registró la entrega real, un compromiso vencido ya no bloquea (se cumplió, aunque tarde)');
});

test('WA-57 (punto 4, séptima revisión): un pedido con "Entrega vencida" bloquea el ciclo principal completo, no solo la alerta interna de refacciones', async () => {
  const s = await crearSiniestro({ numero:'WA57', cliente_telefono: tel() });
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), false);
  db.prepare(`INSERT INTO pedidos (numero, siniestro_id, estatus_operativo) VALUES ('WA57-PED', ?, 'Entrega vencida')`).run(s.id);
  assert.equal(whatsappFaseA.tieneIncidenciaDelicadaActiva(db, s.id), true, 'un pedido con entrega vencida debe contar como situación delicada para todo el ciclo principal');
});

// ===================== SÉPTIMA REVISIÓN: punto 3 -- flujo completo del webhook smb_message_echoes =====================
function firmar(secret, rawBody){
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}
async function postWebhook(payload, { secret, firmaIncorrecta=false } = {}){
  const raw = JSON.stringify(payload);
  const headers = { 'Content-Type':'application/json' };
  if(secret){
    headers['X-Hub-Signature-256'] = firmaIncorrecta ? 'sha256=' + '0'.repeat(64) : firmar(secret, raw);
  }
  const res = await fetch(BASE + '/api/whatsapp-fase-a/webhooks/echo', { method:'POST', headers, body: raw });
  let data = null;
  try { data = await res.json(); } catch(e) {}
  return { status: res.status, data };
}

test('WA-58 (punto 3, séptima revisión): sin WHATSAPP_APP_SECRET configurado, el webhook rechaza TODO -- estructuralmente inerte sin número real vinculado', async () => {
  delete process.env.WHATSAPP_APP_SECRET;
  const r = await postWebhook({ id:'wamid.WA58', type:'text', to:'5215512340001' });
  assert.equal(r.status, 503);
});

test('WA-59 (punto 3, séptima revisión): con secreto configurado, una firma inválida se rechaza (401); una firma válida se acepta', async () => {
  process.env.WHATSAPP_APP_SECRET = 'secreto_de_prueba_wa59';
  try{
    let r = await postWebhook({ id:'wamid.WA59-bad', type:'text', to:'5215512340002' }, { secret:process.env.WHATSAPP_APP_SECRET, firmaIncorrecta:true });
    assert.equal(r.status, 401);

    const s = await crearSiniestro({ numero:'WA59', cliente_telefono:'5512340002' });
    r = await postWebhook({ id:'wamid.WA59-ok', type:'text', to:'5215512340002' }, { secret:process.env.WHATSAPP_APP_SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.data.procesado, true);
    assert.equal(r.data.siniestroId, s.id);
    const fila = db.prepare(`SELECT * FROM whatsapp_comunicaciones_manuales WHERE wamid='wamid.WA59-ok'`).get();
    assert.ok(fila, 'debe quedar registrada la comunicación con su wamid');
  } finally {
    delete process.env.WHATSAPP_APP_SECRET;
  }
});

test('WA-60 (punto 3, séptima revisión): el mismo wamid reenviado (reintento de Meta) se detecta como duplicado, sin registrar una segunda comunicación', async () => {
  process.env.WHATSAPP_APP_SECRET = 'secreto_de_prueba_wa60';
  try{
    const s = await crearSiniestro({ numero:'WA60', cliente_telefono:'5512340003' });
    const payload = { id:'wamid.WA60-dup', type:'text', to:'5215512340003' };
    let r = await postWebhook(payload, { secret:process.env.WHATSAPP_APP_SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.data.procesado, true);
    r = await postWebhook(payload, { secret:process.env.WHATSAPP_APP_SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.data.procesado, false);
    assert.match(r.data.motivo, /duplicado/i);
    const total = db.prepare(`SELECT COUNT(*) c FROM whatsapp_comunicaciones_manuales WHERE wamid='wamid.WA60-dup'`).get().c;
    assert.equal(total, 1, 'un reintento con el mismo wamid nunca debe producir una segunda fila');
  } finally {
    delete process.env.WHATSAPP_APP_SECRET;
  }
});

test('WA-61 (punto 3, séptima revisión): un eco de tipo "reaction" no cuenta como comunicación nueva -- filtro estructural, no interpretación de contenido', async () => {
  process.env.WHATSAPP_APP_SECRET = 'secreto_de_prueba_wa61';
  try{
    const s = await crearSiniestro({ numero:'WA61', cliente_telefono:'5512340004' });
    const r = await postWebhook({ id:'wamid.WA61-reaction', type:'reaction', to:'5215512340004' }, { secret:process.env.WHATSAPP_APP_SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.data.procesado, false);
    assert.match(r.data.motivo, /reacción|contenido nuevo/i);
    const fila = db.prepare(`SELECT * FROM whatsapp_comunicaciones_manuales WHERE wamid='wamid.WA61-reaction'`).get();
    assert.equal(fila, undefined, 'una reacción nunca debe registrarse como comunicación');
  } finally {
    delete process.env.WHATSAPP_APP_SECRET;
  }
});

test('WA-62 (punto 3, séptima revisión): teléfono ambiguo (2+ expedientes activos) NUNCA elige uno arbitrariamente ni reinicia ningún contador -- una sola alerta interna por teléfono', async () => {
  process.env.WHATSAPP_APP_SECRET = 'secreto_de_prueba_wa62';
  try{
    const telCompartido = '5512340005';
    const uno = await crearSiniestro({ numero:'WA62A', cliente_telefono: telCompartido });
    const dos = await crearSiniestro({ numero:'WA62B', cliente_telefono: telCompartido });

    let r = await postWebhook({ id:'wamid.WA62-1', type:'text', to:'5215512340005' }, { secret:process.env.WHATSAPP_APP_SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.data.procesado, false);
    assert.match(r.data.motivo, /ambigu/i);
    assert.deepEqual(r.data.candidatos.sort(), ['WA62A','WA62B'].sort(), 'debe listar los candidatos, sin elegir ninguno');

    const comUno = db.prepare('SELECT COUNT(*) c FROM whatsapp_comunicaciones_manuales WHERE siniestro_id=?').get(uno.id).c;
    const comDos = db.prepare('SELECT COUNT(*) c FROM whatsapp_comunicaciones_manuales WHERE siniestro_id=?').get(dos.id).c;
    assert.equal(comUno, 0, 'ningún contador debe reiniciarse mientras la ambigüedad no se resuelva');
    assert.equal(comDos, 0);

    const alertas1 = db.prepare(`SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE plantilla_codigo='ALERTA-TELEFONO-AMBIGUO'`).get().c;
    assert.equal(alertas1, 1, 'debe registrarse exactamente una alerta interna');

    // Un segundo mensaje ambiguo (wamid distinto) del mismo teléfono no debe generar trabajo recurrente:
    // sigue siendo la MISMA alerta (dedup por teléfono, no por mensaje).
    r = await postWebhook({ id:'wamid.WA62-2', type:'text', to:'5215512340005' }, { secret:process.env.WHATSAPP_APP_SECRET });
    assert.equal(r.data.procesado, false);
    const alertas2 = db.prepare(`SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE plantilla_codigo='ALERTA-TELEFONO-AMBIGUO'`).get().c;
    assert.equal(alertas2, 1, 'un segundo mensaje ambiguo del mismo teléfono no debe generar una alerta nueva ni trabajo recurrente para Alejandra');
  } finally {
    delete process.env.WHATSAPP_APP_SECRET;
  }
});

test('WA-63 (punto 3, séptima revisión): verificarFirma -- casos de borde (sin secreto, sin firma, longitud distinta, firma correcta)', () => {
  const secreto = 'x'.repeat(20);
  const raw = Buffer.from('{"id":"wamid.X"}');
  const firmaOk = firmar(secreto, raw);
  assert.equal(whatsappWebhook.verificarFirma(null, raw, firmaOk), false);
  assert.equal(whatsappWebhook.verificarFirma(secreto, raw, null), false);
  assert.equal(whatsappWebhook.verificarFirma(secreto, raw, 'sha256=abc'), false);
  assert.equal(whatsappWebhook.verificarFirma(secreto, raw, firmaOk), true);
  assert.equal(whatsappWebhook.verificarFirma(secreto, raw, firmaOk.slice(0, -2) + 'zz'), false);
});
