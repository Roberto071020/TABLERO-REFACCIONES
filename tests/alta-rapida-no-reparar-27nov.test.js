// 27-nov-2026 (solicitud de Orlando aprobada por Roberto): alta rápida para todos (sin duplicar placas; a Ale le aparece
// para recibirla) y "No reparar" con motivo (sale de pendientes; Daniela/Roberto la regresan a proceso).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-alta-rapida-27nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const { calcularInicioOrlando } = require('../server/inicioOrlando');
const { calcularInicioAlejandra } = require('../server/inicioAlejandra');

const PORT = 3971;
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
  for(const [q, e, p] of [['orl','orlando@serviciocristian.mx','ServicioCristian2026!'], ['beto','beto@serviciocristian.mx','ServicioCristian2026!'],
    ['dan','daniela@serviciocristian.mx','ServicioCristian2026-Reset!'], ['adm','admin@serviciocristian.mx','ServicioCristian2026!']])
    assert.equal((await req(q, 'POST', '/api/auth/login', { email:e, password:p })).status, 200, e);
});
test.after(() => server.close());

test('ALTA-1: Orlando registra una unidad en piso y a Ale le aparece para recibirla', async () => {
  const r = await req('orl', 'POST', '/api/siniestros', { numero:'AR-1', aseguradora:'GNP', vehiculo:'Jetta 2016', placas:'XYM154B', ubicacion:'Piso', alta_rapida:1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.alta_rapida_por, 'Orlando');
  const t = calcularInicioAlejandra(db).tarjetas.find(x => x.id === r.data.id);
  assert.ok(t, 'le aparece a Ale');
  assert.equal(t.tipo, 'alta_otro'); assert.equal(t.en_piso, true); assert.match(t.motivo, /Registrada por Orlando/);
  // Ale la recibe -> ya no aparece como "registrada por otra persona"
  db.prepare(`UPDATE siniestros SET fecha_admision=date('now') WHERE id=?`).run(r.data.id);
  const t2 = calcularInicioAlejandra(db).tarjetas.find(x => x.id === r.data.id);
  assert.ok(!t2 || t2.tipo !== 'alta_otro');
});

test('ALTA-2: en tránsito pide cita y desaparece cuando ya tiene una', async () => {
  const r = await req('beto', 'POST', '/api/siniestros', { numero:'AR-2', aseguradora:'INBURSA', vehiculo:'Smart', placas:'ABC1234', ubicacion:'Tránsito', alta_rapida:1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const t = calcularInicioAlejandra(db).tarjetas.find(x => x.id === r.data.id);
  assert.equal(t.tipo, 'alta_otro'); assert.equal(t.en_piso, false);
  db.prepare(`UPDATE siniestros SET cita_fecha=date('now','+3 days') WHERE id=?`).run(r.data.id);
  const t2 = calcularInicioAlejandra(db).tarjetas.find(x => x.id === r.data.id);
  assert.ok(!t2 || t2.tipo !== 'alta_otro');
});

test('ALTA-3: mismas placas que una unidad activa -> pregunta; si es otro siniestro, se crea', async () => {
  const r = await req('dan', 'POST', '/api/siniestros', { numero:'AR-3', aseguradora:'GNP', vehiculo:'Jetta', placas:'xym-154-b', alta_rapida:1 });
  assert.equal(r.status, 409);
  assert.equal(r.data.coincide_unidad.numero, 'AR-1');
  const r2 = await req('dan', 'POST', '/api/siniestros', { numero:'AR-3', aseguradora:'GNP', vehiculo:'Jetta', placas:'XYM154B', alta_rapida:1, es_otro_siniestro:1 });
  assert.equal(r2.status, 201);
  // sin placas no pregunta nada
  assert.equal((await req('dan', 'POST', '/api/siniestros', { numero:'AR-4', aseguradora:'GNP', vehiculo:'Aveo' })).status, 201);
});

test('NOREP-1: "No reparar" exige motivo, saca la unidad de los pendientes de Orlando y Daniela la regresa', async () => {
  const id = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, fecha_hora_disponible_revision, estado_revision_tecnica)
    VALUES ('MUS-1','GNP','Mustang negro 2015','DSK156K','2026-11-12 10:00:00','en_revision')`).run().lastInsertRowid);
  assert.ok(calcularInicioOrlando(db).revisar.some(x => x.siniestro_id === id));
  assert.equal((await req('orl', 'POST', `/api/siniestros/${id}/no-reparar`, { motivo:'' })).status, 400);
  const r = await req('orl', 'POST', `/api/siniestros/${id}/no-reparar`, { motivo:'Al final no ingresa por siniestro' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estatus_general, 'No reparar'); assert.equal(r.data.archivado, 1);
  assert.equal(r.data.no_reparar_por, 'Orlando'); assert.match(r.data.no_reparar_motivo, /no ingresa/);
  assert.ok(!calcularInicioOrlando(db).revisar.some(x => x.siniestro_id === id), 'ya no le aparece a Orlando');
  assert.equal((await req('orl', 'POST', `/api/siniestros/${id}/no-reparar`, { motivo:'otra vez' })).status, 400, 'ya no está en proceso');
  assert.equal((await req('orl', 'PATCH', `/api/siniestros/${id}/desarchivar`, {})).status, 403, 'Orlando no la regresa');
  assert.equal((await req('dan', 'PATCH', `/api/siniestros/${id}/desarchivar`, {})).status, 200);
  const s = db.prepare('SELECT estatus_general, archivado, no_reparar_motivo FROM siniestros WHERE id=?').get(id);
  assert.equal(s.estatus_general, 'Abierto'); assert.equal(s.archivado, 0); assert.equal(s.no_reparar_motivo, null);
  assert.ok(calcularInicioOrlando(db).revisar.some(x => x.siniestro_id === id), 'regresa a Orlando');
  assert.ok(db.prepare(`SELECT 1 FROM auditoria WHERE entidad_id=? AND accion='no_reparar'`).get(id), 'queda en la auditoría');
});
