// ===================== Pruebas: WhatsApp -- bandeja manual asistida (rama whatsapp-bandeja-manual) =====
// Cubren, sobre server/whatsappBandejaManual.js y server/routes/whatsappBandejaManual.js: permisos,
// concurrencia en el reclamo atómico, caducidad de reserva, revalidación (teléfono inválido, incidencia
// delicada, cambio de etapa), confirmación Sí/No, cancelación automática (punto 10), protección contra
// duplicados, textos EXACTOS de plantilla, y compatibilidad con el motor de detección existente
// (server/whatsappFaseA.js, que esta rama NUNCA modifica).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-whatsapp-bandeja-manual.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const bandeja = require('../server/whatsappBandejaManual');
const activacion = require('../server/whatsappFaseAActivacion');

const PORT = 3995;
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
  assert.equal(r.status, 200, `login debe funcionar para ${email}: ${JSON.stringify(r.data)}`);
}

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, resolve); });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  activacion.establecerConfig(db, 'activo', '1');
  activacion.establecerConfig(db, 'piloto_todos', '1');
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

let contador = 0;
function tel(){ contador++; return '551' + String(1000000 + contador); }

async function crearSiniestro(campos){
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const numero = campos.numero;
  const body = { aseguradora:'GNP', cliente_nombre:'Cliente '+numero, cliente_correo: numero.toLowerCase()+'@test.mx',
    cliente_telefono: tel(), ingreso_tipo:'grua', ...campos };
  const r = await req('POST', '/api/siniestros', body);
  assert.equal(r.status, 201, 'creación de siniestro debe funcionar: ' + JSON.stringify(r.data));
  return r.data;
}
async function crearSiniestroTelefonoInvalido(campos){
  // OJO: un teléfono AUSENTE nunca llega a registrarse (5.1 exige cliente_telefono truthy en el motor de
  // detección) -- para probar el caso "bloqueado por destino inválido" hace falta un valor NO vacío pero
  // inválido (aquí, un placeholder de 10 dígitos repetidos, exactamente el caso que normalizarTelefonoMX
  // detecta).
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const numero = campos.numero;
  const body = { aseguradora:'GNP', cliente_nombre:'Cliente '+numero, ingreso_tipo:'grua', cliente_telefono:'5555555555', ...campos };
  const r = await req('POST', '/api/siniestros', body);
  assert.equal(r.status, 201, 'creación de siniestro (teléfono inválido) debe funcionar: ' + JSON.stringify(r.data));
  return r.data;
}
async function patchComo(email, password, siniestroId, body){
  await login(email, password);
  return req('PATCH', `/api/siniestros/${siniestroId}`, body);
}
async function buscarEnPendientes(numero, plantillaCodigo){
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('GET', '/api/whatsapp-manual/pendientes');
  assert.equal(r.status, 200);
  return r.data.find(x => x.siniestro_numero === numero && x.plantilla_codigo === plantillaCodigo);
}

// ===================== WB-1: permisos =====================
test('WB-1: todos los roles autenticados pueden CONSULTAR (resumen/pendientes/en-proceso/enviados); solo atencion_cliente/vanessa/operativo pueden reclamar/confirmar; admin puede ver pero no enviar', async () => {
  const s = await crearSiniestro({ numero:'WB1' });
  for(const [email, pass] of [
    ['orlando@serviciocristian.mx','ServicioCristian2026!'],
    ['beto@serviciocristian.mx','ServicioCristian2026!'],
    ['admin@serviciocristian.mx','ServicioCristian2026!'],
  ]){
    await login(email, pass);
    assert.equal((await req('GET','/api/whatsapp-manual/resumen')).status, 200, email+' debe poder consultar el resumen');
    assert.equal((await req('GET','/api/whatsapp-manual/pendientes')).status, 200, email+' debe poder consultar pendientes');
    assert.equal((await req('GET','/api/whatsapp-manual/en-proceso')).status, 200, email+' debe poder consultar en-proceso');
    assert.equal((await req('GET','/api/whatsapp-manual/enviados')).status, 200, email+' debe poder consultar enviados');
  }
  const pendiente = await buscarEnPendientes('WB1', '5.1');
  assert.ok(pendiente, 'debe existir un mensaje pendiente 5.1 para WB1');

  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const intentoAdmin = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  assert.equal(intentoAdmin.status, 403);

  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  const intentoOrlando = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  assert.equal(intentoOrlando.status, 403);

  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const ok = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.link && ok.data.link.startsWith('https://wa.me/52'), 'debe regresar un enlace wa.me listo');

  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  assert.equal((await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:true })).status, 403);

  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const otroConfirma = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:true });
  assert.equal(otroConfirma.status, 403);

  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const confirmaOk = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:true });
  assert.equal(confirmaOk.status, 200);
});

// ===================== WB-2 / WB-13: textos EXACTOS =====================
test('WB-2/WB-13: el texto preparado es EXACTAMENTE el de la plantilla acordada, con variables sustituidas, sin corchetes ni firma de empleado', async () => {
  const s = await crearSiniestro({ numero:'WB2', vehiculo:'Nissan Versa 2022', cliente_nombre:'María López' });
  await patchComo('alejandra@serviciocristian.mx','ServicioCristian2026!', s.id, { cliente_nombre:'María López', vehiculo:'Nissan Versa 2022' });
  const pendiente = await buscarEnPendientes('WB2', '5.1');
  assert.ok(pendiente);
  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const esperado = 'Hola, María López. Te damos la bienvenida a Servicio Cristian. Hemos registrado tu unidad Nissan Versa 2022 y, a partir de este momento, te mantendremos informado por este chat individual sobre los avances importantes de tu proceso. Si tienes alguna duda sobre estos avisos, puedes responder directamente por este mismo medio. Gracias por tu confianza.';
  assert.equal(r.data.texto, esperado);
  assert.ok(!/\[Nombre\]|\[Veh[ií]culo\]/.test(r.data.texto), 'no deben quedar corchetes sin sustituir');
  assert.ok(!/Alejandra|Vanessa|Daniela/i.test(r.data.texto), 'el texto NUNCA debe llevar el nombre de quien lo envía');
  await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:false });

  assert.equal(bandeja.PLANTILLAS_TEXTO['5.11'],
    'Nos complace informarte que tu unidad está lista para entrega. Nos pondremos en contacto contigo para coordinarla. Para la entrega te pedimos traer identificación oficial (INE), el inventario que te fue entregado al ingreso y, en caso de aplicar deducible, el comprobante de pago correspondiente.');
  assert.equal(bandeja.renderTexto('6.1', { nombre:'Juan', vehiculo:'Aveo' }),
    'Hola, Juan. Queremos mantenerte informado sobre tu unidad Aveo. Actualmente continuamos en espera de la autorización correspondiente. Seguimos dando seguimiento al proceso y te notificaremos en cuanto tengamos una actualización.');
});

// ===================== WB-3: concurrencia en el reclamo atómico =====================
test('WB-3: dos reclamos "simultáneos" sobre el mismo mensaje -- exactamente uno gana, el otro recibe 409', async () => {
  const s = await crearSiniestro({ numero:'WB3' });
  const pendiente = await buscarEnPendientes('WB3', '5.1');
  assert.ok(pendiente);
  async function intentoIndependiente(email, pass){
    let cookieLocal = '';
    const loginRes = await fetch(BASE + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password: pass }) });
    const sc = loginRes.headers.get('set-cookie'); if(sc) cookieLocal = sc.split(';')[0];
    const res = await fetch(BASE + `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, { method:'POST', headers:{'Content-Type':'application/json', Cookie: cookieLocal} });
    return res.status;
  }
  const [statusA, statusB] = await Promise.all([
    intentoIndependiente('alejandra@serviciocristian.mx','ServicioCristian2026!'),
    intentoIndependiente('vanessa@serviciocristian.mx','ServicioCristian2026!'),
  ]);
  const statuses = [statusA, statusB].sort();
  assert.deepEqual(statuses, [200, 409], 'exactamente uno de los dos reclamos debe ganar (200) y el otro debe rechazarse (409)');
  const envioDb = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(pendiente.envio_id);
  assert.equal(envioDb.estado, 'reservado');
  const idAlejandra = db.prepare("SELECT id FROM usuarios WHERE email='alejandra@serviciocristian.mx'").get().id;
  await login(envioDb.abierto_por === idAlejandra ? 'alejandra@serviciocristian.mx' : 'vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:false });
});

// ===================== WB-4: revalidación (teléfono inválido, incidencia delicada) =====================
test('WB-4a: un expediente sin teléfono válido nunca se materializa como accionable -- se muestra informativo, sin botón de envío', async () => {
  const s = await crearSiniestroTelefonoInvalido({ numero:'WB4A' });
  const r = await req('GET', '/api/whatsapp-manual/pendientes');
  const fila = r.data.find(x => x.siniestro_numero === 'WB4A');
  assert.ok(fila, 'el expediente sin teléfono debe aparecer en la lista, de forma informativa');
  assert.equal(fila.tipo, 'informativo');
  assert.equal(fila.accionable, false);
  assert.match(fila.motivo, /teléfono/i);
  assert.equal(fila.envio_id, null, 'no debe existir fila de envío accionable para un destino inválido');
});

test('WB-4b: una incidencia delicada abierta ANTES de la detección bloquea el mensaje al nacer -- informativo, sin botón', async () => {
  const s = await crearSiniestro({ numero:'WB4B' });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const pedido = (await req('POST', '/api/pedidos', { siniestro_id: s.id, numero:'PED-WB4B', fecha_prevista:'2026-12-01' })).data;
  const proveedor = (await req('POST', '/api/proveedores', { razon_social:'Proveedor WB4B' })).data;
  const pieza = (await req('POST', '/api/piezas', { pedido_id: pedido.id, descripcion:'Espejo', proveedor_id: proveedor.id })).data;
  const inc = await req('POST', '/api/incidencias', { pieza_id: pieza.id, tipo:'incorrecta', descripcion:'Pieza incorrecta' });
  assert.equal(inc.status, 201, JSON.stringify(inc.data));

  const rr = await patchComo('orlando@serviciocristian.mx','ServicioCristian2026!', s.id, { estado_valuacion:'enviada', valuacion_fecha_envio:'2026-09-14' });
  assert.equal(rr.status, 200, JSON.stringify(rr.data));

  const r = await req('GET', '/api/whatsapp-manual/pendientes');
  const fila = r.data.find(x => x.siniestro_numero === 'WB4B' && x.plantilla_codigo === '5.2');
  assert.ok(fila, 'el mensaje 5.2 debe listarse, aunque bloqueado');
  assert.equal(fila.accionable, false);
  assert.match(fila.motivo, /incidencia delicada/i);
});

test('WB-4c: una incidencia delicada abierta DESPUÉS de materializado el pendiente lo vuelve informativo (no lo cancela); reclamar() lo rechaza con 409 sin cancelarlo', async () => {
  const s = await crearSiniestro({ numero:'WB4C' });
  const pendiente = await buscarEnPendientes('WB4C', '5.1');
  assert.ok(pendiente && pendiente.accionable);

  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const pedido = (await req('POST', '/api/pedidos', { siniestro_id: s.id, numero:'PED-WB4C', fecha_prevista:'2026-12-01' })).data;
  const proveedor = (await req('POST', '/api/proveedores', { razon_social:'Proveedor WB4C' })).data;
  const pieza = (await req('POST', '/api/piezas', { pedido_id: pedido.id, descripcion:'Faro', proveedor_id: proveedor.id })).data;
  await req('POST', '/api/incidencias', { pieza_id: pieza.id, tipo:'danada', descripcion:'Pieza dañada' });

  const relistado = await buscarEnPendientes('WB4C', '5.1');
  assert.ok(relistado, 'la fila debe seguir en Pendientes (no se cancela por esto)');
  assert.equal(relistado.accionable, false, 'ahora debe verse como bloqueada/informativa');
  assert.match(relistado.motivo, /incidencia delicada/i);
  assert.equal(relistado.envio_id, pendiente.envio_id, 'debe ser la MISMA fila, no una nueva');

  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const intento = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  assert.equal(intento.status, 409);
  assert.match(intento.data.error, /incidencia delicada/i);
  const envioDb = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(pendiente.envio_id);
  assert.equal(envioDb.estado, 'pendiente', 'debe regresar a pendiente, NUNCA cancelarse por esto');
});

// ===================== WB-5: caducidad de reserva =====================
test('WB-5: una reserva abandonada (sin confirmar) expira sola y el mensaje regresa a Pendientes', async () => {
  const s = await crearSiniestro({ numero:'WB5' });
  const pendiente = await buscarEnPendientes('WB5', '5.1');
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  assert.equal(r.status, 200);
  let envioDb = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(pendiente.envio_id);
  assert.equal(envioDb.estado, 'reservado');

  db.prepare(`UPDATE whatsapp_envios_manuales SET reserva_expira_en = datetime('now','-1 minute') WHERE id=?`).run(pendiente.envio_id);

  const relistado = await req('GET', '/api/whatsapp-manual/pendientes');
  assert.equal(relistado.status, 200);
  const filaLiberada = relistado.data.find(x => x.envio_id === pendiente.envio_id);
  assert.ok(filaLiberada, 'debe volver a aparecer en Pendientes');
  assert.equal(filaLiberada.accionable, true);

  envioDb = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(pendiente.envio_id);
  assert.equal(envioDb.estado, 'pendiente');
  assert.equal(envioDb.abierto_por, null);

  const historial = db.prepare(`SELECT * FROM whatsapp_envios_manuales_historial WHERE envio_id=? ORDER BY id DESC`).all(pendiente.envio_id);
  assert.ok(historial.some(h => h.evento === 'reserva_expirada'), 'debe quedar registrado en el historial interno');
});

// ===================== WB-6: confirmación Sí / No =====================
test('WB-6a: confirmar "Sí" registra el envío (usuario, fecha, plantilla, siniestro, teléfono) y lo retira de Pendientes', async () => {
  const s = await crearSiniestro({ numero:'WB6A' });
  const pendiente = await buscarEnPendientes('WB6A', '5.1');
  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const rec = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  assert.equal(rec.status, 200);
  const conf = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:true });
  assert.equal(conf.status, 200);

  const envioDb = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(pendiente.envio_id);
  assert.equal(envioDb.estado, 'enviado');
  assert.ok(envioDb.confirmado_por);
  assert.ok(envioDb.confirmado_en);
  assert.ok(envioDb.telefono);
  assert.equal(envioDb.plantilla_codigo, '5.1');

  const yaNoPendiente = await buscarEnPendientes('WB6A', '5.1');
  assert.equal(yaNoPendiente, undefined);

  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const enviados = await req('GET', '/api/whatsapp-manual/enviados?q=WB6A');
  assert.equal(enviados.status, 200);
  assert.ok(enviados.data.some(x => x.envio_id === pendiente.envio_id));
});

test('WB-6b: confirmar "No" libera la reserva y el mensaje regresa a Pendientes, disponible de nuevo', async () => {
  const s = await crearSiniestro({ numero:'WB6B' });
  const pendiente = await buscarEnPendientes('WB6B', '5.1');
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  const conf = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:false });
  assert.equal(conf.status, 200);
  const envioDb = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(pendiente.envio_id);
  assert.equal(envioDb.estado, 'pendiente');
  const denuevo = await buscarEnPendientes('WB6B', '5.1');
  assert.ok(denuevo && denuevo.accionable);
});

// ===================== WB-7: duplicados / mensaje confirmado no se puede reenviar =====================
test('WB-7: un mensaje ya confirmado ("enviado") no puede volver a reclamarse ni duplicarse en la bandeja', async () => {
  const s = await crearSiniestro({ numero:'WB7' });
  const pendiente = await buscarEnPendientes('WB7', '5.1');
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:true });

  const reintento = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
  assert.equal(reintento.status, 409);

  const eventoId = db.prepare('SELECT evento_id FROM whatsapp_envios_manuales WHERE id=?').get(pendiente.envio_id).evento_id;
  const antes = db.prepare('SELECT COUNT(*) c FROM whatsapp_envios_manuales WHERE evento_id=?').get(eventoId).c;
  bandeja.sincronizarBandeja(db);
  bandeja.sincronizarBandeja(db);
  const despues = db.prepare('SELECT COUNT(*) c FROM whatsapp_envios_manuales WHERE evento_id=?').get(eventoId).c;
  assert.equal(antes, 1); assert.equal(despues, 1);
});

// ===================== WB-8: cancelación automática por cambio de etapa (punto 10) =====================
test('WB-8: si la etapa del expediente cambia antes de enviarse, el mensaje anterior se cancela solo y aparece el vigente', async () => {
  const s = await crearSiniestro({ numero:'WB8' });
  const pendienteBienvenida = await buscarEnPendientes('WB8', '5.1');
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  await req('POST', `/api/whatsapp-manual/envios/${pendienteBienvenida.envio_id}/reclamar`, {});
  await req('POST', `/api/whatsapp-manual/envios/${pendienteBienvenida.envio_id}/confirmar`, { enviado:true });

  const rr = await patchComo('orlando@serviciocristian.mx','ServicioCristian2026!', s.id, { estado_valuacion:'enviada', valuacion_fecha_envio:'2026-09-14' });
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
  const pendiente52 = await buscarEnPendientes('WB8', '5.2');
  assert.ok(pendiente52 && pendiente52.accionable, '5.2 debe estar pendiente y accionable');

  const auth = await patchComo('orlando@serviciocristian.mx','ServicioCristian2026!', s.id,
    { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-14', autorizador:'GNP', piezas_autorizadas_cambio:1 });
  assert.equal(auth.status, 200, JSON.stringify(auth.data));

  const listaTrasAvance = await req('GET', '/api/whatsapp-manual/pendientes');
  const sigue52 = listaTrasAvance.data.find(x => x.envio_id === pendiente52.envio_id);
  assert.equal(sigue52, undefined, 'el mensaje 5.2 obsoleto ya no debe listarse como pendiente');

  const envioDb = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(pendiente52.envio_id);
  assert.equal(envioDb.estado, 'cancelado');
  assert.match(envioDb.cancelado_motivo, /ya no se cumple|etapa cambió/i);
  const historial = db.prepare(`SELECT * FROM whatsapp_envios_manuales_historial WHERE envio_id=?`).all(pendiente52.envio_id);
  assert.ok(historial.some(h => h.evento === 'cancelado_automatico'));

  const nuevoVigente = listaTrasAvance.data.find(x => x.siniestro_numero === 'WB8' && x.plantilla_codigo === '5.3');
  assert.ok(nuevoVigente, 'debe aparecer el mensaje vigente de la nueva etapa (5.3, con piezas a cambio)');
  assert.equal(nuevoVigente.accionable, true);
});

// ===================== WB-9: horario =====================
// esHorarioHabil() es una función interna de whatsappFaseA.js (no exportada, y aunque lo estuviera,
// reasignar la propiedad del export no cambiaría las llamadas internas -- son referencias de closure, no
// búsquedas dinámicas). En vez de eso, se fija la hora "actual" que usa TODO el módulo -- incluida
// whatsappFaseA.js, porque ambos archivos hacen `require('dayjs')` y Node cachea el mismo objeto módulo,
// así que parchar dayjs.utc aquí también cambia lo que ve whatsappFaseA.js -- a un domingo (cerrado todo
// el día, HORARIO_HABIL[0]=null), sin depender de la hora real en la que corra la prueba.
test('WB-9: al listar, un mensaje fuera de horario se sigue mostrando accionable (fuera_de_horario:true); al reclamar de verdad, el horario SÍ se exige', async () => {
  const s = await crearSiniestro({ numero:'WB9' });
  const evento = db.prepare(`SELECT id FROM whatsapp_eventos_registrados WHERE siniestro_id=? AND plantilla_codigo='5.1'`).get(s.id);
  assert.ok(evento);
  const dayjsLib = require('dayjs');
  const originalUtc = dayjsLib.utc;
  const DOMINGO_FIJO = '2026-09-13T18:00:00Z'; // domingo -- HORARIO_HABIL[0] es null, cerrado todo el día.
  dayjsLib.utc = (...args) => args.length ? originalUtc(...args) : originalUtc(DOMINGO_FIJO);
  try{
    const pendiente = await buscarEnPendientes('WB9', '5.1');
    assert.ok(pendiente, 'debe seguir apareciendo como pendiente aunque esté fuera de horario');
    assert.equal(pendiente.accionable, true, 'fuera de horario NO debe ocultar el mensaje de la lista');
    assert.equal(pendiente.fuera_de_horario, true);

    await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
    const intento = await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});
    assert.equal(intento.status, 409);
    assert.match(intento.data.error, /horario/i);
    const envioDb = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(pendiente.envio_id);
    assert.equal(envioDb.estado, 'pendiente', 'fuera de horario libera la reserva, no cancela el mensaje');
  } finally {
    dayjsLib.utc = originalUtc;
  }
});

// ===================== WB-10: compatibilidad con el motor existente y con el resto del tablero =====================
test('WB-10: la bandeja manual nunca escribe en whatsapp_eventos_registrados; el resto del tablero (PATCH normal) sigue funcionando igual', async () => {
  const s = await crearSiniestro({ numero:'WB10' });
  const eventosAntes = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados').get().c;
  bandeja.sincronizarBandeja(db);
  bandeja.sincronizarBandeja(db);
  const eventosDespues = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados').get().c;
  assert.equal(eventosAntes, eventosDespues, 'sincronizar la bandeja jamás debe crear/alterar eventos del motor de detección');

  const r = await patchComo('daniela@serviciocristian.mx','ServicioCristian2026-Reset!', s.id, { notas:'Nota operativa normal, sin relación con WhatsApp.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.notas, 'Nota operativa normal, sin relación con WhatsApp.');
});

// ===================== WB-11: reabrir un envío reservado propio (continuar) =====================
test('WB-11: GET /envios/:id devuelve el enlace de un mensaje reservado por mí; devuelve 403 si lo reservó otra persona', async () => {
  const s = await crearSiniestro({ numero:'WB11' });
  const pendiente = await buscarEnPendientes('WB11', '5.1');
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/reclamar`, {});

  const propio = await req('GET', `/api/whatsapp-manual/envios/${pendiente.envio_id}`);
  assert.equal(propio.status, 200);
  assert.ok(propio.data.link);

  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const ajeno = await req('GET', `/api/whatsapp-manual/envios/${pendiente.envio_id}`);
  assert.equal(ajeno.status, 403);

  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  await req('POST', `/api/whatsapp-manual/envios/${pendiente.envio_id}/confirmar`, { enviado:false });
});

// ===================== WB-12: verificación del frontend (markers) =====================
test('WB-12: la pantalla "WhatsApp" existe en el menú y expone únicamente el flujo esperado (sin filtros avanzados, plantilla, redacción manual ni envío masivo)', async () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appJs, /\{k:'whatsapp', label:'WhatsApp'\}/, 'debe existir la pestaña "WhatsApp" en el menú, sola (sin roles restringidos)');
  assert.match(appJs, /async function viewWhatsapp\(\)/);
  assert.match(appJs, /function enviarPorWhatsappBandeja\(/);
  assert.match(appJs, /function confirmarEnvioWhatsappBandeja\(/);
  assert.match(appJs, /¿El mensaje fue enviado\?/);
  assert.ok(!/selectorPlantilla|redaccionManual|envioMasivo/i.test(appJs), 'no deben existir ganchos de selección de plantilla, redacción manual o envío masivo');
});
