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
