// Pruebas del Reporte de arranque del día (4-nov-2026): contenido, formato WhatsApp, ventanilla con clave
// y envío diario por correo (con un envío simulado -- nunca manda correos reales).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-reporte-arranque.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const reporte = require('../server/reporteArranque');

const PORT = 3994;
const BASE = 'http://localhost:' + PORT;
let server;
let cookie = '';

async function req(method, url, body, headers = {}){
  const h = Object.assign({ 'Content-Type':'application/json' }, headers);
  if(cookie) h.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if(sc) cookie = sc.split(';')[0];
  const txt = await res.text();
  let data = txt; try { data = JSON.parse(txt); } catch(e) {}
  return { status: res.status, data };
}
function dias(n){ return new Date(Date.now() + n * 86400000).toISOString().slice(0,10); }

function crearSiniestro(numero, extra = {}){
  const campos = Object.assign({ numero, aseguradora:'GNP', vehiculo:'Versa', placas:'ABC-' + numero.slice(-3),
    estado_autorizacion:'autorizada' }, extra);
  const cols = Object.keys(campos);
  const r = db.prepare(`INSERT INTO siniestros (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>campos[c]));
  return Number(r.lastInsertRowid);
}

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, resolve); });
  // Escenario: una vencida, una que vence mañana, una lista para iniciar y piezas vencidas de un proveedor.
  crearSiniestro('RA-VENCIDA', { fecha_entrega_prevista: dias(-3) });
  crearSiniestro('RA-MANANA', { fecha_entrega_prevista: dias(1), vehiculo:'Aveo' });
  const lista = crearSiniestro('RA-LISTA', { fecha_entrega_prevista: dias(20), vehiculo:'March', requiere_refacciones:'si' });
  const prov = Number(db.prepare(`INSERT INTO proveedores (razon_social) VALUES ('Refacciones Golfo')`).run().lastInsertRowid);
  const pedLista = Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion, estatus_operativo) VALUES ('RA-PED-1', ?, ?, 'Recibido completo')`).run(lista, dias(-10)).lastInsertRowid);
  db.prepare(`INSERT INTO piezas (pedido_id, proveedor_id, descripcion, estatus) VALUES (?, ?, 'Facia', 'Recibida físicamente')`).run(pedLista, prov);
  const conPiezas = crearSiniestro('RA-PIEZAS', { fecha_entrega_prevista: dias(15), requiere_refacciones:'si' });
  const ped = Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion) VALUES ('RA-PED-2', ?, ?)`).run(conPiezas, dias(-10)).lastInsertRowid);
  db.prepare(`INSERT INTO piezas (pedido_id, proveedor_id, descripcion, estatus, fecha_prometida) VALUES (?, ?, 'Faro', 'Confirmada', ?)`).run(ped, prov, dias(-2));
  db.prepare(`INSERT INTO piezas (pedido_id, proveedor_id, descripcion, estatus, fecha_prometida) VALUES (?, ?, 'Calavera', 'Confirmada', ?)`).run(ped, prov, dias(-1));
});
test.after(async () => {
  delete process.env.REPORTE_TOKEN; delete process.env.REPORTE_ARRANQUE_CORREO;
  await new Promise(resolve => server.close(resolve));
});

test('REPORTE-1: separa vencidas, vencen pronto, listas para iniciar y piezas vencidas por proveedor', () => {
  const r = reporte.calcularReporteArranque(db);
  assert.ok(r.vencidas.some(u => u.numero === 'RA-VENCIDA'));
  assert.ok(!r.vencidas.some(u => u.numero === 'RA-MANANA'), 'la que vence mañana no es vencida');
  assert.ok(r.vencen_pronto.some(u => u.numero === 'RA-MANANA'));
  assert.ok(r.listas_para_iniciar.some(u => u.numero === 'RA-LISTA'));
  const golfo = r.piezas_vencidas.find(p => p.proveedor === 'Refacciones Golfo');
  assert.ok(golfo, 'el proveedor con piezas vencidas debe aparecer');
  assert.equal(golfo.piezas, 2);
  assert.equal(golfo.unidades, 1);
});

test('REPORTE-2: el texto viene en formato WhatsApp (negritas con *, sin tablas)', () => {
  const { texto } = reporte.calcularReporteArranque(db);
  assert.match(texto, /^\*🔧 ARRANQUE DEL DÍA – /);
  assert.match(texto, /\*🔴 Vencidas \(\d+\)\*/);
  assert.match(texto, /\*📦 Piezas vencidas \(\d+\)\*\n• Refacciones Golfo: 2 piezas \(1 unidad\)/);
  assert.ok(!texto.includes('|'), 'sin tablas');
});

test('REPORTE-3: la ruta del tablero exige sesión', async () => {
  cookie = '';
  const sin = await req('GET', '/api/reportes/arranque-dia');
  assert.equal(sin.status, 401);
  await req('POST', '/api/auth/login', { email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' });
  const con = await req('GET', '/api/reportes/arranque-dia');
  assert.equal(con.status, 200);
  assert.equal(typeof con.data.texto, 'string');
});

test('REPORTE-4: la ventanilla externa está apagada sin REPORTE_TOKEN y rechaza claves incorrectas', async () => {
  cookie = '';
  delete process.env.REPORTE_TOKEN;
  assert.equal((await req('GET', '/api/externo/reporte-arranque', null, { Authorization:'Bearer x' })).status, 503);
  process.env.REPORTE_TOKEN = 'clave-de-prueba-larga-123';
  assert.equal((await req('GET', '/api/externo/reporte-arranque')).status, 401);
  assert.equal((await req('GET', '/api/externo/reporte-arranque', null, { Authorization:'Bearer otra' })).status, 401);
  const ok = await req('GET', '/api/externo/reporte-arranque?formato=texto', null, { Authorization:'Bearer clave-de-prueba-larga-123' });
  assert.equal(ok.status, 200);
  assert.match(ok.data, /ARRANQUE DEL DÍA/);
});

test('REPORTE-5: el correo diario sale una sola vez, solo entre 7:30 y 12:00 (hora de México)', async () => {
  process.env.REPORTE_ARRANQUE_CORREO = 'roberto@example.com';
  const enviados = [];
  const enviar = async (m) => { enviados.push(m); };
  // 4-nov-2026 13:00 UTC = 7:00 a.m. en Ciudad de México -> todavía no.
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora: new Date('2026-11-04T13:00:00Z'), enviar })).motivo, 'fuera_de_horario');
  // 13:35 UTC = 7:35 a.m. -> se envía.
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora: new Date('2026-11-04T13:35:00Z'), enviar })).enviado, true);
  // Mismo día otra vez -> no duplica.
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora: new Date('2026-11-04T14:00:00Z'), enviar })).motivo, 'ya_enviado');
  // 19:00 UTC = 1:00 p.m. del día siguiente -> ya pasó el límite.
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora: new Date('2026-11-05T19:00:00Z'), enviar })).motivo, 'fuera_de_horario');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'roberto@example.com');
  assert.match(enviados[0].text, /reporte-dia\.html/);
});

test('REPORTE-6: si el correo falla, se reintenta en la siguiente revisión del mismo día', async () => {
  process.env.REPORTE_ARRANQUE_CORREO = 'roberto@example.com';
  let intentos = 0;
  const falla = async () => { intentos++; throw new Error('Gmail rechazó'); };
  const ahora = new Date('2026-11-06T13:40:00Z');
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora, enviar: falla })).motivo, 'error');
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora, enviar: async()=>{} })).enviado, true);
  assert.equal(intentos, 1);
});
