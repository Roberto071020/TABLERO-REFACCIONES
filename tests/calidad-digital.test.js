// Checklist de calidad digital por OT (12-nov-2026). Roberto: "que ese checklist se tuviera de manera digital dentro
// de SC Control y se pudiera contestar ahí mismo desde el teléfono".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-calidad-digital.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.LINEA_BASE_DANIELA = '9999-12-31';
process.env.LINEA_BASE_ALEJANDRA = '9999-12-31';
process.env.CARGA_OT_TOKEN = 'clave-ot-prueba';

const app = require('../server/index');
const db = require('../server/db');
const C = require('../server/calidadDigital');
const { unidadesPorRevisarCalidad } = require('../server/calidadPendiente');

const PORT = 3993;
const BASE = 'http://localhost:' + PORT;
let server, cookie = '';
async function req(method, url, body, extra = {}){
  const h = { 'Content-Type':'application/json', ...extra };
  if(cookie) h.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const txt = await res.text(); let data = txt; try { data = JSON.parse(txt); } catch(e) {}
  return { status: res.status, data };
}
async function login(email, password){ cookie = ''; const r = await req('POST', '/api/auth/login', { email, password }); assert.equal(r.status, 200, 'login ' + email); }
const BETO = ['beto@serviciocristian.mx', 'ServicioCristian2026!'];

const OT_VERSA = [
  { pieza:'PARRILLA SUPERIOR', laminacion:'CAMBIO', pintura:'N/A' },
  { pieza:'FASCIA DELANTERA', laminacion:'CAMBIO', pintura:'COMPLETA' },
  { pieza:'SALPICADERA IZQUIERDA', laminacion:'REPARAR', pintura:'RESANE' },
  { pieza:'FARO IZQUIERDO (PULIR)', laminacion:'REVISAR', pintura:'PULIR' },
  { pieza:'GRAPAS', laminacion:'AUTORIZADO', pintura:'N/A' },
  { pieza:'LARGUERO DELANTERO IZQUIERDO', laminacion:'NO AUTORIZADO', pintura:'N/A' },
  { pieza:'MOLDURA DE FARO', laminacion:'NO AUTORIZADO', pintura:'N/A' },
];

test('puntos: aviso de seguridad, 8 generales y uno por pieza autorizada', () => {
  const p = C.puntosCalidad(OT_VERSA);
  assert.equal(p[0].seccion, 'Avisos de seguridad');
  assert.match(p[0].texto, /LARGUERO DELANTERO IZQUIERDO \(NO AUTORIZADO\)/);
  assert.equal(p.filter(x => x.critico).length, 1, 'la moldura no autorizada no es aviso de seguridad');
  assert.equal(p.filter(x => x.seccion === 'General').length, 8);
  const ot = p.filter(x => x.seccion === 'Trabajos de la OT');
  assert.equal(ot.length, 5, 'las no autorizadas no se revisan como trabajo hecho');
  assert.match(ot.find(x => /FASCIA/.test(x.texto)).texto, /Cambio \+ pintura completa: pieza nueva .*; tono, brillo/);
  assert.match(ot.find(x => /SALPICADERA/.test(x.texto)).texto, /Reparación \+ resane/);
  assert.equal(C.puntosCalidad([]).length, 8, 'sin OT: solo los generales');
});

test('flujo completo: Claude carga piezas, Beto revisa desde el celular, corrige y libera', async () => {
  const sid = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, estado_produccion) VALUES ('CD-001','GNP','Versa 2025','S/P','terminado')`).run().lastInsertRowid);
  // Rechazo del checklist anterior: no debe impedir liberar después de la revisión digital.
  db.prepare(`INSERT INTO checklist_calidad (siniestro_id, dimension, resultado, hallazgo) VALUES (?, 'Pintura/acabado', 'rechazado', 'polvo')`).run(sid);

  cookie = '';
  const sinClave = await req('POST', '/api/externo/ot-piezas', { siniestro_id: sid, piezas: OT_VERSA });
  assert.equal(sinClave.status, 401);
  const carga = await req('POST', '/api/externo/ot-piezas', { siniestro_id: sid, piezas: OT_VERSA }, { Authorization:'Bearer clave-ot-prueba' });
  assert.equal(carga.status, 201);
  assert.equal(carga.data.piezas, 7);
  assert.equal(carga.data.puntos, 14);

  await login(...BETO);
  const g = await req('GET', '/api/calidad/' + sid);
  assert.equal(g.status, 200);
  assert.equal(g.data.tiene_ot, true);
  const puntos = g.data.puntos;

  const incompleta = await req('POST', '/api/calidad/' + sid, { respuestas: [{ clave: puntos[0].clave, resultado: 'cumple' }] });
  assert.equal(incompleta.status, 400);

  const fascia = puntos.find(p => /FASCIA/.test(p.texto)).clave;
  const resp = puntos.map(p => ({ clave: p.clave, resultado: p.clave === fascia ? 'no_cumple' : 'cumple' }));
  assert.equal((await req('POST', '/api/calidad/' + sid, { respuestas: resp })).status, 400, 'no cumple sin decir qué corregir');
  resp.find(r => r.clave === fascia).observacion = 'Fascia desalineada del lado izquierdo';
  const mal = await req('POST', '/api/calidad/' + sid, { respuestas: resp });
  assert.equal(mal.status, 200);
  assert.equal(mal.data.todo_bien, false);
  const pend = unidadesPorRevisarCalidad(db).find(u => u.id === sid);
  assert.equal(pend.rechazados[0].dimension, 'Fascia desalineada del lado izquierdo');

  const bien = await req('POST', '/api/calidad/' + sid, { respuestas: puntos.map(p => ({ clave: p.clave, resultado: 'cumple' })) });
  assert.equal(bien.data.todo_bien, true);
  const lib = await req('PATCH', '/api/siniestros/' + sid, { estado_calidad: 'liberado' });
  assert.equal(lib.status, 200, JSON.stringify(lib.data));
  assert.equal(lib.data.estado_calidad, 'liberado');
  const g2 = await req('GET', '/api/calidad/' + sid);
  assert.ok(g2.data.puntos.every(p => p.resultado === 'cumple' && p.inspector_nombre));
});

test('unidad sin piezas de OT: se revisa con los 8 puntos generales', async () => {
  const sid = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, estado_produccion) VALUES ('CD-002','GNP','Aveo','YAA111A','terminado')`).run().lastInsertRowid);
  await login(...BETO);
  const g = await req('GET', '/api/calidad/' + sid);
  assert.equal(g.data.tiene_ot, false);
  assert.equal(g.data.puntos.length, 8);
});

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(() => { server.close(); });
