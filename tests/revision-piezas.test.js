// Auxiliar de refacciones (12-nov-2026): revisa las piezas que llegan y le avisa a Daniela si llegan mal.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-revision-piezas.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const { calcularInicioDaniela } = require('../server/inicioDaniela');
const PORT = 3982;
let server; const ses = {};
async function req(quien, method, url, body){
  const h = {}; if(ses[quien]) h.Cookie = ses[quien];
  let cuerpo; if(body instanceof FormData) cuerpo = body; else if(body){ h['Content-Type'] = 'application/json'; cuerpo = JSON.stringify(body); }
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: cuerpo });
  const sc = r.headers.get('set-cookie'); if(sc) ses[quien] = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(3000, 1), Buffer.from([0xFF, 0xD9])]);
const hoy = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
let SID, BIEN, MAL;

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  db.prepare(`UPDATE usuarios SET password_hash = ? WHERE email IN ('adrian.beiza','marco.cobos')`).run(bcrypt.hashSync('prueba1234', 4));
  SID = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, estado_autorizacion, requiere_refacciones) VALUES ('RP-1','GNP','Mazda 3','MZD-001','autorizada','si')`).run().lastInsertRowid);
  const ped = Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion, estatus_operativo) VALUES ('PRP-1', ?, ?, 'Esperando proveedor')`).run(SID, hoy).lastInsertRowid);
  BIEN = Number(db.prepare(`INSERT INTO piezas (pedido_id, descripcion, estatus) VALUES (?, 'Faro izquierdo', 'En tránsito')`).run(ped).lastInsertRowid);
  MAL = Number(db.prepare(`INSERT INTO piezas (pedido_id, descripcion, estatus) VALUES (?, 'Fascia delantera', 'Confirmada')`).run(ped).lastInsertRowid);
  for(const [q, e] of [['adrian','adrian.beiza'], ['marco','marco.cobos']]) assert.equal((await req(q, 'POST', '/api/auth/login', { email:e, password:'prueba1234' })).status, 200);
});
test.after(async () => { await new Promise(r => server.close(r)); });

test('REV-1: solo el auxiliar ve las piezas pendientes; los demás técnicos no', async () => {
  const r = await req('adrian', 'GET', '/api/revision-piezas');
  assert.equal(r.status, 200);
  const u = r.data.unidades.find(x => x.siniestro_id === SID);
  assert.deepEqual(u.piezas.map(z => z.descripcion).sort(), ['Faro izquierdo', 'Fascia delantera']);
  assert.equal((await req('marco', 'GET', '/api/revision-piezas')).status, 403);
  assert.equal((await req('adrian', 'GET', '/api/patio/mis-trabajos')).data.puesto, 'Auxiliar de refacciones');
  assert.equal((await req('adrian', 'GET', '/api/siniestros/' + SID)).status, 403); // sigue sin ver expedientes
});

test('REV-2: "Llegó bien" la deja en Recibir piezas de Daniela marcada como revisada (Daniela confirma)', async () => {
  assert.equal((await req('adrian', 'POST', `/api/revision-piezas/${BIEN}/bien`)).status, 200);
  const z = db.prepare('SELECT * FROM piezas WHERE id=?').get(BIEN);
  assert.equal(z.estatus, 'Entregada por proveedor'); assert.ok(z.revisada_en);
  const d = calcularInicioDaniela(db);
  const p = d.recibir.find(g => g.siniestro_id === SID).piezas.find(x => x.id === BIEN);
  assert.equal(p.revisada_por_nombre, 'Adrián Beiza');
  const lista = (await req('adrian', 'GET', '/api/revision-piezas')).data.unidades.find(x => x.siniestro_id === SID);
  assert.ok(lista.piezas.find(x => x.id === BIEN).revisada);
});

test('REV-3: "Llegó mal" exige foto, abre la incidencia y Daniela ve las fotos', async () => {
  assert.equal((await req('adrian', 'POST', `/api/revision-piezas/${MAL}/mal`, { tipo:'danada', fotos:[] })).status, 400);
  const fd = new FormData(); fd.append('foto', new Blob([JPEG], { type:'image/jpeg' }), 'f.jpg');
  const f = await req('adrian', 'POST', `/api/revision-piezas/${MAL}/foto`, fd);
  assert.equal(f.status, 201, JSON.stringify(f.data));
  const m = await req('adrian', 'POST', `/api/revision-piezas/${MAL}/mal`, { tipo:'danada', nota:'Viene estrellada', fotos:[f.data.id] });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(db.prepare('SELECT estatus FROM piezas WHERE id=?').get(MAL).estatus, 'Incorrecta/dañada');
  const d = calcularInicioDaniela(db);
  const z = d.mal.find(x => x.id === MAL);
  assert.ok(z.incidencia); assert.deepEqual(z.incidencia.fotos, [f.data.id]);
  assert.match(z.incidencia.descripcion, /Llegó rota o dañada\. Reporta Adrián B\.: Viene estrellada/);
  // Ya no aparece en su lista (ya está reportada).
  const lista = (await req('adrian', 'GET', '/api/revision-piezas')).data.unidades.find(x => x.siniestro_id === SID);
  assert.ok(!lista.piezas.find(x => x.id === MAL));
  // Le llega el aviso push a Daniela (mismo aviso de "Pieza mal surtida").
  assert.ok(require('../server/push').FUENTES.operativo(db).some(a => a.titulo.includes('mal surtida') && a.cuerpo.includes('Fascia')));
});
