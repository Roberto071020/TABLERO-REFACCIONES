// Ventanilla de solo lectura para reportes (9-nov-2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-consulta-externa.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
delete process.env.LECTURA_TOKEN;

const app = require('../server/index');
const db = require('../server/db');
const PORT = 3984;
const CLAVE = 'clave-lectura-de-prueba-123456';
let server;
const pedir = async (url, { body, token, metodo = 'POST' } = {}) => {
  const h = { 'Content-Type':'application/json' };
  if(token) h.Authorization = 'Bearer ' + token;
  const r = await fetch('http://localhost:' + PORT + url, { method: metodo, headers: h, body: metodo === 'GET' ? undefined : JSON.stringify(body || {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const consulta = (sql, params) => pedir('/api/externo/lectura/consulta', { body: { sql, params }, token: CLAVE });

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { delete process.env.LECTURA_TOKEN; await new Promise(r => server.close(r)); });

test('LECT-1: sin LECTURA_TOKEN no existe; con clave equivocada se rechaza', async () => {
  assert.equal((await consulta('SELECT 1')).status, 503);
  process.env.LECTURA_TOKEN = CLAVE;
  assert.equal((await pedir('/api/externo/lectura/consulta', { body: { sql: 'SELECT 1' } })).status, 401);
  assert.equal((await pedir('/api/externo/lectura/consulta', { body: { sql: 'SELECT 1' }, token: 'otra' })).status, 401);
});

test('LECT-2: lee datos reales con parámetros', async () => {
  process.env.LECTURA_TOKEN = CLAVE;
  db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo) VALUES ('LECT-001', 'Mapfre', 'Fit')`).run();
  const r = await consulta(`SELECT numero, aseguradora FROM siniestros WHERE numero = ?`, ['LECT-001']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.filas.map(f => ({ ...f })), [{ numero: 'LECT-001', aseguradora: 'Mapfre' }]);
});

test('LECT-3: nada que modifique pasa, y la base sigue igual', async () => {
  process.env.LECTURA_TOKEN = CLAVE;
  const antes = db.prepare(`SELECT COUNT(*) n FROM siniestros`).get().n;
  for(const sql of [
    `DELETE FROM siniestros`,
    `UPDATE siniestros SET vehiculo='X'`,
    `SELECT 1; DELETE FROM siniestros`,
    `WITH x AS (SELECT 1) DELETE FROM siniestros`,
    `ATTACH DATABASE '/tmp/otra.db' AS o`,
    `PRAGMA table_info(siniestros)`,
  ]){
    const r = await consulta(sql);
    assert.equal(r.status, 400, sql);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM siniestros`).get().n, antes);
  assert.equal(db.prepare(`SELECT vehiculo FROM siniestros WHERE numero='LECT-001'`).get().vehiculo, 'Fit');
});

test('LECT-4: tablas con contraseñas, sesiones o claves están bloqueadas', async () => {
  process.env.LECTURA_TOKEN = CLAVE;
  for(const sql of [`SELECT * FROM usuarios`, `SELECT * FROM "usuarios"`, `SELECT * FROM sesiones`, `SELECT * FROM google_drive_tokens`, `SELECT * FROM whatsapp_config`]){
    const r = await consulta(sql);
    assert.equal(r.status, 400, sql);
  }
  // Una palabra bloqueada DENTRO de un texto no estorba.
  assert.equal((await consulta(`SELECT 'usuarios' AS t`)).status, 200);
});

test('LECT-5: el esquema no muestra tablas bloqueadas', async () => {
  process.env.LECTURA_TOKEN = CLAVE;
  const r = await pedir('/api/externo/lectura/esquema', { token: CLAVE, metodo: 'GET' });
  assert.equal(r.status, 200);
  assert.ok(r.data.tablas.siniestros);
  for(const t of ['usuarios', 'sesiones', 'google_drive_tokens', 'whatsapp_config']) assert.ok(!r.data.tablas[t], t);
});
