// Entregadas con pendiente (18-nov-2026): Roberto -- "Hay que crear un apartado para estas unidades que se reparan y
// entregan dejando algo pendiente ... se le entrega un vale solo por lo pendiente". Lo cierra cualquiera de oficina o Beto.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-vales-18nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const PORT = 3987;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const login = async (email, password = 'ServicioCristian2026!') => { cookie = ''; assert.equal((await req('POST', '/api/auth/login', { email, password })).status, 200); };
const hoyMX = () => require('../server/valesPendientes').hoyMX();
let id;

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  id = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, ubicacion, estado_autorizacion, estado_produccion, fecha_admision, reingreso_recibido_en)
    VALUES ('VALE-001','Inbursa','Volkswagen Vento 2017 Plata','YJY943C','Transito','autorizada','programado','2026-11-03','2026-11-03')`).run().lastInsertRowid);
});
test.after(async () => { await new Promise(r => server.close(r)); });

test('VALE-1: el importador abre el vale con VALE + FECHA ENTREGADA; sin entrega da error', async () => {
  const A = require('../server/actualizacionUnidades');
  const sinEntrega = A.analizar(db, 'SINIESTRO\tVALE\nVALE-001\tInstalar moldura');
  assert.equal(sinEntrega.filas[0].accion, 'error');
  const r = A.aplicar(db, 'SINIESTRO\tFECHA ENTREGADA\tVALE\nVALE-001\t13/11/2026\tInstalar moldura central fascia trasera', null);
  assert.equal(r.aplicadas, 1);
  const v = db.prepare(`SELECT * FROM vales_pendientes WHERE siniestro_id=?`).all(id);
  assert.equal(v.length, 1); assert.equal(v[0].estado, 'pendiente'); assert.equal(v[0].fecha_entrega_vehiculo, '2026-11-13');
  // Repetido: no duplica.
  const r2 = A.analizar(db, 'SINIESTRO\tVALE\nVALE-001\tInstalar moldura central fascia trasera');
  assert.equal(r2.filas[0].accion, 'sin_cambios');
});

test('VALE-2: aparece en el apartado y la cita le sale a Alejandra aunque ya esté entregada', async () => {
  db.prepare(`UPDATE siniestros SET cita_fecha=? WHERE id=?`).run(hoyMX(), id);
  await login('beto@serviciocristian.mx');
  const a = await req('GET', '/api/vales-pendientes/apartado');
  assert.equal(a.status, 200);
  assert.equal(a.data.vales.length, 1);
  assert.equal(a.data.vales[0].cita.estado, 'hoy');
  const ale = require('../server/inicioAlejandra').calcularInicioAlejandra(db);
  const t = ale.tarjetas.find(x => x.id === id);
  assert.ok(t, 'Alejandra debe ver la cita');
  assert.equal(t.tipo, 'cita'); assert.match(t.motivo, /vale/);
  const arr = require('../server/reporteArranque').calcularReporteArranque(db);
  assert.match(arr.texto, /Entregadas con pendiente/);
});

test('VALE-3: con vale pendiente no se archiva sola ni se puede cerrar', async () => {
  db.prepare(`UPDATE siniestros SET fecha_entrega_real='2025-01-01' WHERE id=?`).run(id);
  require('../server/utils').archivarSiniestrosVencidos(db);
  assert.equal(db.prepare('SELECT archivado FROM siniestros WHERE id=?').get(id).archivado, 0);
  await login('admin@serviciocristian.mx');
  const c = await req('PATCH', `/api/siniestros/${id}/cerrar`);
  assert.equal(c.status, 400);
  assert.ok(c.data.detalle.some(d => /Vale pendiente/.test(d)));
  db.prepare(`UPDATE siniestros SET fecha_entrega_real='2026-11-13' WHERE id=?`).run(id);
});

test('VALE-4: Beto (y cualquiera de oficina) lo cierra con "Ya se instaló"; el patio no', async () => {
  const vid = db.prepare(`SELECT id FROM vales_pendientes WHERE siniestro_id=?`).get(id).id;
  db.prepare(`INSERT OR IGNORE INTO usuarios (nombre,email,password_hash,rol) SELECT 'Tec','tec.vale', password_hash, 'tecnico' FROM usuarios WHERE email='beto@serviciocristian.mx'`).run();
  await login('tec.vale');
  assert.equal((await req('POST', `/api/vales-pendientes/${vid}/resolver`, {})).status, 403);
  await login('beto@serviciocristian.mx');
  const r = await req('POST', `/api/vales-pendientes/${vid}/resolver`, { nota:'Instalada' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'surtido'); assert.ok(r.data.resuelto_en);
  assert.equal((await req('POST', `/api/vales-pendientes/${vid}/resolver`, {})).status, 400);
  assert.equal((await req('GET', '/api/vales-pendientes/apartado')).data.vales.length, 0);
  const ale = require('../server/inicioAlejandra').calcularInicioAlejandra(db);
  assert.ok(!ale.tarjetas.find(x => x.id === id && x.tipo === 'cita'), 'ya entregada y sin vale: no le sale cita');
});

test('VALE-5: la foto del vale se acepta como etapa "vale"', () => {
  assert.ok(require('../server/fotos').ETAPAS_FOTO.includes('vale'));
});
