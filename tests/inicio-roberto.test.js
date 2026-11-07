// Inicio de Roberto (7-nov-2026): valuar -> esperar respuesta -> arrancar, complementos y alertas del taller.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-inicio-roberto.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.LINEA_BASE_ROBERTO = '2000-01-01';
process.env.LINEA_BASE_ALEJANDRA = '9999-12-31';
process.env.LINEA_BASE_DANIELA = '9999-12-31';

const app = require('../server/index');
const db = require('../server/db');
const PORT = 3985;
let server, cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' }; if(cookie) h.Cookie = cookie;
  const r = await fetch('http://localhost:' + PORT + url, { method, headers:h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const t = await r.text(); let data = t; try{ data = JSON.parse(t); }catch(e){}
  return { status: r.status, data };
}
async function login(e, p){ cookie = ''; assert.equal((await req('POST', '/api/auth/login', { email:e, password:p })).status, 200); }
const ADMIN = ['admin@serviciocristian.mx', 'ServicioCristian2026!'];
function crear(numero, extra = {}){
  const c = Object.assign({ numero, aseguradora:'Mapfre', vehiculo:'Versa ' + numero, placas:'YK' + numero.slice(-3) }, extra);
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
}
const inicio = async () => { const r = await req('GET', '/api/inicio-roberto'); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); await login(...ADMIN); });
test.after(async () => { await new Promise(r => server.close(r)); });

test('ROB-1: por valuar -> "Valué y envié" -> esperando -> "Llegó la respuesta" -> por arrancar -> expediente enviado', async () => {
  const id = crear('RB-0001', { estado_expediente:'listo_para_valuacion' });
  let d = await inicio();
  assert.ok(d.por_valuar.some(x => x.id === id));
  let r = await req('PATCH', '/api/siniestros/' + id, { valuacion_fecha_envio:'2026-11-02', estado_valuacion:'enviada', estado_autorizacion:'en_autorizacion', autorizacion_fecha_envio:'2026-11-02' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  d = await inicio();
  assert.ok(!d.por_valuar.some(x => x.id === id));
  const e = d.esperando.find(x => x.id === id);
  assert.ok(e); assert.equal(e.vencida, true, 'más de 3 días hábiles sin respuesta');
  r = await req('PATCH', '/api/siniestros/' + id, { estado_autorizacion:'autorizada', piezas_autorizadas_cambio:2, autorizador:'Ajustador',
    autorizacion_fecha_respuesta:'2026-11-06', valuacion_fecha_respuesta:'2026-11-06', estado_valuacion:'autorizada_total' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  d = await inicio();
  assert.ok(!d.esperando.some(x => x.id === id));
  const a = d.por_arrancar.find(x => x.id === id);
  assert.ok(a); assert.ok(a.faltan.includes('la orden de trabajo'));
  assert.equal((await req('PATCH', `/api/siniestros/${id}/enviar-expediente-completo`, {})).status, 200);
  d = await inicio();
  assert.ok(!d.por_arrancar.some(x => x.id === id));
});

test('ROB-2: línea base -- lo autorizado antes del día de arranque no aparece en "Por arrancar"', async () => {
  const id = crear('RB-0002', { estado_autorizacion:'autorizada', autorizador:'X', autorizacion_fecha_respuesta:'2026-11-01' });
  db.prepare(`INSERT INTO auditoria (entidad_tipo, entidad_id, accion, campo, valor_nuevo, fecha) VALUES ('siniestro', ?, 'actualizacion_masiva', 'estado_autorizacion', 'autorizada', '2026-11-07 18:00:00')`).run(id);
  process.env.LINEA_BASE_ROBERTO = '2026-11-09';
  delete require.cache[require.resolve('../server/inicioRoberto')];
  const { calcularInicioRoberto } = require('../server/inicioRoberto');
  assert.ok(!calcularInicioRoberto(db, { alertas:false }).por_arrancar.some(x => x.id === id));
  process.env.LINEA_BASE_ROBERTO = '2000-01-01';
  delete require.cache[require.resolve('../server/inicioRoberto')];
  assert.ok(require('../server/inicioRoberto').calcularInicioRoberto(db, { alertas:false }).por_arrancar.some(x => x.id === id));
});

test('ROB-3: reautorización con 6 h o menos aparece; complemento de más de $1,000 se decide desde aquí', async () => {
  const s1 = crear('RB-0003', { estado_autorizacion:'autorizada' });
  db.prepare(`INSERT INTO complementos (siniestro_id, causa, pieza_operacion, tipo, fecha_limite, estado, decision) VALUES (?, 'x', 'Faro', 'no_autorizado_inicial', ?, 'detectado', 'pendiente')`)
    .run(s1, new Date(Date.now() + 3 * 3600000).toISOString());
  const s2 = crear('RB-0004', { estado_autorizacion:'autorizada', estado_produccion:'en_laminado' });
  const c = Number(db.prepare(`INSERT INTO complementos (siniestro_id, causa, importe, tipo, estado, decision) VALUES (?, 'Larguero', 2500, 'dano_oculto', 'enviado', 'pendiente')`).run(s2).lastInsertRowid);
  let d = await inicio();
  assert.ok(d.reautorizaciones.some(x => x.id === s1 && x.horas_restantes <= 3));
  assert.ok(d.complementos.some(x => x.complemento_id === c));
  assert.equal((await req('PATCH', '/api/complementos/' + c, { decision:'autorizado' })).status, 200);
  d = await inicio();
  assert.ok(!d.complementos.some(x => x.complemento_id === c));
});

test('ROB-4: alertas del taller solo muestran lo atorado (entregas vencidas)', async () => {
  const id = crear('RB-0005', { estado_autorizacion:'autorizada', fecha_entrega_prevista:'2026-10-01', estado_produccion:'pintura' });
  const d = await inicio();
  const a = d.alertas.find(x => x.clave === 'vencidas');
  assert.ok(a && a.items.some(x => x.id === id));
  assert.ok(d.alertas.every(x => x.items.length > 0));
});

test('ROB-5: solo Roberto (admin/jefe) ve esta pantalla', async () => {
  await login('alejandra@serviciocristian.mx', 'ServicioCristian2026!');
  assert.equal((await req('GET', '/api/inicio-roberto')).status, 403);
  await login(...ADMIN);
});
