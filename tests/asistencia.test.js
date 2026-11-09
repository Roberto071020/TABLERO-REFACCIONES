// Registro de entrada del personal (9-nov-2026): ubicación dentro del taller + foto en el momento.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-asistencia.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'asistencia-'));

const app = require('../server/index');
const db = require('../server/db');
const A = require('../server/asistencia');
const PORT = 3983;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const PASS = 'ServicioCristian2026!';
async function login(email){ cookie = ''; assert.equal((await req('POST', '/api/auth/login', { email, password: PASS })).status, 200); }
const TALLER = { lat: 19.1738, lng: -96.1342 };
const FOTO = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(4000, 7)]).toString('base64');
const cerca = { lat: TALLER.lat + 0.0003, lng: TALLER.lng, precision: 15 };   // ~33 m
const lejos = { lat: TALLER.lat + 0.03, lng: TALLER.lng, precision: 15 };     // ~3.3 km

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { await new Promise(r => server.close(r)); });

test('ASIS-1: mientras Roberto no marque el taller, nadie queda bloqueado', async () => {
  await login('alejandra@serviciocristian.mx');
  const e = await req('GET', '/api/asistencia/estado');
  assert.equal(e.status, 200); assert.equal(e.data.requiere, false); assert.equal(e.data.taller_configurado, false);
});

test('ASIS-2: solo Roberto marca la ubicación del taller', async () => {
  await login('alejandra@serviciocristian.mx');
  assert.equal((await req('POST', '/api/asistencia/taller', TALLER)).status, 403);
  await login('admin@serviciocristian.mx');
  assert.equal((await req('POST', '/api/asistencia/taller', { ...TALLER, precision: 12 })).status, 200);
  assert.deepEqual({ lat: A.leerTaller(db).lat, lng: A.leerTaller(db).lng }, TALLER);
  const e = await req('GET', '/api/asistencia/estado');
  assert.equal(e.data.requiere, false, 'el propietario no registra entrada');
});

test('ASIS-3: desde fuera del taller, sin foto o con ubicación imprecisa se rechaza (y queda constancia)', async () => {
  await login('orlando@serviciocristian.mx');
  assert.equal((await req('GET', '/api/asistencia/estado')).data.requiere, true);
  const r1 = await req('POST', '/api/asistencia/entrada', { ...lejos, foto: FOTO });
  assert.equal(r1.status, 400); assert.match(r1.data.error, /km del taller/);
  assert.equal((await req('POST', '/api/asistencia/entrada', { ...cerca })).status, 400);
  assert.equal((await req('POST', '/api/asistencia/entrada', { ...cerca, precision: 900, foto: FOTO })).status, 400);
  assert.equal((await req('POST', '/api/asistencia/entrada', { ...cerca, foto: 'data:image/jpeg;base64,AAAA' })).status, 400);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM asistencia`).get().n, 0);
  assert.ok(db.prepare(`SELECT 1 FROM auditoria WHERE entidad_tipo='asistencia' AND accion='entrada_rechazada' AND usuario_nombre='Orlando' AND campo='distancia_m'`).get());
});

test('ASIS-4: dentro del taller y con foto queda registrada una sola vez, con hora del servidor', async () => {
  await login('orlando@serviciocristian.mx');
  const r = await req('POST', '/api/asistencia/entrada', { ...cerca, foto: FOTO });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.hora, A.ahoraMX().hora);
  assert.equal(r.data.retardo, A.esRetardo(r.data.hora));
  const r2 = await req('POST', '/api/asistencia/entrada', { ...cerca, foto: FOTO });
  assert.equal(r2.data.ya_registrado, true);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM asistencia`).get().n, 1);
  const e = await req('GET', '/api/asistencia/estado');
  assert.equal(e.data.registrado, true);
});

test('ASIS-5: Roberto ve quién llegó, a qué hora y la foto; los demás no ven fotos ajenas', async () => {
  await login('admin@serviciocristian.mx');
  const h = await req('GET', '/api/asistencia/hoy');
  assert.equal(h.status, 200);
  const nombres = h.data.personas.map(p => p.nombre);
  assert.ok(!nombres.includes('Roberto'), 'el propietario no aparece');
  for(const n of ['Alejandra', 'Beto', 'Orlando', 'Daniela Sosa']) assert.ok(nombres.includes(n), n);
  const dani = h.data.personas.find(p => p.nombre === 'Orlando');
  assert.ok(dani.hora && dani.registro_id); assert.equal(h.data.personas[0].nombre, 'Orlando', 'los registrados van primero');
  assert.equal(h.data.personas.find(p => p.nombre === 'Alejandra').hora, null);
  const foto = await fetch(`http://localhost:${PORT}/api/asistencia/${dani.registro_id}/foto`, { headers: { Cookie: cookie } });
  assert.equal(foto.status, 200); assert.equal(foto.headers.get('content-type'), 'image/jpeg');
  await login('alejandra@serviciocristian.mx');
  assert.equal((await req('GET', `/api/asistencia/${dani.registro_id}/foto`)).status, 403);
  assert.equal((await req('GET', '/api/asistencia/hoy')).status, 403);
});

test('ASIS-6: retardo después de las 9:00', () => {
  assert.equal(A.esRetardo('08:59'), false);
  assert.equal(A.esRetardo('09:00'), false);
  assert.equal(A.esRetardo('09:01'), true);
});
