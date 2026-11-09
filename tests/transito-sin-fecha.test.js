// 9-nov-2026 (Roberto): "no puede tener fecha de entrega si no está en piso".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-transito-sin-fecha.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const { analizar, aplicar } = require('../server/actualizacionUnidades');
const PORT = 3982;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const crear = (numero, extra = {}) => {
  const c = Object.assign({ numero, aseguradora:'GNP', vehiculo:'Clásico ' + numero }, extra);
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
};
const fila = id => db.prepare('SELECT * FROM siniestros WHERE id = ?').get(id);

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  assert.equal((await req('POST', '/api/auth/login', { email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' })).status, 200);
});
test.after(async () => { await new Promise(r => server.close(r)); });

test('TRAN-1: la plantilla no pone fecha de entrega a una unidad en TRÁNSITO, y quita la que tuviera', () => {
  const id = crear('TR-001', { ubicacion:'Tránsito', fecha_entrega_prevista:'2026-11-14' });
  const texto = ['ASEGURADORA\tSINIESTRO\tUBICACION\tFECHA ENTREGA', 'GNP\tTR-001\tTRANSITO\t20/11/2026', 'GNP\tTR-002\tTRANSITO\t21/11/2026', 'GNP\tTR-003\tPISO\t22/11/2026'].join('\n');
  const a = analizar(db, texto);
  assert.ok(a.filas.find(r => r.siniestro === 'TR-001').avisos.some(x => /circulando/.test(x)));
  aplicar(db, texto, { id: null, nombre:'prueba' });
  assert.equal(fila(id).fecha_entrega_prevista, null);
  assert.equal(db.prepare(`SELECT fecha_entrega_prevista f FROM siniestros WHERE numero='TR-002'`).get().f, null);
  assert.equal(db.prepare(`SELECT fecha_entrega_prevista f FROM siniestros WHERE numero='TR-003'`).get().f, '2026-11-22', 'en PISO sí se toma');
});

test('TRAN-2: en el tablero no se puede capturar fecha a una unidad que circula', async () => {
  const id = crear('TR-010', { ubicacion:'Tránsito' });
  const r = await req('PATCH', '/api/siniestros/' + id, { fecha_entrega_prevista:'2026-11-20' });
  assert.equal(r.status, 400); assert.match(r.data.error, /circulando/);
  assert.equal(fila(id).fecha_entrega_prevista, null);
});

test('TRAN-3: si una unidad pasa a Tránsito, se le quita la fecha (queda en la auditoría)', async () => {
  const id = crear('TR-020', { ubicacion:'Piso', fecha_entrega_prevista:'2026-11-20' });
  const r = await req('PATCH', '/api/siniestros/' + id, { ubicacion:'Tránsito' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fila(id).fecha_entrega_prevista, null);
  assert.ok(db.prepare(`SELECT 1 FROM auditoria WHERE entidad_id=? AND campo='fecha_entrega_prevista' AND valor_anterior='2026-11-20'`).get(id));
});

test('TRAN-4: en piso todo sigue igual', async () => {
  const id = crear('TR-030', { ubicacion:'Piso' });
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { fecha_entrega_prevista:'2026-11-20' })).status, 200);
  assert.equal(fila(id).fecha_entrega_prevista, '2026-11-20');
});
