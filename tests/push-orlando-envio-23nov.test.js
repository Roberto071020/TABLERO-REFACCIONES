// 23-nov-2026. Roberto: "que se genere el recordatorio para Orlando que si no termina en tablero no me va a llegar".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-push-orlando-envio.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
const llaves = require('web-push').generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = llaves.publicKey;
process.env.VAPID_PRIVATE_KEY = llaves.privateKey;

require('../server/index');
const db = require('../server/db');
const push = require('../server/push');

function unidad(numero, terminadaHaceHoras, extra = {}){
  const t = new Date(Date.now() - terminadaHaceHoras * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const c = { numero, aseguradora:'GNP', vehiculo:'Prueba ' + numero, placas:'ENV' + numero.slice(-3), estado_revision_tecnica:'revision_terminada', revision_tecnica_terminada_en: t, ...extra };
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
}

test('recuerda a Orlando terminar el envío después de 2 h, no antes', () => {
  const vieja = unidad('ENV001', 3);
  const nueva = unidad('ENV002', 0.5);
  const enviada = unidad('ENV003', 5, { enviado_propietario: 1 });
  const l = push.pendientesOrlando(db);
  const a = l.find(p => p.clave === `envio-${vieja}`);
  assert.ok(a, 'la de hace 3 h sí avisa');
  assert.match(a.cuerpo, /no le llega para valuar/);
  assert.ok(!l.some(p => p.clave === `envio-${nueva}`), 'la de hace media hora todavía no');
  assert.ok(!l.some(p => p.clave === `envio-${enviada}`), 'la ya enviada no');
});
