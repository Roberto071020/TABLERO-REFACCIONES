// Pruebas del Reporte de arranque del día (4-nov-2026): contenido, formato WhatsApp, ventanilla con clave
// y envío diario por correo (con un envío simulado -- nunca manda correos reales).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-reporte-arranque.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const reporte = require('../server/reporteArranque');

const PORT = 3994;
const BASE = 'http://localhost:' + PORT;
let server;
let cookie = '';

async function req(method, url, body, headers = {}){
  const h = Object.assign({ 'Content-Type':'application/json' }, headers);
  if(cookie) h.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if(sc) cookie = sc.split(';')[0];
  const txt = await res.text();
  let data = txt; try { data = JSON.parse(txt); } catch(e) {}
  return { status: res.status, data };
}
function dias(n){ return new Date(Date.now() + n * 86400000).toISOString().slice(0,10); }

function crearSiniestro(numero, extra = {}){
  const campos = Object.assign({ numero, aseguradora:'GNP', vehiculo:'Versa', placas:'ABC-' + numero.slice(-3),
    estado_autorizacion:'autorizada' }, extra);
  const cols = Object.keys(campos);
  const r = db.prepare(`INSERT INTO siniestros (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>campos[c]));
  return Number(r.lastInsertRowid);
}

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, resolve); });
  // Escenario: una vencida, una que vence mañana, una lista para iniciar y piezas vencidas de un proveedor.
  crearSiniestro('RA-VENCIDA', { fecha_entrega_prevista: dias(-3) });
  crearSiniestro('RA-MANANA', { fecha_entrega_prevista: dias(1), vehiculo:'Aveo' });
  const lista = crearSiniestro('RA-LISTA', { fecha_entrega_prevista: dias(20), vehiculo:'March', requiere_refacciones:'si' });
  const prov = Number(db.prepare(`INSERT INTO proveedores (razon_social) VALUES ('Refacciones Golfo')`).run().lastInsertRowid);
  const pedLista = Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion, estatus_operativo) VALUES ('RA-PED-1', ?, ?, 'Recibido completo')`).run(lista, dias(-10)).lastInsertRowid);
  db.prepare(`INSERT INTO piezas (pedido_id, proveedor_id, descripcion, estatus) VALUES (?, ?, 'Facia', 'Recibida físicamente')`).run(pedLista, prov);
  const conPiezas = crearSiniestro('RA-PIEZAS', { fecha_entrega_prevista: dias(15), requiere_refacciones:'si' });
  const ped = Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion) VALUES ('RA-PED-2', ?, ?)`).run(conPiezas, dias(-10)).lastInsertRowid);
  db.prepare(`INSERT INTO piezas (pedido_id, proveedor_id, descripcion, estatus, fecha_prometida) VALUES (?, ?, 'Faro', 'Confirmada', ?)`).run(ped, prov, dias(-2));
  db.prepare(`INSERT INTO piezas (pedido_id, proveedor_id, descripcion, estatus, fecha_prometida) VALUES (?, ?, 'Calavera', 'Confirmada', ?)`).run(ped, prov, dias(-1));
});
test.after(async () => {
  delete process.env.REPORTE_TOKEN; delete process.env.REPORTE_ARRANQUE_CORREO;
  await new Promise(resolve => server.close(resolve));
});

test('REPORTE-1: separa vencidas, vencen pronto, listas para iniciar y piezas vencidas por proveedor', () => {
  const r = reporte.calcularReporteArranque(db);
  assert.ok(r.vencidas.some(u => u.numero === 'RA-VENCIDA'));
  assert.ok(!r.vencidas.some(u => u.numero === 'RA-MANANA'), 'la que vence mañana no es vencida');
  assert.ok(r.vencen_pronto.some(u => u.numero === 'RA-MANANA'));
  assert.ok(r.listas_para_iniciar.some(u => u.numero === 'RA-LISTA'));
  const golfo = r.piezas_vencidas.find(p => p.proveedor === 'Refacciones Golfo');
  assert.ok(golfo, 'el proveedor con piezas vencidas debe aparecer');
  assert.equal(golfo.piezas, 2);
  assert.equal(golfo.unidades, 1);
});

test('REPORTE-2: el texto viene en formato WhatsApp (negritas con *, sin tablas)', () => {
  const { texto } = reporte.calcularReporteArranque(db);
  assert.match(texto, /^\*🔧 ARRANQUE DEL DÍA – /);
  assert.match(texto, /\*🔴 Vencidas \(\d+\)\*/);
  assert.match(texto, /\*📦 Piezas vencidas \(\d+\)\*\n• Refacciones Golfo: 2 piezas \(1 unidad\)/);
  assert.ok(!texto.includes('|'), 'sin tablas');
});

test('REPORTE-3: la ruta del tablero exige sesión', async () => {
  cookie = '';
  const sin = await req('GET', '/api/reportes/arranque-dia');
  assert.equal(sin.status, 401);
  await req('POST', '/api/auth/login', { email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' });
  const con = await req('GET', '/api/reportes/arranque-dia');
  assert.equal(con.status, 200);
  assert.equal(typeof con.data.texto, 'string');
});

test('REPORTE-4: la ventanilla externa está apagada sin REPORTE_TOKEN y rechaza claves incorrectas', async () => {
  cookie = '';
  delete process.env.REPORTE_TOKEN;
  assert.equal((await req('GET', '/api/externo/reporte-arranque', null, { Authorization:'Bearer x' })).status, 503);
  process.env.REPORTE_TOKEN = 'clave-de-prueba-larga-123';
  assert.equal((await req('GET', '/api/externo/reporte-arranque')).status, 401);
  assert.equal((await req('GET', '/api/externo/reporte-arranque', null, { Authorization:'Bearer otra' })).status, 401);
  const ok = await req('GET', '/api/externo/reporte-arranque?formato=texto', null, { Authorization:'Bearer clave-de-prueba-larga-123' });
  assert.equal(ok.status, 200);
  assert.match(ok.data, /ARRANQUE DEL DÍA/);
});

test('REPORTE-5: el correo diario sale una sola vez, solo entre 7:30 y 12:00 (hora de México)', async () => {
  process.env.REPORTE_ARRANQUE_CORREO = 'roberto@example.com';
  const enviados = [];
  const enviar = async (m) => { enviados.push(m); };
  // 4-nov-2026 13:00 UTC = 7:00 a.m. en Ciudad de México -> todavía no.
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora: new Date('2026-11-04T13:00:00Z'), enviar })).motivo, 'fuera_de_horario');
  // 13:35 UTC = 7:35 a.m. -> se envía.
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora: new Date('2026-11-04T13:35:00Z'), enviar })).enviado, true);
  // Mismo día otra vez -> no duplica.
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora: new Date('2026-11-04T14:00:00Z'), enviar })).motivo, 'ya_enviado');
  // 19:00 UTC = 1:00 p.m. del día siguiente -> ya pasó el límite.
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora: new Date('2026-11-05T19:00:00Z'), enviar })).motivo, 'fuera_de_horario');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'roberto@example.com');
  assert.match(enviados[0].text, /reporte-dia\.html/);
});

test('REPORTE-6: si el correo falla, se reintenta en la siguiente revisión del mismo día', async () => {
  process.env.REPORTE_ARRANQUE_CORREO = 'roberto@example.com';
  let intentos = 0;
  const falla = async () => { intentos++; throw new Error('Gmail rechazó'); };
  const ahora = new Date('2026-11-06T13:40:00Z');
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora, enviar: falla })).motivo, 'error');
  assert.equal((await reporte.intentarEnvioDiario(db, { ahora, enviar: async()=>{} })).enviado, true);
  assert.equal(intentos, 1);
});

test('REPORTE-7: sin dato de refacciones NO cuenta como "lista para iniciar"; en tránsito con piezas completas pide citar reingreso', () => {
  crearSiniestro('RA-SINDATO', { fecha_entrega_prevista: dias(20) });                                  // requiere_refacciones = por_definir
  crearSiniestro('RA-TRANSITO', { fecha_entrega_prevista: dias(20), requiere_refacciones:'no', ubicacion:'Tránsito' });
  const r = reporte.calcularReporteArranque(db);
  assert.ok(!r.listas_para_iniciar.some(u => u.numero === 'RA-SINDATO'), 'sin dato no es lista');
  assert.ok(!r.listas_para_iniciar.some(u => u.numero === 'RA-TRANSITO'), 'en tránsito no está en el taller');
  assert.ok(r.transito_para_citar.some(u => u.numero === 'RA-TRANSITO'));
  assert.ok(r.sin_dato_refacciones >= 1);
  assert.match(r.texto, /Falta capturar en el tablero/);
  assert.match(r.texto, /citar reingreso/);
});

const actualizacion = require('../server/actualizacionUnidades');
const TAB = '\t';
const ENC = ['SINIESTRO','ASEGURADORA','VEHICULO','PLACAS','UBICACION','AUTORIZADA','REQUIERE REFACCIONES','FECHA ENTREGA','ETAPA','CITA REINGRESO','FECHA ENTREGADA'].join(TAB);
const fila = (...c) => c.join(TAB);

test('ACT-1: revisar muestra los cambios sin guardar nada y marca errores por renglón', () => {
  crearSiniestro('ACT-UNO', { estado_autorizacion: null, vehiculo:'Aveo' });
  const texto = [ENC,
    fila('ACT-UNO','','','','TRANSITO','SI','SI','15/12/2026','Hojalatería','',''),
    fila('ACT-MALO','','','','PISO','','','','',''),
    fila('4.26411E+15','GNP','','','','','','','',''),
    fila('ACT-FECHA','GNP','','','','','','31/02/2026','','','')
  ].join('\n');
  const r = actualizacion.analizar(db, texto);
  const uno = r.filas.find(f => f.siniestro === 'ACT-UNO');
  assert.equal(uno.accion, 'actualizar');
  const campos = uno.cambios.map(c => c.campo);
  for(const c of ['ubicacion','estado_autorizacion','requiere_refacciones','fecha_entrega_prevista','estado_produccion']) assert.ok(campos.includes(c), c);
  assert.equal(r.filas.find(f => f.siniestro === 'ACT-MALO').accion, 'error', 'no existe y no trae aseguradora');
  assert.match(r.filas.find(f => f.siniestro.startsWith('4.26')).errores[0], /Excel/);
  assert.match(r.filas.find(f => f.siniestro === 'ACT-FECHA').errores[0], /fecha válida/);
  // Nada se guardó todavía.
  assert.notEqual(db.prepare(`SELECT ubicacion FROM siniestros WHERE numero='ACT-UNO'`).get().ubicacion, 'Tránsito');
});

test('ACT-2: confirmar guarda, crea los nuevos, registra auditoría y saca de producción a las entregadas', async () => {
  crearSiniestro('ACT-DOS', { estado_produccion:'pintura' });
  const texto = [ENC,
    fila('ACT-DOS','','','','','','','','','','03/11/2026'),
    fila('ACT-NUEVA','gnp','Jetta','xyz123','PISO','SI','NO','20/11/2026','Sin iniciar','','')
  ].join('\n');
  // Por HTTP, como lo usará Roberto (requiere admin/jefe).
  cookie = '';
  await req('POST', '/api/auth/login', { email:'daniela@serviciocristian.mx', password:'ServicioCristian2026-Reset!' });
  assert.equal((await req('POST', '/api/actualizacion-unidades/confirmar', { texto })).status, 403, 'Daniela no puede');
  cookie = '';
  await req('POST', '/api/auth/login', { email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' });
  const r = await req('POST', '/api/actualizacion-unidades/confirmar', { texto });
  assert.equal(r.status, 200);
  assert.equal(r.data.aplicadas, 2);

  const dos = db.prepare(`SELECT * FROM siniestros WHERE numero='ACT-DOS'`).get();
  assert.equal(dos.fecha_entrega_real, '2026-11-03');
  assert.equal(dos.estado_produccion, 'terminado');
  assert.equal(dos.estado_entrega, 'entregado');
  const nueva = db.prepare(`SELECT * FROM siniestros WHERE numero='ACT-NUEVA'`).get();
  assert.equal(nueva.aseguradora, 'GNP');
  assert.equal(nueva.placas, 'XYZ123');
  assert.equal(nueva.estado_autorizacion, 'autorizada');
  assert.ok(nueva.autorizacion_fecha_respuesta && nueva.autorizador);
  assert.equal(nueva.requiere_refacciones, 'no');
  assert.equal(nueva.fecha_entrega_prevista, '2026-11-20');
  assert.equal(nueva.estado_produccion, 'programado');
  const aud = db.prepare(`SELECT COUNT(*) n FROM auditoria WHERE entidad_tipo='siniestro' AND entidad_id=? AND accion='actualizacion_masiva'`).get(dos.id).n;
  assert.ok(aud >= 3);

  // La nueva entra al panorama como lista para iniciar (en piso, no requiere refacciones).
  const rep = reporte.calcularReporteArranque(db);
  assert.ok(rep.listas_para_iniciar.some(u => u.numero === 'ACT-NUEVA'));
  assert.ok(!rep.listas_para_iniciar.concat(rep.vencidas).some(u => u.numero === 'ACT-DOS'), 'entregada sale del panorama');

  // Volver a pegar lo mismo no cambia nada.
  const otra = await req('POST', '/api/actualizacion-unidades/validar', { texto });
  assert.equal(otra.data.resumen.sin_cambios, 2);
});

test('ACT-3: GNP con 1-3 piezas a cambio queda como autosurtido; en piso cuenta como lista para iniciar sin buscar en Inpart', () => {
  crearSiniestro('ACT-AUTO', { aseguradora:'GNP', fecha_entrega_prevista: dias(15) });
  crearSiniestro('ACT-AUTO-TR', { aseguradora:'GNP', fecha_entrega_prevista: dias(15) });
  crearSiniestro('ACT-GNP-5', { aseguradora:'GNP', fecha_entrega_prevista: dias(15) });
  const enc = ['SINIESTRO','UBICACION','PIEZAS A CAMBIO'].join(TAB);
  const texto = [enc, fila('ACT-AUTO','PISO','2'), fila('ACT-AUTO-TR','TRANSITO','3'), fila('ACT-GNP-5','PISO','5')].join('\n');
  actualizacion.aplicar(db, texto, null);
  const auto = db.prepare(`SELECT * FROM siniestros WHERE numero='ACT-AUTO'`).get();
  assert.equal(auto.aseguradora_ruta_refacciones, 'autosurtido');
  assert.equal(auto.requiere_refacciones, 'si');
  assert.equal(auto.piezas_autorizadas_cambio, 2);
  assert.equal(db.prepare(`SELECT aseguradora_ruta_refacciones r FROM siniestros WHERE numero='ACT-GNP-5'`).get().r, 'inpart');

  const r = reporte.calcularReporteArranque(db);
  assert.ok(r.listas_para_iniciar.some(u => u.numero === 'ACT-AUTO'), 'autosurtido en piso = piezas en taller');
  assert.ok(!r.listas_para_iniciar.some(u => u.numero === 'ACT-AUTO-TR'), 'autosurtido en tránsito todavía no');
  assert.ok(!r.transito_para_citar.some(u => u.numero === 'ACT-AUTO-TR'), 'en tránsito no se asume que ya tiene piezas');
  assert.ok(!r.listas_para_iniciar.some(u => u.numero === 'ACT-GNP-5'), 'GNP 5 piezas va por Inpart y no tiene pedidos recibidos');
  assert.match(r.texto, /\[Autosurtido\]/);
});

test('ACT-4: "AUTOSURTIDO GNP" en requiere refacciones marca la ruta sin capturar piezas y se conserva al editar la ficha', async () => {
  crearSiniestro('ACT-AS-GNP', { aseguradora:'GNP', fecha_entrega_prevista: dias(15), autorizacion_fecha_respuesta:'2026-11-01', autorizador:'Ajustador' });
  crearSiniestro('ACT-AS-MAP', { aseguradora:'Mapfre' });
  const enc = ['SINIESTRO','UBICACION','REQUIERE REFACCIONES'].join(TAB);
  const texto = [enc, fila('ACT-AS-GNP','PISO','AUTOSURTIDO GNP'), fila('ACT-AS-MAP','PISO','AUTOSURTIDO GNP')].join('\n');
  const r = actualizacion.aplicar(db, texto, null);
  assert.match(r.filas.find(f => f.siniestro === 'ACT-AS-MAP').errores[0], /solo aplica para GNP/);
  const s = db.prepare(`SELECT * FROM siniestros WHERE numero='ACT-AS-GNP'`).get();
  assert.equal(s.aseguradora_ruta_refacciones, 'autosurtido');
  assert.equal(s.requiere_refacciones, 'si');
  assert.ok(reporte.calcularReporteArranque(db).listas_para_iniciar.some(u => u.numero === 'ACT-AS-GNP'));

  cookie = '';
  await req('POST', '/api/auth/login', { email:'admin@serviciocristian.mx', password:'ServicioCristian2026!' });
  const p = await req('PATCH', '/api/siniestros/' + s.id, { vehiculo:'Aveo Rojo' });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(db.prepare(`SELECT aseguradora_ruta_refacciones r FROM siniestros WHERE id=?`).get(s.id).r, 'autosurtido', 'editar la ficha no la regresa a "por confirmar"');
});

test('REPORTE-8: panorama del taller cuenta patio, circulando y fechas promesa', () => {
  const antes = reporte.calcularReporteArranque(db).taller;
  crearSiniestro('PAN-PISO-LAM', { ubicacion:'Piso', estado_produccion:'en_laminado', fecha_entrega_prevista: dias(2) });
  crearSiniestro('PAN-PISO-NOAUT', { ubicacion:'Piso', estado_autorizacion:null });
  crearSiniestro('PAN-PISO-TERM', { ubicacion:'Piso', estado_produccion:'terminado' });
  crearSiniestro('PAN-TR-ESPERA', { ubicacion:'Tránsito', requiere_refacciones:'si' });
  crearSiniestro('PAN-TR-LISTA', { ubicacion:'Tránsito', requiere_refacciones:'no' });
  crearSiniestro('PAN-TR-CITA', { ubicacion:'Tránsito', cita_fecha: dias(3) });
  crearSiniestro('PAN-ENTREGADA', { ubicacion:'Piso', fecha_entrega_real: dias(-1) });
  const r = reporte.calcularReporteArranque(db);
  const t = r.taller;
  assert.equal(t.patio - antes.patio, 3, 'la entregada no cuenta');
  assert.equal(t.por_autorizar - antes.por_autorizar, 1);
  assert.equal(t.en_reparacion - antes.en_reparacion, 1);
  assert.equal(t.terminadas - antes.terminadas, 1);
  assert.equal(t.circulando - antes.circulando, 3);
  assert.equal(t.esperando_piezas - antes.esperando_piezas, 1);
  assert.equal(t.piezas_completas_sin_cita - antes.piezas_completas_sin_cita, 1);
  assert.equal(t.con_cita - antes.con_cita, 1);
  assert.equal(t.vencen_3_dias - antes.vencen_3_dias, 1);
  assert.match(r.texto, /PANORAMA DEL TALLER/);
  assert.match(r.texto, /🅿️ \*En patio: \d+\*/);
  assert.match(r.texto, /🚗 \*Circulando: \d+\*/);
  assert.match(r.texto, /Hojalatería \d+/);
});

test('FECHA-1: Beto/Alejandra capturan la fecha; cambiarla solo Daniela o Roberto, con motivo en la línea de tiempo', async () => {
  const id = crearSiniestro('FECHA-001', { autorizacion_fecha_respuesta:'2026-11-01', autorizador:'A' });
  db.prepare(`INSERT OR IGNORE INTO usuarios (nombre,email,password_hash,rol) VALUES ('Beto prueba','beto.prueba@x.mx',?,'beto')`).run(require('bcryptjs').hashSync('Clave123!', 4));
  cookie = ''; assert.equal((await req('POST','/api/auth/login',{ email:'beto.prueba@x.mx', password:'Clave123!' })).status, 200);
  assert.equal((await req('PATCH','/api/siniestros/'+id,{ fecha_entrega_prevista: dias(10) })).status, 200, 'Beto la captura');
  const r = await req('PATCH','/api/siniestros/'+id,{ fecha_entrega_prevista: dias(12) });
  assert.equal(r.status, 403, 'Beto ya no la puede cambiar');
  assert.match(r.data.error, /Daniela o Roberto/);
  cookie = ''; await req('POST','/api/auth/login',{ email:'daniela@serviciocristian.mx', password:'ServicioCristian2026-Reset!' });
  assert.equal((await req('PATCH','/api/siniestros/'+id,{ fecha_entrega_prevista: dias(12), motivo_cambio_fecha:'Llegó tarde la facia' })).status, 200, 'Daniela sí');
  const aud = db.prepare(`SELECT valor_nuevo FROM auditoria WHERE entidad_id=? AND accion='cambio_fecha_entrega'`).get(id);
  assert.match(aud.valor_nuevo, /Llegó tarde la facia/);
});

test('FECHA-2: el reporte pide fecha solo a unidades en piso con piezas listas (60%+), no a las que circulan o esperan piezas', () => {
  const lista = crearSiniestro('FECHA-LISTA', { ubicacion:'Piso', requiere_refacciones:'no' });
  const circula = crearSiniestro('FECHA-CIRCULA', { ubicacion:'Tránsito', requiere_refacciones:'no' });
  const espera = crearSiniestro('FECHA-ESPERA', { ubicacion:'Piso', requiere_refacciones:'si' });
  const sesenta = crearSiniestro('FECHA-60', { ubicacion:'Piso', requiere_refacciones:'si' });
  const ped = Number(db.prepare(`INSERT INTO pedidos (numero, siniestro_id, fecha_creacion) VALUES ('FECHA-60-P', ?, ?)`).run(sesenta, dias(-5)).lastInsertRowid);
  ['Recibida físicamente','Recibida físicamente','Recibida físicamente','Confirmada','Confirmada'].forEach((e,i)=>
    db.prepare(`INSERT INTO piezas (pedido_id, descripcion, estatus) VALUES (?, ?, ?)`).run(ped, 'P'+i, e));
  const r = reporte.calcularReporteArranque(db);
  const nums = r.falta_fecha_entrega.map(u => u.numero);
  assert.ok(nums.includes('FECHA-LISTA'));
  assert.ok(nums.includes('FECHA-60'), '3 de 5 piezas = 60%');
  assert.ok(!nums.includes('FECHA-CIRCULA'));
  assert.ok(!nums.includes('FECHA-ESPERA'));
  assert.ok(r.listas_para_iniciar.some(u => u.numero === 'FECHA-60'), 'con 60% ya aparece para iniciar');
  assert.match(r.texto, /Falta fecha de entrega – Beto/);
});
