// Pruebas de los inicios de Daniela y Orlando, y de la revisión de calidad (6-nov-2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-inicio-daniela-orlando.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;
process.env.LINEA_BASE_DANIELA = '9999-12-31';
process.env.LINEA_BASE_ALEJANDRA = '9999-12-31';

const app = require('../server/index');
const db = require('../server/db');

const PORT = 3987;
const BASE = 'http://localhost:' + PORT;
let server;
let cookie = '';
async function req(method, url, body){
  const h = { 'Content-Type':'application/json' };
  if(cookie) h.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const txt = await res.text(); let data = txt; try { data = JSON.parse(txt); } catch(e) {}
  return { status: res.status, data };
}
async function login(email, password){ cookie = ''; const r = await req('POST', '/api/auth/login', { email, password }); assert.equal(r.status, 200, 'login ' + email); }
const DANIELA = ['daniela@serviciocristian.mx', 'ServicioCristian2026-Reset!'];
const ORLANDO = ['orlando@serviciocristian.mx', 'ServicioCristian2026!'];
const ALEJANDRA = ['alejandra@serviciocristian.mx', 'ServicioCristian2026!'];
const BETO = ['beto@serviciocristian.mx', 'ServicioCristian2026!'];
const HOY = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
const dia = n => new Date(Date.parse(HOY) + n * 86400000).toISOString().slice(0, 10);

function siniestro(numero, extra = {}){
  const c = Object.assign({ numero, aseguradora:'GNP', vehiculo:'Versa ' + numero, placas:'YK-' + numero.slice(-3), cliente_nombre:'Cliente', cliente_telefono:'2291234567' }, extra);
  const k = Object.keys(c);
  return Number(db.prepare(`INSERT INTO siniestros (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => c[x])).lastInsertRowid);
}
function proveedor(nombre, tel = ''){ return Number(db.prepare(`INSERT INTO proveedores (razon_social, telefono, correo) VALUES (?,?,?)`).run(nombre, tel, 'x@y.mx').lastInsertRowid); }
function pedido(numero, sid, estatus = 'Esperando proveedor'){ return Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion, estatus_operativo) VALUES (?,?,?,?)`).run(numero, sid, dia(-10), estatus).lastInsertRowid); }
function pieza(pid, prov, desc, estatus, fecha = ''){ return Number(db.prepare(`INSERT INTO piezas (pedido_id, proveedor_id, descripcion, estatus, fecha_prometida) VALUES (?,?,?,?,?)`).run(pid, prov, desc, estatus, fecha).lastInsertRowid); }

let ids = {};
test.before(async () => {
  await new Promise(r => { server = app.listen(PORT, r); });
  const s1 = siniestro('DN-001'), s2 = siniestro('DN-002'), s3 = siniestro('DN-003');
  const golfo = proveedor('Refacciones Golfo', '229 111 2233'), sur = proveedor('Autopartes Sur');
  const p1 = pedido('DN-P1', s1), p2 = pedido('DN-P2', s2), p3 = pedido('DN-P3', s3);
  ids = {
    s1, s2, s3, golfo, sur, p3,
    entregada: pieza(p1, golfo, 'Faro derecho', 'Entregada por proveedor', dia(-1)),
    vencida1: pieza(p1, golfo, 'Defensa', 'Confirmada', dia(-5)),
    vencida2: pieza(p2, golfo, 'Parrilla', 'Confirmada', dia(-2)),
    vencidaSur: pieza(p2, sur, 'Espejo', 'En tránsito', dia(-1)),
    vieja: pieza(p2, sur, 'Moldura', 'Confirmada', dia(-45)),
    asignada: pieza(p1, sur, 'Calavera', 'Asignada'),
    futura: pieza(p1, golfo, 'Cofre', 'Confirmada', dia(5)),
    incorrecta: pieza(p2, golfo, 'Salpicadera', 'Incorrecta/dañada'),
    recibida: pieza(p1, golfo, 'Emblema', 'Recibida físicamente'),
  };
  db.prepare(`UPDATE piezas SET fecha_recepcion=datetime('now','-2 days') WHERE id=?`).run(ids.recibida);
  pedido('DN-P4', s3); // pedido sin piezas
  const ins = db.prepare(`INSERT INTO comunicaciones (pedido_id, siniestro_id, proveedor_id, asunto, cuerpo, estado, disparador, fecha_envio) VALUES (?,?,?,?,?,'pendiente_aprobacion','manual',datetime('now', ?))`);
  ids.correoNuevo = Number(ins.run(p1, s1, golfo, 'Seguimiento', 'x', '-1 days').lastInsertRowid);
  ids.correoViejo = Number(ins.run(p2, s2, golfo, 'Viejo', 'x', '-20 days').lastInsertRowid);
});
test.after(async () => { await new Promise(r => server.close(r)); });

test('DAN-1: cada pieza cae en su sección; vencidas y por confirmar agrupadas por proveedor', async () => {
  await login(...DANIELA);
  const r = await req('GET', '/api/inicio-daniela');
  assert.equal(r.status, 200);
  const d = r.data;
  const mias = new Set(['entregada','vencida1','vencida2','vencidaSur','vieja','asignada','futura','incorrecta','recibida'].map(k => ids[k]));
  const soloMias = a => a.filter(id => mias.has(id));
  assert.deepEqual(soloMias(d.recibir.flatMap(u => u.piezas.map(z => z.id))), [ids.entregada]);
  const golfo = d.vencidas.find(g => g.proveedor_id === ids.golfo);
  assert.deepEqual(golfo.piezas.map(z => z.id), [ids.vencida1, ids.vencida2], 'agrupadas y la más vencida primero');
  assert.equal(golfo.telefono, '229 111 2233');
  assert.ok(d.vencidas.find(g => g.proveedor_id === ids.sur).piezas.some(z => z.id === ids.vencidaSur));
  assert.deepEqual(soloMias(d.viejas.map(z => z.id)), [ids.vieja], 'vencida hace más de 30 días va a "¿siguen pendientes?"');
  assert.deepEqual(soloMias(d.confirmar.flatMap(g => g.piezas.map(z => z.id))), [ids.asignada]);
  assert.deepEqual(soloMias(d.mal.map(z => z.id)), [ids.incorrecta]);
  assert.ok(!JSON.stringify(d.vencidas).includes('"Cofre"'), 'con fecha futura no estorba');
  assert.ok(d.pedidos_sin_piezas.some(p => p.pedido_numero === 'DN-P4'));
  assert.ok(d.ya_llegaron.some(z => z.id === ids.recibida));
  ids.base = { recibir: d.numeros.por_recibir - 1, confirmar: d.numeros.por_confirmar - 1, viejas: d.numeros.vencidas_viejas - 1 };
  assert.equal(soloMias(d.vencidas.flatMap(g => g.piezas.map(z => z.id))).length, 3);
  assert.ok(d.correos.some(c => c.id === ids.correoNuevo) && d.correos.some(c => c.id === ids.correoViejo));
});

test('DAN-2: capturar fecha confirma la pieza; "Llegó bien" la quita; "Se canceló" limpia una vieja', async () => {
  await login(...DANIELA);
  assert.equal((await req('PATCH', '/api/piezas/' + ids.asignada, { fecha_prometida: dia(3), estatus:'Confirmada' })).status, 200);
  assert.equal((await req('POST', `/api/piezas/${ids.entregada}/recibir`)).status, 200);
  assert.equal((await req('PATCH', '/api/piezas/' + ids.vieja, { estatus:'Cancelada' })).status, 200);
  const d = (await req('GET', '/api/inicio-daniela')).data;
  assert.equal(d.numeros.por_confirmar, ids.base.confirmar); assert.equal(d.numeros.por_recibir, ids.base.recibir); assert.equal(d.numeros.vencidas_viejas, ids.base.viejas);
});

test('DAN-3: "Llegó una pieza" busca por placas sin guion y solo trae piezas pendientes', async () => {
  await login(...DANIELA);
  const r = await req('GET', '/api/inicio-daniela/piezas-pendientes?q=YK002');
  assert.equal(r.status, 200);
  assert.ok(r.data.length >= 1);
  assert.ok(r.data.every(z => z.siniestro_numero === 'DN-002' && !['Recibida físicamente','Cancelada'].includes(z.estatus)));
});

test('DAN-4: la línea base archiva correos de más de 7 días (sin enviar ni borrar) y no se vuelven a crear', async () => {
  await login(...DANIELA);
  assert.equal((await req('POST', '/api/inicio-daniela/linea-base')).status, 403, 'solo Roberto puede adelantarla');
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('POST', '/api/inicio-daniela/linea-base');
  assert.equal(r.status, 200); assert.ok(r.data.archivados >= 1);
  assert.equal(db.prepare('SELECT estado FROM comunicaciones WHERE id=?').get(ids.correoViejo).estado, 'archivado');
  assert.equal(db.prepare('SELECT estado FROM comunicaciones WHERE id=?').get(ids.correoNuevo).estado, 'pendiente_aprobacion');
  await login(...DANIELA);
  const d = (await req('GET', '/api/inicio-daniela')).data;
  assert.ok(d.correos.some(c => c.id === ids.correoNuevo)); assert.ok(!d.correos.some(c => c.id === ids.correoViejo));
});

test('DAN-5: solo Daniela (y Roberto) ven su inicio', async () => {
  await login(...ALEJANDRA);
  assert.equal((await req('GET', '/api/inicio-daniela')).status, 403);
});

test('ORL-1: reautorización con horas restantes y fotos editadas; al enviarla sale de su lista', async () => {
  const s = siniestro('OR-001', { estado_autorizacion:'autorizada' });
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const c = (await req('POST', '/api/complementos', { siniestro_id: s, tipo:'no_autorizado_inicial', pieza_operacion:'Faro', causa:'No autorizado' })).data;
  await login(...ORLANDO);
  let d = (await req('GET', '/api/inicio-orlando')).data;
  const r = d.reautorizar.find(x => x.id === c.id);
  assert.ok(r); assert.ok(r.horas_restantes >= 23 && r.horas_restantes <= 24); assert.equal(r.fotos_editadas, 0);
  require('../server/fotos').asegurarEsquemaFotos(db);
  db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, etapa, nombre_original, nombre_almacenado, mime, tamano) VALUES ('siniestro', ?, 'foto', 'reautorizacion', 'f.jpg', 'x.jpg', 'image/jpeg', 0)`).run(s);
  d = (await req('GET', '/api/inicio-orlando')).data;
  assert.equal(d.reautorizar.find(x => x.id === c.id).fotos_editadas, 1);
  assert.equal((await req('PATCH', '/api/complementos/' + c.id, { estado:'enviado' })).status, 200);
  d = (await req('GET', '/api/inicio-orlando')).data;
  assert.ok(!d.reautorizar.some(x => x.id === c.id));
});

test('ORL-2: revisar -> desarme -> terminada -> captura en 3 pasos -> enviada a Roberto', async () => {
  const s = siniestro('OR-002');
  db.prepare(`UPDATE siniestros SET fecha_hora_disponible_revision=datetime('now','-2 days') WHERE id=?`).run(s);
  const viejaAutorizada = siniestro('OR-003', { estado_autorizacion:'autorizada', estado_produccion:'pintura' });
  db.prepare(`UPDATE siniestros SET fecha_hora_disponible_revision=datetime('now','-40 days') WHERE id=?`).run(viejaAutorizada);
  await login(...ORLANDO);
  const ver = async () => (await req('GET', '/api/inicio-orlando')).data;
  let d = await ver();
  const x = d.revisar.find(u => u.siniestro_id === s);
  assert.ok(x); assert.equal(x.dias_esperando, 2);
  assert.ok(!d.revisar.some(u => u.siniestro_id === viejaAutorizada), 'si ya está autorizada/en producción no le estorba');
  await req('PATCH', '/api/siniestros/' + s, { estado_revision_tecnica:'requiere_desarme' });
  d = await ver(); assert.ok(d.desarme.some(u => u.siniestro_id === s)); assert.ok(!d.revisar.some(u => u.siniestro_id === s));
  await req('PATCH', '/api/siniestros/' + s, { estado_revision_tecnica:'revision_terminada' });
  for(const [paso, cambios] of [['excel', { excel_capturado:1 }], ['fotos', { fotos_completas:1 }], ['enviar', { enviado_propietario:1 }]]){
    d = await ver();
    assert.equal(d.captura.find(u => u.siniestro_id === s).paso, paso);
    assert.equal((await req('PATCH', '/api/siniestros/' + s, cambios)).status, 200);
  }
  d = await ver();
  assert.ok(!d.captura.some(u => u.siniestro_id === s), 'enviada a Roberto: sale de su lista');
});

test('ORL-3: complemento por daño oculto aparece y se marca enviado', async () => {
  const s = siniestro('OR-004', { estado_autorizacion:'autorizada', estado_produccion:'en_laminado' });
  await login(...ORLANDO);
  const c = (await req('POST', '/api/complementos', { siniestro_id: s, causa:'Golpe oculto en larguero' })).data;
  let d = (await req('GET', '/api/inicio-orlando')).data;
  assert.ok(d.complementos.some(x => x.id === c.id));
  await req('PATCH', '/api/complementos/' + c.id, { estado:'enviado' });
  d = (await req('GET', '/api/inicio-orlando')).data;
  assert.ok(!d.complementos.some(x => x.id === c.id));
});

test('ORL-4: fotos editadas de reautorización se pueden subir como etapa propia', async () => {
  const F = require('../server/fotos');
  assert.ok(F.ETAPAS_FOTO.includes('reautorizacion'));
});

test('CAL-1: Beto ve todas las terminadas sin calidad; los demás solo las de 1 día o más', async () => {
  const nueva = siniestro('CA-001', { estado_autorizacion:'autorizada', estado_produccion:'terminado' });
  const vieja = siniestro('CA-002', { estado_autorizacion:'autorizada', estado_produccion:'terminado' });
  db.prepare(`INSERT INTO auditoria (entidad_tipo, entidad_id, accion, campo, valor_nuevo, fecha) VALUES ('siniestro', ?, 'edicion', 'estado_produccion', 'terminado', datetime('now','-30 hours'))`).run(vieja);
  db.prepare(`INSERT INTO auditoria (entidad_tipo, entidad_id, accion, campo, valor_nuevo, fecha) VALUES ('siniestro', ?, 'edicion', 'estado_produccion', 'terminado', datetime('now','-2 hours'))`).run(nueva);
  await login(...BETO);
  const todas = (await req('GET', '/api/inicio-orlando/calidad-pendiente')).data;
  assert.ok(todas.some(u => u.id === nueva) && todas.some(u => u.id === vieja));
  assert.equal(todas[0].id, vieja, 'la que lleva más tiempo, primero');
  await login(...ALEJANDRA);
  const apoyo = (await req('GET', '/api/inicio-orlando/calidad-pendiente?apoyo=1')).data;
  assert.ok(apoyo.some(u => u.id === vieja)); assert.ok(!apoyo.some(u => u.id === nueva));
});

test('CAL-2: Alejandra y Daniela ya pueden liberar calidad con el checklist completo', async () => {
  for(const [quien, numero] of [[ALEJANDRA, 'CA-010'], [DANIELA, 'CA-011']]){
    const s = siniestro(numero, { estado_autorizacion:'autorizada', estado_produccion:'terminado' });
    await login(...quien);
    for(const d of ['Alcance','Seguridad y función','Lámina/ajuste','Pintura/acabado','Armado','Presentación','Documentación']){
      assert.equal((await req('POST', '/api/checklist-calidad', { siniestro_id: s, dimension: d, resultado:'aprobado' })).status, 201);
    }
    const r = await req('PATCH', '/api/siniestros/' + s, { estado_calidad:'liberado' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!(await req('GET', '/api/inicio-orlando/calidad-pendiente')).data.some(u => u.id === s), 'liberada: sale de la lista');
  }
});

test('CAL-3: con un rubro mal, queda para corregir y Beto lo ve con lo que falta', async () => {
  const s = siniestro('CA-020', { estado_autorizacion:'autorizada', estado_produccion:'terminado' });
  await login(...BETO);
  await req('POST', '/api/checklist-calidad', { siniestro_id: s, dimension:'Pintura/acabado', resultado:'rechazado', hallazgo:'Escurrido en puerta' });
  assert.equal((await req('PATCH', '/api/siniestros/' + s, { estado_calidad:'liberado' })).status, 400, 'no se libera con rubros rechazados');
  assert.equal((await req('PATCH', '/api/siniestros/' + s, { estado_calidad:'rechazado_a_retrabajo' })).status, 200);
  const u = (await req('GET', '/api/inicio-orlando/calidad-pendiente')).data.find(x => x.id === s);
  assert.deepEqual(u.rechazados.map(r => r.dimension), ['Pintura/acabado']);
});
