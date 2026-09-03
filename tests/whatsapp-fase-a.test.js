// Pruebas del modo "solo registro" de WhatsApp Fase A (autorizado por Roberto, 3-sep-2026).
// Cubren: detección por plantilla, deduplicación, bloqueo por incidencia delicada, cálculo de
// horario hábil / continuidad de 72h (pruebas directas y deterministas de las funciones puras),
// resolución de expediente por teléfono (único vs. ambiguo), y una prueba de regresión que confirma
// que este módulo JAMÁS hace una llamada real a un servicio externo de WhatsApp/Meta.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-whatsapp-fase-a.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const PORT = 3998;
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

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, resolve); });
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

async function eventosDe(siniestroId){
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('GET', `/api/whatsapp-fase-a/eventos?siniestro_id=${siniestroId}`);
  assert.equal(r.status, 200);
  return r.data;
}

// ===================== 1) Detección en la creación (5.1 Bienvenida) =====================
test('WA-1: al crear un expediente con teléfono, se registra 5.1 (solo registro, no envía nada)', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s = (await req('POST', '/api/siniestros', { numero:'WA1-TEST', aseguradora:'GNP', cliente_nombre:'Cliente Uno', cliente_telefono:'5510000001', cliente_correo:'uno@test.mx' })).data;
  const eventos = await eventosDe(s.id);
  const e51 = eventos.find(e => e.plantilla_codigo === '5.1');
  assert.ok(e51, 'debe existir un evento 5.1 registrado');
  assert.equal(e51.estado, 'registrado');
  const vars = JSON.parse(e51.variables_json);
  assert.equal(vars.nombre, 'Cliente Uno');
});

test('WA-2: un expediente sin teléfono NO registra 5.1', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s = (await req('POST', '/api/siniestros', { numero:'WA2-TEST', aseguradora:'GNP' })).data;
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.find(e => e.plantilla_codigo === '5.1'), undefined);
});

// ===================== 2) Autorizado con piezas (5.3) vs sin piezas en piso (5.6) =====================
test('WA-3: autorización con piezas a cambio registra 5.3 (no 5.6 ni 5.7)', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s = (await req('POST', '/api/siniestros', { numero:'WA3-TEST', aseguradora:'GNP', cliente_nombre:'Cliente Tres', cliente_telefono:'5510000003', cliente_correo:'tres@test.mx' })).data;
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('PATCH', `/api/siniestros/${s.id}`, {
    estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'Ajustador X', piezas_autorizadas_cambio:2
  });
  assert.equal(r.status, 200);
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.3' && e.estado === 'registrado'), 'debe registrar 5.3');
  assert.equal(eventos.find(e => e.plantilla_codigo === '5.6'), undefined);
  assert.equal(eventos.find(e => e.plantilla_codigo === '5.7'), undefined);
});

test('WA-4: autorización SIN piezas a cambio registra 5.6 (unidad en piso por default, sin hito de reingreso)', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s = (await req('POST', '/api/siniestros', { numero:'WA4-TEST', aseguradora:'GNP', cliente_nombre:'Cliente Cuatro', cliente_telefono:'5510000004', cliente_correo:'cuatro@test.mx' })).data;
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, {
    estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'Ajustador X', piezas_autorizadas_cambio:0
  });
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e => e.plantilla_codigo === '5.6' && e.estado === 'registrado'), 'debe registrar 5.6');
  assert.equal(eventos.find(e => e.plantilla_codigo === '5.3'), undefined);
});

// ===================== 3) Deduplicación =====================
test('WA-5: repetir el mismo PATCH sin cambio real de estado NO duplica el evento', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s = (await req('POST', '/api/siniestros', { numero:'WA5-TEST', aseguradora:'GNP', cliente_nombre:'Cliente Cinco', cliente_telefono:'5510000005', cliente_correo:'cinco@test.mx' })).data;
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'Ajustador X', piezas_autorizadas_cambio:0 });
  // segundo PATCH: ya estaba 'autorizada', no es una transición nueva -> no debe registrar otra vez
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-03', autorizador:'Ajustador X', piezas_autorizadas_cambio:0, notas:'tocar otro campo' });
  const eventos = (await eventosDe(s.id)).filter(e => e.plantilla_codigo === '5.6');
  assert.equal(eventos.length, 1, 'no debe duplicarse el evento 5.6');
});

// ===================== 4) Bloqueo por incidencia delicada =====================
test('WA-6: con una incidencia delicada activa, el evento se registra como bloqueado (no se "envía")', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s = (await req('POST', '/api/siniestros', { numero:'WA6-TEST', aseguradora:'GNP', cliente_nombre:'Cliente Seis', cliente_telefono:'5510000006', cliente_correo:'seis@test.mx' })).data;
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const p = (await req('POST', '/api/pedidos', { numero:'WA6-PED', siniestro_id:s.id, fecha_prevista:'2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id:p.id, descripcion:'Cofre' })).data;
  await req('POST', `/api/incidencias`, { pieza_id:z.id, tipo:'danada', descripcion:'Llegó dañada' });
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'en_laminado' });
  const eventos = await eventosDe(s.id);
  const e58 = eventos.find(e => e.plantilla_codigo === '5.8');
  assert.ok(e58, 'debe existir el intento de registro de 5.8');
  assert.equal(e58.estado, 'bloqueado');
  assert.ok(e58.motivo_bloqueo && e58.motivo_bloqueo.includes('incidencia delicada'), 'el motivo debe explicar el bloqueo');
});

// ===================== 5) Hojalatería / Pintura / Calidad =====================
test('WA-7: transición a hojalatería y pintura registra 5.8 y 5.9 una sola vez cada una', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s = (await req('POST', '/api/siniestros', { numero:'WA7-TEST', aseguradora:'GNP', cliente_nombre:'Cliente Siete', cliente_telefono:'5510000007', cliente_correo:'siete@test.mx' })).data;
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'en_laminado' });
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'preparacion' });
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'pintura' });
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_produccion:'pintura', notas:'sin cambio de etapa' });
  const eventos = await eventosDe(s.id);
  assert.equal(eventos.filter(e=>e.plantilla_codigo==='5.8').length, 1);
  assert.equal(eventos.filter(e=>e.plantilla_codigo==='5.9').length, 1);
});

test('WA-8: calidad en inspección y liberada registran 5.10 y 5.11', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s = (await req('POST', '/api/siniestros', { numero:'WA8-TEST', aseguradora:'GNP', cliente_nombre:'Cliente Ocho', cliente_telefono:'5510000008', cliente_correo:'ocho@test.mx' })).data;
  await login('orlando@serviciocristian.mx', 'ServicioCristian2026!');
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_calidad:'en_inspeccion' });
  await req('PATCH', `/api/siniestros/${s.id}`, { estado_calidad:'liberado' });
  const eventos = await eventosDe(s.id);
  assert.ok(eventos.find(e=>e.plantilla_codigo==='5.10'));
  assert.ok(eventos.find(e=>e.plantilla_codigo==='5.11'));
});

// ===================== 6) Resolución de expediente por teléfono =====================
test('WA-9: teléfono con un solo siniestro activo se resuelve automático; con varios, queda ambiguo', async () => {
  const whatsappFaseA = require('../server/whatsappFaseA');
  const db = require('../server/db');
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  const s1 = (await req('POST', '/api/siniestros', { numero:'WA9-A', aseguradora:'GNP', cliente_nombre:'Nueve A', cliente_telefono:'5519990001', cliente_correo:'nuevea@test.mx' })).data;
  let r1 = whatsappFaseA.resolverExpedientePorTelefono(db, '5519990001');
  assert.equal(r1.resultado, 'resuelto_automatico');
  assert.equal(r1.siniestro.id, s1.id);

  const s2 = (await req('POST', '/api/siniestros', { numero:'WA9-B', aseguradora:'GNP', cliente_nombre:'Nueve B', cliente_telefono:'5519990002', cliente_correo:'nueveb@test.mx' })).data;
  const s3 = (await req('POST', '/api/siniestros', { numero:'WA9-C', aseguradora:'GNP', cliente_nombre:'Nueve C', cliente_telefono:'5519990002', cliente_correo:'nuevec@test.mx' })).data;
  let r2 = whatsappFaseA.resolverExpedientePorTelefono(db, '5519990002');
  assert.equal(r2.resultado, 'ambiguo_pendiente_asignacion');
  assert.equal(r2.candidatos.length, 2);
  assert.equal(r2.siniestro, null, 'no debe asignar arbitrariamente cuando hay varios');

  let r3 = whatsappFaseA.resolverExpedientePorTelefono(db, '0000000000');
  assert.equal(r3.resultado, 'sin_expediente_activo');
});

// ===================== 7) Horario hábil y continuidad de 72h (funciones puras, deterministas) =====================
test('WA-10: esHorarioHabil respeta L-V 9-18, Sáb 9-14, domingo cerrado', () => {
  const whatsappFaseA = require('../server/whatsappFaseA');
  const dayjs = require('dayjs');
  const utc = require('dayjs/plugin/utc'); const timezone = require('dayjs/plugin/timezone');
  dayjs.extend(utc); dayjs.extend(timezone);
  const TZ = 'America/Mexico_City';
  // 2026-09-03 es jueves.
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-03 10:00', TZ)), true, 'jueves 10:00 es hábil');
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-03 20:00', TZ)), false, 'jueves 20:00 NO es hábil');
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-05 13:00', TZ)), true, 'sábado 13:00 es hábil');
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-05 15:00', TZ)), false, 'sábado 15:00 ya NO es hábil (cierra 14:00)');
  assert.equal(whatsappFaseA.esHorarioHabil(dayjs.tz('2026-09-06 12:00', TZ)), false, 'domingo cerrado');
});

test('WA-11: horasHabilesTranscurridas cuenta solo horas hábiles entre dos fechas', () => {
  const whatsappFaseA = require('../server/whatsappFaseA');
  // 2026-09-03 (jueves) 10:00 CDMX -> 2026-09-07 (lunes) 10:00 CDMX, en UTC (CDMX = UTC-6, sin DST).
  const desde = '2026-09-03 16:00:00'; // jueves 10:00 local
  const hasta = '2026-09-07 16:00:00'; // lunes 10:00 local
  // Jueves 10-18 = 8h, viernes 9-18 = 9h, sábado 9-14 = 5h, domingo = 0h, lunes 9-10 = 1h => 23h
  const horas = whatsappFaseA.horasHabilesTranscurridas(desde, hasta);
  assert.equal(horas, 23, `se esperaban 23 horas hábiles, se calcularon ${horas}`);
});

// ===================== 8) Regresión de seguridad: nunca una llamada real a WhatsApp/Meta =====================
test('WA-12: el módulo de "solo registro" no contiene ninguna llamada real a un servicio externo de WhatsApp/Meta', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'whatsappFaseA.js'), 'utf-8');
  assert.ok(!/fetch\s*\(/.test(src), 'no debe haber ningún fetch() en el módulo');
  assert.ok(!/require\(['"]axios['"]\)|axios\s*\./i.test(src), 'no debe usarse axios (solo se permite mencionarlo en comentarios explicando que NO se usa)');
  assert.ok(!/graph\.facebook\.com|whatsapp\.com|meta\.com/i.test(src), 'no debe referenciar ningún dominio real de Meta/WhatsApp');
  assert.ok(!/require\(['"]https?['"]\)/.test(src), 'no debe requerir el módulo http/https para llamadas salientes');
});

test('WA-13: el módulo de "solo registro" nunca escribe en tablas del módulo de Daniela (pedidos/piezas/proveedores/comunicaciones)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'whatsappFaseA.js'), 'utf-8');
  assert.ok(!/UPDATE\s+pedidos/i.test(src));
  assert.ok(!/UPDATE\s+piezas/i.test(src));
  assert.ok(!/INSERT\s+INTO\s+comunicaciones/i.test(src));
  assert.ok(!/UPDATE\s+proveedores/i.test(src));
});
