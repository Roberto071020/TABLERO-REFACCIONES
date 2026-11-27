// 27-nov-2026 (Roberto): PT y "No reparar" que siguen en piso aparecen "por retirar del taller" hasta que alguien marca
// "Ya se retiró"; en rojo desde 3 días.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-por-retirar-27nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');

const PORT = 3972;
let server; const ses = {};
async function req(q, method, url, body){
  const h = { 'Content-Type':'application/json' }; if(ses[q]) h.Cookie = ses[q];
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) ses[q] = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const sin = (numero, extra) => {
  const c = Object.assign({ numero, aseguradora:'Inbursa', vehiculo:'Spark ' + numero, placas:'P-' + numero, ubicacion:'Piso', archivado:1 }, extra);
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
};

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  for(const [q, e, p] of [['ale','alejandra@serviciocristian.mx','ServicioCristian2026!'], ['orl','orlando@serviciocristian.mx','ServicioCristian2026!'],
    ['dan','daniela@serviciocristian.mx','ServicioCristian2026-Reset!']])
    assert.equal((await req(q, 'POST', '/api/auth/login', { email:e, password:p })).status, 200, e);
});
test.after(() => server.close());

test('RET-1: PT y "No reparar" en piso aparecen; en tránsito, entregadas o abiertas no', async () => {
  const pt = sin('PT-1', { estatus_general:'Pérdida total', archivado_en:"2026-11-11 18:00:00" });
  const nr = sin('NR-1', { estatus_general:'No reparar', no_reparar_en: new Date().toISOString().replace('T',' ').slice(0,19), no_reparar_motivo:'No va a reparar' });
  sin('NR-2', { estatus_general:'No reparar', ubicacion:'Tránsito' });
  sin('PT-2', { estatus_general:'Pérdida total', fecha_entrega_real:'2026-09-22' });
  sin('AB-1', { estatus_general:'Abierto', archivado:0 });
  const r = await req('ale', 'GET', '/api/retiros');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.unidades.map(u => u.numero), ['PT-1', 'NR-1']);
  const p = r.data.unidades.find(u => u.id === pt), n = r.data.unidades.find(u => u.id === nr);
  assert.equal(p.rojo, true); assert.ok(p.dias >= 3); assert.equal(p.tipo, 'Pérdida total');
  assert.equal(n.rojo, false); assert.equal(n.dias, 0); assert.equal(n.tipo, 'No reparar');
  assert.equal((await req('orl', 'GET', '/api/retiros')).status, 403, 'Orlando no la ve');
});

test('RET-2: "Ya se retiró" la saca de la lista y queda quién y cuándo', async () => {
  const id = db.prepare(`SELECT id FROM siniestros WHERE numero='PT-1'`).get().id;
  assert.equal((await req('dan', 'POST', `/api/retiros/${id}/retirada`, {})).status, 200);
  const s = db.prepare('SELECT retirada_en, retirada_por FROM siniestros WHERE id=?').get(id);
  assert.ok(s.retirada_en); assert.equal(s.retirada_por, 'Daniela');
  assert.ok(!(await req('ale', 'GET', '/api/retiros')).data.unidades.some(u => u.id === id));
  assert.equal((await req('dan', 'POST', `/api/retiros/${id}/retirada`, {})).status, 400, 'no se marca dos veces');
  const ab = db.prepare(`SELECT id FROM siniestros WHERE numero='AB-1'`).get().id;
  assert.equal((await req('dan', 'POST', `/api/retiros/${ab}/retirada`, {})).status, 400, 'solo PT o No reparar');
});
