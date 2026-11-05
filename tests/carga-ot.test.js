// Carga de órdenes de trabajo por Claude (5-nov-2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-carga-ot.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const PORT = 3992, BASE = 'http://localhost:' + PORT, CLAVE = 'clave-ot-de-prueba-123';
let server;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

async function subir(siniestroId, buf = PDF, clave = CLAVE, tipo = 'application/pdf'){
  const fd = new FormData();
  fd.append('siniestro_id', String(siniestroId));
  fd.append('archivo', new Blob([buf], { type: tipo }), 'OT 7967160.pdf');
  const r = await fetch(BASE + '/api/externo/ot', { method:'POST', headers:{ Authorization:'Bearer ' + clave }, body: fd });
  return { status: r.status, data: await r.json().catch(()=>null) };
}
async function buscar(q, clave = CLAVE){
  const r = await fetch(BASE + '/api/externo/buscar-siniestro?q=' + encodeURIComponent(q), { headers:{ Authorization:'Bearer ' + clave } });
  return { status: r.status, data: await r.json().catch(()=>null) };
}

test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, estado_autorizacion) VALUES ('7967160','Inbursa','Chevrolet Corsa','YSL166A','autorizada')`).run();
  db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas) VALUES ('4264105293001635','Mapfre','VW Jetta','HBN-818-J')`).run();
});
test.after(async () => { delete process.env.CARGA_OT_TOKEN; await new Promise(r => server.close(r)); });

test('OT-1: apagada sin CARGA_OT_TOKEN y rechaza claves incorrectas', async () => {
  delete process.env.CARGA_OT_TOKEN;
  assert.equal((await buscar('7967160')).status, 503);
  process.env.CARGA_OT_TOKEN = CLAVE;
  assert.equal((await buscar('7967160', 'otra')).status, 401);
  assert.equal((await subir(1, PDF, 'otra')).status, 401);
});

test('OT-2: encuentra el expediente por número o placas, sin importar guiones ni espacios', async () => {
  process.env.CARGA_OT_TOKEN = CLAVE;
  assert.equal((await buscar('7967160')).data[0].placas, 'YSL166A');
  assert.equal((await buscar('hbn 818 j')).data[0].numero, '4264105293001635');
  assert.equal((await buscar('4264-1052-9300-1635')).data.length, 1);
  assert.deepEqual((await buscar('99999999')).data, []);
});

test('OT-3: sube la OT al expediente, no la duplica y Beto la ve en su lista y en su panorama', async () => {
  process.env.CARGA_OT_TOKEN = CLAVE;
  const s = db.prepare(`SELECT id FROM siniestros WHERE numero='7967160'`).get();
  const r = await subir(s.id);
  assert.equal(r.status, 201);
  assert.equal((await subir(s.id)).data.duplicada, true, 'la misma OT dos veces no se duplica');
  assert.equal((await subir(999999)).status, 404);
  assert.equal((await subir(s.id, Buffer.from('hola'), CLAVE, 'text/plain')).status >= 400, true, 'solo PDF o foto');
  const a = db.prepare(`SELECT * FROM archivos WHERE entidad_id=? AND tipo='Orden de trabajo'`).all(s.id);
  assert.equal(a.length, 1);
  assert.ok(db.prepare(`SELECT 1 FROM auditoria WHERE entidad_id=? AND accion='ot_cargada' AND usuario_nombre='Claude (carga de OT)'`).get(s.id));
  const { calcularPanoramaBeto } = require('../server/panoramaBeto');
  assert.equal(calcularPanoramaBeto(db).find(x => x.id === s.id).ot_archivo_id, a[0].id);

  // Se abre dentro del celular con ?ver=1.
  const login = await fetch(BASE + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ver = await fetch(BASE + `/api/archivos/${a[0].id}/descargar?ver=1`, { headers:{ Cookie: cookie } });
  assert.equal(ver.status, 200);
  assert.match(ver.headers.get('content-disposition'), /^inline/);
  const bandeja = await (await fetch(BASE + '/api/reportes/bandeja-produccion', { headers:{ Cookie: cookie } })).json();
  assert.equal(bandeja.find(x => x.id === s.id).ot_archivo_id, a[0].id);
});
