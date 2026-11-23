// 23-nov-2026. Roberto: "Adrián de refacciones ya no trabaja con nosotros" -> dar de baja desde Entradas de hoy.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-baja-usuario.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const bcrypt = require('bcryptjs');

const PORT = 3993, BASE = 'http://localhost:' + PORT;
let server;
function cliente(){
  let cookie = '';
  return async (method, url, body) => {
    const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
    const r = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
    const t = await r.text(); let d = t; try{ d = JSON.parse(t); }catch(e){}
    return { status: r.status, data: d };
  };
}
test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(() => { server.close(); });

test('Roberto da de baja a alguien: no puede entrar y su sesión abierta se cierra', async () => {
  db.prepare(`UPDATE usuarios SET password_hash = ? WHERE email = 'adrian.beiza'`).run(bcrypt.hashSync('Prueba123!', 4));
  const adrian = db.prepare(`SELECT id FROM usuarios WHERE email = 'adrian.beiza'`).get();
  const tec = cliente();
  assert.equal((await tec('POST', '/api/auth/login', { email:'adrian.beiza', password:'Prueba123!' })).status, 200);
  assert.equal((await tec('GET', '/api/auth/me')).status, 200);

  const rob = cliente();
  assert.equal((await rob('POST', '/api/auth/login', { email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' })).status, 200);
  const r = await rob('POST', `/api/auth/usuarios/${adrian.id}/baja`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT activo FROM usuarios WHERE id = ?').get(adrian.id).activo, 0);
  assert.ok(db.prepare(`SELECT 1 FROM auditoria WHERE entidad_tipo='usuario' AND entidad_id=? AND accion='baja'`).get(adrian.id));

  assert.equal((await tec('GET', '/api/asistencia/estado')).status, 401, 'su sesión abierta se cierra');
  assert.equal((await cliente()('POST', '/api/auth/login', { email:'adrian.beiza', password:'Prueba123!' })).status, 401);
});

test('no se puede dar de baja a uno mismo ni sin ser admin', async () => {
  const rob = cliente();
  await rob('POST', '/api/auth/login', { email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' });
  const yo = db.prepare(`SELECT id FROM usuarios WHERE email='admin@serviciocristian.mx'`).get();
  assert.equal((await rob('POST', `/api/auth/usuarios/${yo.id}/baja`)).status, 400);
  const ale = cliente();
  await ale('POST', '/api/auth/login', { email:'alejandra@serviciocristian.mx', password:'ServicioCristian2026!' });
  const marco = db.prepare(`SELECT id FROM usuarios WHERE email='marco.cobos'`).get();
  assert.equal((await ale('POST', `/api/auth/usuarios/${marco.id}/baja`)).status, 403);
});
