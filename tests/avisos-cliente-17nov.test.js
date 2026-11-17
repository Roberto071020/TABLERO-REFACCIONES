// 17-nov-2026 (Roberto): "no en todos los expedientes se está generando el mensaje automático para que ella informe a
// los clientes". Autorización parcial, "en autorización" sin fecha de envío, autorizadas con refacciones sin número de
// piezas, y el número de piezas a cambio que sale de la OT de Roberto.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-avisos-17nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.LINEA_BASE_ALEJANDRA = '9999-12-31';
const CLAVE = 'clave-ot-prueba-17nov';
process.env.CARGA_OT_TOKEN = CLAVE;

const app = require('../server/index');
const db = require('../server/db');
const { calcularInicioAlejandra } = require('../server/inicioAlejandra');
const PORT = 3964;
let server;
test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { await new Promise(r => server.close(r)); });

function crear(numero, extra = {}){
  const c = Object.assign({ numero, aseguradora:'Mapfre', vehiculo:'Polo 2018', placas:'P-' + numero, cliente_nombre:'Cliente ' + numero,
    cliente_telefono:'2291234567', fecha_admision:'2026-11-01', ubicacion:'Tránsito' }, extra);
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
}
const tarjeta = id => calcularInicioAlejandra(db).tarjetas.find(t => t.id === id);

test('AV-1: autorizada con refacciones sin número de piezas -> "estamos consiguiendo tus piezas" (5.3), no 5.6/5.7', () => {
  const id = crear('AV-1', { estado_autorizacion:'autorizada', requiere_refacciones:'si', piezas_autorizadas_cambio:0 });
  const t = tarjeta(id);
  assert.equal(t.tipo, 'aviso'); assert.equal(t.codigo, '5.3');
});

test('AV-2: autorización parcial también avisa al cliente', () => {
  const id = crear('AV-2', { estado_autorizacion:'parcial', requiere_refacciones:'si', piezas_autorizadas_cambio:2 });
  assert.equal(tarjeta(id).codigo, '5.3');
});

test('AV-3: "en autorización" sin fecha de envío -> "tu presupuesto ya se envió" (5.2)', () => {
  const id = crear('AV-3', { estado_autorizacion:'en_autorizacion' });
  assert.equal(tarjeta(id).codigo, '5.2');
});

test('AV-4: si ya se avisó "ya autorizaron" (5.6/5.7) no se le repite como 5.3', () => {
  const id = crear('AV-4', { estado_autorizacion:'autorizada', requiere_refacciones:'si' });
  db.prepare(`INSERT INTO eventos_cliente (siniestro_id,direccion,canal,tipo_evento,mensaje) VALUES (?,?,?,?,?)`).run(id, 'saliente', 'whatsapp', 'aviso:5.7', 'x');
  const t = tarjeta(id);
  assert.ok(!t || t.codigo !== '5.3');
});

test('AV-5: sin teléfono queda en "falta el teléfono" y al capturarlo pasa a avisar', () => {
  const id = crear('AV-5', { estado_autorizacion:'autorizada', requiere_refacciones:'no', cliente_telefono:'' });
  assert.equal(tarjeta(id).tipo, 'sin_datos');
  db.prepare(`UPDATE siniestros SET cliente_telefono='2299876543' WHERE id=?`).run(id);
  assert.equal(tarjeta(id).tipo, 'aviso');
});

test('AV-6: al cargar la OT, las piezas a CAMBIO definen piezas_autorizadas_cambio', async () => {
  const id = crear('AV-6', { estado_autorizacion:'autorizada', requiere_refacciones:'si' });
  const r = await fetch(`http://localhost:${PORT}/api/externo/ot-piezas`, { method:'POST', headers:{ Authorization:'Bearer ' + CLAVE, 'Content-Type':'application/json' },
    body: JSON.stringify({ siniestro_id:id, piezas:[{ pieza:'Faro', laminacion:'CAMBIO', pintura:'N/A' }, { pieza:'Fascia', laminacion:'CAMBIO', pintura:'COMPLETA' }, { pieza:'Cofre', laminacion:'REPARAR', pintura:'RESANE' }] }) });
  assert.equal(r.status, 201, await r.text());
  assert.equal(db.prepare('SELECT piezas_autorizadas_cambio n FROM siniestros WHERE id=?').get(id).n, 2);
});
