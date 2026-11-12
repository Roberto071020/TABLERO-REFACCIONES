// Acceso completo de Claude (12-nov-2026). Roberto: "haz lo necesario para que puedas realizar todo lo que yo te pida
// sin restricciones".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-acceso-claude.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.LINEA_BASE_DANIELA = '9999-12-31';
process.env.LINEA_BASE_ALEJANDRA = '9999-12-31';
delete process.env.CLAUDE_TOKEN;

const app = require('../server/index');
const db = require('../server/db');

const PORT = 3994;
const BASE = 'http://localhost:' + PORT + '/api/externo/claude';
let server;
async function req(method, url, body, token = 'clave-claude-prueba'){
  const h = { 'Content-Type':'application/json' };
  if(token) h.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text(); let data = txt; try { data = JSON.parse(txt); } catch(e) {}
  return { status: res.status, data, cookie: res.headers.get('set-cookie') };
}

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(() => { server.close(); });

test('sin CLAUDE_TOKEN está apagado; con clave equivocada, 401', async () => {
  assert.equal((await req('GET', '/siniestros')).status, 503);
  process.env.CLAUDE_TOKEN = 'clave-claude-prueba';
  assert.equal((await req('GET', '/siniestros', null, 'otra')).status, 401);
  assert.equal((await req('GET', '/siniestros', null, null)).status, 401);
});

test('usa las mismas rutas de la pantalla, sin cookie, y queda en la auditoría con su nombre', async () => {
  process.env.CLAUDE_TOKEN = 'clave-claude-prueba';
  const sid = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, vehiculo, placas, estado_produccion, estado_autorizacion)
    VALUES ('AC-001','Mapfre','BMW X1 2018','RRP141A','detenido','autorizada')`).run().lastInsertRowid);
  const g = await req('GET', '/siniestros/' + sid);
  assert.equal(g.status, 200);
  assert.equal(g.cookie, null, 'no crea sesión');
  const p = await req('PATCH', '/siniestros/' + sid, { estado_produccion:'detenido', detenido_motivo:'falta_pieza', detenido_nota:'Espera radiador auxiliar y lodera' });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const s = db.prepare('SELECT detenido_motivo FROM siniestros WHERE id = ?').get(sid);
  assert.equal(s.detenido_motivo, 'falta_pieza');
  const a = db.prepare(`SELECT usuario_nombre FROM auditoria WHERE entidad_id = ? AND campo = 'detenido_motivo' ORDER BY id DESC`).get(sid);
  assert.equal(a.usuario_nombre, 'Claude (por indicación de Roberto)');
  const u = db.prepare(`SELECT activo, rol FROM usuarios WHERE email = 'claude@sistema.sc'`).get();
  assert.deepEqual({ ...u }, { activo: 0, rol: 'admin' }, 'nadie puede iniciar sesión con este usuario');
});

test('usuarios, contraseñas y respaldos quedan fuera', async () => {
  process.env.CLAUDE_TOKEN = 'clave-claude-prueba';
  assert.notEqual((await req('GET', '/auth/usuarios')).status, 200);
  assert.notEqual((await req('POST', '/auth/usuarios', { nombre:'x', email:'x@x.mx', password:'12345678' })).status, 201);
  const r = await req('GET', '/respaldos');
  assert.ok(r.status !== 200 || typeof r.data === 'string', 'no regresa la lista de respaldos');
});
