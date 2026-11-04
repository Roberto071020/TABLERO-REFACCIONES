// Pruebas de Fotos de la unidad (4-nov-2026): subir, ver, descargar (una y .zip), fotos obligatorias por
// etapa y borrado automático por antigüedad / espacio.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-fotos.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const F = require('../server/fotos');

const PORT = 3993;
const BASE = 'http://localhost:' + PORT;
let server;
let cookie = '';

async function req(method, url, body){
  const h = { 'Content-Type':'application/json' };
  if(cookie) h.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await res.arrayBuffer());
  let data = buf; try { data = JSON.parse(buf.toString('utf8')); } catch(e) {}
  return { status: res.status, data, headers: res.headers };
}
async function login(email, password){
  cookie = '';
  const r = await req('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200);
}
const ADMIN = ['admin@serviciocristian.mx','ServicioCristian2026!'];
const DANIELA = ['daniela@serviciocristian.mx','ServicioCristian2026-Reset!'];

// JPEG mínimo válido (1x1) para las pruebas.
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

async function subirFoto(siniestroId, etapa, { mime = 'image/jpeg', conMini = true } = {}){
  const fd = new FormData();
  fd.append('siniestro_id', String(siniestroId));
  fd.append('etapa', etapa);
  fd.append('foto', new Blob([JPG], { type: mime }), 'IMG_0001.jpg');
  if(conMini) fd.append('miniatura', new Blob([JPG], { type:'image/jpeg' }), 'mini.jpg');
  const res = await fetch(BASE + '/api/fotos', { method:'POST', headers: cookie ? { Cookie: cookie } : {}, body: fd });
  let data = null; try { data = await res.json(); } catch(e) {}
  return { status: res.status, data };
}
function crearSiniestro(numero, extra = {}){
  const campos = Object.assign({ numero, aseguradora:'GNP', vehiculo:'Versa', placas:'AAA111', estado_autorizacion:'autorizada',
    autorizacion_fecha_respuesta:'2026-11-01', autorizador:'Ajustador' }, extra);
  const cols = Object.keys(campos);
  return Number(db.prepare(`INSERT INTO siniestros (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>campos[c])).lastInsertRowid);
}

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); });
test.after(async () => { await new Promise(r => server.close(r)); });

test('FOTOS-1: subir varias fotos de recepción; todos las ven, se ven en miniatura y se descargan con nombre claro', async () => {
  const id = crearSiniestro('FOT-001');
  await login(...DANIELA); // cualquier rol con sesión puede subir y ver
  assert.equal((await subirFoto(id, 'recepcion')).status, 201);
  assert.equal((await subirFoto(id, 'recepcion', { conMini:false })).status, 201);
  const lista = await req('GET', '/api/fotos?siniestro_id=' + id);
  assert.equal(lista.status, 200);
  assert.equal(lista.data.fotos.filter(f => f.etapa === 'recepcion').length, 2);
  const f1 = lista.data.fotos[0];
  const img = await req('GET', `/api/fotos/${f1.id}/imagen?mini=1`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/jpeg/);
  const desc = await req('GET', `/api/fotos/${f1.id}/descargar`);
  assert.equal(desc.status, 200);
  assert.match(desc.headers.get('content-disposition'), /FOT-001_Recepci/);
});

test('FOTOS-2: rechaza archivos que no son foto y etapas inventadas', async () => {
  const id = crearSiniestro('FOT-002');
  await login(...ADMIN);
  assert.equal((await subirFoto(id, 'recepcion', { mime:'application/pdf' })).status, 400);
  assert.equal((await subirFoto(id, 'inventada')).status, 400);
  assert.equal((await subirFoto(999999, 'recepcion')).status, 404);
});

test('FOTOS-3: descargar todas en un .zip ordenado por etapa (archivo válido)', async () => {
  const id = crearSiniestro('FOT-003');
  await login(...ADMIN);
  await subirFoto(id, 'recepcion'); await subirFoto(id, 'en_laminado'); await subirFoto(id, 'en_laminado');
  const z = await req('GET', '/api/fotos/zip?siniestro_id=' + id);
  assert.equal(z.status, 200);
  assert.equal(z.headers.get('content-type'), 'application/zip');
  const ruta = path.join(path.dirname(TEST_DB), 'test-fotos.zip');
  fs.writeFileSync(ruta, z.data);
  const nombres = execFileSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))`, ruta]).toString().trim().split('\n');
  assert.deepEqual(nombres, ['01_Recepción/FOT-003_Recepción_01.jpg', '03_Hojalatería/FOT-003_Hojalatería_01.jpg', '03_Hojalatería/FOT-003_Hojalatería_02.jpg']);
  fs.unlinkSync(ruta);
  const soloLam = await req('GET', '/api/fotos/zip?siniestro_id=' + id + '&etapa=en_laminado');
  assert.equal(soloLam.status, 200);
  assert.equal((await req('GET', '/api/fotos/zip?siniestro_id=' + crearSiniestro('FOT-003B'))).status, 404, 'sin fotos -> aviso claro');
});

test('FOTOS-4: no deja salir de hojalatería sin foto, ni marcar Terminado sin foto de la unidad terminada', async () => {
  const id = crearSiniestro('FOT-004', { estado_produccion:'en_laminado' });
  await login(...ADMIN);
  const r1 = await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'pintura' });
  assert.equal(r1.status, 409);
  assert.equal(r1.data.codigo, 'FOTOS_REQUERIDAS');
  assert.equal(r1.data.etapa, 'en_laminado');
  // Detenido siempre se permite (es un bloqueo, no un avance).
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'detenido' })).status, 200);
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'en_laminado' })).status, 200);
  await subirFoto(id, 'en_laminado');
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'pintura' })).status, 200);
  await subirFoto(id, 'pintura');
  // Pulido y lavado son opcionales.
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'pulido' })).status, 200);
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'lavado' })).status, 200);
  const r2 = await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'terminado' });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.etapa, 'terminado');
  await subirFoto(id, 'terminado');
  assert.equal((await req('PATCH', '/api/siniestros/' + id, { estado_produccion:'terminado' })).status, 200);
  // Una foto quitada por error ya no cuenta.
  const id2 = crearSiniestro('FOT-004B', { estado_produccion:'pintura' });
  const f = await subirFoto(id2, 'pintura');
  await req('DELETE', '/api/fotos/' + f.data.id);
  assert.equal((await req('PATCH', '/api/siniestros/' + id2, { estado_produccion:'armado' })).status, 409);
});

test('FOTOS-5: solo quien subió la foto o el propietario la pueden quitar', async () => {
  const id = crearSiniestro('FOT-005');
  await login(...ADMIN);
  const f = await subirFoto(id, 'recepcion');
  await login(...DANIELA);
  assert.equal((await req('DELETE', '/api/fotos/' + f.data.id)).status, 403);
  const propia = await subirFoto(id, 'recepcion');
  assert.equal((await req('DELETE', '/api/fotos/' + propia.data.id)).status, 200);
  assert.equal((await req('GET', '/api/fotos/espacio')).status, 403, 'el espacio del disco solo lo ve propietario/jefe');
  await login(...ADMIN);
  const e = await req('GET', '/api/fotos/espacio');
  assert.equal(e.status, 200);
  assert.ok(e.data.disco && e.data.disco.total > 0);
});

function fotoEnDisco(siniestroId, etapa){
  const nombre = `foto-prueba-${Math.random().toString(36).slice(2)}.jpg`;
  fs.writeFileSync(path.join(F.UPLOAD_DIR, nombre), JPG);
  const id = Number(db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, etapa, nombre_original, nombre_almacenado, mime, tamano)
    VALUES ('siniestro', ?, 'foto', ?, 'x.jpg', ?, 'image/jpeg', ?)`).run(siniestroId, etapa, nombre, JPG.length).lastInsertRowid);
  return { id, ruta: path.join(F.UPLOAD_DIR, nombre) };
}
const haceMeses = m => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0,10); };

test('FOTOS-6: se borran solas las fotos de unidades entregadas hace más de 12 meses; nunca las de unidades en proceso', () => {
  const vieja = crearSiniestro('FOT-006-VIEJA', { fecha_entrega_real: haceMeses(13) });
  const reciente = crearSiniestro('FOT-006-RECIENTE', { fecha_entrega_real: haceMeses(2) });
  const proceso = crearSiniestro('FOT-006-PROCESO', { estado_produccion:'pintura' });
  const a = fotoEnDisco(vieja, 'recepcion'), b = fotoEnDisco(reciente, 'recepcion'), c = fotoEnDisco(proceso, 'recepcion');
  const r = F.limpiezaFotos(db, { medir: () => ({ pct: 0.2 }) });
  assert.equal(r.antiguedad.fotos, 1);
  assert.equal(fs.existsSync(a.ruta), false, 'la foto vieja se borró del disco');
  assert.equal(fs.existsSync(b.ruta), true);
  assert.equal(fs.existsSync(c.ruta), true);
  assert.ok(db.prepare('SELECT purgado_en FROM archivos WHERE id=?').get(a.id).purgado_en);
});

test('FOTOS-7: si el disco pasa de 85% borra las entregadas más antiguas hasta bajar de 70%, sin tocar las que siguen en proceso', () => {
  const u1 = crearSiniestro('FOT-007-A', { fecha_entrega_real: haceMeses(6) });
  const u2 = crearSiniestro('FOT-007-B', { fecha_entrega_real: haceMeses(4) });
  const u3 = crearSiniestro('FOT-007-C', { fecha_entrega_real: haceMeses(1) });
  const enProceso = crearSiniestro('FOT-007-P', { estado_produccion:'armado' });
  const f1 = fotoEnDisco(u1, 'pintura'), f2 = fotoEnDisco(u2, 'pintura'), f3 = fotoEnDisco(u3, 'pintura'), fp = fotoEnDisco(enProceso, 'pintura');
  // Disco simulado: empieza en 90% y baja 10 puntos por cada unidad entregada que se limpia.
  const reciente = db.prepare(`SELECT id FROM siniestros WHERE numero='FOT-006-RECIENTE'`).get().id;
  const ids = [u1, u2, u3, reciente];
  const medir = () => {
    const n = db.prepare(`SELECT COUNT(DISTINCT entidad_id) n FROM archivos WHERE purgado_en IS NOT NULL AND entidad_id IN (${ids.map(()=>'?').join(',')})`).get(...ids).n;
    return { pct: 0.90 - n * 0.10 };
  };
  const r = F.limpiezaFotos(db, { medir });
  assert.ok(r.espacio, 'hubo limpieza por espacio');
  assert.equal(fs.existsSync(f1.ruta), false, 'la entregada más antigua se borra primero');
  assert.equal(fs.existsSync(f2.ruta), false);
  assert.equal(fs.existsSync(f3.ruta), true, 'al bajar de 70% se detiene');
  assert.equal(fs.existsSync(fp.ruta), true, 'nunca se tocan unidades en proceso');
  const aviso = F.avisoEspacio(db, () => ({ pct: 0.8 }));
  assert.ok(aviso.some(l => /Se borraron/.test(l)));
  assert.ok(aviso.some(l => /80%/.test(l)));
});
