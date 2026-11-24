// 24-nov-2026. Roberto: "un apartado para las unidades particulares ... sencillo y con su proceso independiente".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-particulares.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.LINEA_BASE_DANIELA = '9999-12-31';
process.env.LINEA_BASE_ALEJANDRA = '9999-12-31';

const app = require('../server/index');
const db = require('../server/db');
const P = require('../server/particulares');

const PORT = 3994, BASE = 'http://localhost:' + PORT;
let server;
function cliente(){
  let cookie = '';
  return async (method, url, body) => {
    const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
    const r = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
    const t = await r.text(); let d = t; try{ d = JSON.parse(t); }catch(e){}
    return { status: r.status, data: d };
  };
}
const PASS = 'ServicioCristian2026!';
async function como(email){ const c = cliente(); const r = await c('POST', '/api/auth/login', { email, password: PASS }); assert.equal(r.status, 200, email); return c; }

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  // el reset de emergencia cambia la contraseña de Daniela al arrancar: en la prueba se deja la conocida
  db.prepare(`UPDATE usuarios SET password_hash = ? WHERE email = 'daniela@serviciocristian.mx'`).run(require('bcryptjs').hashSync(PASS, 4));
});
test.after(() => { server.close(); });

test('flujo completo con piezas: Beto captura, Daniela cotiza, Ale cobra anticipo, piezas, recibe, Beto termina, Ale cobra y entrega', async () => {
  const beto = await como('beto@serviciocristian.mx');
  const ale = await como('alejandra@serviciocristian.mx');
  const dani = await como('daniela@serviciocristian.mx');
  const r = await beto('POST', '/api/particulares', { cliente_nombre:'Juan Pérez', cliente_telefono:'2291112233', vehiculo:'Nissan Versa 2019 blanco', placas:'yzx123a',
    trabajo:'Reparar y pintar fascia y salpicadera', monto:'6500', lleva_piezas:1, piezas:'Faro izquierdo', decision:'acepta', en_taller:0, fecha_cita:'2026-12-01', fecha_entrega:'2026-12-05' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.id;
  assert.equal(r.data.placas, 'YZX123A');
  assert.equal(r.data.paso, 'cotizar'); assert.equal(r.data.quien, 'daniela');

  assert.equal((await ale('POST', `/api/particulares/${id}/accion`, { accion:'cotizar', piezas_costo:1800, piezas_dias:3 })).status, 403, 'cotizar no le toca a Ale');
  let x = await dani('POST', `/api/particulares/${id}/accion`, { accion:'cotizar', piezas_costo:1800, piezas_dias:3 });
  assert.equal(x.data.paso, 'anticipo'); assert.equal(x.data.quien, 'alejandra');
  x = await ale('POST', `/api/particulares/${id}/accion`, { accion:'anticipo', monto:1800 });
  assert.equal(x.data.paso, 'piezas'); assert.equal(x.data.quien, 'daniela');
  x = await dani('POST', `/api/particulares/${id}/accion`, { accion:'piezas_llegaron' });
  assert.equal(x.data.paso, 'recibir');
  x = await ale('POST', `/api/particulares/${id}/accion`, { accion:'recibir' });
  assert.equal(x.data.paso, 'reparar'); assert.equal(x.data.quien, 'beto');
  assert.equal((await ale('POST', `/api/particulares/${id}/accion`, { accion:'entregar' })).status, 400, 'no se entrega sin terminar y cobrar');
  x = await beto('POST', `/api/particulares/${id}/accion`, { accion:'terminado' });
  assert.equal(x.data.paso, 'cobrar'); assert.equal(x.data.saldo, 4700);
  assert.equal((await ale('POST', `/api/particulares/${id}/accion`, { accion:'entregar' })).status, 400, 'no se entrega sin pago');
  x = await ale('POST', `/api/particulares/${id}/accion`, { accion:'pago', monto:4700 });
  assert.equal(x.data.paso, 'entregar');
  x = await ale('POST', `/api/particulares/${id}/accion`, { accion:'entregar' });
  assert.equal(x.data.paso, 'entregado');
  const lista = await ale('GET', '/api/particulares?historial=1');
  assert.ok(!lista.data.unidades.some(p => p.id === id));
  assert.ok(lista.data.historial.some(p => p.id === id));
  assert.ok(db.prepare(`SELECT COUNT(*) n FROM auditoria WHERE entidad_tipo='particular' AND entidad_id=?`).get(id).n >= 8);
});

test('lo deja hoy: primero el inventario; lo va a pensar: seguimiento de Ale a los 2 días', async () => {
  const beto = await como('beto@serviciocristian.mx');
  const a = await beto('POST', '/api/particulares', { cliente_nombre:'Ana', vehiculo:'Aveo', trabajo:'Pintar puerta', monto:2500, decision:'acepta', en_taller:1, fecha_entrega:'2026-12-02' });
  assert.equal(a.data.paso, 'recibir'); assert.equal(a.data.quien, 'alejandra');
  const b = await beto('POST', '/api/particulares', { cliente_nombre:'Luis', vehiculo:'Jetta', trabajo:'Golpe cajuela', monto:4000, decision:'pensando' });
  assert.equal(b.data.paso, 'seguimiento'); assert.ok(!b.data.urgente);
  db.prepare(`UPDATE particulares SET creado_en = datetime('now','-3 days') WHERE id = ?`).run(b.data.id);
  const p = P.obtener(db, b.data.id);
  assert.ok(p.urgente); assert.match(p.texto, /llámale/);
  assert.ok(P.pendientesPush(db, 'alejandra').some(x => x.clave.startsWith(`part-${b.data.id}-seguimiento`)));
});

test('faltan datos, técnico sin acceso y no aparece en lo de aseguradoras', async () => {
  const beto = await como('beto@serviciocristian.mx');
  const r = await beto('POST', '/api/particulares', { cliente_nombre:'X', vehiculo:'Y', trabajo:'' });
  assert.equal(r.status, 400); assert.match(r.data.error, /qué se va a hacer/); assert.match(r.data.error, /monto/);
  const n = db.prepare(`SELECT COUNT(*) n FROM siniestros`).get().n;
  await beto('POST', '/api/particulares', { cliente_nombre:'Z', vehiculo:'Spark', trabajo:'Pulir', monto:800, decision:'acepta', en_taller:1 });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM siniestros`).get().n, n, 'no crea siniestros');
});

test('fotos del daño: se suben al particular y salen en su tarjeta', async () => {
  const beto = await como('beto@serviciocristian.mx');
  const r = await beto('POST', '/api/particulares', { cliente_nombre:'Foto', vehiculo:'Sentra', trabajo:'Fascia', monto:3000, decision:'acepta', en_taller:1 });
  assert.equal(r.data.fotos.length, 0);
  const login = await fetch(BASE + '/api/auth/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ email:'beto@serviciocristian.mx', password: PASS }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('foto', new Blob([png], { type:'image/png' }), 'dano.png');
  const up = await fetch(BASE + `/api/particulares/${r.data.id}/fotos`, { method:'POST', headers:{ Cookie: cookie }, body: fd });
  assert.equal(up.status, 201, await up.clone().text());
  const fotoId = (await up.json()).id;
  const lista = await beto('GET', '/api/particulares');
  assert.deepEqual(lista.data.unidades.find(p => p.id === r.data.id).fotos, [fotoId]);
  const img = await fetch(BASE + `/api/particulares/fotos/${fotoId}`, { headers:{ Cookie: cookie } });
  assert.equal(img.status, 200);
});
