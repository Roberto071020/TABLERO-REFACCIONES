// 23-nov-2026. Roberto: "Si, eso y todo lo que consideres le debe llegar" (avisos push de Beto).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-push-beto-23nov.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
const llaves = require('web-push').generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = llaves.publicKey;
process.env.VAPID_PRIVATE_KEY = llaves.privateKey;

require('../server/index');
const db = require('../server/db');
const push = require('../server/push');

const AHORA = new Date('2026-11-23T17:00:00Z'); // lunes 11:00 en Veracruz
let n = 0;
function unidad(campos){
  n++;
  const base = { numero:'BETO' + n, aseguradora:'GNP', vehiculo:'Prueba ' + n, placas:'BET' + n, ubicacion:'Piso', estado_autorizacion:'autorizada', requiere_refacciones:'no' };
  const c = { ...base, ...campos };
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
}
const claves = (usuario) => push.pendientesExtraBeto(db, usuario, AHORA).map(p => p.clave);
const beto = db.prepare(`SELECT id, rol FROM usuarios WHERE rol = 'beto' LIMIT 1`).get();

test('GNP en piso sin fecha avisa; en tránsito no', () => {
  const piso = unidad({});
  const transito = unidad({ ubicacion:'Tránsito' });
  const c = claves(beto);
  assert.ok(c.includes(`sinfecha-${piso}`));
  assert.ok(!c.includes(`sinfecha-${transito}`));
  const aviso = push.pendientesExtraBeto(db, beto, AHORA).find(p => p.clave === `sinfecha-${piso}`);
  assert.match(aviso.cuerpo, /indicador/);
});

test('no GNP sin piezas no avisa sin fecha; con piezas sí', () => {
  const sinPiezas = unidad({ aseguradora:'Mapfre', requiere_refacciones:'si' });
  const listas = unidad({ aseguradora:'Mapfre', requiere_refacciones:'no' });
  const c = claves(beto);
  assert.ok(!c.includes(`sinfecha-${sinPiezas}`));
  assert.ok(c.includes(`sinfecha-${listas}`));
});

test('fecha vencida, hoy y mañana', () => {
  const venc = unidad({ fecha_entrega_prevista:'2026-11-20' });
  const hoy = unidad({ fecha_entrega_prevista:'2026-11-23' });
  const man = unidad({ fecha_entrega_prevista:'2026-11-24' });
  const lejos = unidad({ fecha_entrega_prevista:'2026-12-10' });
  const l = push.pendientesExtraBeto(db, beto, AHORA);
  assert.ok(l.find(p => p.clave === `vencida-${venc}-2026-11-20`));
  assert.equal(l.find(p => p.clave === `vence-${hoy}-2026-11-23`).titulo, '⏰ Se entrega hoy');
  assert.equal(l.find(p => p.clave === `vence-${man}-2026-11-24`).titulo, '⏰ Se entrega mañana');
  assert.ok(!l.some(p => p.clave.includes(`-${lejos}-`) || p.clave === `sinfecha-${lejos}`));
});

test('reingreso reciente, OT nueva y aviso dejado a Beto', () => {
  const r = unidad({ fecha_entrega_prevista:'2026-12-10', reingreso_recibido_en: new Date().toISOString() });
  const ot = Number(db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, nombre_original, nombre_almacenado, mime, tamano) VALUES ('siniestro', ?, 'Orden de trabajo', 'OT.pdf', 'x.pdf', 'application/pdf', 1)`).run(r).lastInsertRowid);
  const t = Number(db.prepare(`INSERT INTO tareas (siniestro_id, tipo, descripcion, responsable_id, estado, origen) VALUES (?, 'aviso', 'Beto: coloca la fecha', ?, 'pendiente', 'manual')`).run(r, beto.id).lastInsertRowid);
  const l = push.pendientesExtraBeto(db, beto, AHORA);
  assert.ok(l.some(p => p.clave.startsWith(`reingreso-${r}-`)));
  assert.ok(l.some(p => p.clave === `ot-${ot}`));
  const a = l.find(p => p.clave === `tarea-${t}`);
  assert.ok(a);
  assert.match(a.cuerpo, /coloca la fecha/);
  assert.ok(!/Beto:/.test(a.cuerpo));
  assert.ok(!push.pendientesExtraBeto(db, null, AHORA).some(p => p.clave === `tarea-${t}`), 'sin usuario no hay tareas');
});

test('la fuente de Beto es por persona e incluye lo anterior', () => {
  const f = push.FUENTES.beto;
  assert.equal(f.porUsuario, true);
  assert.ok(Array.isArray(f(db, beto)));
  assert.ok(f(db, beto).some(p => p.clave.startsWith('tarea-')));
});
