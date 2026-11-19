// 19-nov-2026: (1) las reincidencias de Orlando salen siempre en el corte de las 3; (2) al resolver una incidencia,
// la pieza deja de contar como mal surtida y queda "por llegar" con su fecha.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-cambios-19nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const PORT = 3988;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const login = async (email, password = 'ServicioCristian2026!') => { cookie = ''; assert.equal((await req('POST', '/api/auth/login', { email, password })).status, 200); };

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { await new Promise(r => server.close(r)); });

test('C19-1: una reincidencia con más de 6 h sale a Orlando en el corte, en su propio renglón', () => {
  const id = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, estado_autorizacion) VALUES ('R19-1','Mapfre','Honda Fit 2016 Plata','YNF065A','parcial')`).run().lastInsertRowid);
  const limite = new Date(Date.now() + 10 * 3600000).toISOString();
  db.prepare(`INSERT INTO complementos (siniestro_id, causa, fecha, pieza_operacion, decision, estado, tipo, fecha_limite, reincidencia)
    VALUES (?, 'x', '2026-11-18', 'BISAGRA', 'pendiente', 'documentando', 'no_autorizado_inicial', ?, 1)`).run(id, limite);
  db.prepare(`INSERT INTO complementos (siniestro_id, causa, fecha, pieza_operacion, decision, estado, tipo, fecha_limite, reincidencia)
    VALUES (?, 'x', '2026-11-18', 'FARO', 'pendiente', 'detectado', 'no_autorizado_inicial', ?, 0)`).run(id, limite);
  const c = require('../server/corteTarde').calcularCorteTarde(db);
  const o = c.personas.find(p => p.nombre === 'Orlando');
  assert.ok(o.renglones.some(r => /1 REINCIDENCIA sin resolver \(Honda Fit\)/.test(r)), JSON.stringify(o));
  assert.ok(!o.renglones.some(r => /por vencer/.test(r)), 'la normal con 10 h todavía no sale');
});

test('C19-2: al resolver la incidencia, la pieza pasa a "por llegar" con la fecha y ya no cuenta como mal surtida', async () => {
  await login('admin@serviciocristian.mx');
  const s = (await req('POST', '/api/siniestros', { numero: 'INC19-1', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'INC19-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Portaplaca delantero' })).data;
  const inc = (await req('POST', '/api/incidencias', { pieza_id: z.id, tipo: 'incorrecta', accion_solicitada: 'cambio' })).data;
  const D = require('../server/inicioDaniela');
  assert.ok(D.calcularInicioDaniela(db).mal.some(m => m.id === z.id), 'antes: mal surtida');
  const r = await req('PATCH', '/api/incidencias/' + inc.id, { estado: 'resuelta', resolucion: 'El proveedor surtirá la correcta', fecha_llegada: '2027-06-10' });
  assert.equal(r.status, 200);
  const pieza = db.prepare('SELECT * FROM piezas WHERE id=?').get(z.id);
  assert.equal(pieza.estatus, 'Confirmada'); assert.equal(pieza.fecha_prometida, '2027-06-10');
  assert.equal(db.prepare('SELECT estatus_operativo FROM pedidos WHERE id=?').get(p.id).estatus_operativo, 'Esperando proveedor');
  assert.ok(!D.calcularInicioDaniela(db).mal.some(m => m.id === z.id), 'después: ya no es mal surtida');
  const rec = await req('POST', `/api/piezas/${z.id}/recibir`);
  assert.equal(rec.status, 200); assert.equal(rec.data.estatus, 'Recibida físicamente');
});
