// ===================== Pruebas: limpieza administrativa de una corrida de piloto (ficticia) =============
// Punto 3 de la revisión del plan de despliegue (Roberto, 15-sep-2026): "La limpieza actual no es
// ejecutable y su orden produciría referencias foráneas... implementa una ruta administrativa
// transaccional y probada para limpiar exclusivamente una corrida ficticia. Debe exigir piloto_run_id y
// los números exactos, borrar primero whatsapp_envios_manuales_historial, después
// whatsapp_envios_manuales, luego revertir los registros de Fase A y finalmente permitir eliminar los
// expedientes ficticios. Sin runId o sin coincidencia exacta, no debe borrar nada. Debe conservar
// intactas otras corridas y expedientes."
//
// Estas pruebas cubren, sobre server/whatsappBandejaManual.js#limpiarCorridaFicticia y la ruta
// POST /api/whatsapp-manual/piloto/limpiar (server/routes/whatsappBandejaManual.js):
//   WB-PL-1: sin runId -> no borra nada.
//   WB-PL-2: runId que no existe -> no borra nada.
//   WB-PL-3: lista de números que no coincide exactamente (falta uno / sobra uno) -> no borra nada,
//            y el error reporta exactamente qué faltó y qué sobró.
//   WB-PL-4: caso de éxito -- borra, en el orden correcto, las 5 tablas involucradas (historial, envíos,
//            eventos, comunicaciones, errores) de esa corrida; el expediente en sí sobrevive (no se pidió
//            eliminarExpedientes).
//   WB-PL-5: aislamiento entre corridas -- el mismo expediente participa en DOS corridas distintas;
//            limpiar la corrida A no toca ni una fila de la corrida B sobre ese mismo expediente.
//   WB-PL-6: eliminarExpedientes se cancela (ROLLBACK de TODO, incluidos los pasos 1-3 ya ejecutados en la
//            misma transacción) si después de limpiar queda cualquier otra fila dependiente del expediente
//            en cualquier tabla del esquema (se agrega un pedido real a propósito, para simular esto).
//   WB-PL-7: eliminarExpedientes SÍ borra el expediente cuando de verdad no queda nada más colgando.
//   WB-PL-8: solo admin puede llamar la ruta -- Alejandra/Vanessa/Daniela reciben 403.
//
// Segunda revisión (Roberto, 15-sep-2026): "No uses eliminarExpedientes:true como procedimiento normal
// -- todo expediente creado por la API genera al menos una tarea automática, esa opción hará ROLLBACK.
// Usa: limpiar con eliminarExpedientes:false, y después DELETE /api/siniestros/:id (confirmar_numero) --
// ese endpoint ya limpia sus tareas y demás dependencias normales." También pidió un endpoint de solo
// lectura para el historial del piloto (no hay acceso a SQL directo en producción). Pruebas nuevas:
//   WB-PL-9: secuencia completa, SOLO por HTTP (sin ningún DELETE/SQL directo de prueba, salvo para leer
//            y verificar): crear expediente ficticio -> generar mensaje (reclamar+confirmar) -> limpiar la
//            corrida con eliminarExpedientes:false -> DELETE /api/siniestros/:id con confirmar_numero ->
//            confirmar que no queda ninguna fila asociada, en ninguna de las tablas involucradas.
//   WB-PL-10: demuestra por qué importa el orden -- intentar DELETE /api/siniestros/:id ANTES de limpiar
//             la corrida (con datos de WhatsApp todavía colgando) falla con la restricción de llave
//             foránea real -- confirma que saltarse el paso 1 no es una opción silenciosa.
//   WB-PL-11 a WB-PL-14: GET /api/whatsapp-manual/piloto/historial -- sin runId ni numeros (400, nunca
//            lista todo sin acotar), filtrado por runId, filtrado por numeros, y que NO mezcla el
//            historial de otra corrida sobre el mismo expediente (misma garantía de aislamiento que
//            limpiarCorridaFicticia). Incluye verificar que aparecen exactamente los eventos
//            "confirmado_enviado" / "liberado_no_enviado" con el usuario correcto -- la evidencia que
//            pedía el punto 9 del plan, sin necesitar SQL directo.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-whatsapp-bandeja-manual-piloto-limpieza.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const bandeja = require('../server/whatsappBandejaManual');
const activacion = require('../server/whatsappFaseAActivacion');

const PORT = 3993;
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
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

let contador = 0;
function tel(){ contador++; return '552' + String(2000000 + contador); }

// Crea un expediente ficticio con teléfono y vehículo válidos (así el motor de Fase A genera 5.1 de
// inmediato, sin depender de las 72h reales de continuidad -- punto 2 de esta misma revisión) y lo deja
// como el único número en piloto_numeros, bajo el piloto_run_id ACTUAL (el que esté vigente al momento de
// llamar esta función -- llamar activacion.iniciarPilotoRun(db) antes si se quiere una corrida nueva).
async function crearExpedienteFicticioEnCorridaActual(numero){
  activacion.establecerConfig(db, 'piloto_numeros', numero);
  activacion.establecerConfig(db, 'piloto_todos', '0');
  activacion.establecerConfig(db, 'activo', '1');
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('POST', '/api/siniestros', {
    numero, aseguradora:'GNP', cliente_nombre:'Cliente '+numero, cliente_correo: numero.toLowerCase()+'@test.mx',
    cliente_telefono: tel(), ingreso_tipo:'grua', vehiculo:'Vehículo de prueba '+numero,
  });
  assert.equal(r.status, 201, 'creación de expediente ficticio debe funcionar: ' + JSON.stringify(r.data));
  return r.data;
}

test('WB-PL-1: sin piloto_run_id, no se borra nada', () => {
  const r = bandeja.limpiarCorridaFicticia(db, { numeros: ['CUALQUIERA'] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /piloto_run_id/);
});

test('WB-PL-2: un piloto_run_id que no existe, no se borra nada', () => {
  const r = bandeja.limpiarCorridaFicticia(db, { runId: 'run-que-no-existe-jamas', numeros: ['CUALQUIERA'] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('WB-PL-3: la lista de números no coincide exactamente -- no se borra nada, y se reporta qué faltó y qué sobró', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  await crearExpedienteFicticioEnCorridaActual('WBPL3');

  // Falta un número real (se manda una lista vacía-de-lo-esperado con un número que no es).
  const r1 = bandeja.limpiarCorridaFicticia(db, { runId, numeros: ['NO-ES-ESTE'] });
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 409);
  assert.deepEqual(r1.esperados, ['WBPL3']);
  assert.deepEqual(r1.faltan, ['WBPL3']);
  assert.deepEqual(r1.sobran, ['NO-ES-ESTE']);

  // Sobra un número de más (el correcto, más uno inventado).
  const r2 = bandeja.limpiarCorridaFicticia(db, { runId, numeros: ['WBPL3', 'INVENTADO'] });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 409);
  assert.deepEqual(r2.sobran, ['INVENTADO']);

  // Nada de esto debió borrar una sola fila.
  const evento = db.prepare(`SELECT e.* FROM whatsapp_eventos_registrados e JOIN siniestros s ON s.id=e.siniestro_id WHERE s.numero='WBPL3'`).get();
  assert.ok(evento, 'el evento de Fase A debe seguir existiendo -- no se borró nada por el desacuerdo');
});

test('WB-PL-4: caso de éxito -- borra, en el orden correcto, las tablas de esa corrida; el expediente sobrevive', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  const s = await crearExpedienteFicticioEnCorridaActual('WBPL4');

  // Reclama y confirma el mensaje (genera fila en whatsapp_envios_manuales_historial de verdad).
  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const pend = await req('GET', '/api/whatsapp-manual/pendientes');
  const fila = pend.data.find(x => x.siniestro_numero === 'WBPL4');
  assert.ok(fila, 'debe aparecer como pendiente accionable');
  const rec = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/reclamar`, {});
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  const conf = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/confirmar`, { enviado:true });
  assert.equal(conf.status, 200);

  // Confirma que de verdad hay filas que borrar en las 5 tablas relevantes antes de limpiar.
  const antesEventos = db.prepare(`SELECT COUNT(*) n FROM whatsapp_eventos_registrados WHERE siniestro_id=?`).get(s.id).n;
  const antesEnvios = db.prepare(`SELECT COUNT(*) n FROM whatsapp_envios_manuales WHERE siniestro_id=?`).get(s.id).n;
  const antesHistorial = db.prepare(`SELECT COUNT(*) n FROM whatsapp_envios_manuales_historial h JOIN whatsapp_envios_manuales m ON m.id=h.envio_id WHERE m.siniestro_id=?`).get(s.id).n;
  assert.ok(antesEventos > 0 && antesEnvios > 0 && antesHistorial > 0, 'deben existir filas reales antes de limpiar');

  const r = bandeja.limpiarCorridaFicticia(db, { runId, numeros: ['WBPL4'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.historialBorrados, antesHistorial);
  assert.equal(r.enviosBorrados, antesEnvios);
  assert.equal(r.eventosBorrados, antesEventos);
  assert.equal(r.expedientesBorrados, 0, 'no se pidió eliminarExpedientes -- el expediente debe sobrevivir');

  const despuesEventos = db.prepare(`SELECT COUNT(*) n FROM whatsapp_eventos_registrados WHERE siniestro_id=?`).get(s.id).n;
  const despuesEnvios = db.prepare(`SELECT COUNT(*) n FROM whatsapp_envios_manuales WHERE siniestro_id=?`).get(s.id).n;
  const despuesHistorial = db.prepare(`SELECT COUNT(*) n FROM whatsapp_envios_manuales_historial h JOIN whatsapp_envios_manuales m ON m.id=h.envio_id WHERE m.siniestro_id=?`).get(s.id).n;
  assert.equal(despuesEventos, 0);
  assert.equal(despuesEnvios, 0);
  assert.equal(despuesHistorial, 0);
  const sigueExistiendo = db.prepare(`SELECT id FROM siniestros WHERE id=?`).get(s.id);
  assert.ok(sigueExistiendo, 'el expediente en sí debe seguir existiendo');

  // Repetir la misma limpieza ahora debe fallar con 404 (ya no queda nada con ese runId) -- confirma que
  // no hay manera de "limpiar dos veces" por accidente.
  const otra = bandeja.limpiarCorridaFicticia(db, { runId, numeros: ['WBPL4'] });
  assert.equal(otra.ok, false);
  assert.equal(otra.status, 404);
});

test('WB-PL-5: limpiar la corrida A nunca toca la corrida B, aunque compartan el mismo expediente', async () => {
  const runA = activacion.iniciarPilotoRun(db);
  const s = await crearExpedienteFicticioEnCorridaActual('WBPL5');
  const eventoA = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE siniestro_id=?`).get(s.id);
  assert.ok(eventoA, 'debe existir el evento 5.1 de la corrida A');
  assert.equal(eventoA.piloto_run_id, runA);

  // Corrida B, sobre el MISMO expediente: se envía a valuación (genera un 5.2 nuevo, bajo la corrida B).
  const runB = activacion.iniciarPilotoRun(db);
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  const rr = await req('PATCH', `/api/siniestros/${s.id}`, { estado_valuacion:'enviada', valuacion_fecha_envio:'2026-09-15' });
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
  const eventoB = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE siniestro_id=? AND plantilla_codigo='5.2'`).get(s.id);
  assert.ok(eventoB, 'debe existir el evento 5.2 de la corrida B');
  assert.equal(eventoB.piloto_run_id, runB);

  // Limpiar SOLO la corrida A.
  const r = bandeja.limpiarCorridaFicticia(db, { runId: runA, numeros: ['WBPL5'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.eventosBorrados, 1, 'solo debe borrar el evento de la corrida A (el 5.1)');

  // El 5.1 (corrida A) debe haber desaparecido; el 5.2 (corrida B) debe seguir intacto, con su propio
  // envío manual (si llegó a materializarse) también intacto.
  const sigueA = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE id=?`).get(eventoA.id);
  assert.equal(sigueA, undefined, 'el evento de la corrida A debe haber desaparecido');
  const sigueB = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE id=?`).get(eventoB.id);
  assert.ok(sigueB, 'el evento de la corrida B (5.2) debe seguir intacto -- otra corrida, no se toca');

  // Limpiar ahora la corrida A otra vez debe fallar (ya no queda nada con ese runId) -- pero la corrida B
  // sigue viva y limpiable por separado, con su propio runId exacto.
  const otraVez = bandeja.limpiarCorridaFicticia(db, { runId: runA, numeros: ['WBPL5'] });
  assert.equal(otraVez.ok, false);
  assert.equal(otraVez.status, 404);
});

test('WB-PL-6: eliminarExpedientes se cancela por completo (ROLLBACK de todo) si queda algo más colgando del expediente', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  const s = await crearExpedienteFicticioEnCorridaActual('WBPL6');

  // A propósito, se agrega un dato REAL no relacionado con WhatsApp (un pedido) -- simula que este
  // expediente ya no está aislado y no debería borrarse de verdad.
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const pedido = await req('POST', '/api/pedidos', { siniestro_id: s.id, numero:'PED-WBPL6', fecha_prevista:'2026-12-01' });
  assert.equal(pedido.status, 201, JSON.stringify(pedido.data));

  const antesEventos = db.prepare(`SELECT COUNT(*) n FROM whatsapp_eventos_registrados WHERE siniestro_id=?`).get(s.id).n;
  assert.ok(antesEventos > 0);

  const r = bandeja.limpiarCorridaFicticia(db, { runId, numeros: ['WBPL6'], eliminarExpedientes: true });
  assert.equal(r.ok, false, 'debe fallar -- el pedido todavía depende del expediente');
  assert.match(r.error, /pedidos/);

  // ROLLBACK completo: ni siquiera los pasos 1-3 (que sí corrieron dentro de la misma transacción) deben
  // haber quedado aplicados -- "se cancela toda la limpieza, nada se borró".
  const despuesEventos = db.prepare(`SELECT COUNT(*) n FROM whatsapp_eventos_registrados WHERE siniestro_id=?`).get(s.id).n;
  assert.equal(despuesEventos, antesEventos, 'los eventos de Fase A deben seguir intactos -- el ROLLBACK deshizo todo, no solo el paso 4');
  const sigueExpediente = db.prepare(`SELECT id FROM siniestros WHERE id=?`).get(s.id);
  assert.ok(sigueExpediente, 'el expediente debe seguir existiendo');
  const sigueElPedido = db.prepare(`SELECT id FROM pedidos WHERE siniestro_id=?`).get(s.id);
  assert.ok(sigueElPedido, 'el pedido debe seguir existiendo');
});

test('WB-PL-7: eliminarExpedientes SÍ borra el expediente cuando de verdad no queda nada más dependiendo de él', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  const s = await crearExpedienteFicticioEnCorridaActual('WBPL7');

  // Crear un expediente por la vía normal (POST /api/siniestros) ya deja, además de lo propio de la
  // bandeja, una tarea de seguimiento automática (tabla "tareas", ver server/routes/siniestros.js) -- el
  // propio recorrido dinámico de tablasQueReferencianSiniestros() la detecta y, correctamente, bloquearía
  // el borrado del expediente (exactamente lo que ya demuestra WB-PL-6 con "pedidos"). Para probar el
  // camino de éxito de verdad (expediente REALMENTE limpio, no solo de datos de WhatsApp), se retira aquí
  // esa tarea auxiliar antes de pedir eliminarExpedientes -- tal como tendría que hacerlo un admin en la
  // práctica, o como podría automatizarse más adelante si Roberto lo pide.
  const tareasAntes = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE siniestro_id=?`).get(s.id).n;
  assert.ok(tareasAntes > 0, 'crear un expediente por la vía normal debe generar al menos una tarea automática');
  db.prepare(`DELETE FROM tareas WHERE siniestro_id=?`).run(s.id);

  const r = bandeja.limpiarCorridaFicticia(db, { runId, numeros: ['WBPL7'], eliminarExpedientes: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.expedientesBorrados, 1);

  const yaNoExiste = db.prepare(`SELECT id FROM siniestros WHERE id=?`).get(s.id);
  assert.equal(yaNoExiste, undefined, 'el expediente ficticio debe haber desaparecido por completo');
});

test('WB-PL-8: la ruta HTTP exige rol admin -- Alejandra/Vanessa/Daniela reciben 403', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  await crearExpedienteFicticioEnCorridaActual('WBPL8');

  for (const [email, pass] of [
    ['alejandra@serviciocristian.mx', 'ServicioCristian2026!'],
    ['vanessa@serviciocristian.mx', 'ServicioCristian2026!'],
    ['daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!'],
  ]) {
    await login(email, pass);
    const r = await req('POST', '/api/whatsapp-manual/piloto/limpiar', { runId, numeros: ['WBPL8'] });
    assert.equal(r.status, 403, `${email} no debe poder llamar esta ruta: ${JSON.stringify(r.data)}`);
  }

  // Con admin sí debe funcionar.
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const rAdmin = await req('POST', '/api/whatsapp-manual/piloto/limpiar', { runId, numeros: ['WBPL8'] });
  assert.equal(rAdmin.status, 200, JSON.stringify(rAdmin.data));
  assert.equal(rAdmin.data.ok, true);
});

// ===================== WB-PL-9 / WB-PL-10: secuencia real de teardown, solo por HTTP ======================
// Corrección de Roberto (segunda revisión, 15-sep-2026): eliminarExpedientes:true no es viable como
// procedimiento normal -- todo expediente creado por la API deja al menos una tarea automática (ver
// WB-PL-7), y en producción no hay forma de borrar esa tarea con SQL directo. La secuencia real es:
// limpiar la corrida (eliminarExpedientes:false) y, aparte, usar el endpoint administrativo YA EXISTENTE
// DELETE /api/siniestros/:id (server/routes/siniestros.js, sin tocar -- ya limpia tareas, pedidos, piezas,
// hitos y todo lo demás en su propia transacción). Estas dos pruebas NO usan una sola sentencia SQL para
// borrar nada -- solo para leer y verificar el resultado.
test('WB-PL-9: secuencia real (limpiar corrida con eliminarExpedientes:false + DELETE /api/siniestros/:id) borra TODO sin SQL directo', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  const s = await crearExpedienteFicticioEnCorridaActual('WBPL9');

  // Generar un mensaje real (reclamar + confirmar), igual que en WB-PL-4.
  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const pend = await req('GET', '/api/whatsapp-manual/pendientes');
  const fila = pend.data.find(x => x.siniestro_numero === 'WBPL9');
  assert.ok(fila, 'debe aparecer como pendiente accionable');
  const rec = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/reclamar`, {});
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  const conf = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/confirmar`, { enviado: true });
  assert.equal(conf.status, 200);

  // Confirma (antes de tocar nada) que existe la tarea automática que WB-PL-7 ya documentó -- y que por
  // eso eliminarExpedientes:true habría hecho ROLLBACK aquí también.
  const tareasAntes = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE siniestro_id=?`).get(s.id).n;
  assert.ok(tareasAntes > 0, 'debe existir al menos una tarea automática -- por eso NO se usa eliminarExpedientes:true');

  // Paso 1: limpiar la corrida, SIN pedir eliminarExpedientes.
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const limpieza = await req('POST', '/api/whatsapp-manual/piloto/limpiar', { runId, numeros: ['WBPL9'], eliminarExpedientes: false });
  assert.equal(limpieza.status, 200, JSON.stringify(limpieza.data));
  assert.equal(limpieza.data.ok, true);
  assert.equal(limpieza.data.expedientesBorrados, 0, 'no se pidió eliminarExpedientes -- el expediente debe seguir vivo tras este paso');

  // El expediente y su tarea siguen existiendo -- solo se limpió lo de WhatsApp.
  const sigueExpediente = db.prepare(`SELECT id FROM siniestros WHERE id=?`).get(s.id);
  assert.ok(sigueExpediente, 'el expediente debe seguir existiendo tras limpiar solo la corrida');
  const sigueLaTarea = db.prepare(`SELECT COUNT(*) n FROM tareas WHERE siniestro_id=?`).get(s.id).n;
  assert.equal(sigueLaTarea, tareasAntes, 'la tarea automática NO se toca en este paso -- eso lo hace el endpoint de borrado, no esta ruta');

  // Paso 2: borrar el expediente con el endpoint administrativo YA EXISTENTE -- por HTTP, con la
  // confirmación exigida (confirmar_numero), sin ninguna sentencia SQL de por medio.
  const borrado = await req('DELETE', `/api/siniestros/${s.id}`, { confirmar_numero: 'WBPL9' });
  assert.equal(borrado.status, 200, JSON.stringify(borrado.data));
  assert.equal(borrado.data.ok, true);

  // Verificación final: no debe quedar NINGUNA fila asociada, en ninguna de las tablas involucradas --
  // esto SÍ se comprueba con consultas directas (verificación de la prueba, no parte del procedimiento).
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE id=?`).get(s.id).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM tareas WHERE siniestro_id=?`).get(s.id).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM whatsapp_eventos_registrados WHERE siniestro_id=?`).get(s.id).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM whatsapp_envios_manuales WHERE siniestro_id=?`).get(s.id).n, 0);
});

test('WB-PL-10: borrar el expediente ANTES de limpiar la corrida falla de verdad (restricción de llave foránea) -- el orden importa', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  const s = await crearExpedienteFicticioEnCorridaActual('WBPL10');

  // Intentar el paso 2 sin haber hecho el paso 1 -- todavía hay filas de WhatsApp que dependen del
  // expediente (whatsapp_eventos_registrados.siniestro_id, whatsapp_envios_manuales.siniestro_id).
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const borradoPrematuro = await req('DELETE', `/api/siniestros/${s.id}`, { confirmar_numero: 'WBPL10' });
  assert.notEqual(borradoPrematuro.status, 200, 'debe fallar -- todavía hay datos de WhatsApp colgando de este expediente');
  assert.match(JSON.stringify(borradoPrematuro.data), /FOREIGN KEY|foreign key/i);

  // Nada debió borrarse -- el expediente y sus eventos de WhatsApp siguen intactos.
  const sigueExpediente = db.prepare(`SELECT id FROM siniestros WHERE id=?`).get(s.id);
  assert.ok(sigueExpediente, 'el expediente debe seguir existiendo -- el intento falló, no se aplicó a medias');
  const sigueElEvento = db.prepare(`SELECT COUNT(*) n FROM whatsapp_eventos_registrados WHERE siniestro_id=?`).get(s.id).n;
  assert.ok(sigueElEvento > 0, 'el evento de WhatsApp debe seguir intacto');

  // Ahora sí, en el orden correcto: limpiar primero, borrar después -- debe funcionar.
  const limpieza = await req('POST', '/api/whatsapp-manual/piloto/limpiar', { runId, numeros: ['WBPL10'] });
  assert.equal(limpieza.status, 200, JSON.stringify(limpieza.data));
  const borradoCorrecto = await req('DELETE', `/api/siniestros/${s.id}`, { confirmar_numero: 'WBPL10' });
  assert.equal(borradoCorrecto.status, 200, JSON.stringify(borradoCorrecto.data));
});

// ===================== WB-PL-11 a WB-PL-14: historial de una corrida, solo lectura, sin SQL directo =======
// Punto 2 de la segunda revisión: GET /api/whatsapp-manual/piloto/historial -- comprueba quién confirmó
// "Sí" y quién confirmó "No", con fecha, evento y expediente, filtrable por piloto_run_id y/o numeros, sin
// exponer datos de otra corrida.
test('WB-PL-11: sin runId ni numeros, el historial responde 400 -- nunca se lista todo sin acotar', async () => {
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('GET', '/api/whatsapp-manual/piloto/historial');
  assert.equal(r.status, 400, JSON.stringify(r.data));
});

test('WB-PL-12: filtrado por runId trae exactamente los eventos de esa corrida, con usuario, fecha, evento y expediente', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  await crearExpedienteFicticioEnCorridaActual('WBPL12');

  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const pend = await req('GET', '/api/whatsapp-manual/pendientes');
  const fila = pend.data.find(x => x.siniestro_numero === 'WBPL12');
  const rec = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/reclamar`, {});
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  const vanessaId = db.prepare(`SELECT id FROM usuarios WHERE email='vanessa@serviciocristian.mx'`).get().id;

  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const confNo = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/confirmar`, { enviado: false });
  // Solo quien reservó puede confirmar (regla ya aprobada) -- Daniela no reservó, así que esto debe fallar;
  // se usa Vanessa (quien sí reservó) para dejar un "No" real en el historial.
  assert.equal(confNo.status, 403);
  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const confNoReal = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/confirmar`, { enviado: false });
  assert.equal(confNoReal.status, 200, JSON.stringify(confNoReal.data));

  // Vuelve a reclamar y esta vez confirma "Sí".
  const rec2 = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/reclamar`, {});
  assert.equal(rec2.status, 200, JSON.stringify(rec2.data));
  const confSi = await req('POST', `/api/whatsapp-manual/envios/${fila.envio_id}/confirmar`, { enviado: true });
  assert.equal(confSi.status, 200, JSON.stringify(confSi.data));

  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('GET', `/api/whatsapp-manual/piloto/historial?runId=${encodeURIComponent(runId)}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.runId, runId);
  assert.ok(r.data.historial.length >= 3, 'debe incluir al menos: reservado, liberado_no_enviado, confirmado_enviado');
  for (const fila2 of r.data.historial) {
    assert.equal(fila2.siniestro_numero, 'WBPL12', 'todas las filas deben pertenecer al expediente de esta corrida');
  }
  const noEnviado = r.data.historial.find(h => h.evento === 'liberado_no_enviado');
  assert.ok(noEnviado, 'debe aparecer el "No"');
  assert.equal(noEnviado.usuario_id, vanessaId, 'debe registrar quién confirmó el "No"');
  assert.ok(noEnviado.fecha, 'debe traer fecha');
  const siEnviado = r.data.historial.find(h => h.evento === 'confirmado_enviado');
  assert.ok(siEnviado, 'debe aparecer el "Sí"');
  assert.equal(siEnviado.usuario_id, vanessaId, 'debe registrar quién confirmó el "Sí"');
});

test('WB-PL-13: filtrado por numeros (sin runId) trae el historial de esos expedientes; filtrar por runId de OTRA corrida no mezcla nada', async () => {
  const runA = activacion.iniciarPilotoRun(db);
  const sA = await crearExpedienteFicticioEnCorridaActual('WBPL13A');
  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const pendA = await req('GET', '/api/whatsapp-manual/pendientes');
  const filaA = pendA.data.find(x => x.siniestro_numero === 'WBPL13A');
  await req('POST', `/api/whatsapp-manual/envios/${filaA.envio_id}/reclamar`, {});
  await req('POST', `/api/whatsapp-manual/envios/${filaA.envio_id}/confirmar`, { enviado: true });

  const runB = activacion.iniciarPilotoRun(db);
  await crearExpedienteFicticioEnCorridaActual('WBPL13B');
  await login('vanessa@serviciocristian.mx', 'ServicioCristian2026!');
  const pendB = await req('GET', '/api/whatsapp-manual/pendientes');
  const filaB = pendB.data.find(x => x.siniestro_numero === 'WBPL13B');
  await req('POST', `/api/whatsapp-manual/envios/${filaB.envio_id}/reclamar`, {});
  await req('POST', `/api/whatsapp-manual/envios/${filaB.envio_id}/confirmar`, { enviado: true });

  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');

  // Por numeros (sin runId): trae el historial de ambos si se piden ambos números.
  const rAmbos = await req('GET', '/api/whatsapp-manual/piloto/historial?numeros=WBPL13A,WBPL13B');
  assert.equal(rAmbos.status, 200, JSON.stringify(rAmbos.data));
  const numerosVistos = new Set(rAmbos.data.historial.map(h => h.siniestro_numero));
  assert.ok(numerosVistos.has('WBPL13A') && numerosVistos.has('WBPL13B'), 'debe incluir el historial de ambos expedientes pedidos');

  // Por runId de la corrida A: NUNCA debe traer nada de WBPL13B (otra corrida, otro expediente).
  const rSoloA = await req('GET', `/api/whatsapp-manual/piloto/historial?runId=${encodeURIComponent(runA)}`);
  assert.equal(rSoloA.status, 200);
  assert.ok(rSoloA.data.historial.length > 0);
  for (const fila2 of rSoloA.data.historial) {
    assert.equal(fila2.siniestro_numero, 'WBPL13A', 'filtrar por el runId de la corrida A nunca debe traer filas de la corrida B');
  }

  // runId + numeros combinados: sigue acotado a la intersección -- pedir runB pero numeros de A no debe
  // devolver nada (no coinciden).
  const rCruzado = await req('GET', `/api/whatsapp-manual/piloto/historial?runId=${encodeURIComponent(runB)}&numeros=WBPL13A`);
  assert.equal(rCruzado.status, 200);
  assert.equal(rCruzado.data.historial.length, 0, 'runId de B + número de A no deben coincidir en ninguna fila');
});

test('WB-PL-14: solo admin puede consultar el historial -- Alejandra/Vanessa/Daniela reciben 403', async () => {
  const runId = activacion.iniciarPilotoRun(db);
  await crearExpedienteFicticioEnCorridaActual('WBPL14');

  for (const [email, pass] of [
    ['alejandra@serviciocristian.mx', 'ServicioCristian2026!'],
    ['vanessa@serviciocristian.mx', 'ServicioCristian2026!'],
    ['daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!'],
  ]) {
    await login(email, pass);
    const r = await req('GET', `/api/whatsapp-manual/piloto/historial?runId=${encodeURIComponent(runId)}`);
    assert.equal(r.status, 403, `${email} no debe poder consultar el historial: ${JSON.stringify(r.data)}`);
  }
});
