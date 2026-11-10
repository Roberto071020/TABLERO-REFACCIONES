// Unidades detenidas (10-nov-2026): motivo obligatorio y aviso a quien le toca destrabarla.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-detenidas.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const PORT = 3979;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const login = async (email, password = 'ServicioCristian2026!') => { cookie = ''; assert.equal((await req('POST', '/api/auth/login', { email, password })).status, 200); };
let id;

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  id = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, ubicacion, estado_autorizacion, estado_produccion)
    VALUES ('DET-001','Mapfre','BMW X1 2018 Blanco','RRP141A','Piso','autorizada','programado')`).run().lastInsertRowid);
});
test.after(async () => { await new Promise(r => server.close(r)); });

test('DET-1: marcar Detenido exige el motivo ("Otro" exige nota)', async () => {
  await login('beto@serviciocristian.mx');
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'detenido' })).status, 400);
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'detenido', detenido_motivo:'otro' })).status, 400);
  const r = await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'detenido', detenido_motivo:'falta_pieza', detenido_nota:'Faro derecho' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = db.prepare('SELECT * FROM siniestros WHERE id=?').get(id);
  assert.equal(s.detenido_motivo, 'falta_pieza'); assert.equal(s.detenido_nota, 'Faro derecho'); assert.ok(s.detenido_desde);
});

test('DET-2: le aparece a Daniela (no a Orlando), en las alertas de Roberto y en el corte de las 3', async () => {
  await login('daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const d = await req('GET', '/api/detenidas');
  assert.equal(d.data.detenidas.length, 1); assert.equal(d.data.detenidas[0].quien, 'Daniela');
  await login('orlando@serviciocristian.mx');
  assert.equal((await req('GET', '/api/detenidas')).data.detenidas.length, 0);
  await login('admin@serviciocristian.mx');
  const ini = await req('GET', '/api/inicio-roberto');
  const a = ini.data.alertas.find(x => x.clave === 'detenidas');
  assert.ok(a && /Falta pieza/.test(a.items[0].detalle) && /Daniela/.test(a.items[0].detalle), JSON.stringify(ini.data.alertas));
  const corte = require('../server/corteTarde').calcularCorteTarde(db);
  assert.ok(corte.personas.find(p => p.nombre === 'Daniela').renglones.some(r => /detenida esperando pieza/.test(r) && /BMW X1/.test(r)));
});

test('DET-3: al reanudarla se limpia el motivo y queda en la auditoría', async () => {
  await login('beto@serviciocristian.mx');
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'en_laminado' })).status, 200);
  const s = db.prepare('SELECT * FROM siniestros WHERE id=?').get(id);
  assert.equal(s.detenido_motivo, null); assert.equal(s.detenido_desde, null);
  assert.ok(db.prepare(`SELECT 1 FROM auditoria WHERE entidad_id=? AND accion='detenida_resuelta'`).get(id));
  assert.equal(require('../server/detenidas').listarDetenidas(db).length, 0);
});

test('DET-4: una detenida sin motivo (p. ej. de la plantilla) le toca a Beto', () => {
  db.prepare(`UPDATE siniestros SET estado_produccion='detenido' WHERE id=?`).run(id);
  const l = require('../server/detenidas').listarDetenidas(db);
  assert.equal(l[0].quien, 'Beto'); assert.equal(l[0].motivo_etiqueta, 'Sin motivo registrado');
});
