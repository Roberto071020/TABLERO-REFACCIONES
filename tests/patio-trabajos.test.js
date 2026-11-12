// Trabajo del personal de patio (12-nov-2026): Beto asigna, el técnico ve sus trabajos y usa Empecé / Terminé / Me detuve.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-patio-trabajos.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const push = require('../server/push');
const PORT = 3981;
let server;
const sesiones = {};
async function req(quien, method, url, body){
  const h = {}; if(sesiones[quien]) h.Cookie = sesiones[quien];
  let cuerpo;
  if(body instanceof FormData) cuerpo = body; else if(body){ h['Content-Type'] = 'application/json'; cuerpo = JSON.stringify(body); }
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: cuerpo });
  const sc = r.headers.get('set-cookie'); if(sc) sesiones[quien] = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
async function entrar(quien, email, password = 'ServicioCristian2026!'){
  delete sesiones[quien];
  assert.equal((await req(quien, 'POST', '/api/auth/login', { email, password })).status, 200, email);
}
// JPEG mínimo válido para la prueba.
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(3000, 1), Buffer.from([0xFF, 0xD9])]);
async function subirFoto(quien, sid, para){
  const fd = new FormData();
  fd.append('para', para); fd.append('foto', new Blob([JPEG], { type:'image/jpeg' }), 'f.jpg');
  return req(quien, 'POST', `/api/patio/${sid}/foto`, fd);
}
const uid = email => db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email).id;
let SID, MARCELO, ADRIAN;

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  const hash = bcrypt.hashSync('prueba1234', 4);
  db.prepare(`UPDATE usuarios SET password_hash = ? WHERE email IN ('marcelo.lopez','adrian.rivera','jaime.pacheco')`).run(hash);
  MARCELO = uid('marcelo.lopez'); ADRIAN = uid('adrian.rivera');
  SID = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, ubicacion, estado_autorizacion, requiere_refacciones, fecha_entrega_prevista, cliente_nombre)
    VALUES ('PT-001','GNP','Nissan Versa','ABC-123','Piso','autorizada','no','2026-11-20','Cliente Privado')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO asistencia (usuario_id, usuario_nombre, fecha, hora_local, retardo) VALUES (?, 'Marcelo López', ?, '08:50', 0)`)
    .run(MARCELO, new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10));
});
test.after(async () => { await new Promise(r => server.close(r)); });

test('PT-1: Beto ve "Patio hoy" y asigna hojalatero y pintor (solo del puesto correcto)', async () => {
  await entrar('beto', 'beto@serviciocristian.mx');
  const v = await req('beto', 'GET', '/api/patio/beto');
  assert.equal(v.status, 200);
  assert.equal(v.data.total, 13); assert.equal(v.data.llegaron, 1);
  assert.ok(v.data.personal.find(p => p.id === MARCELO && p.llego && p.hora === '08:50'));
  // Un pintor no se puede poner como hojalatero.
  assert.equal((await req('beto', 'POST', '/api/patio/asignar', { siniestro_id: SID, area:'hojalateria', usuario_id: ADRIAN })).status, 400);
  assert.equal((await req('beto', 'POST', '/api/patio/asignar', { siniestro_id: SID, area:'hojalateria', usuario_id: MARCELO })).status, 200);
  assert.equal((await req('beto', 'POST', '/api/patio/asignar', { siniestro_id: SID, area:'pintura', usuario_id: ADRIAN })).status, 200);
  const v2 = await req('beto', 'GET', '/api/patio/beto');
  assert.equal(v2.data.por_siniestro[SID].length, 2);
  // Al técnico le llega el aviso de la asignación.
  assert.ok(push.FUENTES.tecnico(db, { id: MARCELO }).some(a => a.titulo.includes('asignó')));
});

test('PT-2: el técnico ve solo sus trabajos (sin datos del cliente) y sigue sin ver expedientes', async () => {
  await entrar('marcelo', 'marcelo.lopez', 'prueba1234');
  const r = await req('marcelo', 'GET', '/api/patio/mis-trabajos');
  assert.equal(r.status, 200);
  assert.equal(r.data.trabajos.length, 1);
  const t = r.data.trabajos[0];
  assert.equal(t.vehiculo, 'Nissan Versa'); assert.equal(t.placas, 'ABC-123'); assert.equal(t.accion, 'empezar');
  assert.ok(!JSON.stringify(r.data).includes('Cliente Privado'));
  assert.equal((await req('marcelo', 'GET', '/api/siniestros/' + SID)).status, 403);
  assert.equal((await req('marcelo', 'GET', '/api/patio/beto')).status, 403);
  assert.equal((await req('marcelo', 'POST', '/api/patio/asignar', { siniestro_id: SID, area:'hojalateria', usuario_id: MARCELO })).status, 403);
  // El pintor todavía no puede empezar (la unidad no ha pasado a su área)... salvo que esté sin iniciar.
});

test('PT-3: Empecé pasa la unidad sin iniciar a Hojalatería; Terminé exige foto', async () => {
  const e = await req('marcelo', 'POST', `/api/patio/${SID}/empece`);
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.equal(db.prepare('SELECT estado_produccion FROM siniestros WHERE id=?').get(SID).estado_produccion, 'en_laminado');
  assert.equal((await req('marcelo', 'POST', `/api/patio/${SID}/empece`)).status, 400); // no se duplica
  // El pintor ve que todavía no le toca.
  await entrar('adrian', 'adrian.rivera', 'prueba1234');
  const ad = await req('adrian', 'GET', '/api/patio/mis-trabajos');
  assert.equal(ad.data.trabajos[0].accion, 'no_toca');
  assert.equal((await req('adrian', 'POST', `/api/patio/${SID}/empece`)).status, 400);
  // Terminé sin foto: no.
  assert.equal((await req('marcelo', 'POST', `/api/patio/${SID}/termine`, { fotos: [] })).status, 400);
  const f = await subirFoto('marcelo', SID, 'trabajo');
  assert.equal(f.status, 201, JSON.stringify(f.data)); assert.equal(f.data.etapa, 'en_laminado');
  const t = await req('marcelo', 'POST', `/api/patio/${SID}/termine`, { fotos: [f.data.id] });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.equal((await req('marcelo', 'GET', '/api/patio/mis-trabajos')).data.trabajos[0].accion, 'espera_beto');
  // Beto ve el aviso y confirma pasando a Preparación (la foto de hojalatería ya cubre la regla de fotos por etapa).
  assert.ok(push.FUENTES.beto(db).some(a => a.titulo.includes('terminó')));
  assert.equal((await req('beto', 'GET', '/api/patio/beto')).data.por_siniestro[SID].find(a => a.area === 'hojalateria').trabajo.estado, 'terminado');
  const p = await req('beto', 'PATCH', '/api/siniestros/' + SID, { estado_produccion:'preparacion' });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(db.prepare(`SELECT estado FROM patio_trabajos WHERE usuario_id=? AND siniestro_id=?`).get(MARCELO, SID).estado, 'cerrado');
  assert.equal((await req('adrian', 'GET', '/api/patio/mis-trabajos')).data.trabajos[0].accion, 'empezar');
});

test('PT-4: Me detuve por pieza mal surtida exige foto, detiene la unidad y la evidencia le llega a Daniela', async () => {
  assert.equal((await req('adrian', 'POST', `/api/patio/${SID}/empece`)).status, 200);
  assert.equal((await req('adrian', 'POST', `/api/patio/${SID}/me-detuve`, { motivo:'pieza_mal' })).status, 400);
  const f = await subirFoto('adrian', SID, 'paro');
  assert.equal(f.data.etapa, 'paro');
  const d = await req('adrian', 'POST', `/api/patio/${SID}/me-detuve`, { motivo:'pieza_mal', nota:'Fascia rota', fotos:[f.data.id] });
  assert.equal(d.status, 200, JSON.stringify(d.data)); assert.equal(d.data.avisa, 'Daniela');
  const s = db.prepare('SELECT * FROM siniestros WHERE id=?').get(SID);
  assert.equal(s.estado_produccion, 'detenido'); assert.equal(s.detenido_motivo, 'pieza_mal'); assert.match(s.detenido_nota, /Adrián R\.: Fascia rota/);
  await entrar('daniela', 'daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!');
  const det = await req('daniela', 'GET', '/api/detenidas');
  const u = det.data.detenidas.find(x => x.id === SID);
  assert.ok(u); assert.deepEqual(u.fotos, [f.data.id]);
  assert.equal((await req('daniela', 'GET', `/api/fotos/${f.data.id}/imagen`)).status, 200);
  assert.ok(push.FUENTES.operativo(db).some(a => a.cuerpo.includes('Pieza mal surtida')));
  // Mientras siga detenida no puede seguir; cuando Beto la regresa a Pintura, sí.
  assert.equal((await req('adrian', 'POST', `/api/patio/${SID}/seguir`)).status, 400);
  assert.equal((await req('beto', 'PATCH', '/api/siniestros/' + SID, { estado_produccion:'pintura' })).status, 200);
  assert.equal((await req('adrian', 'GET', '/api/patio/mis-trabajos')).data.trabajos[0].accion, 'seguir');
  assert.equal((await req('adrian', 'POST', `/api/patio/${SID}/seguir`)).status, 200);
  assert.equal(db.prepare(`SELECT etapa, estado FROM patio_trabajos WHERE usuario_id=? AND siniestro_id=? ORDER BY id DESC`).get(ADRIAN, SID).estado, 'en_curso');
});

test('PT-5: falta material o "Beto me movió" solo pausan (no detienen la unidad)', async () => {
  const d = await req('adrian', 'POST', `/api/patio/${SID}/me-detuve`, { motivo:'falta_material', nota:'Thinner' });
  assert.equal(d.status, 200); assert.equal(d.data.avisa, 'Beto');
  assert.equal(db.prepare('SELECT estado_produccion FROM siniestros WHERE id=?').get(SID).estado_produccion, 'pintura');
  assert.ok(push.FUENTES.beto(db).some(a => a.titulo.includes('material')));
  assert.equal((await req('adrian', 'POST', `/api/patio/${SID}/seguir`)).status, 200);
  assert.equal((await req('adrian', 'POST', `/api/patio/${SID}/me-detuve`, { motivo:'me_movieron' })).status, 200);
});

test('PT-6: si Beto reasigna, el anterior ya no la ve y queda registrado', async () => {
  const JAIME = uid('jaime.pacheco');
  assert.equal((await req('beto', 'POST', '/api/patio/asignar', { siniestro_id: SID, area:'hojalateria', usuario_id: JAIME })).status, 200);
  assert.equal((await req('marcelo', 'GET', '/api/patio/mis-trabajos')).data.trabajos.length, 0);
  assert.equal((await req('marcelo', 'POST', `/api/patio/${SID}/empece`)).status, 403);
  assert.ok(db.prepare(`SELECT 1 FROM patio_eventos WHERE siniestro_id=? AND tipo='quitar' AND nota LIKE '%Marcelo%'`).get(SID));
  // Quitar a alguien (sin reemplazo) también funciona.
  assert.equal((await req('beto', 'POST', '/api/patio/asignar', { siniestro_id: SID, area:'hojalateria', usuario_id: null })).status, 200);
  assert.ok(!(await req('beto', 'GET', '/api/patio/beto')).data.por_siniestro[SID].some(a => a.area === 'hojalateria'));
});

test('PT-7: la OT solo la abre el técnico asignado', async () => {
  const dir = require('../server/fotos').UPLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ot-prueba-patio.pdf'), '%PDF-1.4 prueba');
  db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, nombre_original, nombre_almacenado, mime, tamano) VALUES ('siniestro', ?, 'Orden de trabajo', 'OT.pdf', 'ot-prueba-patio.pdf', 'application/pdf', 15)`).run(SID);
  assert.equal((await req('adrian', 'GET', `/api/patio/${SID}/ot`)).status, 200);
  assert.equal((await req('marcelo', 'GET', `/api/patio/${SID}/ot`)).status, 403);
  fs.unlinkSync(path.join(dir, 'ot-prueba-patio.pdf'));
});
