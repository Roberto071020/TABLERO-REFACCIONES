// 27-nov-2026 (Roberto: "¿Podríamos agregar algunos fondos o temas?"): tema y tamaño de letra por persona; el personal
// de patio no personaliza.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-mi-pantalla-27nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const bcrypt = require('bcryptjs');

const PORT = 3973;
let server; const ses = {};
async function req(q, method, url, body){
  const h = { 'Content-Type':'application/json' }; if(ses[q]) h.Cookie = ses[q];
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) ses[q] = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)').run('Pintor Prueba', 'pintor-mp@test.mx', bcrypt.hashSync('Clave123', 4), 'tecnico');
  for(const [q, e, p] of [['ale','alejandra@serviciocristian.mx','ServicioCristian2026!'], ['orl','orlando@serviciocristian.mx','ServicioCristian2026!'], ['tec','pintor-mp@test.mx','Clave123']])
    assert.equal((await req(q, 'POST', '/api/auth/login', { email:e, password:p })).status, 200, e);
});
test.after(() => server.close());

test('MP-1: por default claro/normal y sin elegir; se guarda por persona', async () => {
  assert.deepEqual((await req('ale', 'GET', '/api/mi-pantalla')).data, { tema:'claro', letra:'normal', elegida:false });
  const r = await req('ale', 'PATCH', '/api/mi-pantalla', { tema:'cristian' });
  assert.equal(r.status, 200); assert.deepEqual(r.data, { tema:'cristian', letra:'normal', elegida:true });
  assert.equal((await req('ale', 'PATCH', '/api/mi-pantalla', { letra:'grande' })).data.tema, 'cristian', 'conserva el tema');
  assert.equal((await req('orl', 'GET', '/api/mi-pantalla')).data.tema, 'claro', 'cada quien el suyo');
});

test('MP-2: "Ahora no" solo marca que ya se le ofreció; valores raros se rechazan; patio no personaliza', async () => {
  assert.deepEqual((await req('orl', 'PATCH', '/api/mi-pantalla', {})).data, { tema:'claro', letra:'normal', elegida:true });
  assert.equal((await req('orl', 'PATCH', '/api/mi-pantalla', { tema:'neon' })).status, 400);
  assert.equal((await req('orl', 'PATCH', '/api/mi-pantalla', { letra:'gigante' })).status, 400);
  assert.equal((await req('tec', 'PATCH', '/api/mi-pantalla', { tema:'oscuro' })).status, 403);
});
