// Personal de patio (9-nov-2026): usuario propio, por ahora solo registra su entrada.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-patio.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const PORT = 3980;
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

test('PATIO-1: los 13 (patio y auxiliar de refacciones) quedan dados de alta con su puesto, sin duplicarse', () => {
  const t = db.prepare(`SELECT nombre, email, puesto FROM usuarios WHERE rol = 'tecnico' ORDER BY email`).all();
  assert.equal(t.length, 13);
  assert.ok(t.find(x => x.email === 'marco.cobos' && x.puesto === 'Pintor' && x.nombre === 'Marco Cobos'));
  assert.ok(t.find(x => x.email === 'jesus.palomares' && x.puesto === 'Mecánico'));
  // Los usuarios de oficina siguen ahí.
  assert.ok(db.prepare(`SELECT 1 FROM usuarios WHERE email='admin@serviciocristian.mx' AND rol='admin'`).get());
});

test('PATIO-2: entra con su usuario corto y solo puede ver su registro de entrada', async () => {
  db.prepare(`UPDATE usuarios SET password_hash = ? WHERE email = 'marco.cobos'`).run(bcrypt.hashSync('prueba1234', 4));
  const l = await req('POST', '/api/auth/login', { email:'Marco.Cobos ', password:'prueba1234' });
  assert.equal(l.status, 200); assert.equal(l.data.user.rol, 'tecnico');
  assert.equal((await req('GET', '/api/asistencia/estado')).status, 200);
  for(const url of ['/api/siniestros', '/api/inicio-roberto', '/api/reportes/resumen', '/api/asistencia/hoy', '/api/whatsapp-manual/resumen']){
    assert.equal((await req('GET', url)).status, 403, url);
  }
  assert.equal((await req('GET', '/api/auth/me')).status, 200);
});

test('PATIO-3: Roberto los ve en "Entradas de hoy" con su puesto', async () => {
  cookie = '';
  assert.equal((await req('POST', '/api/auth/login', { email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' })).status, 200);
  const h = await req('GET', '/api/asistencia/hoy');
  assert.equal(h.status, 200);
  const m = h.data.personas.find(p => p.nombre === 'Marco Cobos');
  assert.ok(m); assert.equal(m.puesto, 'Pintor');
});
