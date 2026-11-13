// 13-nov-2026 (Roberto): el auxiliar de refacciones ve si la unidad está en piso o tránsito y puede marcar
// "🚫 No ha llegado" cuando el proveedor dio la pieza por entregada antes de tiempo.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-revision-no-llego.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const { calcularInicioDaniela } = require('../server/inicioDaniela');
const PORT = 3993;
let server; let cookie = '';
async function req(method, url, body){
  const h = {}; if(cookie) h.Cookie = cookie;
  if(body){ h['Content-Type'] = 'application/json'; }
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const hoy = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
let SID, STR, ENTREGADA, TRANSITO;

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  db.prepare(`UPDATE usuarios SET password_hash = ? WHERE email = 'adrian.beiza'`).run(bcrypt.hashSync('prueba1234', 4));
  SID = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, ubicacion) VALUES ('NL-1','Mapfre','Sonic 2014','YEZ702B','Piso')`).run().lastInsertRowid);
  STR = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, ubicacion) VALUES ('NL-2','Mapfre','Versa 2019','J02BWW','Tránsito')`).run().lastInsertRowid);
  const p1 = Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion, estatus_operativo) VALUES ('PNL-1', ?, ?, 'Esperando proveedor')`).run(SID, hoy).lastInsertRowid);
  const p2 = Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion, estatus_operativo) VALUES ('PNL-2', ?, ?, 'Esperando proveedor')`).run(STR, hoy).lastInsertRowid);
  ENTREGADA = Number(db.prepare(`INSERT INTO piezas (pedido_id, descripcion, estatus) VALUES (?, 'Faro derecho', 'Entregada por proveedor')`).run(p1).lastInsertRowid);
  TRANSITO = Number(db.prepare(`INSERT INTO piezas (pedido_id, descripcion, estatus) VALUES (?, 'Tolva escape', 'Confirmada')`).run(p2).lastInsertRowid);
  assert.equal((await req('POST', '/api/auth/login', { email:'adrian.beiza', password:'prueba1234' })).status, 200);
});
test.after(async () => { await new Promise(r => server.close(r)); });

test('NL-1: cada unidad trae si está en piso o en tránsito', async () => {
  const r = await req('GET', '/api/revision-piezas');
  assert.equal(r.data.unidades.find(u => u.siniestro_id === SID).ubicacion, 'Piso');
  assert.equal(r.data.unidades.find(u => u.siniestro_id === STR).ubicacion, 'Tránsito');
});

test('NL-2: "No ha llegado" solo si el proveedor la dio por entregada; crea la discrepancia y Daniela la ve', async () => {
  assert.equal((await req('POST', `/api/revision-piezas/${TRANSITO}/no-llego`)).status, 400);
  const r = await req('POST', `/api/revision-piezas/${ENTREGADA}/no-llego`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = db.prepare('SELECT * FROM discrepancias_proveedor WHERE id = ?').get(r.data.discrepancia_id);
  assert.equal(d.no_llego, 1); assert.equal(d.estado, 'abierta'); assert.equal(d.pieza_id, ENTREGADA);
  assert.equal((await req('POST', `/api/revision-piezas/${ENTREGADA}/no-llego`)).status, 400, 'no se duplica');
  const z = (await req('GET', '/api/revision-piezas')).data.unidades.find(u => u.siniestro_id === SID).piezas.find(x => x.id === ENTREGADA);
  assert.equal(z.no_llego, true);
  const dan = calcularInicioDaniela(db);
  assert.equal(dan.recibir.find(g => g.siniestro_id === SID).piezas.find(x => x.id === ENTREGADA).no_llego, true);
  assert.ok(dan.revisa.discrepancias >= 1);
});

test('NL-3: cuando llega y se marca "Llegó bien", la discrepancia se cierra con la fecha real', async () => {
  assert.equal((await req('POST', `/api/revision-piezas/${ENTREGADA}/bien`)).status, 200);
  const d = db.prepare('SELECT * FROM discrepancias_proveedor WHERE pieza_id = ?').get(ENTREGADA);
  assert.equal(d.estado, 'resuelta'); assert.equal(d.fecha_real_llegada, hoy);
});
