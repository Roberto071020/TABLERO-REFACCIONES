// Alta por volante (19-nov-2026): unidades asignadas por ANA/Inbursa dadas de alta antes de llegar, con datos por
// confirmar al recibirlas y sin duplicarse por placas/VIN.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-volante-19nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const A = require('../server/actualizacionUnidades');
const PORT = 3989;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const login = async (email, password = 'ServicioCristian2026!') => { cookie = ''; assert.equal((await req('POST', '/api/auth/login', { email, password })).status, 200); };
const hoy = () => require('../server/valesPendientes').hoyMX();
const masDias = n => new Date(Date.parse(hoy() + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
let id;

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { await new Promise(r => server.close(r)); });

test('VOL-1: el importador da de alta por volante (columna VOLANTE) y le sale a Alejandra con la explicación', () => {
  const r = A.aplicar(db, `SINIESTRO\tASEGURADORA\tVEHICULO\tPLACAS\tVIN\tUBICACION\tVOLANTE\n0426C7237-001\tANA\tAudi Q5 2019 Blanco\tYHY862C\t3U5AFDFY9K2016649\tTRANSITO\t${masDias(5)}`, null);
  assert.equal(r.aplicadas, 1, JSON.stringify(r.filas));
  const s = db.prepare(`SELECT * FROM siniestros WHERE numero='0426C7237-001'`).get(); id = s.id;
  assert.equal(s.volante_origen, 'ANA'); assert.equal(s.volante_vigencia, masDias(5)); assert.equal(s.vin, '3U5AFDFY9K2016649');
  const t = require('../server/inicioAlejandra').calcularInicioAlejandra(db).tarjetas.find(x => x.id === id);
  assert.equal(t.tipo, 'volante'); assert.equal(t.color, 'azul'); assert.match(t.motivo, /volante \(ANA\)/);
});

test('VOL-2: otro alta con las mismas placas pregunta; "es otro siniestro" sí la crea; con el mismo número no aplica', async () => {
  await login('admin@serviciocristian.mx');
  const r = await req('POST', '/api/siniestros', { numero:'OTRO-001', aseguradora:'GNP', placas:'yhy-862-c' });
  assert.equal(r.status, 409); assert.equal(r.data.coincide_volante.id, id); assert.match(r.data.error, /¿Es la misma unidad\?/);
  const r2 = await req('POST', '/api/siniestros', { numero:'OTRO-001', aseguradora:'GNP', placas:'YHY862C', es_otro_siniestro:1 });
  assert.equal(r2.status, 201, JSON.stringify(r2.data));
  const imp = A.analizar(db, 'SINIESTRO\tASEGURADORA\tPLACAS\nOTRO-002\tGNP\tYHY862C');
  assert.equal(imp.filas[0].accion, 'error');
  const imp2 = A.analizar(db, 'SINIESTRO\tASEGURADORA\tPLACAS\tOTRO SINIESTRO\nOTRO-002\tGNP\tYHY862C\tSI');
  assert.equal(imp2.filas[0].accion, 'crear');
});

test('VOL-3: al confirmar los datos (corrigiendo uno) la marca se quita y ya no se compara', async () => {
  await login('alejandra@serviciocristian.mx');
  const r = await req('POST', `/api/siniestros/${id}/confirmar-volante`, { vehiculo:'Audi Q5 2019 Blanco', placas:'YHY862C', vin:'3U5AFDFY9K2016649', cliente_nombre:'Roberto Marín', cliente_telefono:'2299807668', cliente_correo:'r@x.com', deducible_aplica:'1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.volante_confirmado_en); assert.equal(r.data.cliente_nombre, 'Roberto Marín'); assert.equal(r.data.deducible_aplica, 1);
  assert.equal((await req('POST', `/api/siniestros/${id}/confirmar-volante`, {})).status, 400);
  const t = require('../server/inicioAlejandra').calcularInicioAlejandra(db).tarjetas.find(x => x.id === id);
  assert.ok(!t || t.tipo !== 'volante');
  assert.equal(require('../server/volantes').buscarCoincidencia(db, { placas:'YHY862C', numero:'X' }), null);
});

test('VOL-4: volante vencido sale en rojo', () => {
  A.aplicar(db, `SINIESTRO\tASEGURADORA\tVEHICULO\tPLACAS\tUBICACION\tVOLANTE\n8009999\tInbursa\tVW Vento 2018\tABC1234\tTRANSITO\t${masDias(-1)}`, null);
  const s = db.prepare(`SELECT id FROM siniestros WHERE numero='8009999'`).get();
  const t = require('../server/inicioAlejandra').calcularInicioAlejandra(db).tarjetas.find(x => x.id === s.id);
  assert.equal(t.tipo, 'volante'); assert.equal(t.color, 'rojo'); assert.match(t.motivo, /venció/);
});
