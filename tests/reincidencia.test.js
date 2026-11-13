// 13-nov-2026 (Roberto: "actívale ese pendiente de nuevo a Orlando" / "como es una reincidencia te pediría que
// tenga 12 horas"): una reautorización que Orlando dio por enviada se reactiva como REINCIDENCIA con 12 h.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-reincidencia.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const { calcularInicioOrlando } = require('../server/inicioOrlando');

const PORT = 3960;
const BASE = 'http://localhost:' + PORT;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' };
  if(cookie) h.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const txt = await res.text(); let data = txt; try { data = JSON.parse(txt); } catch(e) {}
  return { status: res.status, data };
}
async function login(email, password){ cookie = ''; const r = await req('POST', '/api/auth/login', { email, password }); assert.equal(r.status, 200, 'login ' + email); }
const ADMIN = ['admin@serviciocristian.mx', 'ServicioCristian2026!'];
const ORLANDO = ['orlando@serviciocristian.mx', 'ServicioCristian2026!'];

let sid;
test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  sid = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas) VALUES ('REIN-1','Allianz','Peugeot 3008 2018','XZX823A')`).run().lastInsertRowid);
});
test.after(() => { server.close(); });

test('REIN-1: reautorización enviada se reactiva como reincidencia con 12 h y vuelve con Orlando', async () => {
  await login(...ADMIN);
  const c = await req('POST', '/api/complementos', { siniestro_id: sid, tipo:'no_autorizado_inicial', causa:'Piezas no autorizadas por la aseguradora', pieza_operacion:'MOLDURA SUPERIOR TAPA CAJUELA' });
  assert.equal(c.status, 201);
  db.prepare(`UPDATE complementos SET estado='enviado', fecha_limite=? WHERE id=?`).run(new Date(Date.now() - 20*3600000).toISOString(), c.data.id);
  assert.ok(!calcularInicioOrlando(db).reautorizar.some(x => x.id === c.data.id), 'enviada: ya no le aparece');

  const r = await req('POST', `/api/complementos/${c.data.id}/reincidencia`, { nota:'¿Se regresó el expediente?' });
  assert.equal(r.status, 200);
  assert.equal(r.data.reincidencia, 1);
  assert.equal(r.data.estado, 'documentando');
  assert.equal(r.data.vencido, false);
  const horas = (Date.parse(r.data.fecha_limite) - Date.now()) / 3600000;
  assert.ok(horas > 11.9 && horas <= 12, 'plazo de 12 h: ' + horas);
  assert.match(r.data.causa, /Se regresó el expediente/);

  const o = calcularInicioOrlando(db).reautorizar.find(x => x.id === c.data.id);
  assert.ok(o, 'vuelve a la lista de Orlando');
  assert.equal(o.reincidencia, 1);
  assert.ok(db.prepare(`SELECT 1 FROM tareas WHERE siniestro_id=? AND disparador='reautorizacion_reincidencia'`).get(sid), 'queda el aviso');
});

test('REIN-2: solo Roberto la reactiva y no aplica a una ya resuelta', async () => {
  await login(...ADMIN);
  const c = await req('POST', '/api/complementos', { siniestro_id: sid, tipo:'no_autorizado_inicial', causa:'x', pieza_operacion:'ALETILLA' });
  await login(...ORLANDO);
  assert.equal((await req('POST', `/api/complementos/${c.data.id}/reincidencia`, {})).status, 403);
  await login(...ADMIN);
  db.prepare(`UPDATE complementos SET decision='autorizado' WHERE id=?`).run(c.data.id);
  assert.equal((await req('POST', `/api/complementos/${c.data.id}/reincidencia`, {})).status, 400);
});
