// "Ya llegó" desde la pantalla de Beto (10-nov-2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-llegada.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const { calcularPanoramaBeto } = require('../server/panoramaBeto');
const PORT = 3978;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { await new Promise(r => server.close(r)); });

test('LLEGA-1: Beto marca "Ya llegó" y la unidad pasa a piso, lista para iniciarse', async () => {
  const id = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, ubicacion, estado_autorizacion, estado_produccion, requiere_refacciones, cita_fecha)
    VALUES ('LL-001','Mapfre','Honda City','Tránsito','autorizada','programado','no','2026-01-02')`).run().lastInsertRowid);
  let u = calcularPanoramaBeto(db).find(x => x.id === id);
  assert.ok(u.reingreso_citado || u.en_transito);
  cookie = ''; assert.equal((await req('POST', '/api/auth/login', { email:'beto@serviciocristian.mx', password:'ServicioCristian2026!' })).status, 200);
  const r = await req('POST', '/api/llegada/' + id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = db.prepare('SELECT * FROM siniestros WHERE id=?').get(id);
  assert.equal(s.ubicacion, 'Piso'); assert.ok(s.reingreso_recibido_en);
  u = calcularPanoramaBeto(db).find(x => x.id === id);
  assert.ok(!u.reingreso_citado && !u.en_transito, JSON.stringify(u));
  assert.ok(db.prepare(`SELECT 1 FROM auditoria WHERE entidad_id=? AND accion='llegada_patio' AND usuario_nombre='Beto'`).get(id));
});

test('LLEGA-2: Daniela no puede marcar llegadas', async () => {
  cookie = ''; assert.equal((await req('POST', '/api/auth/login', { email:'daniela@serviciocristian.mx', password:'ServicioCristian2026-Reset!' })).status, 200);
  assert.equal((await req('POST', '/api/llegada/1')).status, 403);
});
