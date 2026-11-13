// 13-nov-2026 (solicitud de Orlando aprobada por Roberto): tipo de reparación al terminar la revisión, autosurtido con
// piezas para Daniela fuera del indicador de captura, revisiones recientes editables y reautorización "con Daniela".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-orlando-13nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const { calcularInicioOrlando } = require('../server/inicioOrlando');
const { calcularInicioDaniela } = require('../server/inicioDaniela');
const { calcularInicioRoberto } = require('../server/inicioRoberto');

const PORT = 3962;
let server; const ses = {};
async function req(q, method, url, body){
  const h = { 'Content-Type':'application/json' }; if(ses[q]) h.Cookie = ses[q];
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) ses[q] = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
const sin = (numero, extra = {}) => {
  const c = Object.assign({ numero, aseguradora:'GNP', vehiculo:'Aveo ' + numero, placas:'P-' + numero }, extra);
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
};

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  for(const [q, e, p] of [['orl','orlando@serviciocristian.mx','ServicioCristian2026!'], ['dan','daniela@serviciocristian.mx','ServicioCristian2026-Reset!'], ['adm','admin@serviciocristian.mx','ServicioCristian2026!']])
    assert.equal((await req(q, 'POST', '/api/auth/login', { email:e, password:p })).status, 200, e);
});
test.after(() => server.close());

test('ORL-1: autosurtido no cuenta en captura; sus piezas le llegan a Daniela y ella puede completarlas', async () => {
  const a = sin('AS-1', { fecha_hora_disponible_revision: '2026-11-13 10:00:00' });
  const t = sin('TR-1', { fecha_hora_disponible_revision: '2026-11-13 10:00:00' });
  assert.equal((await req('orl', 'PATCH', '/api/siniestros/' + t, { estado_revision_tecnica:'revision_terminada', tipo_reparacion:'TRADICIONAL' })).status, 200);
  assert.equal((await req('orl', 'PATCH', '/api/siniestros/' + a, { estado_revision_tecnica:'revision_terminada', tipo_reparacion:'AUTO_SURTIDO' })).status, 200);
  let o = calcularInicioOrlando(db);
  assert.ok(o.captura.some(x => x.siniestro_id === t), 'tradicional sí va a captura');
  assert.ok(!o.captura.some(x => x.siniestro_id === a), 'autosurtido no cuenta en captura');
  assert.ok(o.revisadas.some(x => x.siniestro_id === a && x.tipo_reparacion === 'AUTO_SURTIDO'), 'aparece en revisiones recientes');
  const p = await req('orl', 'POST', '/api/autosurtido-piezas', { siniestro_id: a, pieza:'Fascia delantera' });
  assert.equal(p.status, 201);
  await req('orl', 'PATCH', '/api/siniestros/' + a, { enviado_propietario:1, enviado_propietario_fecha:'2026-11-13' });
  const d = calcularInicioDaniela(db);
  const it = d.autosurtido.find(x => x.siniestro_id === a);
  assert.ok(it && it.piezas === 1 && /Fascia/.test(it.lista));
  assert.equal((await req('dan', 'PATCH', '/api/autosurtido-piezas/' + p.data.id, { costo: 1200, tiempo_entrega:'2 días', proveedor_nombre:'Radec' })).status, 200);
  // cambiar tipo después de revisada
  assert.equal((await req('orl', 'PATCH', '/api/siniestros/' + t, { tipo_reparacion:'EXPRES' })).status, 200);
  assert.equal(db.prepare('SELECT tipo_reparacion FROM siniestros WHERE id=?').get(t).tipo_reparacion, 'EXPRES');
});

test('ORL-2: "Depende de Daniela" detiene el reloj y al regresar conserva las horas que quedaban', async () => {
  const s = sin('RA-1');
  const c = await req('adm', 'POST', '/api/complementos', { siniestro_id: s, tipo:'no_autorizado_inicial', causa:'Piezas no autorizadas por la aseguradora', pieza_operacion:'MOLDURA' });
  db.prepare(`UPDATE complementos SET fecha_limite=? WHERE id=?`).run(new Date(Date.now() + 5*3600000).toISOString(), c.data.id);
  assert.equal((await req('orl', 'POST', `/api/complementos/${c.data.id}/con-daniela`, { nota:'' })).status, 400, 'nota obligatoria');
  assert.equal((await req('orl', 'POST', `/api/complementos/${c.data.id}/con-daniela`, { nota:'Confirmar con proveedor' })).status, 200);
  const o = calcularInicioOrlando(db).reautorizar.find(x => x.id === c.data.id);
  assert.equal(o.con_daniela, 1); assert.equal(o.horas_restantes, null);
  assert.ok(!calcularInicioRoberto(db, { alertas:false }).reautorizaciones.some(x => x.complemento_id === c.data.id), 'Roberto no la ve como por vencer');
  assert.ok(calcularInicioDaniela(db).reautorizaciones.some(x => x.id === c.data.id), 'Daniela la ve');
  // aunque pase el plazo original mientras está con Daniela, no vence
  db.prepare(`UPDATE complementos SET fecha_limite=? WHERE id=?`).run(new Date(Date.now() - 3600000).toISOString(), c.data.id);
  assert.equal((await req('orl', 'POST', `/api/complementos/${c.data.id}/daniela-listo`, {})).status, 403, 'solo Daniela la regresa');
  const r = await req('dan', 'POST', `/api/complementos/${c.data.id}/daniela-listo`, { respuesta:'No incluye molduras' });
  assert.equal(r.status, 200);
  const horas = (Date.parse(r.data.fecha_limite) - Date.now()) / 3600000;
  assert.ok(horas > 4.8 && horas <= 5.01, 'regresa con ~5 h: ' + horas);
  assert.match(r.data.causa, /Daniela: No incluye molduras/);
  assert.equal(calcularInicioOrlando(db).reautorizar.find(x => x.id === c.data.id).con_daniela, 0);
});

test('ORL-3: "No está terminada" regresa la unidad a Beto como detenida con el motivo', async () => {
  const { listarDetenidas } = require('../server/detenidas');
  const s = sin('NT-1', { estado_produccion:'terminado' });
  assert.equal((await req('dan', 'POST', `/api/inicio-orlando/calidad-pendiente/${s}/no-terminada`, { nota:'' })).status, 400);
  const r = await req('dan', 'POST', `/api/inicio-orlando/calidad-pendiente/${s}/no-terminada`, { nota:'Falta la programación' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const u = db.prepare('SELECT estado_produccion, detenido_motivo, detenido_nota FROM siniestros WHERE id=?').get(s);
  assert.equal(u.estado_produccion, 'detenido'); assert.equal(u.detenido_motivo, 'no_terminada');
  assert.match(u.detenido_nota, /programación \(reporta Daniela\)/);
  const d = listarDetenidas(db).find(x => x.id === s);
  assert.equal(d.quien, 'Beto');
  assert.equal((await req('dan', 'POST', `/api/inicio-orlando/calidad-pendiente/${s}/no-terminada`, { nota:'x' })).status, 400, 'ya no está terminada');
});
