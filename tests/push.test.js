// Avisos push al celular (11-nov-2026). Roberto: "para que al tener algo por hacer en automático le avise" (Orlando).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-push.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.LINEA_BASE_DANIELA = '9999-12-31';
process.env.LINEA_BASE_ALEJANDRA = '9999-12-31';
const llaves = require('web-push').generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = llaves.publicKey;
process.env.VAPID_PRIVATE_KEY = llaves.privateKey;

const app = require('../server/index');
const db = require('../server/db');
const push = require('../server/push');

const PORT = 3991;
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
const ORLANDO = ['orlando@serviciocristian.mx', 'ServicioCristian2026!'];
const ALEJANDRA = ['alejandra@serviciocristian.mx', 'ServicioCristian2026!'];

function siniestro(numero){
  return Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas) VALUES (?,?,?,?)`).run(numero, 'Allianz', 'Peugeot 3008', 'XZX' + numero.slice(-3)).lastInsertRowid);
}
function reautorizacion(sid, piezas){
  const limite = new Date(Date.now() + 24 * 3600000).toISOString();
  return Number(db.prepare(`INSERT INTO complementos (siniestro_id, causa, pieza_operacion, tipo, decision, estado, fecha_limite) VALUES (?,?,?,?,?,?,?)`)
    .run(sid, 'No autorizado', piezas, 'no_autorizado_inicial', 'pendiente', 'detectado', limite).lastInsertRowid);
}
const sub = n => ({ endpoint:`https://fcm.googleapis.com/fcm/send/prueba-${n}`, keys:{ p256dh:'BAbc', auth:'xyz' } });
let enviados = [];
const EN_HORARIO = new Date('2026-11-11T18:00:00Z'); // miércoles 12:00 en Veracruz
const enviarFalso = async (s, payload) => { enviados.push({ endpoint: s.endpoint, ...JSON.parse(payload) }); };

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(() => { server.close(); });

test('estado: disponible para Orlando y Alejandra', async () => {
  await login(...ORLANDO);
  const r = await req('GET', '/api/push/estado');
  assert.equal(r.status, 200);
  assert.equal(r.data.disponible, true);
  assert.equal(r.data.clave_publica, llaves.publicKey);
  await login(...ALEJANDRA);
  const a = await req('GET', '/api/push/estado');
  assert.equal(a.data.disponible, true, '12-nov-2026: Alejandra también tiene avisos');
});

test('lo que ya tenía pendiente al activar no se avisa; lo nuevo sí, una sola vez', async () => {
  const s1 = siniestro('PU-001');
  reautorizacion(s1, 'MOLDURA SUPERIOR TAPA CAJUELA');
  await login(...ORLANDO);
  assert.equal((await req('POST', '/api/push/suscribir', { subscription: { endpoint:'http://inseguro', keys:{} } })).status, 400);
  const r = await req('POST', '/api/push/suscribir', { subscription: sub(1) });
  assert.equal(r.status, 200);
  enviados = [];
  await push.barrido(db, { enviar: enviarFalso, ahora: EN_HORARIO });
  assert.equal(enviados.length, 0, 'lo que ya estaba no se avisa');

  const s2 = siniestro('PU-002');
  reautorizacion(s2, 'ALETILLA COSTADO DERECHO');
  await push.barrido(db, { enviar: enviarFalso, ahora: EN_HORARIO });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].titulo, /reautorizar/);
  assert.match(enviados[0].cuerpo, /ALETILLA COSTADO DERECHO/);
  assert.match(enviados[0].cuerpo, /PU-002/);

  await push.barrido(db, { enviar: enviarFalso, ahora: EN_HORARIO });
  assert.equal(enviados.length, 1, 'no se repite');
});

test('más de 3 cosas nuevas juntas -> un solo aviso con el total', async () => {
  enviados = [];
  for(let i = 0; i < 5; i++) reautorizacion(siniestro('PU-1' + i), 'PIEZA ' + i);
  await push.barrido(db, { enviar: enviarFalso, ahora: EN_HORARIO });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].titulo, /5 pendientes nuevos/);
});

test('un celular que ya no acepta avisos (410) se borra', async () => {
  const uid = db.prepare(`SELECT id FROM usuarios WHERE email = ?`).get(ORLANDO[0]).id;
  reautorizacion(siniestro('PU-020'), 'FARO');
  const r = await push.barrido(db, { ahora: EN_HORARIO, enviar: async () => { const e = new Error('Gone'); e.statusCode = 410; throw e; } });
  assert.equal(r.avisos, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_suscripciones WHERE usuario_id = ?').get(uid).n, 0);
});

test('quitar suscripción y tabla bloqueada en la ventanilla de lectura', async () => {
  await login(...ORLANDO);
  await req('POST', '/api/push/suscribir', { subscription: sub(2) });
  const q = await req('POST', '/api/push/quitar', { endpoint: sub(2).endpoint });
  assert.equal(q.data.quitadas, 1);
  process.env.LECTURA_TOKEN = 'clave-prueba';
  const res = await fetch(BASE + '/api/externo/lectura/consulta', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer clave-prueba' }, body: JSON.stringify({ sql:'SELECT * FROM push_suscripciones' }) });
  assert.equal(res.status, 400);
});

// 12-nov-2026: avisos para todo el equipo, solo en horario laboral (L-V 9-7, sáb 9-2).
test('horario laboral de Veracruz', () => {
  const mx = t => new Date(Date.parse(t) + 6 * 3600000); // hora local de Veracruz -> UTC
  assert.equal(push.enHorarioLaboral(mx('2026-11-11T08:59:00Z')), false, 'miércoles antes de las 9');
  assert.equal(push.enHorarioLaboral(mx('2026-11-11T09:00:00Z')), true);
  assert.equal(push.enHorarioLaboral(mx('2026-11-11T18:59:00Z')), true);
  assert.equal(push.enHorarioLaboral(mx('2026-11-11T19:00:00Z')), false, 'miércoles 7 pm');
  assert.equal(push.enHorarioLaboral(mx('2026-11-14T13:30:00Z')), true, 'sábado 1:30 pm');
  assert.equal(push.enHorarioLaboral(mx('2026-11-14T14:00:00Z')), false, 'sábado 2 pm');
  assert.equal(push.enHorarioLaboral(mx('2026-11-15T12:00:00Z')), false, 'domingo');
});

test('fuera de horario no se manda nada; al abrir sí', async () => {
  enviados = [];
  await login(...ORLANDO);
  await req('POST', '/api/push/suscribir', { subscription: sub(3) });
  reautorizacion(siniestro('PU-030'), 'COFRE');
  const noche = await push.barrido(db, { enviar: enviarFalso, ahora: new Date('2026-11-12T03:00:00Z') });
  assert.equal(noche.fuera_de_horario, true);
  assert.equal(enviados.length, 0);
  await push.barrido(db, { enviar: enviarFalso, ahora: EN_HORARIO });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].cuerpo, /COFRE/);
});

test('Daniela y Alejandra: expediente completo enviado; Roberto: expediente por valuar', () => {
  const sid = siniestro('PU-040');
  db.prepare(`UPDATE siniestros SET expediente_completo_enviado_en = ? WHERE id = ?`).run(new Date().toISOString(), sid);
  assert.ok(push.pendientesDaniela(db).some(p => p.clave === 'expc-' + sid));
  assert.ok(push.pendientesAlejandra(db).some(p => p.clave === 'expc-' + sid));
  const v = siniestro('PU-041');
  db.prepare(`UPDATE siniestros SET estado_expediente = 'listo_para_valuacion' WHERE id = ?`).run(v);
  assert.ok(push.pendientesRoberto(db).some(p => p.clave === 'valuar-' + v));
  assert.ok(Array.isArray(push.pendientesBeto(db)));
});
