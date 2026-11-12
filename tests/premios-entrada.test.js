// Premios por llegar a tiempo (12-nov-2026): "Semana perfecta" y medallas por racha en el reporte de la mañana.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-premios-entrada.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const db = require('../server/db');
const A = require('../server/asistencia');
const { calcularReporteArranque } = require('../server/reporteArranque');
const uid = e => db.prepare('SELECT id, nombre FROM usuarios WHERE email = ?').get(e);
const reg = (u, fecha, retardo = 0) => db.prepare(`INSERT INTO asistencia (usuario_id, usuario_nombre, fecha, hora_local, retardo) VALUES (?,?,?,?,?)`)
  .run(u.id, u.nombre, fecha, retardo ? '09:20' : '08:50', retardo);

test('PREMIO-1: semana perfecta (lunes) solo nombra a quien llegó a tiempo todos los días que abrió el taller', () => {
  const marcelo = uid('marcelo.lopez'), jaime = uid('jaime.pacheco'), pedro = uid('pedro.aguirre');
  // Semana del lunes 2 al sábado 7 de nov 2026 (abrió los 6 días).
  for(const f of ['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07']){
    reg(marcelo, f);
    reg(jaime, f, f === '2026-11-04' ? 1 : 0); // un retardo
    if(f !== '2026-11-06') reg(pedro, f);    // faltó un día
  }
  const s = A.semanaPerfecta(db, '2026-11-09');
  assert.equal(s.dias, 6);
  assert.deepEqual(s.nombres, ['Marcelo López']);
  assert.equal(A.semanaPerfecta(db, '2026-11-10'), null); // solo los lunes
  const med = A.medallasVigentes(db, '2026-11-09');
  assert.deepEqual(med.map(m => [m.nombre, m.icono, m.racha]), [['Marcelo López', '🥉', 6]]);
  const r = calcularReporteArranque(db, new Date('2026-11-09T15:00:00Z'));
  assert.match(r.texto, /RECONOCIMIENTO/);
  assert.match(r.texto, /Semana perfecta\* \(a tiempo los 6 días\):\n• Marcelo López/);
  assert.match(r.texto, /🥉 Marcelo \(6\)/);
  assert.ok(!/Jaime|Pedro/.test(r.texto.split('RECONOCIMIENTO')[1].split('\n\n')[0]));
});
