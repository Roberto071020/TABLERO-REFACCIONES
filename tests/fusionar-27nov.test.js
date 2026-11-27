// 27-nov-2026 (Roberto): juntar la unidad duplicada de recepción con la buena (número de la LIBRETA).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-fusionar-27nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');

const PORT = 3974;
let server; const ses = {};
async function req(q, method, url, body){
  const h = { 'Content-Type':'application/json' }; if(ses[q]) h.Cookie = ses[q];
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) ses[q] = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const ins = c => { const k = Object.keys(c); return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid); };

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  for(const [q, e, p] of [['adm','admin@serviciocristian.mx','ServicioCristian2026!'], ['orl','orlando@serviciocristian.mx','ServicioCristian2026!']])
    assert.equal((await req(q, 'POST', '/api/auth/login', { email:e, password:p })).status, 200, e);
});
test.after(() => server.close());

test('FUS-1: la duplicada pasa sus fotos/tareas y datos de recepción a la buena y queda archivada', async () => {
  const dup = ins({ numero:'426410628300085', aseguradora:'Mapfre', vehiculo:'ARONA ROJO', placas:'YGV950B', cliente_nombre:'DAVID ARIAS', cliente_telefono:'9511428506',
    fecha_admision:'2026-11-21', ingreso_tipo:'grua', llaves_entregadas:1, fecha_hora_disponible_revision:'2026-11-21 01:08:44' });
  const dst = ins({ numero:'4264106283000851', aseguradora:'Mapfre', vehiculo:'Seat Arona 2022 Rojo', placas:'YGV950B', cliente_nombre:'LETICIA LOPEZ',
    fecha_hora_disponible_revision:'2026-11-24 15:10:00' });
  db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, nombre_original, nombre_almacenado) VALUES ('siniestro', ?, 'inventario_fisico', 'inv.jpg', 'x.jpg')`).run(dup);
  db.prepare(`INSERT INTO tareas (siniestro_id, tipo, descripcion, estado, origen) VALUES (?, 'mensaje', 'Bienvenida', 'pendiente', 'manual')`).run(dup);
  assert.equal((await req('orl', 'POST', `/api/siniestros/${dup}/fusionar-en/${dst}`, {})).status, 403, 'solo admin');
  const r = await req('adm', 'POST', `/api/siniestros/${dup}/fusionar-en/${dst}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = db.prepare('SELECT * FROM siniestros WHERE id=?').get(dst);
  assert.equal(d.cliente_nombre, 'LETICIA LOPEZ'); assert.equal(d.cliente_telefono, '9511428506');
  assert.equal(d.fecha_admision, '2026-11-21'); assert.equal(d.ingreso_tipo, 'grua'); assert.equal(d.llaves_entregadas, 1);
  assert.equal(d.fecha_hora_disponible_revision, '2026-11-21 01:08:44');
  assert.match(d.notas, /Contacto registrado en recepción: DAVID ARIAS/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM archivos WHERE entidad_tipo='siniestro' AND entidad_id=?`).get(dst).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM tareas WHERE siniestro_id=?`).get(dst).n, 1);
  const u = db.prepare('SELECT archivado, estatus_general FROM siniestros WHERE id=?').get(dup);
  assert.equal(u.archivado, 1); assert.equal(u.estatus_general, 'Fusionado');
  assert.equal((await req('adm', 'POST', `/api/siniestros/${dst}/fusionar-en/${dst}`, {})).status, 400);
});

test('FUS-2: el importador no crea otra unidad con placas de una activa (salvo OTRO SINIESTRO = SI)', async () => {
  const AU = require('../server/actualizacionUnidades');
  const a = AU.analizar(db, 'SINIESTRO\tASEGURADORA\tVEHICULO\tPLACAS\n4264106283000859\tMAPFRE\tSeat Arona\tYGV950B');
  assert.ok(a.filas[0].errores.some(e => /YGV950B/.test(e)), JSON.stringify(a.filas[0]));
  const b = AU.analizar(db, 'SINIESTRO\tASEGURADORA\tVEHICULO\tPLACAS\tOTRO SINIESTRO\n4264106283000859\tMAPFRE\tSeat Arona\tYGV950B\tSI');
  assert.equal(b.filas[0].errores.length, 0);
});
