// Aviso del reporte de arranque y del corte de las 3 desde SC Control (13-nov-2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-aviso-reportes.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

require('../server/index'); // siembra los usuarios
const db = require('../server/db');
const push = require('../server/push');
const { enviarAvisoReportes } = require('../server/avisoReportes');
push.asegurarTablas(db);
const admin = db.prepare(`SELECT id FROM usuarios WHERE email='admin@serviciocristian.mx'`).get().id;
const beto = db.prepare(`SELECT id FROM usuarios WHERE email='beto@serviciocristian.mx'`).get().id;
for(const [u, n] of [[admin, 1], [beto, 2]]) db.prepare(`INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth) VALUES (?,?,?,?)`).run(u, 'https://push.example/' + n, 'k', 'a');
const enviados = [];
const enviar = async (sub, payload) => { enviados.push({ sub, p: JSON.parse(payload) }); };
const hora = (dia, hhmm) => new Date(`${dia}T${hhmm}:00-06:00`); // hora de Veracruz

test('AVREP-1: a las 7:20 le llega a Roberto el aviso del reporte de arranque, una sola vez, y abre la página', async () => {
  await enviarAvisoReportes(db, { ahora: hora('2026-11-13', '07:10'), enviar });
  assert.equal(enviados.length, 0); // todavía no
  await enviarAvisoReportes(db, { ahora: hora('2026-11-13', '07:21'), enviar });
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].sub.endpoint, 'https://push.example/1'); // solo Roberto, no Beto
  assert.equal(enviados[0].p.titulo, '🔧 Reporte de arranque listo');
  assert.equal(enviados[0].p.url, '/reporte-dia.html');
  assert.match(enviados[0].p.cuerpo, /vencidas?, .*listas para iniciar/);
  await enviarAvisoReportes(db, { ahora: hora('2026-11-13', '07:40'), enviar });
  assert.equal(enviados.length, 1); // no se repite
});

test('AVREP-2: el corte de las 3 sale a las 14:55; domingo no sale nada', async () => {
  await enviarAvisoReportes(db, { ahora: hora('2026-11-13', '14:56'), enviar });
  assert.equal(enviados.length, 2);
  assert.equal(enviados[1].p.titulo, '⏱️ Corte de las 3 listo');
  assert.equal(enviados[1].p.url, '/reporte-dia.html?tipo=corte');
  await enviarAvisoReportes(db, { ahora: hora('2026-11-15', '07:30'), enviar });
  assert.equal(enviados.length, 2);
  // Al día siguiente vuelve a salir.
  await enviarAvisoReportes(db, { ahora: hora('2026-11-14', '07:25'), enviar });
  assert.equal(enviados.length, 3);
});
