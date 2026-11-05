// Pruebas del Inicio de Alejandra (5-nov-2026): tarjetas por unidad en el orden del proceso confirmado por
// Roberto (entregar, recibir, agendar reingreso, avisar, dar seguimiento) y sus acciones.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-inicio-alejandra.db');
for(const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if(fs.existsSync(f)) fs.unlinkSync(f);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const { calcularPanoramaBeto } = require('../server/panoramaBeto');
const { hoyMX } = require('../server/inicioAlejandra');

const PORT = 3988;
const BASE = 'http://localhost:' + PORT;
let server;
let cookie = '';

async function req(method, url, body){
  const h = { 'Content-Type':'application/json' };
  if(cookie) h.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if(sc) cookie = sc.split(';')[0];
  const txt = await res.text();
  let data = txt; try { data = JSON.parse(txt); } catch(e) {}
  return { status: res.status, data };
}
async function login(email, password){
  cookie = '';
  const r = await req('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, 'login ' + email);
}
const ALEJANDRA = ['alejandra@serviciocristian.mx', 'ServicioCristian2026!'];
const HOY = hoyMX();
function dia(n){ return new Date(Date.parse(HOY) + n * 86400000).toISOString().slice(0, 10); }
function crear(numero, extra = {}){
  const campos = Object.assign({ numero, aseguradora:'GNP', vehiculo:'Versa 2020', placas:'YK-' + numero.slice(-3),
    cliente_nombre:'Cliente ' + numero, cliente_telefono:'229 123 4567' }, extra);
  const cols = Object.keys(campos);
  return Number(db.prepare(`INSERT INTO siniestros (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c => campos[c])).lastInsertRowid);
}
function fotosRecepcion(id, n){
  require('../server/fotos').asegurarEsquemaFotos(db);
  for(let i = 0; i < n; i++){
    db.prepare(`INSERT INTO archivos (entidad_tipo, entidad_id, tipo, etapa, nombre_original, nombre_almacenado, mime, tamano)
      VALUES ('siniestro', ?, 'foto', 'recepcion', 'r.jpg', 'no-existe.jpg', 'image/jpeg', 0)`).run(id);
  }
}
async function inicio(){ const r = await req('GET', '/api/inicio-alejandra'); assert.equal(r.status, 200); return r.data; }
const de = (d, id) => d.tarjetas.filter(t => t.id === id);

test.before(async () => { await new Promise(r => { server = app.listen(PORT, r); }); await login(...ALEJANDRA); });
test.after(async () => { await new Promise(r => server.close(r)); });

test('ALE-1: unidad liberada -> primero avisar "lista para entrega" (5.11); ya avisada -> Entregar', async () => {
  const id = crear('ALE-0001', { estado_autorizacion:'autorizada', estado_produccion:'terminado', estado_calidad:'liberado', ingreso_tipo:'grua', fecha_admision: dia(-10) });
  let t = de(await inicio(), id);
  assert.equal(t.length, 1, 'una sola tarjeta por unidad');
  assert.equal(t[0].tipo, 'aviso'); assert.equal(t[0].codigo, '5.11');
  assert.equal(t[0].telefono, '2291234567');
  assert.match(t[0].texto, /lista para entrega/);
  assert.equal((await req('POST', `/api/inicio-alejandra/${id}/aviso`, { codigo:'5.11', tipo:'aviso', modo:'whatsapp' })).status, 201);
  t = de(await inicio(), id);
  assert.equal(t[0].tipo, 'entrega'); assert.equal(t[0].lista, true);
});

test('ALE-2: prometida para hoy y no lista -> "Escribir al cliente"; al confirmar sale de entregas por hoy', async () => {
  const id = crear('ALE-0002', { estado_autorizacion:'autorizada', estado_produccion:'pintura', fecha_entrega_prevista: HOY, ingreso_tipo:'grua', fecha_admision: dia(-8) });
  let d = await inicio();
  assert.equal(de(d, id)[0].tipo, 'retraso');
  assert.ok(d.numeros.entregas >= 1);
  assert.equal((await req('POST', `/api/inicio-alejandra/${id}/aviso`, { codigo:'retraso' })).status, 201);
  const t = de(await inicio(), id);
  assert.ok(!t.length || t[0].tipo !== 'retraso');
});

test('ALE-3: cita de hoy (primera llegada) -> Recibir unidad; exige 4 fotos de recepción del día', async () => {
  const id = crear('ALE-0003', { cita_fecha: HOY });
  let d = await inicio();
  let t = de(d, id)[0];
  assert.equal(t.tipo, 'cita'); assert.equal(t.es_reingreso, false);
  assert.ok(d.numeros.citas >= 1);
  fotosRecepcion(id, 2);
  const sinFotos = await req('POST', `/api/inicio-alejandra/${id}/llego`, {});
  assert.equal(sinFotos.status, 400); assert.equal(sinFotos.data.codigo, 'FOTOS_RECEPCION');
  fotosRecepcion(id, 2);
  assert.equal((await req('GET', `/api/inicio-alejandra/${id}/fotos-recepcion`)).data.fotos, 4);
  assert.equal((await req('POST', `/api/inicio-alejandra/${id}/llego`, {})).status, 200);
  const p = await req('PATCH', '/api/siniestros/' + id, { fecha_admision: HOY, ingreso_tipo:'circulando', kilometraje:'45000', combustible_nivel:'1/2', llaves_entregadas:1, pertenencias:'ninguna', ubicacion:'Piso', estado_admision:'admitido' });
  assert.equal(p.status, 200);
  t = de(await inicio(), id)[0];
  assert.ok(!t || t.tipo !== 'cita', 'ya recibida, deja de ser cita pendiente');
  assert.equal(t && t.codigo, '5.1', 'lo que sigue es mandarle la bienvenida');
});

test('ALE-4: reingreso (ya admitida antes, cita hoy) -> Recibir registra el reingreso y Beto la ve en piso', async () => {
  const id = crear('ALE-0004', { ingreso_tipo:'circulando', fecha_admision: dia(-20), cita_fecha: HOY, estado_autorizacion:'autorizada', ubicacion:'Tránsito' });
  let t = de(await inicio(), id)[0];
  assert.equal(t.tipo, 'cita'); assert.equal(t.es_reingreso, true);
  let beto = calcularPanoramaBeto(db).find(x => x.id === id);
  assert.equal(beto.reingreso_citado, true, 'antes de llegar, Beto la ve como reingreso por llegar');
  fotosRecepcion(id, 4);
  const r = await req('POST', `/api/inicio-alejandra/${id}/llego`, {});
  assert.equal(r.status, 200); assert.equal(r.data.es_reingreso, true);
  const pu = await req('PATCH', '/api/siniestros/' + id, { ubicacion:'Piso' }); assert.equal(pu.status, 200, JSON.stringify(pu.data));
  assert.equal(db.prepare('SELECT reingreso_recibido_en FROM siniestros WHERE id=?').get(id).reingreso_recibido_en, HOY);
  t = de(await inicio(), id)[0];
  assert.ok(!t || t.tipo !== 'cita');
  beto = calcularPanoramaBeto(db).find(x => x.id === id);
  assert.equal(beto.reingreso_citado, false);
  assert.equal(beto.situacion, 'en_piso');
});

test('ALE-5: 90% de piezas -> Agendar reingreso; con cita y tarea completada desaparece', async () => {
  const id = crear('ALE-0005', { ingreso_tipo:'circulando', fecha_admision: dia(-15), estado_autorizacion:'autorizada', ubicacion:'Tránsito' });
  const tarea = Number(db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador) VALUES (?,?,?,?,'pendiente','automatica','reingreso_90pct')`)
    .run(id, 'mensaje', 'Ya se recibió el 90% de las piezas (9/10): agendar la cita de reingreso con el cliente.', HOY).lastInsertRowid);
  let t = de(await inicio(), id)[0];
  assert.equal(t.tipo, 'reingreso'); assert.equal(t.tarea_id, tarea);
  const pc = await req('PATCH', '/api/siniestros/' + id, { cita_fecha: dia(3) }); assert.equal(pc.status, 200, JSON.stringify(pc.data));
  assert.equal((await req('PATCH', '/api/tareas/' + tarea, { estado:'completada' })).status, 200);
  t = de(await inicio(), id)[0];
  assert.ok(!t || t.tipo !== 'reingreso');
});

test('ALE-6: autorizada sin piezas, en taller -> avisar 5.6 con el texto exacto; al confirmar cierra la tarea vieja', async () => {
  const id = crear('ALE-0006', { estado_autorizacion:'autorizada', ingreso_tipo:'grua', fecha_admision: dia(-5) });
  const tarea = Number(db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,estado,origen,disparador) VALUES (?,?,?,'pendiente','automatica','autorizacion_resuelta')`)
    .run(id, 'mensaje', 'Autorización resuelta').lastInsertRowid);
  const t = de(await inicio(), id)[0];
  assert.equal(t.tipo, 'aviso'); assert.equal(t.codigo, '5.6');
  assert.equal(t.texto, require('../server/whatsappBandejaManual').PLANTILLAS_TEXTO['5.6']);
  assert.equal((await req('POST', `/api/inicio-alejandra/${id}/aviso`, { codigo:'5.6', tipo:'aviso', modo:'whatsapp' })).status, 201);
  assert.equal(db.prepare('SELECT estado FROM tareas WHERE id=?').get(tarea).estado, 'completada');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM eventos_cliente WHERE siniestro_id=? AND tipo_evento='aviso:5.6'`).get(id).n, 1);
  assert.ok(!de(await inicio(), id).length, 'avisada hoy: ya no tiene pendiente');
});

test('ALE-7: más de 3 días sin aviso -> Dar seguimiento con la plantilla de continuidad (6.x)', async () => {
  const id = crear('ALE-0007', { estado_autorizacion:'autorizada', ingreso_tipo:'grua', fecha_admision: dia(-9), estado_produccion:'en_laminado' });
  db.prepare(`INSERT INTO eventos_cliente (siniestro_id,direccion,canal,tipo_evento,mensaje,creado_en) VALUES (?,'saliente','whatsapp','aviso:5.8','x',datetime('now','-5 days'))`).run(id);
  const d = await inicio();
  const t = de(d, id)[0];
  assert.equal(t.tipo, 'seguimiento'); assert.equal(t.codigo, '6.4');
  assert.ok(t.dias_sin_aviso >= 4);
  assert.ok(d.numeros.seguimiento >= 1);
  assert.equal((await req('POST', `/api/inicio-alejandra/${id}/aviso`, { codigo:'6.4', tipo:'seguimiento', modo:'whatsapp' })).status, 201);
  assert.ok(!de(await inicio(), id).length);
});

test('ALE-8: "Ya se lo había avisado" registra sin abrir WhatsApp; sin teléfono la tarjeta lo pide', async () => {
  const id = crear('ALE-0008', { estado_autorizacion:'autorizada', ingreso_tipo:'grua', fecha_admision: dia(-2), cliente_telefono:'' });
  const t = de(await inicio(), id)[0];
  assert.equal(t.tipo, 'aviso'); assert.equal(t.telefono, null);
  const r = await req('POST', `/api/inicio-alejandra/${id}/aviso`, { codigo: t.codigo, tipo:'aviso', modo:'ya_avisado' });
  assert.equal(r.status, 201);
  assert.equal(db.prepare(`SELECT resultado FROM eventos_cliente WHERE id=?`).get(r.data.id).resultado, 'ya_avisado');
  assert.ok(!de(await inicio(), id).length);
});

test('ALE-9: orden de la lista: entregas, citas, reingresos, avisos, seguimiento', async () => {
  const orden = (await inicio()).tarjetas.map(t => t.orden);
  assert.deepEqual(orden, [...orden].sort((a, b) => a - b));
});

test('ALE-10: el panorama de Roberto usa el mismo número de "clientes pendientes de informar"', async () => {
  const d = await inicio();
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('GET', '/api/reportes/resumen');
  assert.equal(r.data.clientesPorInformar, d.numeros.avisos + d.numeros.seguimiento);
  const det = await req('GET', '/api/reportes/detalle/clientesPorInformar');
  assert.equal(det.data.length, d.numeros.avisos + d.numeros.seguimiento);
  await login(...ALEJANDRA);
});

test('ALE-11: solo Alejandra (y Roberto) ven esta pantalla', async () => {
  db.prepare(`INSERT OR IGNORE INTO usuarios (nombre,email,password_hash,rol) VALUES ('Beto prueba','beto.ale@x.mx',?,'beto')`).run(require('bcryptjs').hashSync('Clave123!', 4));
  await login('beto.ale@x.mx', 'Clave123!');
  assert.equal((await req('GET', '/api/inicio-alejandra')).status, 403);
  await login(...ALEJANDRA);
});

test('ALE-12: "Entregar unidad" (mismos pasos que la pantalla) registra entrega y finiquito; datos viejos de autorización no estorban', async () => {
  // Expediente con autorización capturada a medias (sin fecha de respuesta ni autorizador), como hay en datos reales.
  const id = crear('ALE-0012', { estado_autorizacion:'autorizada', estado_produccion:'terminado', estado_calidad:'liberado', ingreso_tipo:'grua', fecha_admision: dia(-12), deducible_aplica:1 });
  await req('POST', `/api/inicio-alejandra/${id}/aviso`, { codigo:'5.11', tipo:'aviso', modo:'whatsapp' });
  assert.equal(de(await inicio(), id)[0].tipo, 'entrega');
  const p1 = await req('PATCH', '/api/siniestros/' + id, { entrega_receptor:'Juan', entrega_identificacion:'INE', entrega_kilometraje:'45100', entrega_combustible:'1/2',
    entrega_llaves_entregadas:1, estado_entrega:'entregado', deducible_pagado_confirmado_en: HOY, entrega_encuesta_gnp_solicitada:1, encuesta_estado:'respondida' });
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  assert.equal((await req('PATCH', `/api/siniestros/${id}/entrega`, { fecha_entrega_real: HOY })).status, 200);
  const p3 = await req('PATCH', '/api/siniestros/' + id, { finiquito_estado:'firmado', finiquito_fecha: HOY });
  assert.equal(p3.status, 200, JSON.stringify(p3.data));
  assert.ok(!de(await inicio(), id).length, 'entregada: sale de la lista');
});

test('ALE-13: la regla de autorización completa se sigue exigiendo cuando sí se captura la autorización', async () => {
  const id = crear('ALE-0013', {});
  await login('admin@serviciocristian.mx', 'ServicioCristian2026!');
  const r = await req('PATCH', '/api/siniestros/' + id, { estado_autorizacion:'autorizada' });
  assert.equal(r.status, 400);
  await login(...ALEJANDRA);
});
