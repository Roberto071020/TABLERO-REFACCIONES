// Actualización de unidades por Claude con clave (7-nov-2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-actualizacion-externa.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
delete process.env.ACTUALIZACION_TOKEN;

const app = require('../server/index');
const db = require('../server/db');
const PORT = 3986;
let server;
const post = async (url, body, token) => {
  const h = { 'Content-Type':'application/json' };
  if(token) h.Authorization = 'Bearer ' + token;
  const r = await fetch('http://localhost:' + PORT + url, { method:'POST', headers:h, body: JSON.stringify(body || {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const TEXTO = ['ASEGURADORA\tSINIESTRO\tVEHICULO\tUBICACION\tETAPA', 'MAPFRE\tEXT-0001\tJETTA AZUL\tPISO\tHojalatería'].join('\n');

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { delete process.env.ACTUALIZACION_TOKEN; await new Promise(r => server.close(r)); });

test('EXT-1: sin ACTUALIZACION_TOKEN la ventanilla no existe; con clave equivocada se rechaza', async () => {
  assert.equal((await post('/api/externo/unidades/validar', { texto: TEXTO }, 'x')).status, 503);
  process.env.ACTUALIZACION_TOKEN = 'clave-de-prueba-larga-123456';
  assert.equal((await post('/api/externo/unidades/validar', { texto: TEXTO })).status, 401);
  assert.equal((await post('/api/externo/unidades/validar', { texto: TEXTO }, 'otra')).status, 401);
});

test('EXT-2: validar no guarda nada; confirmar aplica y deja la auditoría a nombre de Claude', async () => {
  process.env.ACTUALIZACION_TOKEN = 'clave-de-prueba-larga-123456';
  const v = await post('/api/externo/unidades/validar', { texto: TEXTO }, 'clave-de-prueba-larga-123456');
  assert.equal(v.status, 200); assert.equal(v.data.resumen.crear, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE numero='EXT-0001'`).get().n, 0);
  const c = await post('/api/externo/unidades/confirmar', { texto: TEXTO }, 'clave-de-prueba-larga-123456');
  assert.equal(c.status, 200);
  const s = db.prepare(`SELECT * FROM siniestros WHERE numero='EXT-0001'`).get();
  assert.equal(s.aseguradora, 'Mapfre'); assert.equal(s.estado_produccion, 'en_laminado');
  assert.ok(db.prepare(`SELECT 1 FROM auditoria WHERE entidad_id=? AND usuario_nombre='Claude (actualización de unidades)'`).get(s.id));
});

test('EXT-3: REVISION = PENDIENTE manda la unidad a Orlando; POR VALUAR, a la lista de Valuación de Roberto', async () => {
  process.env.ACTUALIZACION_TOKEN = 'clave-de-prueba-larga-123456';
  const crear = n => db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, estado_autorizacion) VALUES (?, 'Mapfre', 'Fit', 'en_autorizacion')`).run(n);
  crear('EXT-REV-1'); crear('EXT-REV-2');
  const texto = ['SINIESTRO\tAUTORIZADA\tREVISION', 'EXT-REV-1\tNO\tPENDIENTE', 'EXT-REV-2\tNO\tPOR VALUAR'].join('\n');
  const c = await post('/api/externo/unidades/confirmar', { texto }, 'clave-de-prueba-larga-123456');
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const u1 = db.prepare(`SELECT * FROM siniestros WHERE numero='EXT-REV-1'`).get();
  const u2 = db.prepare(`SELECT * FROM siniestros WHERE numero='EXT-REV-2'`).get();
  assert.equal(u1.estado_autorizacion, null); assert.equal(u2.estado_autorizacion, null);
  const { calcularInicioOrlando } = require('../server/inicioOrlando');
  const o = calcularInicioOrlando(db);
  assert.ok(o.revisar.some(x => x.siniestro_id === u1.id), 'PENDIENTE: le sale a Orlando para revisar');
  assert.ok(!o.revisar.some(x => x.siniestro_id === u2.id) && !o.captura.some(x => x.siniestro_id === u2.id), 'POR VALUAR: ya no le estorba a Orlando');
  assert.equal(u2.estado_expediente, 'listo_para_valuacion');
  const r = await fetch('http://localhost:' + PORT + '/api/auth/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' }) });
  const ck = r.headers.get('set-cookie').split(';')[0];
  const b = await (await fetch('http://localhost:' + PORT + '/api/reportes/bandeja-valuacion', { headers:{ Cookie: ck } })).json();
  assert.ok(b.some(x => x.id === u2.id), 'POR VALUAR: aparece en la lista de Valuación de Roberto');
  assert.ok(!b.some(x => x.id === u1.id));
});

test('EXT-ARCH: ARCHIVAR = SI archiva la unidad (y se puede reactivar después)', async () => {
  process.env.ACTUALIZACION_TOKEN = 'clave-de-prueba-larga-123456';
  db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo) VALUES ('EXT-PT-1', 'GNP', 'Spark')`).run();
  const c = await post('/api/externo/unidades/confirmar', { texto: 'SINIESTRO\tARCHIVAR\nEXT-PT-1\tSI' }, 'clave-de-prueba-larga-123456');
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(db.prepare(`SELECT archivado FROM siniestros WHERE numero='EXT-PT-1'`).get().archivado, 1);
  const n = await post('/api/externo/unidades/validar', { texto: 'SINIESTRO\tARCHIVAR\nNO-EXISTE-9\tSI' }, 'clave-de-prueba-larga-123456');
  assert.equal(n.data.filas[0].accion, 'error');
});
