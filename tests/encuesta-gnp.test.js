// Encuesta GNP en la entrega (11-nov-2026). Roberto: "si el cliente quedó en desacuerdo con algo es mejor sin
// respuesta a una mala calificación" y "No sería mejor pedirlo al momento de la entrega aquí en oficina?".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-encuesta-gnp.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.LINEA_BASE_ALEJANDRA = '9999-12-31';

require('../server/index');
const db = require('../server/db');
const whatsappFaseA = require('../server/whatsappFaseA');
const { calcularInicioAlejandra, hoyMX } = require('../server/inicioAlejandra');
const { calcularInicioRoberto } = require('../server/inicioRoberto');

const HOY = hoyMX();
const dia = n => new Date(Date.parse(HOY) + n * 86400000).toISOString().slice(0, 10);
function crear(numero, extra = {}){
  const c = Object.assign({ numero, aseguradora:'GNP', vehiculo:'Versa 2020', placas:'YK-' + numero.slice(-3), cliente_nombre:'Cliente ' + numero,
    cliente_telefono:'229 123 4567', estado_calidad:'liberado', fecha_entrega_real: dia(-3), estado_entrega:'entregado', finiquito_estado:'firmado' }, extra);
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
}
const tarjetas = id => calcularInicioAlejandra(db).tarjetas.filter(t => t.id === id);

test('GNP conforme: a los días de la entrega, el aviso de postventa le recuerda la encuesta', () => {
  const id = crear('EG-001', { encuesta_estado:'enviada', entrega_encuesta_gnp_solicitada: 1 });
  const t = tarjetas(id).find(x => x.codigo === '5.12');
  assert.ok(t, 'debe tener el aviso 5.12');
  assert.match(t.motivo, /encuesta de GNP/);
  assert.match(t.texto, /encuesta/);
});

test('GNP inconforme: nunca se le pide ni se le recuerda la encuesta', () => {
  const id = crear('EG-002', { encuesta_estado:'no_solicitar', encuesta_comentarios:'Inconforme en la entrega: tono de pintura' });
  assert.equal(tarjetas(id).some(x => x.codigo === '5.12'), false);
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(id);
  assert.equal(whatsappFaseA.vigenciaPlantillaPrincipal(db, s, '5.12'), false);
});

test('otra aseguradora: el aviso de postventa no menciona la encuesta de GNP', () => {
  const id = crear('EG-003', { aseguradora:'Allianz' });
  const t = tarjetas(id).find(x => x.codigo === '5.12');
  assert.ok(t);
  assert.doesNotMatch(t.texto, /GNP/);
});

test('Roberto ve a los clientes GNP inconformes de los últimos 15 días, con el motivo', () => {
  crear('EG-004', { encuesta_estado:'no_solicitar', encuesta_comentarios:'Inconforme en la entrega: tardaron mucho', fecha_entrega_real: dia(-30) });
  const a = calcularInicioRoberto(db).alertas.find(x => x.clave === 'inconformes');
  assert.ok(a);
  const nums = a.items.map(i => i.numero);
  assert.ok(nums.includes('EG-002'));
  assert.ok(!nums.includes('EG-004'), 'más de 15 días ya no se muestra');
  assert.match(a.items.find(i => i.numero === 'EG-002').detalle, /tono de pintura/);
});
