// Corte de las 3 de la tarde (9-nov-2026): lo que sigue pendiente de hoy, por persona.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-corte-tarde.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
delete process.env.REPORTE_TOKEN;

const app = require('../server/index');
const db = require('../server/db');
const { calcularCorteTarde } = require('../server/corteTarde');
const PORT = 3981;
let server;
const crear = (numero, extra = {}) => {
  const c = Object.assign({ numero, aseguradora:'Mapfre', vehiculo:'Nissan Versa ' + numero, placas:'YK' + numero.slice(-3) }, extra);
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
};

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { delete process.env.REPORTE_TOKEN; await new Promise(r => server.close(r)); });

test('CORTE-1: sin pendientes, salen al corriente (Daniela trae el caso sembrado de pieza mal surtida)', () => {
  const c = calcularCorteTarde(db);
  for(const n of ['Beto', 'Alejandra', 'Orlando']) assert.match(c.texto, new RegExp(`\\*${n}:\\* ✅ al corriente`));
  assert.match(c.texto, /CORTE DE LAS 3/);
});

test('CORTE-2: una vencida sin avance hoy le sale a Beto; si se movió hoy, ya no', () => {
  const id = crear('CT-001', { estado_autorizacion:'autorizada', ubicacion:'Piso', estado_produccion:'en_laminado', fecha_entrega_prevista:'2026-01-05', requiere_refacciones:'no' });
  let c = calcularCorteTarde(db);
  const beto = c.personas.find(p => p.nombre === 'Beto');
  assert.ok(beto.renglones.some(r => /vencida sin avance hoy/.test(r) && /Nissan Versa/.test(r)), JSON.stringify(beto));
  db.prepare(`INSERT INTO auditoria (entidad_tipo, entidad_id, accion, campo, valor_anterior, valor_nuevo, usuario_nombre) VALUES ('siniestro', ?, 'edicion', 'estado_produccion', 'en_laminado', 'preparacion', 'Beto')`).run(id);
  c = calcularCorteTarde(db);
  assert.ok(!c.personas.find(p => p.nombre === 'Beto').renglones.some(r => /vencida/.test(r)));
});

test('CORTE-3: la ventanilla usa la misma clave del reporte de la mañana', async () => {
  const url = `http://localhost:${PORT}/api/externo/corte-tarde?formato=texto`;
  assert.equal((await fetch(url)).status, 503);
  process.env.REPORTE_TOKEN = 'clave-corte-123';
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer otra' } })).status, 401);
  const r = await fetch(url, { headers: { Authorization: 'Bearer clave-corte-123' } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /CORTE DE LAS 3/);
});
