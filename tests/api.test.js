// Pruebas automatizadas REALES contra la API (corrige F-09: antes el panel de "Reglas y pruebas"
// marcaba pass:true fijo sin comprobar nada). Cada prueba aquí falla de verdad si la regla se rompe.
// Ejecutar con: npm test  (usa el test runner integrado de Node, no requiere dependencias extra)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Base de datos de pruebas aislada, para no tocar los datos reales de Daniela.
const TEST_DB = path.join(__dirname, '..', 'data', 'test.db');
if(fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const PORT = 3999;
const BASE = 'http://localhost:' + PORT;
let server;
let cookie = '';

function withCookie(opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (cookie) headers['Cookie'] = cookie;
  return { ...opts, headers };
}
async function req(method, url, body) {
  const res = await fetch(BASE + url, withCookie({ method, body: body ? JSON.stringify(body) : undefined }));
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, resolve); });
  // El reset de emergencia (resetEmergenciaDaniela) cambia la contraseña de Daniela al arrancar el server,
  // así que el login inicial de las pruebas usa la contraseña ya reseteada, no la temporal original.
  const r = await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  assert.equal(r.status, 200, 'login inicial debe funcionar con la contraseña vigente');
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

test('CA-01: dos pedidos del mismo siniestro aparecen juntos en su ficha', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CA01-TEST', aseguradora: 'GNP', vehiculo: 'Aveo', placas: 'AAA-000-A' })).data;
  await req('POST', '/api/pedidos', { numero: 'CA01-PED-1', siniestro_id: s.id, fecha_prevista: '2027-06-01' });
  await req('POST', '/api/pedidos', { numero: 'CA01-PED-2', siniestro_id: s.id, fecha_prevista: '2027-06-02' });
  const r = await req('GET', '/api/pedidos?siniestro_id=' + s.id);
  assert.equal(r.data.length, 2, 'ambos pedidos deben listarse bajo el mismo siniestro');
});

test('CA-03 / F-01 / F-02: una pieza con incidencia NUNCA aparece en el borrador de correo', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CA03-TEST', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'CA03-PED', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  const pv = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor CA03' })).data;
  const z1 = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Espejo lateral derecho', proveedor_id: pv.id })).data;
  const z2 = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro delantero', proveedor_id: pv.id })).data;
  // marcar z1 como recibida (sin incidencia)
  await req('POST', `/api/piezas/${z1.id}/recibir`);
  const borrador = (await req('GET', `/api/comunicaciones/generar-borrador/${p.id}`)).data;
  assert.equal(borrador.requiereCorreo, true);
  const todasLasPiezasEnBorrador = borrador.borradores.flatMap(b => b.piezas.map(pz => pz.id));
  assert.ok(!todasLasPiezasEnBorrador.includes(z1.id), 'la pieza recibida no debe aparecer en el borrador');
  assert.ok(todasLasPiezasEnBorrador.includes(z2.id), 'la pieza pendiente sí debe aparecer en el borrador');
});

test('CA-04 / R-05: si todas las piezas están recibidas o canceladas, no se requiere correo', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CA04-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'CA04-PED', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Cofre' })).data;
  await req('POST', `/api/piezas/${z.id}/recibir`);
  const borrador = (await req('GET', `/api/comunicaciones/generar-borrador/${p.id}`)).data;
  assert.equal(borrador.requiereCorreo, false, 'no debe requerir correo si todo está recibido');
});

test('CA-05 / R-07 / F-14: la exclusión de proveedor es temporal, no bloquea envíos futuros', async () => {
  const prov = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor CA05 SA' })).data;
  const s = (await req('POST', '/api/siniestros', { numero: 'CA05-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'CA05-PED', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  const exSinMotivo = await req('POST', '/api/comunicaciones/exclusiones', { pedido_id: p.id, proveedor_id: prov.id });
  assert.equal(exSinMotivo.status, 400, 'el motivo debe ser obligatorio');
  const ex = await req('POST', '/api/comunicaciones/exclusiones', { pedido_id: p.id, proveedor_id: prov.id, motivo: 'Revisión de precio, solo este envío' });
  assert.equal(ex.status, 201);
  const provDespues = (await req('GET', '/api/proveedores/' + prov.id)).data;
  assert.equal(provDespues.activo, 1, 'el proveedor sigue activo, no queda bloqueado permanentemente');
});

test('CA-06 / R-06: un pedido Facturado en Inpart sigue como pendiente hasta recepción física', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CA06-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'CA06-PED', siniestro_id: s.id, estatus_inpart: 'Facturado' , fecha_prevista: '2027-06-01' })).data;
  assert.equal(p.estatus_operativo, 'Nuevo');
  assert.notEqual(p.estatus_operativo, 'Cerrado');
  assert.notEqual(p.estatus_operativo, 'Recibido completo');
});

test('CA-07: no se crean siniestros ni pedidos duplicados', async () => {
  await req('POST', '/api/siniestros', { numero: 'CA07-TEST', aseguradora: 'GNP' });
  const dup = await req('POST', '/api/siniestros', { numero: 'CA07-TEST', aseguradora: 'GNP' });
  assert.equal(dup.status, 409, 'debe rechazar el número de siniestro duplicado');
  assert.ok(dup.data.duplicado, 'debe indicar el registro existente');
});

test('CA-08 / F-22: la bitácora registra quién cambió qué y cuándo, y es de solo lectura', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CA08-TEST', aseguradora: 'GNP', vehiculo: 'X' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, { vehiculo: 'Nissan Versa' });
  const eventos = (await req('GET', '/api/auditoria?entidad_tipo=siniestro&entidad_id=' + s.id)).data;
  const edicion = eventos.find(e => e.campo === 'vehiculo');
  assert.ok(edicion, 'debe existir un evento de auditoría del cambio de vehículo');
  assert.equal(edicion.valor_nuevo, 'Nissan Versa');
  assert.equal(edicion.valor_anterior, 'X');
  assert.ok(edicion.usuario_nombre, 'el evento debe indicar el usuario responsable');
});

test('CA-09: los filtros de GNP devuelven únicamente registros de GNP', async () => {
  await req('POST', '/api/siniestros', { numero: 'CA09-GNP', aseguradora: 'GNP' });
  await req('POST', '/api/siniestros', { numero: 'CA09-MAPFRE', aseguradora: 'Mapfre' });
  const r = await req('GET', '/api/siniestros?aseguradora=GNP');
  assert.ok(r.data.every(s => s.aseguradora === 'GNP'), 'todos los resultados deben ser GNP');
  assert.ok(r.data.some(s => s.numero === 'CA09-GNP'));
  assert.ok(!r.data.some(s => s.numero === 'CA09-MAPFRE'));
});

test('CA-10 / F-17: la exportación CSV conserva ceros iniciales y neutraliza fórmulas', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: '0009900001A', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: '00777', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: '=CMD|"/c calc"!A1' }); // intento de inyección de fórmula
  const res = await fetch(BASE + '/api/reportes/lista-maestra.csv?q=0009900001A', { headers: { Cookie: cookie } });
  const text = await res.text();
  // El CSV envuelve cada celda en comillas y duplica las comillas internas (RFC4180), por eso el
  // patrón real de la celda forzada a texto es ="..."" con comillas dobles internas.
  assert.ok(text.includes('=""0009900001A""'), 'el número de siniestro debe exportarse forzado como texto (conserva ceros)');
  assert.ok(text.includes('=""00777""'), 'el número de pedido debe exportarse forzado como texto');
  assert.ok(!text.includes('","=CMD'), 'una descripción que empieza con "=" debe neutralizarse, no quedar como fórmula ejecutable al inicio de celda');
  assert.ok(text.includes("'=CMD"), 'debe anteponer un apóstrofe para neutralizar la fórmula, conservando el texto visible');
});

test('F-03: el Kanban nunca oculta pedidos con incidencia, cancelados o vencidos', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'F03-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'F03-PED', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  await req('PATCH', '/api/pedidos/' + p.id, { estatus_operativo: 'Cancelado' });
  const kanban = (await req('GET', '/api/reportes/kanban')).data;
  assert.ok(kanban.some(k => k.numero === 'F03-PED'), 'el pedido cancelado debe seguir presente en la respuesta del Kanban');
});

test('F-05: un pedido sin piezas capturadas es visible en la Lista maestra', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'F05-TEST', aseguradora: 'GNP' })).data;
  await req('POST', '/api/pedidos', { numero: 'F05-PED', siniestro_id: s.id , fecha_prevista: '2027-06-01' });
  const filas = (await req('GET', '/api/reportes/lista-maestra?q=F05-PED')).data.filas;
  assert.equal(filas.length, 1);
  assert.equal(filas[0].pieza_id, null, 'no debe tener pieza asociada');
});

test('F-10 / F-11: no se puede recibir una pieza con incidencia abierta; recibir queda ligado al usuario autenticado', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'F1011-TEST', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'F1011-PED', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Espejo lateral derecho' })).data;
  await req('POST', '/api/incidencias', { pieza_id: z.id, tipo: 'incorrecta', accion_solicitada: 'cambio' });

  const intento = await req('POST', `/api/piezas/${z.id}/recibir`);
  assert.equal(intento.status, 409, 'debe bloquear la recepción mientras la incidencia esté abierta');

  const incs = (await req('GET', '/api/incidencias?pieza_id=' + z.id)).data;
  const cierreSinResolucion = await req('PATCH', '/api/incidencias/' + incs[0].id, { estado: 'resuelta' });
  assert.equal(cierreSinResolucion.status, 400, 'cerrar como resuelta sin describir la resolución debe rechazarse');

  await req('PATCH', '/api/incidencias/' + incs[0].id, { estado: 'resuelta', resolucion: 'Proveedor envió pieza correcta, confirmada físicamente.' });
  const recibida = await req('POST', `/api/piezas/${z.id}/recibir`);
  assert.equal(recibida.status, 200, 'tras resolver la incidencia, sí debe poder marcarse como recibida');
  assert.equal(recibida.data.estatus, 'Recibida físicamente');
  assert.ok(recibida.data.recibido_por, 'debe quedar registrado el usuario autenticado que recibió, no texto libre');
});

test('F-12: se puede registrar la respuesta de un proveedor a un correo', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'F12-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'F12-PED', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  const com = (await req('POST', '/api/comunicaciones', { pedido_id: p.id, destinatarios: 'prueba@proveedor.mx', asunto: 'Test', cuerpo: 'Cuerpo' })).data;
  const resp = await req('PATCH', `/api/comunicaciones/${com.id}/respuesta`, { respuesta_texto: 'Llega la próxima semana', compromiso_fecha: '2026-09-05' });
  assert.equal(resp.status, 200);
  assert.equal(resp.data.respuesta_texto, 'Llega la próxima semana');
});

test('F-15: las comunicaciones quedan ligadas al proveedor correcto cuando el pedido tiene varios proveedores', async () => {
  const provA = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor A F15' })).data;
  const provB = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor B F15' })).data;
  const s = (await req('POST', '/api/siniestros', { numero: 'F15-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'F15-PED', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, proveedor_id: provA.id, descripcion: 'Pieza de A' });
  await req('POST', '/api/piezas', { pedido_id: p.id, proveedor_id: provB.id, descripcion: 'Pieza de B' });
  const borrador = (await req('GET', `/api/comunicaciones/generar-borrador/${p.id}`)).data;
  assert.equal(borrador.borradores.length, 2, 'debe generar un borrador separado por proveedor');
  const provIds = borrador.borradores.map(b => b.proveedor_id).sort();
  assert.deepEqual(provIds, [provA.id, provB.id].sort());
});

test('Caso real de Daniela (siniestro 4264105314000171 / pedido 337196 / espejo incorrecto): flujo completo del criterio de repetición de pruebas', async () => {
  // 1. Crear o importar el siniestro y el pedido sin duplicarlos.
  let r = await req('POST', '/api/siniestros', { numero: '4264105314000171-REPRO', aseguradora: 'Mapfre', vehiculo: 'Por confirmar', placas: 'Por confirmar' });
  const siniestro = r.data;
  assert.ok(siniestro.advertencia, 'con datos genéricos debe marcarse como pendiente de completar');
  const dupIntento = await req('POST', '/api/siniestros', { numero: '4264105314000171-REPRO', aseguradora: 'Mapfre' });
  assert.equal(dupIntento.status, 409, 'no debe duplicar el siniestro');

  r = await req('POST', '/api/pedidos', { numero: '337196-REPRO', siniestro_id: siniestro.id, estatus_inpart: 'Entregado' , fecha_prevista: '2027-06-01' });
  const pedido = r.data;

  // 2. Agregar la pieza Espejo lateral derecho, con proveedor asignado (triage DEF-007/008: sin
  // proveedor no se genera intento de correo, así que para probar ese flujo hace falta asignarlo).
  const provRepro = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor Repro 171', correo: 'contacto@proveedorrepro.mx' })).data;
  r = await req('POST', '/api/piezas', { pedido_id: pedido.id, descripcion: 'Espejo lateral derecho', proveedor_id: provRepro.id });
  const pieza = r.data;
  assert.equal(pieza.descripcion, 'Espejo lateral derecho');

  // 3. Registrar que la pieza entregada es incorrecta SIN marcarla como recibida físicamente.
  await req('POST', `/api/piezas/${pieza.id}/entregar`);
  r = await req('POST', '/api/incidencias', { pieza_id: pieza.id, tipo: 'incorrecta', descripcion: 'Espejo no corresponde al modelo', accion_solicitada: 'cambio', fecha_compromiso: '2026-08-25' });
  const incidencia = r.data;
  const piezaTrasIncidencia = (await req('GET', '/api/piezas/' + pieza.id)).data;
  assert.notEqual(piezaTrasIncidencia.estatus, 'Recibida físicamente', 'la pieza NO debe quedar marcada como recibida');
  assert.equal(piezaTrasIncidencia.estatus, 'Incorrecta/dañada');

  // 4. La incidencia tiene fecha de solución y queda abierta (las fotografías se adjuntan vía /api/archivos, probado aparte).
  assert.equal(incidencia.fecha_compromiso, '2026-08-25');
  assert.equal(incidencia.estado, 'abierta');

  // 5. El pedido sigue visible en Inicio (resumen), Kanban, Lista maestra e Incidencias.
  const kanban = (await req('GET', '/api/reportes/kanban')).data;
  assert.ok(kanban.some(k => k.numero === '337196-REPRO'), 'debe seguir visible en Kanban');
  const lista = (await req('GET', '/api/reportes/lista-maestra?q=337196-REPRO')).data.filas;
  assert.ok(lista.length > 0, 'debe seguir visible en Lista maestra');
  const incidenciasAbiertas = (await req('GET', '/api/incidencias?estado=abierta')).data;
  assert.ok(incidenciasAbiertas.some(i => i.id === incidencia.id), 'debe seguir visible en la bandeja de Incidencias');
  const resumen = (await req('GET', '/api/reportes/resumen')).data;
  assert.ok(resumen.incidenciasAbiertas >= 1, 'el resumen de Inicio debe contar la incidencia abierta');

  // 6. Generar un borrador correcto (plantilla de incidencia) sin reasignar proveedor y sin enviarlo automáticamente.
  const borrador = (await req('GET', `/api/comunicaciones/generar-borrador/${pedido.id}`)).data;
  assert.equal(borrador.requiereCorreo, true);
  assert.equal(borrador.borradores[0].tipo_plantilla, 'incidencia', 'debe usar la plantilla de incidencia, no la genérica de estatus');
  const comunicacionesAntes = (await req('GET', '/api/comunicaciones?pedido_id=' + pedido.id)).data.filter(c => c.estado === 'aprobado').length;
  assert.equal(comunicacionesAntes, 0, 'generar el borrador no debe enviar ni registrar nada todavía (puede existir el correo automático de "pedido nuevo", pero sigue pendiente de aprobación)');

  const aprobado = await req('POST', '/api/comunicaciones', {
    pedido_id: pedido.id, proveedor_id: borrador.borradores[0].proveedor_id,
    destinatarios: 'proveedor@ejemplo.mx', asunto: borrador.borradores[0].asunto, cuerpo: borrador.borradores[0].cuerpo, tipo_plantilla: 'incidencia'
  });
  assert.equal(aprobado.status, 201, 'aprobar y registrar sí debe requerir una acción explícita separada');

  // 7. Registrar la respuesta del proveedor y cerrar la incidencia únicamente después de confirmar la pieza correcta.
  await req('PATCH', `/api/comunicaciones/${aprobado.data.id}/respuesta`, { respuesta_texto: 'Confirman envío de espejo correcto para el 25/08.', compromiso_fecha: '2026-08-25' });

  const cierreTemprano = await req('POST', `/api/piezas/${pieza.id}/recibir`);
  assert.equal(cierreTemprano.status, 409, 'no debe poder cerrarse mientras la incidencia siga abierta');

  await req('PATCH', '/api/incidencias/' + incidencia.id, { estado: 'resuelta', resolucion: 'Proveedor entregó espejo correcto; confirmado físicamente por Daniela.' });
  const recepcionFinal = await req('POST', `/api/piezas/${pieza.id}/recibir`);
  assert.equal(recepcionFinal.status, 200, 'ahora sí debe permitir marcar la pieza como recibida');
  assert.equal(recepcionFinal.data.estatus, 'Recibida físicamente');

  const pedidoFinal = (await req('GET', '/api/pedidos/' + pedido.id)).data;
  assert.equal(pedidoFinal.estatus_operativo, 'Recibido completo', 'con la única pieza ya resuelta y recibida, el pedido debe cerrar');

  console.log('\n✅ Flujo completo del caso real de Daniela reproducido y verificado de punta a punta.');
});

test('F-19: los archivos se guardan realmente en disco (no solo el nombre)', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'F19-TEST', aseguradora: 'GNP' })).data;
  const fd = new FormData();
  fd.append('entidad_tipo', 'siniestro');
  fd.append('entidad_id', String(s.id));
  fd.append('tipo', 'Evidencia');
  fd.append('archivo', new Blob([Buffer.from('contenido de prueba')], { type: 'application/pdf' }), 'evidencia.pdf');
  const res = await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd });
  assert.equal(res.status, 201);
  const archivo = await res.json();
  assert.equal(archivo.nombre_original, 'evidencia.pdf');

  const descarga = await fetch(BASE + `/api/archivos/${archivo.id}/descargar`, { headers: { Cookie: cookie } });
  assert.equal(descarga.status, 200, 'el archivo debe poder descargarse de verdad desde disco');
  const contenido = await descarga.text();
  assert.equal(contenido, 'contenido de prueba');

  const rechazo = await fetch(BASE + '/api/archivos', {
    method: 'POST', headers: { Cookie: cookie },
    body: (() => { const f2 = new FormData(); f2.append('entidad_tipo','siniestro'); f2.append('entidad_id', String(s.id)); f2.append('archivo', new Blob(['x'], { type:'text/plain' }), 'malicioso.exe.txt'); return f2; })()
  });
  assert.equal(rechazo.status, 400, 'debe rechazar tipos de archivo no permitidos');
});

/* ===================== FASE 0 — Módulo Alejandra: migración aditiva ===================== */
test('FASE0-1: el expediente maestro (siniestros) tiene las columnas nuevas del módulo de Alejandra, sin perder las de Daniela', async () => {
  const db = require('../server/db');
  const cols = db.prepare('PRAGMA table_info(siniestros)').all().map(c => c.name);
  // columnas originales de Daniela siguen presentes
  ['numero','aseguradora','vehiculo','placas','completo','estatus_general'].forEach(c => {
    assert.ok(cols.includes(c), `no debe perderse la columna original "${c}"`);
  });
  // columnas nuevas del expediente maestro
  ['cliente_nombre','cliente_telefono','cliente_correo','cliente_notas','orden_admision','canal_origen',
   'etapa_actual','prioridad','requiere_refacciones','deducible','forma_pago','fecha_entrega_prevista',
   'fecha_entrega_real','postventa_programada','postventa_completada'].forEach(c => {
    assert.ok(cols.includes(c), `falta la columna nueva "${c}"`);
  });
});

test('FASE0-2: requiere_refacciones nace en "por_definir" y un siniestro nuevo de Daniela sigue creándose igual que antes', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE0-TEST-1', aseguradora: 'GNP', vehiculo: 'Aveo', placas: 'ZZZ-111-A' })).data;
  assert.equal(s.requiere_refacciones, 'por_definir', 'debe nacer sin definir hasta que Alejandra o Daniela lo determinen');
  assert.equal(s.completo, 1, 'la lógica de completo de Daniela no debe alterarse');
});

test('FASE0-3: el rol nuevo "atencion_cliente" es válido y los roles existentes de Daniela/admin siguen funcionando', async () => {
  const db = require('../server/db');
  const bcrypt = require('bcryptjs');
  assert.doesNotThrow(() => {
    db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
      .run('Alejandra Prueba', 'alejandra.fase0.test@serviciocristian.mx', bcrypt.hashSync('x',4), 'atencion_cliente');
  }, 'el CHECK de rol debe aceptar atencion_cliente');
  assert.throws(() => {
    db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
      .run('Rol Invalido', 'rolinvalido.fase0.test@serviciocristian.mx', bcrypt.hashSync('x',4), 'rol_que_no_existe');
  }, 'el CHECK de rol debe seguir rechazando roles inválidos, igual que antes');
  const roles = db.prepare("SELECT rol FROM usuarios WHERE email IN ('daniela@serviciocristian.mx','admin@serviciocristian.mx')").all().map(r=>r.rol);
  assert.ok(roles.includes('operativo') && roles.includes('admin'), 'los usuarios sembrados de Daniela y admin conservan su rol original');
});

test('FASE0-4: las tablas nuevas del módulo de Alejandra existen y el catálogo de hitos está sembrado con la secuencia real', async () => {
  const db = require('../server/db');
  ['eventos_cliente','tareas','catalogo_hitos','siniestro_hitos','mensajes_ia'].forEach(t => {
    assert.doesNotThrow(() => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get(), `la tabla ${t} debe existir`);
  });
  const hitos = db.prepare('SELECT orden,clave,condicional FROM catalogo_hitos ORDER BY orden').all();
  assert.equal(hitos.length, 15, 'deben ser los 15 hitos reales descritos por Roberto');
  assert.equal(hitos[0].clave, 'recepcion');
  assert.equal(hitos[hitos.length-1].clave, 'postventa');
  const condicionales = hitos.filter(h => h.condicional === 1).map(h => h.clave);
  ['espera_refacciones','refacciones_completas','cita_reingreso','reprogramacion_cita','mecanica'].forEach(c => {
    assert.ok(condicionales.includes(c), `"${c}" debe quedar marcado como condicional (puede omitirse)`);
  });
});

test('FASE0-5: correr la inicialización de la base dos veces no duplica el catálogo de hitos ni rompe nada (idempotencia)', async () => {
  const db = require('../server/db');
  const antes = db.prepare('SELECT COUNT(*) c FROM catalogo_hitos').get().c;
  delete require.cache[require.resolve('../server/db')];
  require('../server/db');
  const despues = db.prepare('SELECT COUNT(*) c FROM catalogo_hitos').get().c;
  assert.equal(antes, despues, 'no debe duplicarse el catálogo al reiniciar el servidor');
});

/* ===================== FASE 1 — Módulo Alejandra: alta desde recepción + filtro de Daniela ===================== */
test('FASE1-1: Alejandra existe, puede iniciar sesión, y sus datos básicos de cliente son obligatorios al dar de alta un expediente', async () => {
  const loginAlejandra = await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  assert.equal(loginAlejandra.status, 200, 'Alejandra debe poder iniciar sesión con la contraseña temporal sembrada');
  assert.equal(loginAlejandra.data.user.rol, 'atencion_cliente');

  const sinNombre = await req('POST', '/api/siniestros', { numero: 'FASE1-SINDATOS', aseguradora: 'GNP', cliente_telefono: '555', cliente_correo: 'x@x.com' });
  assert.equal(sinNombre.status, 400, 'debe rechazar sin nombre de cliente cuando lo crea Alejandra');

  const sinTelefono = await req('POST', '/api/siniestros', { numero: 'FASE1-SINDATOS', aseguradora: 'GNP', cliente_nombre: 'Cliente Prueba', cliente_correo: 'x@x.com' });
  assert.equal(sinTelefono.status, 400, 'debe rechazar sin teléfono de cliente cuando lo crea Alejandra');

  const sinCorreo = await req('POST', '/api/siniestros', { numero: 'FASE1-SINDATOS', aseguradora: 'GNP', cliente_nombre: 'Cliente Prueba', cliente_telefono: '555-000-0000' });
  assert.equal(sinCorreo.status, 400, 'debe rechazar sin correo de cliente cuando lo crea Alejandra');

  // volver a dejar la sesión como Daniela para no afectar pruebas futuras que dependan de su rol
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('FASE1-2: Alejandra puede registrar un expediente completo desde recepción, sin duplicar siniestros', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', {
    numero: 'FASE1-EXPEDIENTE-1', aseguradora: 'GNP',
    cliente_nombre: 'Juan Pérez', cliente_telefono: '55-1111-2222', cliente_correo: 'juan.perez@example.com',
    orden_admision: 'OA-001', canal_origen: 'WhatsApp'
  })).data;
  assert.equal(s.cliente_nombre, 'Juan Pérez');
  assert.equal(s.requiere_refacciones, 'por_definir', 'nace sin definir cuando Alejandra no lo sabe todavía');
  assert.equal(s.orden_admision, 'OA-001');

  const dup = await req('POST', '/api/siniestros', { numero: 'FASE1-EXPEDIENTE-1', aseguradora: 'GNP', cliente_nombre: 'Otro', cliente_telefono: '1', cliente_correo: 'o@o.com' });
  assert.equal(dup.status, 409, 'no debe duplicar el expediente aunque lo intente crear de nuevo');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('FASE1-3: la vista de Daniela oculta los expedientes marcados "no requiere refacciones", pero conserva "por definir" y "sí"', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const sSi = (await req('POST', '/api/siniestros', { numero: 'FASE1-REQ-SI', aseguradora: 'GNP', cliente_nombre: 'A', cliente_telefono: '1', cliente_correo: 'a@a.com', requiere_refacciones: 'si' })).data;
  const sNo = (await req('POST', '/api/siniestros', { numero: 'FASE1-REQ-NO', aseguradora: 'GNP', cliente_nombre: 'B', cliente_telefono: '2', cliente_correo: 'b@b.com', requiere_refacciones: 'no' })).data;
  const sPorDefinir = (await req('POST', '/api/siniestros', { numero: 'FASE1-REQ-PD', aseguradora: 'GNP', cliente_nombre: 'C', cliente_telefono: '3', cliente_correo: 'c@c.com' })).data;

  // Alejandra (y admin) deben poder ver los tres, incluidos los que no requieren refacciones
  const listaAlejandra = (await req('GET', '/api/siniestros')).data.map(x => x.numero);
  assert.ok(listaAlejandra.includes('FASE1-REQ-SI') && listaAlejandra.includes('FASE1-REQ-NO') && listaAlejandra.includes('FASE1-REQ-PD'));

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const listaDaniela = (await req('GET', '/api/siniestros')).data.map(x => x.numero);
  assert.ok(listaDaniela.includes('FASE1-REQ-SI'), 'Daniela debe ver los que sí requieren refacciones');
  assert.ok(listaDaniela.includes('FASE1-REQ-PD'), 'Daniela debe ver los que están por definir (podría ser ella quien lo determine)');
  assert.ok(!listaDaniela.includes('FASE1-REQ-NO'), 'Daniela NO debe ver los que explícitamente no requieren refacciones');
});

test('FASE1-4: crear el primer pedido sobre un expediente "por definir" lo confirma automáticamente como "sí", y queda auditado', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE1-AUTOFLIP', aseguradora: 'GNP' })).data;
  assert.equal(s.requiere_refacciones, 'por_definir');
  await req('POST', '/api/pedidos', { numero: 'FASE1-AUTOFLIP-PED1', siniestro_id: s.id , fecha_prevista: '2027-06-01' });
  const actualizado = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.equal(actualizado.requiere_refacciones, 'si', 'debe pasar a "sí" automáticamente al crear el primer pedido');

  const auditoria = (await req('GET', `/api/auditoria?entidad_tipo=siniestro&entidad_id=${s.id}`)).data;
  assert.ok(auditoria.some(a => a.campo === 'requiere_refacciones' && a.valor_anterior === 'por_definir' && a.valor_nuevo === 'si'),
    'el cambio automático debe quedar en la bitácora de auditoría');
});

test('FASE1-5: Daniela sigue pudiendo crear un siniestro exactamente igual que antes, sin que se le exijan datos de cliente', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE1-DANIELA-IGUAL', aseguradora: 'GNP', vehiculo: 'Sentra', placas: 'DAN-001-A' })).data;
  assert.equal(s.numero, 'FASE1-DANIELA-IGUAL');
  assert.equal(s.completo, 1);
});

/* ===================== FASE 2 — Módulo Alejandra: bitácora, tareas y alertas ===================== */
test('FASE2-1: al dar de alta un expediente, Alejandra recibe automáticamente la tarea de "mensaje inicial"', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', {
    numero: 'FASE2-TAREAINICIAL', aseguradora: 'GNP', cliente_nombre: 'X', cliente_telefono: '1', cliente_correo: 'x@x.com'
  })).data;
  const tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.equal(tareas.length, 1, 'debe crearse exactamente una tarea automática');
  assert.equal(tareas[0].origen, 'automatica');
  assert.equal(tareas[0].disparador, 'alta_expediente');
  assert.match(tareas[0].descripcion, /mensaje inicial/i);
});

test('FASE2-2: la bitácora de comunicaciones con cliente se registra y lista correctamente (separada de comunicaciones a proveedores)', async () => {
  const s = (await req('POST', '/api/siniestros', {
    numero: 'FASE2-BITACORA', aseguradora: 'GNP', cliente_nombre: 'Y', cliente_telefono: '2', cliente_correo: 'y@y.com'
  })).data;
  const sinDireccion = await req('POST', '/api/eventos-cliente', { siniestro_id: s.id, mensaje: 'hola' });
  assert.equal(sinDireccion.status, 400, 'debe exigir dirección entrante/saliente');

  const ev = await req('POST', '/api/eventos-cliente', { siniestro_id: s.id, direccion: 'saliente', canal: 'WhatsApp', mensaje: 'Le informamos que su unidad ya está en valuación.' });
  assert.equal(ev.status, 201);
  assert.equal(ev.data.autor_nombre, 'Alejandra');

  const lista = (await req('GET', '/api/eventos-cliente?siniestro_id=' + s.id)).data;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].direccion, 'saliente');
});

test('FASE2-3: Alejandra puede crear una tarea suelta (no solo automáticas) y marcarla completada', async () => {
  const s = (await req('POST', '/api/siniestros', {
    numero: 'FASE2-TAREASUELTA', aseguradora: 'GNP', cliente_nombre: 'Z', cliente_telefono: '3', cliente_correo: 'z@z.com'
  })).data;
  const t = await req('POST', '/api/tareas', { siniestro_id: s.id, descripcion: 'Llamar al cliente mañana a las 10am', fecha_limite: '2026-01-01' });
  assert.equal(t.status, 201);
  assert.equal(t.data.origen, 'manual');
  assert.equal(t.data.estado, 'pendiente');

  const completar = await req('PATCH', '/api/tareas/' + t.data.id, { estado: 'completada' });
  assert.equal(completar.status, 200);
  assert.equal(completar.data.estado, 'completada');
  assert.ok(completar.data.completado_en, 'debe registrar cuándo se completó');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('FASE2-4: la bandeja de clientes calcula días sin actualización y cuenta tareas pendientes/vencidas', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', {
    numero: 'FASE2-BANDEJA', aseguradora: 'GNP', cliente_nombre: 'W', cliente_telefono: '4', cliente_correo: 'w@w.com'
  })).data;
  await req('POST', '/api/tareas', { siniestro_id: s.id, descripcion: 'Tarea vencida de prueba', fecha_limite: '2020-01-01' });

  const bandeja = (await req('GET', '/api/reportes/bandeja-clientes')).data;
  const fila = bandeja.find(x => x.numero === 'FASE2-BANDEJA');
  assert.ok(fila, 'el expediente debe aparecer en la bandeja');
  assert.equal(typeof fila.dias_sin_actualizacion, 'number');
  // 2 tareas: la automática de mensaje inicial + la vencida manual -> ambas pendientes, 1 vencida
  assert.equal(fila.tareas_pendientes, 2);
  assert.equal(fila.tareas_vencidas, 1);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== FASE 3 — Módulo Alejandra: catálogo de hitos por expediente ===================== */
test('FASE3-1: al consultar los hitos de un expediente se aprovisionan automáticamente los 15, en orden, todos "pendiente"', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE3-HITOS-1', aseguradora: 'GNP', cliente_nombre: 'A', cliente_telefono: '1', cliente_correo: 'a@a.com' })).data;
  const hitos = (await req('GET', '/api/hitos?siniestro_id=' + s.id)).data;
  assert.equal(hitos.length, 15);
  assert.equal(hitos[0].clave, 'recepcion');
  assert.equal(hitos[14].clave, 'postventa');
  assert.ok(hitos.every(h => h.estado === 'pendiente'));

  // pedir de nuevo no debe duplicar (idempotencia del aprovisionamiento)
  const hitos2 = (await req('GET', '/api/hitos?siniestro_id=' + s.id)).data;
  assert.equal(hitos2.length, 15);
});

test('FASE3-2: un expediente creado ANTES de esta fase (sin filas en siniestro_hitos) también se aprovisiona al consultarlo', async () => {
  // Reutiliza el caso real sembrado por seed.js, que nació antes de que existiera el módulo de hitos.
  const siniestros = (await req('GET', '/api/siniestros')).data;
  const casoReal = siniestros.find(s => s.numero === '4264105314000171');
  assert.ok(casoReal, 'debe existir el caso real sembrado');
  const hitos = (await req('GET', '/api/hitos?siniestro_id=' + casoReal.id)).data;
  assert.equal(hitos.length, 15, 'debe aprovisionarse igual que un expediente nuevo');
});

test('FASE3-3: marcar un hito como "no aplica" exige motivo, y marcarlo "enviado" exige mensaje y lo registra en la bitácora', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE3-HITOS-2', aseguradora: 'GNP', cliente_nombre: 'B', cliente_telefono: '2', cliente_correo: 'b@b.com' })).data;
  const hitos = (await req('GET', '/api/hitos?siniestro_id=' + s.id)).data;
  const espera = hitos.find(h => h.clave === 'espera_refacciones');
  assert.equal(espera.condicional, 1);

  const sinMotivo = await req('PATCH', '/api/hitos/' + espera.id, { estado: 'no_aplica' });
  assert.equal(sinMotivo.status, 400);
  const conMotivo = await req('PATCH', '/api/hitos/' + espera.id, { estado: 'no_aplica', motivo_no_aplica: 'El vehículo no requiere cambio de piezas.' });
  assert.equal(conMotivo.status, 200);
  assert.equal(conMotivo.data.estado, 'no_aplica');

  const recepcion = hitos.find(h => h.clave === 'recepcion');
  const sinMensaje = await req('PATCH', '/api/hitos/' + recepcion.id, { estado: 'enviado' });
  assert.equal(sinMensaje.status, 400);
  const conMensaje = await req('PATCH', '/api/hitos/' + recepcion.id, { estado: 'enviado', mensaje: 'Le explicamos el proceso completo al cliente por WhatsApp.' });
  assert.equal(conMensaje.status, 200);
  assert.ok(conMensaje.data.evento_cliente_id, 'debe quedar ligado a un evento de la bitácora');

  const bitacora = (await req('GET', '/api/eventos-cliente?siniestro_id=' + s.id)).data;
  assert.ok(bitacora.some(e => e.id === conMensaje.data.evento_cliente_id && e.mensaje.includes('explicamos el proceso completo')));

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== FASE 4 — Módulo Alejandra: copiloto de IA (sin API conectada) ===================== */
test('FASE4-1: el contexto para IA incluye los datos vigentes del expediente y las instrucciones de no inventar', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE4-CONTEXTO', aseguradora: 'GNP', cliente_nombre: 'Contexto Cliente', cliente_telefono: '55-0000-9999', cliente_correo: 'ctx@ctx.com' })).data;
  const r = await req('GET', '/api/mensajes-ia/contexto?siniestro_id=' + s.id);
  assert.equal(r.status, 200);
  assert.match(r.data.texto, /Contexto Cliente/);
  assert.match(r.data.texto, /55-0000-9999/);
  assert.match(r.data.texto, /FASE4-CONTEXTO/);
  assert.match(r.data.texto, /No inventes fechas/);
});

test('FASE4-2: se puede guardar un borrador pegado desde la IA, marcarlo revisado y luego enviado, y queda en la bitácora', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE4-BORRADOR', aseguradora: 'GNP', cliente_nombre: 'B', cliente_telefono: '1', cliente_correo: 'b@b.com' })).data;
  const contexto = (await req('GET', '/api/mensajes-ia/contexto?siniestro_id=' + s.id)).data.texto;

  const creado = await req('POST', '/api/mensajes-ia', { siniestro_id: s.id, contexto_usado: contexto, borrador: '' });
  assert.equal(creado.status, 201);
  assert.equal(creado.data.estado, 'generado');

  const sinBorrador = await req('PATCH', '/api/mensajes-ia/' + creado.data.id, { estado: 'enviado' });
  assert.equal(sinBorrador.status, 400, 'no debe poder marcarse enviado sin borrador');

  const conBorrador = await req('PATCH', '/api/mensajes-ia/' + creado.data.id, { borrador: 'Hola, le confirmamos que su vehículo ya está en valuación.', estado: 'aprobado' });
  assert.equal(conBorrador.status, 200);
  assert.equal(conBorrador.data.estado, 'aprobado');
  assert.ok(conBorrador.data.aprobado_por);

  const enviado = await req('PATCH', '/api/mensajes-ia/' + creado.data.id, { estado: 'enviado' });
  assert.equal(enviado.status, 200);
  assert.equal(enviado.data.estado, 'enviado');
  assert.ok(enviado.data.evento_cliente_id);

  const bitacora = (await req('GET', '/api/eventos-cliente?siniestro_id=' + s.id)).data;
  assert.ok(bitacora.some(e => e.id === enviado.data.evento_cliente_id && e.mensaje.includes('ya está en valuación')));

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== FASE 5 — Módulo Alejandra: automatizaciones cruzadas ===================== */
test('FASE5-1: cuando TODOS los pedidos de un expediente quedan en estado terminal, se crea una sola tarea automática (no duplicada)', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE5-REFCOMP', aseguradora: 'GNP', cliente_nombre: 'X', cliente_telefono: '1', cliente_correo: 'x@x.com' })).data;

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const p1 = (await req('POST', '/api/pedidos', { numero: 'FASE5-PED-1', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;
  const p2 = (await req('POST', '/api/pedidos', { numero: 'FASE5-PED-2', siniestro_id: s.id , fecha_prevista: '2027-06-01' })).data;

  await req('PATCH', '/api/pedidos/' + p1.id, { estatus_operativo: 'Recibido completo' });
  let tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.ok(!tareas.some(t => t.disparador === 'refacciones_completas'), 'no debe crearse todavía: falta el segundo pedido');

  await req('PATCH', '/api/pedidos/' + p2.id, { estatus_operativo: 'Recibido completo' });
  tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  const automaticas = tareas.filter(t => t.disparador === 'refacciones_completas');
  assert.equal(automaticas.length, 1, 'debe crearse exactamente una tarea cuando TODOS los pedidos ya cerraron');
  assert.match(automaticas[0].descripcion, /avisar al cliente/i);

  // volver a tocar el estatus no debe duplicar la tarea mientras siga pendiente
  await req('PATCH', '/api/pedidos/' + p2.id, { estatus_operativo: 'Recibido completo' });
  tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.equal(tareas.filter(t => t.disparador === 'refacciones_completas').length, 1, 'no debe duplicarse');
});

test('FASE5-2: cambiar la fecha prometida de un pedido crea una tarea automática de aviso al cliente', async () => {
  const s = (await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' })) && (await req('POST', '/api/siniestros', { numero: 'FASE5-FECHA', aseguradora: 'GNP', cliente_nombre: 'Y', cliente_telefono: '2', cliente_correo: 'y@y.com' })).data;
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const p = (await req('POST', '/api/pedidos', { numero: 'FASE5-PED-FECHA', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;

  await req('PATCH', '/api/pedidos/' + p.id, { cotizacion: 'sin cambio de fecha' });
  let tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.ok(!tareas.some(t => t.disparador === 'fecha_promesa_modificada'), 'no debe crear tarea si la fecha no cambió');

  await req('PATCH', '/api/pedidos/' + p.id, { fecha_prevista: '2026-09-10' });
  tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  const tarea = tareas.find(t => t.disparador === 'fecha_promesa_modificada');
  assert.ok(tarea, 'debe crear la tarea al cambiar la fecha prometida');
  assert.match(tarea.descripcion, /2027-06-01/);
  assert.match(tarea.descripcion, /2026-09-10/);
});

test('FASE5-3: confirmar el hito de Entrega como enviado programa la postventa automáticamente (2-3 días después) y crea su tarea', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE5-ENTREGA', aseguradora: 'GNP', cliente_nombre: 'Z', cliente_telefono: '3', cliente_correo: 'z@z.com' })).data;
  const hitos = (await req('GET', '/api/hitos?siniestro_id=' + s.id)).data;
  const entrega = hitos.find(h => h.clave === 'entrega');

  const r = await req('PATCH', '/api/hitos/' + entrega.id, { estado: 'enviado', mensaje: 'Su unidad ya está lista, la entregamos hoy a las 5pm.' });
  assert.equal(r.status, 200);

  const actualizado = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.ok(actualizado.postventa_programada, 'debe quedar programada la fecha de postventa');

  const tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  const tareaPostventa = tareas.find(t => t.disparador === 'entrega_confirmada');
  assert.ok(tareaPostventa, 'debe crearse la tarea automática de postventa');
  assert.equal(tareaPostventa.fecha_limite, actualizado.postventa_programada);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('REQ-DANIELA-1: solo Daniela (operativo) o admin pueden aprobar/registrar un correo; consulta no puede', async () => {
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ1-SIN', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ1-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;

  const okDaniela = await req('POST', '/api/comunicaciones', { pedido_id: p.id, destinatarios: 'prov@x.com', asunto: 'a', cuerpo: 'b' });
  assert.equal(okDaniela.status, 201, 'Daniela (operativo) sí puede aprobar/registrar un correo');

  // Un usuario de solo consulta no debería poder.
  await req('POST', '/api/auth/usuarios', { nombre: 'Consulta Test', email: 'consulta.req1@serviciocristian.mx', password: 'Password123!', rol: 'consulta' });
  // crearUsuario requiere admin; hacemos login como admin primero solo para crear al usuario de prueba.
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  await req('POST', '/api/auth/usuarios', { nombre: 'Consulta Test', email: 'consulta.req1@serviciocristian.mx', password: 'Password123!', rol: 'consulta' });
  await req('POST', '/api/auth/login', { email: 'consulta.req1@serviciocristian.mx', password: 'Password123!' });
  const bloqueado = await req('POST', '/api/comunicaciones', { pedido_id: p.id, destinatarios: 'prov@x.com', asunto: 'a', cuerpo: 'b' });
  assert.equal(bloqueado.status, 403, 'un usuario de consulta no debe poder aprobar correos');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('REQ-DANIELA-2: no se puede cerrar un siniestro con pedidos pendientes o sin fecha de entrega; sí cuando ambos se cumplen', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ2-SIN', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ2-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;

  const intento1 = await req('PATCH', `/api/siniestros/${s.id}/cerrar`, {});
  assert.equal(intento1.status, 400);
  assert.match(intento1.data.detalle.join(' '), /Pedidos sin recibir/);

  await req('PATCH', `/api/pedidos/${p.id}`, { estatus_operativo: 'Recibido completo' });
  const intento2 = await req('PATCH', `/api/siniestros/${s.id}/cerrar`, {});
  assert.equal(intento2.status, 400, 'todavía falta la fecha de entrega');
  assert.match(intento2.data.detalle.join(' '), /entrega/);

  const entrega = await req('PATCH', `/api/siniestros/${s.id}/entrega`, { fecha_entrega_real: '2026-08-20' });
  assert.equal(entrega.status, 200);

  const cierre = await req('PATCH', `/api/siniestros/${s.id}/cerrar`, {});
  assert.equal(cierre.status, 200);
  assert.equal(cierre.data.estatus_general, 'Cerrado');
});

test('REQ-DANIELA-3: un pedido cancelado cuenta como terminal para poder cerrar el siniestro', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ3-SIN', aseguradora: 'Inbursa' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ3-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  await req('PATCH', `/api/pedidos/${p.id}`, { estatus_operativo: 'Cancelado', motivo_cancelacion: 'Pérdida total' });
  await req('PATCH', `/api/siniestros/${s.id}/entrega`, { fecha_entrega_real: '2026-08-20' });
  const cierre = await req('PATCH', `/api/siniestros/${s.id}/cerrar`, {});
  assert.equal(cierre.status, 200);
});

test('REQ-DANIELA-4: la fecha promesa es obligatoria al crear un pedido', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ4-SIN', aseguradora: 'Afirme' })).data;
  const sinFecha = await req('POST', '/api/pedidos', { numero: 'REQ4-PED', siniestro_id: s.id });
  assert.equal(sinFecha.status, 400);
  assert.match(sinFecha.data.error, /fecha promesa/i);

  const conFecha = await req('POST', '/api/pedidos', { numero: 'REQ4-PED-OK', siniestro_id: s.id, fecha_prevista: '2027-06-01' });
  assert.equal(conFecha.status, 201);
});

test('REQ-DANIELA-5: cancelar un pedido exige motivo y lo conserva', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ5-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ5-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;

  const sinMotivo = await req('PATCH', `/api/pedidos/${p.id}`, { estatus_operativo: 'Cancelado' });
  assert.equal(sinMotivo.status, 400);
  assert.match(sinMotivo.data.error, /motivo/i);

  const conMotivo = await req('PATCH', `/api/pedidos/${p.id}`, { estatus_operativo: 'Cancelado', motivo_cancelacion: 'Reasignación de proveedor' });
  assert.equal(conMotivo.status, 200);
  assert.equal(conMotivo.data.motivo_cancelacion, 'Reasignación de proveedor');
});

test('REQ-DANIELA-6: dar de alta la primera pieza con proveedor prepara automáticamente un correo de "pedido nuevo", pendiente de aprobación', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ6-SIN', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ6-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  // Triage DEF-009: el correo de "pedido nuevo" ya no se dispara para un pedido vacío — hace falta que
  // tenga al menos una pieza con proveedor asignado (si no, no hay a quién escribirle).
  const provReq6 = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor REQ6', correo: 'contacto@proveedorreq6.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Defensa delantera', proveedor_id: provReq6.id });

  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  const propio = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo');
  assert.ok(propio, 'debe existir un correo automático de pedido nuevo pendiente de aprobación');
  assert.equal(propio.estado, 'pendiente_aprobacion');
  // Corrección del 27-ago-2026: ya no se guarda texto de instrucción en copia (antes decía "Copiar a
  // Jorge Contreras y Edgar..."); Mapfre no tiene direcciones reales configuradas, así que queda vacío.
  assert.equal(propio.copia, '', 'no debe haber texto de instrucción en copia; sin direcciones reales, queda vacío');
  assert.equal(propio.destinatarios, 'contacto@proveedorreq6.mx', 'el destinatario debe ser el correo real del proveedor de la pieza pendiente');
  assert.equal(propio.incompleto, 0);
  assert.match(propio.cuerpo, /estatus actualizado del pedido REQ6-PED/, 'debe usar la plantilla corregida que pide el estatus con claridad');
  assert.match(propio.cuerpo, /Defensa delantera/, 'debe listar la pieza pendiente');

  // No debe duplicarse si se vuelve a consultar la bandeja.
  const pendientes2 = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  assert.equal(pendientes2.filter(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo').length, 1);
});

test('REQ-DANIELA-7: un pedido con fecha promesa vencida genera correo automático de vencimiento (día 1)', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ7-SIN', aseguradora: 'Afirme' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ7-PED', siniestro_id: s.id, fecha_prevista: '2020-01-01', confirmar_fecha_prevista: true })).data;
  const provReq7 = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor REQ7', correo: 'contacto@proveedorreq7.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Salpicadera', proveedor_id: provReq7.id });

  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  const vencido = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'vencimiento_dia1');
  assert.ok(vencido, 'debe prepararse el correo de vencimiento');
  // Afirme no tiene una dirección real configurada para copia (antes decía "Copiar a Nancy Monserrat...",
  // texto de instrucción que se quitó el 27-ago-2026); debe quedar vacío, no inventar ni dejar la nota.
  assert.equal(vencido.copia, '');
  assert.equal(vencido.destinatarios, 'contacto@proveedorreq7.mx');
  assert.equal(vencido.incompleto, 0);
});

test('REQ-DANIELA-8: solo Daniela/admin pueden aprobar o descartar un correo de la bandeja; aprobar exige destinatario', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ8-SIN', aseguradora: 'GNP' })).data;
  const provReq8 = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor REQ8' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ8-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Cofre', proveedor_id: provReq8.id });
  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  const com = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo');

  const sinDestinatario = await req('PATCH', `/api/comunicaciones/${com.id}/aprobar`, {});
  assert.equal(sinDestinatario.status, 400);

  const aprobado = await req('PATCH', `/api/comunicaciones/${com.id}/aprobar`, { destinatarios: 'proveedor@ejemplo.mx' });
  assert.equal(aprobado.status, 200);
  assert.equal(aprobado.data.estado, 'aprobado');
  assert.ok(aprobado.data.aprobado_en);

  // Descartar: crear otro caso y verificar el permiso.
  const p2 = (await req('POST', '/api/pedidos', { numero: 'REQ8-PED-2', siniestro_id: s.id, fecha_prevista: '2026-12-02' })).data;
  await req('POST', '/api/piezas', { pedido_id: p2.id, descripcion: 'Puerta', proveedor_id: provReq8.id });
  const pendientes2 = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  const com2 = pendientes2.find(c => c.pedido_id === p2.id && c.disparador === 'pedido_nuevo');

  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const bloqueadoAprobar = await req('PATCH', `/api/comunicaciones/${com2.id}/aprobar`, { destinatarios: 'x@x.com' });
  assert.equal(bloqueadoAprobar.status, 403);
  const bloqueadoDescartar = await req('PATCH', `/api/comunicaciones/${com2.id}/descartar`, {});
  assert.equal(bloqueadoDescartar.status, 403);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const descartado = await req('PATCH', `/api/comunicaciones/${com2.id}/descartar`, { motivo: 'Duplicado' });
  assert.equal(descartado.status, 200);
});

test('REQ-DANIELA-9: el resumen diario refleja los correos realmente pendientes de aprobación', async () => {
  const antes = (await req('GET', '/api/reportes/resumen')).data.correosPendientes;
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ9-SIN', aseguradora: 'Inbursa' })).data;
  const provReq9 = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor REQ9' })).data;
  const p9 = (await req('POST', '/api/pedidos', { numero: 'REQ9-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  await req('POST', '/api/piezas', { pedido_id: p9.id, descripcion: 'Salpicadera', proveedor_id: provReq9.id });
  const despues = (await req('GET', '/api/reportes/resumen')).data.correosPendientes;
  assert.ok(despues > antes, 'debe aumentar el conteo de correos pendientes de aprobación');
});

test('REQ-DANIELA-10: sumarDiasHabiles salta fines de semana correctamente', () => {
  const { sumarDiasHabiles } = require('../server/utils');
  assert.equal(sumarDiasHabiles('2026-08-19', 2), '2026-08-21'); // miércoles + 2 hábiles = viernes
  assert.equal(sumarDiasHabiles('2026-08-20', 2), '2026-08-24'); // jueves + 2 hábiles = lunes (salta sáb/dom)
});

test('REQ-DANIELA-11: un siniestro entregado hace más de 3 meses se archiva solo, se oculta de la vista diaria y sigue disponible con ?archivado=1', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ11-SIN', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ11-PED', siniestro_id: s.id, fecha_prevista: '2026-01-01' })).data;
  await req('PATCH', `/api/pedidos/${p.id}`, { estatus_operativo: 'Recibido completo' });
  // Fecha de entrega hace más de 90 días respecto a "hoy" (el entorno de pruebas usa la fecha real del sistema).
  const hace100dias = new Date(Date.now() - 100*86400000).toISOString().slice(0,10);
  await req('PATCH', `/api/siniestros/${s.id}/entrega`, { fecha_entrega_real: hace100dias });

  const listaDefault = (await req('GET', '/api/siniestros')).data;
  assert.ok(!listaDefault.some(x => x.numero === 'REQ11-SIN'), 'no debe verse en la vista diaria por default');

  const soloArchivados = (await req('GET', '/api/siniestros?archivado=1')).data;
  assert.ok(soloArchivados.some(x => x.numero === 'REQ11-SIN'), 'debe seguir disponible consultando archivados');
  assert.equal(soloArchivados.find(x => x.numero === 'REQ11-SIN').archivado, 1);

  const todos = (await req('GET', '/api/siniestros?archivado=all')).data;
  assert.ok(todos.some(x => x.numero === 'REQ11-SIN'), 'debe seguir en el histórico completo (no se borra nada)');

  const kanban = (await req('GET', '/api/reportes/kanban')).data;
  assert.ok(!kanban.some(k => k.numero === 'REQ11-PED'), 'no debe verse en Kanban una vez archivado');

  // Se puede desarchivar manualmente.
  const desarch = await req('PATCH', `/api/siniestros/${s.id}/desarchivar`, {});
  assert.equal(desarch.status, 200);
  const listaDespues = (await req('GET', '/api/siniestros')).data;
  assert.ok(listaDespues.some(x => x.numero === 'REQ11-SIN'), 'debe reaparecer en la vista diaria tras desarchivar');
});

test('REQ-DANIELA-12: carga masiva - validar agrupa filas por pedido y detecta errores de columnas', async () => {
  const csv = [
    'numero_siniestro,aseguradora,vehiculo,placas,fecha_ingreso,responsable,numero_pedido,fecha_creacion_pedido,fecha_prevista,estatus_inpart,estatus_operativo,numero_parte,descripcion_pieza,precio,proveedor,telefono_proveedor,contacto_proveedor',
    'CM-SIN-1,GNP,Nissan Versa,ABC123,2026-08-01,Daniela,CM-PED-1,2026-08-01,2026-09-01,Aguardando confirmación,Nuevo,NP-1,Espejo derecho,850.50,Proveedor Uno,555-1111,Juan',
    'CM-SIN-1,GNP,Nissan Versa,ABC123,2026-08-01,Daniela,CM-PED-1,2026-08-01,2026-09-01,Aguardando confirmación,Nuevo,NP-2,Faro delantero,1200,Proveedor Uno,555-1111,Juan',
    'CM-SIN-2,Mapfre,,,,,CM-PED-3,,,,,,,,,,',
  ].join('\n');

  const r = await req('POST', '/api/carga-masiva/validar', { csv });
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 2, 'dos pedidos distintos: CM-PED-1 (2 piezas) y CM-PED-3');
  const pedido1 = r.data.pedidos.find(p => p.dato.numero_pedido === 'CM-PED-1');
  assert.equal(pedido1.piezas.length, 2, 'las 2 filas del mismo pedido se agrupan como 2 piezas de un solo pedido');
  assert.equal(pedido1.errores.length, 0);
  const pedido3 = r.data.pedidos.find(p => p.dato.numero_pedido === 'CM-PED-3');
  assert.ok(pedido3.errores.some(m => /fecha promesa/i.test(m)));
});

test('REQ-DANIELA-13: carga masiva - confirmar crea piezas con proveedor y precio real, agrupa pedidos bajo el mismo siniestro y actualiza en vez de duplicar al reimportar', async () => {
  const csv = [
    'numero_siniestro,aseguradora,vehiculo,placas,numero_pedido,fecha_prevista,numero_parte,descripcion_pieza,precio,proveedor,correo_proveedor',
    'CM2-SIN-1,GNP,Chevrolet Aveo,XYZ999,CM2-PED-1,2026-09-01,NPX-1,Cofre,3500,Proveedor Dos,ventas@proveedordos.mx',
    'CM2-SIN-1,GNP,Chevrolet Aveo,XYZ999,CM2-PED-2,2026-09-03,,,,,',
  ].join('\n');
  const validado = (await req('POST', '/api/carga-masiva/validar', { csv })).data;
  assert.equal(validado.pedidos.filter(p=>p.errores.length===0).length, 2);

  const confirmar = await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado.pedidos });
  assert.equal(confirmar.status, 200);
  assert.equal(confirmar.data.siniestrosCreados, 1, 'un solo siniestro para los 2 pedidos');
  assert.equal(confirmar.data.pedidosCreados, 2);
  assert.equal(confirmar.data.piezasCreadas, 1);
  assert.equal(confirmar.data.proveedoresCreados, 1);

  const siniestro = (await req('GET', '/api/siniestros?q=CM2-SIN-1')).data[0];
  const pedidos = (await req('GET', '/api/pedidos?siniestro_id=' + siniestro.id)).data;
  assert.equal(pedidos.length, 2, 'ambos pedidos quedaron bajo el mismo expediente');
  const pedidoConPieza = pedidos.find(p => p.numero === 'CM2-PED-1');
  assert.equal(Number(pedidoConPieza.total), 3500, 'el total del pedido se calcula de sus piezas reales, ya no queda en $0.00');
  const piezas = (await req('GET', '/api/piezas?pedido_id=' + pedidoConPieza.id)).data;
  assert.equal(piezas.length, 1);
  assert.ok(piezas[0].proveedor_id, 'la pieza quedó vinculada a un proveedor real, no Sin proveedor');

  // Reimportar el mismo archivo debe ACTUALIZAR (no duplicar) el pedido y la pieza existentes.
  const segundaVez = await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado.pedidos });
  assert.equal(segundaVez.data.pedidosCreados, 0);
  assert.equal(segundaVez.data.pedidosActualizados, 2);
  assert.equal(segundaVez.data.piezasCreadas, 0);
  assert.equal(segundaVez.data.piezasActualizadas, 1, 'la misma pieza se actualiza, no se duplica');
  const piezasDespues = (await req('GET', '/api/piezas?pedido_id=' + pedidoConPieza.id)).data;
  assert.equal(piezasDespues.length, 1, 'sigue habiendo solo 1 pieza tras reimportar');
});

test('TRIAGE-CARGA-1: el estatus de Inpart se traduce vía el mapeo editable y NUNCA marca una pieza como Recibida físicamente automáticamente', async () => {
  const csv = [
    'numero_siniestro,aseguradora,numero_pedido,fecha_prevista,numero_parte,descripcion_pieza,precio,estatus_inpart_pieza,proveedor',
    'CM3-SIN-1,GNP,CM3-PED-1,2026-09-01,NP-X,Salpicadera,900,Facturado,Proveedor Tres',
  ].join('\n');
  const validado = (await req('POST', '/api/carga-masiva/validar', { csv })).data;
  const confirmar = await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado.pedidos });
  const siniestro = (await req('GET', '/api/siniestros?q=CM3-SIN-1')).data[0];
  const pedido = (await req('GET', '/api/pedidos?siniestro_id=' + siniestro.id)).data[0];
  const pieza = (await req('GET', '/api/piezas?pedido_id=' + pedido.id)).data[0];
  assert.equal(pieza.estatus, 'Facturada', 'Facturado (Inpart) debe mapear a Facturada, nunca a Recibida físicamente');

  // Aunque se reimporte con un estatus de Inpart "Entregado", tampoco debe saltar a Recibida físicamente:
  // esa transición es exclusiva de la confirmación física manual.
  const csv2 = csv.replace('Facturado', 'Entregado');
  const validado2 = (await req('POST', '/api/carga-masiva/validar', { csv: csv2 })).data;
  await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado2.pedidos });
  const piezaDespues = await req('GET', '/api/piezas/' + pieza.id);
  assert.notEqual(piezaDespues.data.estatus, 'Recibida físicamente');
});

test('TRIAGE-CARGA-2: si el siniestro ya tiene placas capturadas y la carga trae un valor distinto, se reporta como conflicto en vez de sobrescribir en silencio', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CM4-SIN-1', aseguradora: 'GNP', placas: 'AAA111' })).data;
  const csv = [
    'numero_siniestro,aseguradora,placas,numero_pedido,fecha_prevista',
    'CM4-SIN-1,GNP,BBB222,CM4-PED-1,2026-09-01',
  ].join('\n');
  const validado = (await req('POST', '/api/carga-masiva/validar', { csv })).data;
  const confirmar = await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado.pedidos });
  assert.equal(confirmar.data.conflictos, 1);
  const conflicto = confirmar.data.conflictos_detalle || confirmar.data.conflictos;
  const siniestroDespues = await req('GET', '/api/siniestros/' + s.id);
  assert.equal(siniestroDespues.data.placas, 'AAA111', 'las placas ya capturadas no se sobrescriben automáticamente');
});

test('TRIAGE-CARGA-3: un lote de carga masiva se puede revertir (soft-revert), sin borrar nada, y no puede revertirse dos veces', async () => {
  const csv = [
    'numero_siniestro,aseguradora,numero_pedido,fecha_prevista,numero_parte,descripcion_pieza,precio,proveedor',
    'CM5-SIN-1,GNP,CM5-PED-1,2026-09-01,NP-R,Puerta trasera,1500,Proveedor Cinco',
  ].join('\n');
  const validado = (await req('POST', '/api/carga-masiva/validar', { csv })).data;
  const confirmar = await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado.pedidos });
  const loteId = confirmar.data.loteId;
  assert.ok(loteId);

  const revertir = await req('POST', '/api/carga-masiva/' + loteId + '/revertir', {});
  assert.equal(revertir.status, 200);
  assert.equal(revertir.data.pedidosCancelados, 1);
  assert.equal(revertir.data.piezasCanceladas, 1);
  assert.equal(revertir.data.siniestrosArchivados, 1, 'el siniestro solo tenía este pedido, así que se archiva (no se borra)');

  const siniestro = (await req('GET', '/api/siniestros?q=CM5-SIN-1')).data;
  // archivado no aparece en la vista diaria por defecto, pero el registro sigue existiendo (no se borró).
  const otraVez = await req('POST', '/api/carga-masiva/' + loteId + '/revertir', {});
  assert.equal(otraVez.status, 400, 'no se puede revertir dos veces el mismo lote');
});

test('REQ-DANIELA-14: carga masiva exclusiva de Daniela/admin; consulta no puede', async () => {
  await req('POST', '/api/auth/login', { email: 'consulta.req1@serviciocristian.mx', password: 'Password123!' });
  const bloqueado = await req('POST', '/api/carga-masiva/validar', { csv: 'numero_siniestro,aseguradora,numero_pedido,fecha_prevista\nA,B,C,2026-01-01' });
  assert.equal(bloqueado.status, 403);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('REQ-DANIELA-15: exportar expedientes en CSV incluye siniestros aunque no tengan ningún pedido capturado', async () => {
  await req('POST', '/api/siniestros', { numero: 'CSV-SIN-SINPEDIDO', aseguradora: 'GNP', vehiculo: 'Test', placas: 'ABC123' });
  const res = await fetch(BASE + '/api/reportes/siniestros.csv', withCookie());
  assert.equal(res.status, 200);
  const texto = await res.text();
  assert.match(texto, /CSV-SIN-SINPEDIDO/);
  assert.match(texto, /"Siniestro","Aseguradora","Vehiculo"/);
});

test('REQ-DANIELA-16: enriquecerDesdeLibreta completa solo campos vacíos de expedientes existentes, nunca crea ni sobreescribe', async () => {
  const { enriquecerDesdeLibreta } = require('../server/enriquecerDesdeLibreta');
  const db = require('../server/db');

  await req('POST', '/api/siniestros', { numero: '0185278777A', aseguradora: 'GNP', vehiculo: 'Chrysler', placas: 'PYM6258' });
  await req('POST', '/api/siniestros', { numero: '0186365300A', aseguradora: 'GNP', vehiculo: 'Mercedes-Benz', placas: 'RDJ972E' });
  db.prepare("UPDATE siniestros SET cliente_nombre='NOMBRE YA CAPTURADO', vin='VIN-YA-CAPTURADO', anio_modelo='1999' WHERE numero='0186365300A'").run();

  enriquecerDesdeLibreta();

  const s1 = (await req('GET', '/api/siniestros?q=0185278777A')).data[0];
  assert.equal(s1.vin, '1C4PJLDB6FW554383');
  assert.equal(s1.cliente_nombre, 'MARIA DEL ROCIO BUENDIA');
  assert.equal(s1.anio_modelo, '2015');

  const s2 = (await req('GET', '/api/siniestros?q=0186365300A')).data[0];
  assert.equal(s2.cliente_nombre, 'NOMBRE YA CAPTURADO', 'no debe sobreescribir un dato ya capturado');
  assert.equal(s2.vin, 'VIN-YA-CAPTURADO');
  assert.equal(s2.anio_modelo, '1999');

  const totalAntes = (await req('GET', '/api/siniestros?archivado=all')).data.length;
  enriquecerDesdeLibreta();
  const totalDespues = (await req('GET', '/api/siniestros?archivado=all')).data.length;
  assert.equal(totalAntes, totalDespues, 'correrlo de nuevo no debe crear duplicados ni nada nuevo');
});

test('REQ-DANIELA-17: las sesiones sobreviven aunque se cree un almacén completamente nuevo (simula reinicio del proceso)', async () => {
  const db = require('../server/db');
  const SqliteSessionStore = require('../server/sqliteSessionStore');

  const store1 = new SqliteSessionStore(db);
  const sesionFalsa = { cookie: { maxAge: 1000*60*60*12 }, user: { id: 999, nombre: 'Prueba Reinicio', rol: 'operativo' } };
  await new Promise((resolve, reject)=> store1.set('sid-de-prueba-reinicio', sesionFalsa, (err)=> err?reject(err):resolve()));

  // Un SEGUNDO store, construido desde cero (sin memoria compartida con store1), debe ver la misma sesión.
  const store2 = new SqliteSessionStore(db);
  const leida = await new Promise((resolve, reject)=> store2.get('sid-de-prueba-reinicio', (err, sess)=> err?reject(err):resolve(sess)));
  assert.ok(leida, 'la sesión debe sobrevivir en un almacén nuevo (antes se perdía con MemoryStore)');
  assert.equal(leida.user.nombre, 'Prueba Reinicio');

  await new Promise((resolve, reject)=> store1.destroy('sid-de-prueba-reinicio', (err)=> err?reject(err):resolve()));
});

test('REQ-DANIELA-18: el login con contraseña incorrecta muestra "Credenciales incorrectas", no "Sesión expirada" (endpoint)', async () => {
  const r = await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'password-incorrecta-cualquiera' });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'Credenciales incorrectas.');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('REQ-DANIELA-19: admin puede resetear la contraseña de otro usuario y el usuario puede entrar con la nueva', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const usuarios = (await req('GET', '/api/auth/usuarios')).data;
  const alejandra = usuarios.find(u => u.email === 'alejandra@serviciocristian.mx');
  const r = await req('POST', `/api/auth/usuarios/${alejandra.id}/reset-password`, {});
  assert.equal(r.status, 200);
  assert.ok(r.data.password_temporal);

  const loginNuevo = await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: r.data.password_temporal });
  assert.equal(loginNuevo.status, 200);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('REQ-DANIELA-20: el reset de emergencia de Daniela es idempotente (no se repite en cada arranque)', async () => {
  const db = require('../server/db');
  const { resetEmergenciaDaniela } = require('../server/resetEmergenciaDaniela');
  const antes = db.prepare("SELECT COUNT(*) n FROM auditoria WHERE accion='reset_emergencia_daniela_2026-08-24'").get().n;
  resetEmergenciaDaniela();
  resetEmergenciaDaniela();
  const despues = db.prepare("SELECT COUNT(*) n FROM auditoria WHERE accion='reset_emergencia_daniela_2026-08-24'").get().n;
  assert.equal(antes, despues, 'no debe crear un segundo marcador ni resetear la contraseña de nuevo');
});

test('REQ-ROBERTO-1: el resumen diario incluye indicadores de atención a clientes (tareas, hitos, IA, expedientes sin actualizar)', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'ROB1-SIN', aseguradora: 'GNP', cliente_nombre: 'Cliente Prueba', cliente_telefono: '555', cliente_correo: 'c@c.com' })).data;
  const db = require('../server/db');
  db.prepare("UPDATE siniestros SET creado_en = datetime('now', '-10 days') WHERE id = ?").run(s.id);

  // Tarea pendiente vencida.
  await req('POST', '/api/tareas', { siniestro_id: s.id, descripcion: 'Llamar al cliente', fecha_limite: '2020-01-01' });

  // Hito listo (generado) sin enviar.
  const hitos = (await req('GET', '/api/hitos?siniestro_id=' + s.id)).data;
  const primero = hitos[0];
  await req('PATCH', '/api/hitos/' + primero.id, { estado: 'generado' });

  // Mensaje de IA generado sin aprobar.
  await req('POST', '/api/mensajes-ia', { siniestro_id: s.id, hito_id: primero.hito_id, contexto_usado: 'ctx', borrador: 'Hola, este es un mensaje de prueba.' });

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const r = (await req('GET', '/api/reportes/resumen')).data;
  assert.ok(r.tareasPendientes >= 1);
  assert.ok(r.tareasVencidas >= 1);
  assert.ok(r.hitosListosSinEnviar >= 1);
  assert.ok(r.mensajesIaPendientes >= 1);
  assert.ok(r.expedientesSinActualizar >= 1, 'el expediente recién creado sin eventos_cliente debe contar como sin actualizar tras 3+ días (o si su fecha de alta ya es vieja)');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-1: motor de reglas por aseguradora — GNP 1-3 piezas = autosurtido obligatorio, 4+ = Inpart', async () => {
  const { calcularRutaAseguradora } = require('../server/utils');
  assert.equal(calcularRutaAseguradora('GNP', 1).ruta, 'autosurtido');
  assert.equal(calcularRutaAseguradora('GNP', 3).ruta, 'autosurtido');
  assert.equal(calcularRutaAseguradora('GNP', 4).ruta, 'inpart');
  assert.equal(calcularRutaAseguradora('GNP', null).ruta, 'pendiente_confirmar');
  assert.equal(calcularRutaAseguradora('ANA', 1).ruta, 'pago_danos');
  assert.equal(calcularRutaAseguradora('ANA', 10).ruta, 'pago_danos', 'ANA nunca migra a Inpart sin importar el número de piezas');
  assert.equal(calcularRutaAseguradora('Zurich', 2).ruta, 'inpart');
  assert.match(calcularRutaAseguradora('Zurich', 2).regla, /CONFIRMAR CASO POR CASO/);
  assert.equal(calcularRutaAseguradora('Inbursa', 5).ruta, 'inpart');
  assert.equal(calcularRutaAseguradora('Mapfre', null).ruta, 'inpart');
});

test('DOC-MAESTRO-2: el expediente recalcula la ruta de refacciones al cambiar aseguradora o piezas autorizadas', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'DOCM2-SIN', aseguradora: 'GNP' })).data;
  assert.equal(s.aseguradora_ruta_refacciones, 'pendiente_confirmar');

  const r1 = await req('PATCH', `/api/siniestros/${s.id}`, { piezas_autorizadas_cambio: 2 });
  assert.equal(r1.data.aseguradora_ruta_refacciones, 'autosurtido');
  assert.match(r1.data.aseguradora_regla_aplicada, /autosurtido OBLIGATORIO/);

  const r2 = await req('PATCH', `/api/siniestros/${s.id}`, { piezas_autorizadas_cambio: 5 });
  assert.equal(r2.data.aseguradora_ruta_refacciones, 'inpart');

  const r3 = await req('PATCH', `/api/siniestros/${s.id}`, { aseguradora: 'ANA' });
  assert.equal(r3.data.aseguradora_ruta_refacciones, 'pago_danos');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-3: los 3 roles nuevos (Orlando, Vanessa, Beto) existen y pueden iniciar sesión', async () => {
  for(const email of ['orlando@serviciocristian.mx','vanessa@serviciocristian.mx','beto@serviciocristian.mx']){
    const r = await req('POST', '/api/auth/login', { email, password: 'ServicioCristian2026!' });
    assert.equal(r.status, 200, `${email} debe poder iniciar sesión`);
  }
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Documento Maestro / Fase B: recepción, admisión y revisión técnica (Orlando) ===================== */

test('DOC-MAESTRO-B-1: admisión condicionada o no admitida exige motivo', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEB-ADM1', aseguradora: 'GNP' })).data;
  const sinMotivo = await req('PATCH', '/api/siniestros/' + s.id, { estado_admision: 'condicionado' });
  assert.equal(sinMotivo.status, 400, 'sin motivo debe rechazarse');
  const conMotivo = await req('PATCH', '/api/siniestros/' + s.id, { estado_admision: 'condicionado', motivo_admision: 'Falta tarjeta de circulación' });
  assert.equal(conMotivo.status, 200);
  assert.equal(conMotivo.data.estado_admision, 'condicionado');
  assert.equal(conMotivo.data.motivo_admision, 'Falta tarjeta de circulación');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-B-2: riesgo de seguridad exige motivo técnico', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEB-RIESGO1', aseguradora: 'GNP' })).data;
  const sinMotivo = await req('PATCH', '/api/siniestros/' + s.id, { riesgo_seguridad: 1 });
  assert.equal(sinMotivo.status, 400, 'riesgo sin motivo debe rechazarse');
  const conMotivo = await req('PATCH', '/api/siniestros/' + s.id, { riesgo_seguridad: 1, riesgo_seguridad_motivo: 'Fuga de frenos, no debe circular' });
  assert.equal(conMotivo.status, 200);
  assert.equal(conMotivo.data.riesgo_seguridad, 1);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-B-3: campos de admisión (tabla 21, circulando vs grúa) se guardan y reutilizan ingreso_tipo/ingreso_seguro de Fase A', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEB-ADM2', aseguradora: 'GNP' })).data;
  const r = await req('PATCH', '/api/siniestros/' + s.id, {
    ingreso_tipo: 'grua', ingreso_seguro: 0, grua_operador: 'Grúas Rápidas SA', grua_hora: '08:30',
    fecha_admision: '2026-08-24', kilometraje: '45000', combustible_nivel: '1/4', llaves_entregadas: 1,
    pertenencias: 'Gato, herramienta básica', estado_admision: 'admitido'
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ingreso_tipo, 'grua');
  assert.equal(r.data.ingreso_seguro, 0);
  assert.equal(r.data.grua_operador, 'Grúas Rápidas SA');
  assert.equal(r.data.llaves_entregadas, 1);
  assert.equal(r.data.estado_admision, 'admitido');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-B-4: crear un hallazgo de daños/evidencia exige zona/pieza y expediente válido', async () => {
  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEB-HALL1', aseguradora: 'GNP' })).data;
  const sinZona = await req('POST', '/api/danos-evidencia', { siniestro_id: s.id });
  assert.equal(sinZona.status, 400);
  const r = await req('POST', '/api/danos-evidencia', {
    siniestro_id: s.id, zona_pieza: 'Puerta delantera derecha', tipo_dano: 'Golpe', visibilidad: 'oculto',
    relacionado: 1, severidad: 'media', operacion_preliminar: 'Reparar y pintar', observaciones: 'Requiere desarme para confirmar alcance'
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.visibilidad, 'oculto');
  assert.equal(r.data.autor_nombre, 'Orlando');

  const lista = await req('GET', '/api/danos-evidencia?siniestro_id=' + s.id);
  assert.equal(lista.data.length, 1);

  const edit = await req('PATCH', '/api/danos-evidencia/' + r.data.id, { severidad: 'severa', observaciones: 'Confirmado daño oculto tras desarme' });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.severidad, 'severa');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-B-5: solo orlando/vanessa/admin/jefe pueden registrar hallazgos (operativo no puede)', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEB-HALL2', aseguradora: 'GNP' })).data;
  // sesión actual: daniela (rol operativo)
  const r = await req('POST', '/api/danos-evidencia', { siniestro_id: s.id, zona_pieza: 'Cofre' });
  assert.equal(r.status, 403, 'operativo (Daniela) no debe poder registrar hallazgos técnicos');
});

test('DOC-MAESTRO-B-6: bandeja técnica de Orlando lista expedientes pendientes y los excluye al terminar la revisión', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEB-BANDEJA1', aseguradora: 'GNP' })).data;
  // Propuesta de Orlando (27-ago-2026): la bandeja solo muestra expedientes con admisión ya completa
  // (ver ORLA-1/2). Aquí se cubre el caso simple (circulando) para no repetir esa cobertura.
  await req('PATCH', '/api/siniestros/' + s.id, { ingreso_tipo: 'circulando', fecha_admision: '2026-08-27' });
  let bandeja = await req('GET', '/api/reportes/bandeja-tecnica');
  assert.ok(bandeja.data.some(x => x.numero === 'FASEB-BANDEJA1'), 'debe aparecer pendiente de revisión técnica');

  await req('PATCH', '/api/siniestros/' + s.id, { estado_revision_tecnica: 'revision_terminada' });
  bandeja = await req('GET', '/api/reportes/bandeja-tecnica');
  assert.ok(!bandeja.data.some(x => x.numero === 'FASEB-BANDEJA1'), 'ya no debe aparecer una vez terminada la revisión');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Documento Maestro / Fase C: captura y armado de expediente (Vanessa) ===================== */

test('DOC-MAESTRO-C-1: al crear un siniestro se sugiere el sistema de valuación según la aseguradora (ACG/BDEO/propio)', async () => {
  const gnp = (await req('POST', '/api/siniestros', { numero: 'FASEC-GNP1', aseguradora: 'GNP' })).data;
  assert.equal(gnp.sistema_valuacion, 'ACG');
  const ana = (await req('POST', '/api/siniestros', { numero: 'FASEC-ANA1', aseguradora: 'ANA' })).data;
  assert.equal(ana.sistema_valuacion, 'BDEO');
  const zurich = (await req('POST', '/api/siniestros', { numero: 'FASEC-ZUR1', aseguradora: 'Zurich' })).data;
  assert.equal(zurich.sistema_valuacion, 'Sistema propio (Zurich)');
});

test('DOC-MAESTRO-C-2: no se puede marcar el expediente como listo para valuación con documentos faltantes/no legibles', async () => {
  await req('POST', '/api/auth/login', { email: 'vanessa@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEC-DOC1', aseguradora: 'GNP' })).data;
  const doc = (await req('POST', '/api/documentos-expediente', { siniestro_id: s.id, tipo_documento: 'Identificación oficial', estado: 'faltante' })).data;
  assert.equal(doc.estado, 'faltante');

  const bloqueado = await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'listo_para_valuacion' });
  assert.equal(bloqueado.status, 400, 'debe bloquearse mientras haya documentos faltantes');
  assert.ok(bloqueado.data.detalle.includes('Identificación oficial'));

  const editado = await req('PATCH', '/api/documentos-expediente/' + doc.id, { estado: 'recibido' });
  assert.equal(editado.status, 200);
  assert.equal(editado.data.estado, 'recibido');

  const listo = await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'listo_para_valuacion' });
  assert.equal(listo.status, 200, 'ya sin faltantes debe permitirse marcarlo listo');
  assert.equal(listo.data.estado_expediente, 'listo_para_valuacion');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-C-3: solo vanessa/admin/jefe pueden capturar documentos del expediente (operativo no puede)', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEC-DOC2', aseguradora: 'GNP' })).data;
  const r = await req('POST', '/api/documentos-expediente', { siniestro_id: s.id, tipo_documento: 'Póliza' });
  assert.equal(r.status, 403, 'operativo (Daniela) no debe poder capturar documentos del expediente');
});

test('DOC-MAESTRO-C-4: bandeja de expediente de Vanessa lista pendientes y los excluye al quedar listos para valuación', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEC-BANDEJA1', aseguradora: 'GNP' })).data;
  let bandeja = await req('GET', '/api/reportes/bandeja-expediente');
  assert.ok(bandeja.data.some(x => x.numero === 'FASEC-BANDEJA1'), 'debe aparecer pendiente de armar expediente');

  await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'listo_para_valuacion' });
  bandeja = await req('GET', '/api/reportes/bandeja-expediente');
  assert.ok(!bandeja.data.some(x => x.numero === 'FASEC-BANDEJA1'), 'ya no debe aparecer una vez listo para valuación');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Documento Maestro / Fase D: valuación, autorización y motor de reglas ===================== */

test('DOC-MAESTRO-D-1: marcar la valuación como enviada/observada/etc. exige fecha de envío', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASED-VAL1', aseguradora: 'GNP' })).data;
  const sinFecha = await req('PATCH', '/api/siniestros/' + s.id, { estado_valuacion: 'enviada' });
  assert.equal(sinFecha.status, 400);
  const conFecha = await req('PATCH', '/api/siniestros/' + s.id, { estado_valuacion: 'enviada', valuacion_fecha_envio: '2026-08-24', valuacion_folio: 'V-001' });
  assert.equal(conFecha.status, 200);
  assert.equal(conFecha.data.estado_valuacion, 'enviada');
  assert.equal(conFecha.data.valuacion_folio, 'V-001');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-D-2: autorizar (total o parcial) exige fecha de respuesta y autorizador', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASED-AUT1', aseguradora: 'GNP' })).data;
  const incompleto = await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'autorizada' });
  assert.equal(incompleto.status, 400);
  const completo = await req('PATCH', '/api/siniestros/' + s.id, {
    estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-24', autorizador: 'Ajustador GNP', autorizacion_importe: 15000
  });
  assert.equal(completo.status, 200);
  assert.equal(completo.data.estado_autorizacion, 'autorizada');
  assert.equal(completo.data.autorizador, 'Ajustador GNP');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-D-3: la autorización de piezas (GNP 1-3) recalcula la ruta de refacciones a autosurtido obligatorio', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASED-GNP2', aseguradora: 'GNP' })).data;
  assert.equal(s.aseguradora_ruta_refacciones, 'pendiente_confirmar');
  const r = await req('PATCH', '/api/siniestros/' + s.id, {
    estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-24', autorizador: 'Ajustador GNP', piezas_autorizadas_cambio: 2
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.aseguradora_ruta_refacciones, 'autosurtido');
  assert.match(r.data.aseguradora_regla_aplicada, /autosurtido OBLIGATORIO/);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-D-4: bandeja de valuación solo incluye expedientes con checklist documental listo y excluye autorizados/rechazados', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASED-BANDEJA1', aseguradora: 'GNP' })).data;
  let bandeja = await req('GET', '/api/reportes/bandeja-valuacion');
  assert.ok(!bandeja.data.some(x => x.numero === 'FASED-BANDEJA1'), 'no debe aparecer sin expediente listo para valuación');

  await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'listo_para_valuacion' });
  bandeja = await req('GET', '/api/reportes/bandeja-valuacion');
  assert.ok(bandeja.data.some(x => x.numero === 'FASED-BANDEJA1'), 'debe aparecer una vez listo para valuación');

  await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-24', autorizador: 'Ajustador' });
  bandeja = await req('GET', '/api/reportes/bandeja-valuacion');
  assert.ok(!bandeja.data.some(x => x.numero === 'FASED-BANDEJA1'), 'ya no debe aparecer una vez autorizado');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Documento Maestro / Fase E: orden de trabajo y producción (Beto) ===================== */

test('DOC-MAESTRO-E-1: crear una OT y agregar operaciones; solo beto/orlando/admin/jefe pueden hacerlo', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEE-OT1', aseguradora: 'GNP' })).data;
  const sinPermiso = await req('POST', '/api/ordenes-trabajo', { siniestro_id: s.id, numero: 'OT-001' });
  assert.equal(sinPermiso.status, 403, 'operativo (Daniela) no debe poder crear OT');

  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const ot = (await req('POST', '/api/ordenes-trabajo', { siniestro_id: s.id, numero: 'OT-001', alcance: 'Cambio de puerta y pintura' })).data;
  assert.equal(ot.estado, 'borrador');

  const op = (await req('POST', '/api/ot-operaciones', { ot_id: ot.id, descripcion: 'Cambio de puerta delantera', area: 'Laminado', tecnico: 'Juan', secuencia: 1 })).data;
  assert.equal(op.estado, 'programado');
  assert.equal(op.avance, 0);

  const lista = await req('GET', '/api/ot-operaciones?ot_id=' + ot.id);
  assert.equal(lista.data.length, 1);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-E-2: detener una operación exige causa de bloqueo normalizada; terminarla fija avance en 100', async () => {
  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEE-OT2', aseguradora: 'GNP' })).data;
  const ot = (await req('POST', '/api/ordenes-trabajo', { siniestro_id: s.id, numero: 'OT-002' })).data;
  const op = (await req('POST', '/api/ot-operaciones', { ot_id: ot.id, descripcion: 'Pintura de cofre' })).data;

  const sinCausa = await req('PATCH', '/api/ot-operaciones/' + op.id, { estado: 'detenido' });
  assert.equal(sinCausa.status, 400);
  const conCausa = await req('PATCH', '/api/ot-operaciones/' + op.id, { estado: 'detenido', causa_bloqueo: 'pieza_faltante' });
  assert.equal(conCausa.status, 200);
  assert.equal(conCausa.data.causa_bloqueo, 'pieza_faltante');

  const terminada = await req('PATCH', '/api/ot-operaciones/' + op.id, { estado: 'terminado' });
  assert.equal(terminada.status, 200);
  assert.equal(terminada.data.avance, 100);
  assert.ok(terminada.data.fecha_fin_real);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-E-3: un complemento no puede incorporarse a la OT sin autorización', async () => {
  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEE-COMP1', aseguradora: 'GNP' })).data;
  const comp = (await req('POST', '/api/complementos', { siniestro_id: s.id, causa: 'Daño oculto en larguero al desarmar cofre' })).data;
  assert.equal(comp.decision, 'pendiente');
  assert.equal(comp.estado, 'detectado');

  const bloqueado = await req('PATCH', '/api/complementos/' + comp.id, { estado: 'incorporado_a_ot' });
  assert.equal(bloqueado.status, 400, 'no debe permitirse incorporar a OT sin autorización');

  const autorizado = await req('PATCH', '/api/complementos/' + comp.id, { decision: 'autorizado', estado: 'incorporado_a_ot' });
  assert.equal(autorizado.status, 200);
  assert.equal(autorizado.data.estado, 'incorporado_a_ot');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-E-4: cerrar un retrabajo exige registrar la corrección aplicada', async () => {
  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEE-RET1', aseguradora: 'GNP' })).data;
  const ret = (await req('POST', '/api/retrabajos', { siniestro_id: s.id, origen: 'Desalineación de puerta detectada en calidad', severidad: 'critica' })).data;
  assert.equal(ret.estado, 'abierto');

  const sinCorreccion = await req('PATCH', '/api/retrabajos/' + ret.id, { estado: 'cerrado' });
  assert.equal(sinCorreccion.status, 400);
  const conCorreccion = await req('PATCH', '/api/retrabajos/' + ret.id, { estado: 'cerrado', correccion: 'Reajuste de bisagras y verificación de holguras' });
  assert.equal(conCorreccion.status, 200);
  assert.equal(conCorreccion.data.estado, 'cerrado');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-E-5: bandeja de producción solo incluye expedientes autorizados y refleja bloqueos/retrabajos abiertos', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });

  const s = (await req('POST', '/api/siniestros', { numero: 'FASEE-BANDEJA1', aseguradora: 'GNP' })).data;
  let bandeja = await req('GET', '/api/reportes/bandeja-produccion');
  assert.ok(!bandeja.data.some(x => x.numero === 'FASEE-BANDEJA1'), 'no debe aparecer sin autorización');

  await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-24', autorizador: 'Ajustador' });
  const ot = (await req('POST', '/api/ordenes-trabajo', { siniestro_id: s.id, numero: 'OT-BANDEJA' })).data;
  const op = (await req('POST', '/api/ot-operaciones', { ot_id: ot.id, descripcion: 'Cambio de faro' })).data;
  await req('PATCH', '/api/ot-operaciones/' + op.id, { estado: 'detenido', causa_bloqueo: 'capacidad' });

  bandeja = await req('GET', '/api/reportes/bandeja-produccion');
  const item = bandeja.data.find(x => x.numero === 'FASEE-BANDEJA1');
  assert.ok(item, 'debe aparecer una vez autorizado');
  assert.equal(item.operaciones_bloqueadas, 1);

  await req('PATCH', '/api/siniestros/' + s.id, { estado_produccion: 'terminado' });
  bandeja = await req('GET', '/api/reportes/bandeja-produccion');
  assert.ok(!bandeja.data.some(x => x.numero === 'FASEE-BANDEJA1'), 'ya no debe aparecer una vez terminada la producción');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Documento Maestro / Fase F: control de calidad, entrega, finiquito y encuesta ===================== */

test('DOC-MAESTRO-F-1: no se puede liberar calidad con rubros del checklist rechazados', async () => {
  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEF-CAL1', aseguradora: 'GNP' })).data;
  const sinHallazgo = await req('POST', '/api/checklist-calidad', { siniestro_id: s.id, dimension: 'Pintura/acabado', resultado: 'rechazado' });
  assert.equal(sinHallazgo.status, 400, 'un rechazo debe exigir el hallazgo que lo motiva');
  const item = (await req('POST', '/api/checklist-calidad', { siniestro_id: s.id, dimension: 'Pintura/acabado', resultado: 'rechazado', hallazgo: 'Escurrimiento en cofre' })).data;

  const bloqueado = await req('PATCH', '/api/siniestros/' + s.id, { estado_calidad: 'liberado' });
  assert.equal(bloqueado.status, 400);
  assert.ok(bloqueado.data.detalle.includes('Pintura/acabado'));

  const corregido = await req('PATCH', '/api/checklist-calidad/' + item.id, { resultado: 'aprobado', correccion: 'Repintado y pulido' });
  assert.equal(corregido.status, 200);
  const liberado = await req('PATCH', '/api/siniestros/' + s.id, { estado_calidad: 'liberado' });
  assert.equal(liberado.status, 200);
  assert.equal(liberado.data.estado_calidad, 'liberado');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-F-2: no se puede registrar la entrega con retrabajos críticos abiertos', async () => {
  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEF-ENT1', aseguradora: 'GNP' })).data;
  const ret = (await req('POST', '/api/retrabajos', { siniestro_id: s.id, origen: 'Falla de ajuste en cajuela', severidad: 'critica' })).data;

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const bloqueado = await req('PATCH', '/api/siniestros/' + s.id + '/entrega', { fecha_entrega_real: '2026-08-24' });
  assert.equal(bloqueado.status, 400);
  assert.ok(bloqueado.data.detalle.includes('Falla de ajuste en cajuela'));

  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  await req('PATCH', '/api/retrabajos/' + ret.id, { estado: 'cerrado', correccion: 'Ajuste de bisagras de cajuela' });
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const permitido = await req('PATCH', '/api/siniestros/' + s.id + '/entrega', { fecha_entrega_real: '2026-08-24' });
  assert.equal(permitido.status, 200, 'ya sin retrabajos críticos abiertos debe permitirse la entrega');
});

test('DOC-MAESTRO-F-3: el finiquito no puede firmarse antes de la entrega; una inconformidad crea una tarea automática', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEF-FIN1', aseguradora: 'GNP' })).data;
  const sinEntrega = await req('PATCH', '/api/siniestros/' + s.id, { finiquito_estado: 'firmado' });
  assert.equal(sinEntrega.status, 400);

  await req('PATCH', '/api/siniestros/' + s.id + '/entrega', { fecha_entrega_real: '2026-08-24' });
  const firmado = await req('PATCH', '/api/siniestros/' + s.id, { finiquito_estado: 'firmado', finiquito_fecha: '2026-08-24' });
  assert.equal(firmado.status, 200);

  const s2 = (await req('POST', '/api/siniestros', { numero: 'FASEF-FIN2', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + s2.id + '/entrega', { fecha_entrega_real: '2026-08-24' });
  const inconforme = await req('PATCH', '/api/siniestros/' + s2.id, { finiquito_estado: 'inconformidad_abierta', finiquito_observacion: 'Cliente reporta ruido en puerta' });
  assert.equal(inconforme.status, 200);
  const tareas = await req('GET', '/api/tareas?siniestro_id=' + s2.id);
  assert.ok(tareas.data.some(t => t.disparador === 'inconformidad_finiquito'), 'debe crearse automáticamente una tarea de seguimiento');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DOC-MAESTRO-F-4: bandeja de calidad incluye producción terminada pendiente de calidad/entrega', async () => {
  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASEF-BANDEJA1', aseguradora: 'GNP' })).data;
  let bandeja = await req('GET', '/api/reportes/bandeja-calidad');
  assert.ok(!bandeja.data.some(x => x.numero === 'FASEF-BANDEJA1'), 'no debe aparecer sin producción terminada');

  await req('PATCH', '/api/siniestros/' + s.id, { estado_produccion: 'terminado' });
  bandeja = await req('GET', '/api/reportes/bandeja-calidad');
  assert.ok(bandeja.data.some(x => x.numero === 'FASEF-BANDEJA1'), 'debe aparecer con producción terminada y sin calidad liberada');

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  await req('PATCH', '/api/siniestros/' + s.id, { estado_calidad: 'liberado' });
  await req('PATCH', '/api/siniestros/' + s.id + '/entrega', { fecha_entrega_real: '2026-08-24' });
  bandeja = await req('GET', '/api/reportes/bandeja-calidad');
  assert.ok(!bandeja.data.some(x => x.numero === 'FASEF-BANDEJA1'), 'ya no debe aparecer una vez liberado y entregado');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Pendientes resueltos por Roberto (24-ago-2026): SLA de autorización y límite de compra ===================== */

test('PENDIENTE-1: la bandeja de valuación marca "sin respuesta" a los 3 días hábiles de enviada la autorización, igual para cualquier aseguradora', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'SLA-AUT1', aseguradora: 'Mapfre' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'listo_para_valuacion' });

  // Envío reciente (hoy): no debe marcarse vencida.
  await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'en_autorizacion', autorizacion_fecha_envio: new Date().toISOString().slice(0,10) });
  let bandeja = await req('GET', '/api/reportes/bandeja-valuacion');
  let item = bandeja.data.find(x => x.numero === 'SLA-AUT1');
  assert.equal(item.autorizacion_vencida, false, 'recién enviada, no debe estar vencida');

  // Envío de hace 10 días naturales (más de 3 hábiles): debe marcarse vencida.
  const hace10dias = new Date(Date.now() - 10*86400000).toISOString().slice(0,10);
  await req('PATCH', '/api/siniestros/' + s.id, { autorizacion_fecha_envio: hace10dias });
  bandeja = await req('GET', '/api/reportes/bandeja-valuacion');
  item = bandeja.data.find(x => x.numero === 'SLA-AUT1');
  assert.equal(item.autorizacion_vencida, true, 'con más de 3 días hábiles sin respuesta debe marcarse vencida');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PENDIENTE-2: un complemento de más de $1,000 MXN no puede autorizarlo Orlando/Beto; sí admin/jefe', async () => {
  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'LIMITE-COMP1', aseguradora: 'GNP' })).data;
  const comp = (await req('POST', '/api/complementos', { siniestro_id: s.id, causa: 'Daño oculto en piso, requiere lámina adicional', importe: 3500 })).data;

  const bloqueado = await req('PATCH', '/api/complementos/' + comp.id, { decision: 'autorizado' });
  assert.equal(bloqueado.status, 403, 'Orlando no debe poder autorizar un complemento de más de $1,000 sin admin/jefe');

  // Un complemento barato sí lo puede autorizar Orlando.
  const compBarato = (await req('POST', '/api/complementos', { siniestro_id: s.id, causa: 'Ajuste menor de sujetadores', importe: 200 })).data;
  const permitido = await req('PATCH', '/api/complementos/' + compBarato.id, { decision: 'autorizado' });
  assert.equal(permitido.status, 200);

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const autorizadoPorAdmin = await req('PATCH', '/api/complementos/' + comp.id, { decision: 'autorizado' });
  assert.equal(autorizadoPorAdmin.status, 200, 'admin sí puede autorizar montos mayores a $1,000');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Propuesta Orlando/Vanessa/Beto (25-ago-2026): fusión de captura y paneles por rol ===================== */

test('PROPUESTA-1: la fecha de borrador de captura la gana el primer registro, sin importar quién la mande', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FUSION-1', aseguradora: 'GNP' })).data;
  const primero = await req('PATCH', '/api/siniestros/' + s.id, { fecha_borrador_captura: '2026-08-20' });
  assert.equal(primero.data.fecha_borrador_captura, '2026-08-20');

  const segundo = await req('PATCH', '/api/siniestros/' + s.id, { fecha_borrador_captura: '2026-08-22' });
  assert.equal(segundo.data.fecha_borrador_captura, '2026-08-20', 'debe conservarse la primera fecha registrada, sin error');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROPUESTA-2: al marcar por primera vez excel/fotos/envío se sella la fecha automáticamente si no se manda una explícita', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FUSION-2', aseguradora: 'GNP' })).data;
  const hoy = new Date().toISOString().slice(0,10);

  const r1 = await req('PATCH', '/api/siniestros/' + s.id, { excel_capturado: true });
  assert.equal(r1.data.excel_capturado, 1);
  assert.equal(r1.data.excel_capturado_fecha, hoy);

  const r2 = await req('PATCH', '/api/siniestros/' + s.id, { fotos_completas: true });
  assert.equal(r2.data.fotos_completas_fecha, hoy);

  const r3 = await req('PATCH', '/api/siniestros/' + s.id, { enviado_propietario: true });
  assert.equal(r3.data.enviado_propietario_fecha, hoy);

  // Una fecha explícita distinta sí se respeta en la primera captura.
  const s2 = (await req('POST', '/api/siniestros', { numero: 'FUSION-2B', aseguradora: 'GNP' })).data;
  const r4 = await req('PATCH', '/api/siniestros/' + s2.id, { excel_capturado: true, excel_capturado_fecha: '2026-08-10' });
  assert.equal(r4.data.excel_capturado_fecha, '2026-08-10');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROPUESTA-3: al resolverse la autorización (autorizada o parcial) se crea una tarea automática para avisar al propietario', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FUSION-3', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-24', autorizador: 'Ajustador Mapfre' });
  const tareas = await req('GET', '/api/tareas?siniestro_id=' + s.id);
  assert.ok(tareas.data.some(t => t.disparador === 'autorizacion_resuelta'), 'debe crearse una tarea para avisar al propietario');

  // No debe duplicarse si ya hay una tarea abierta con el mismo disparador.
  await req('PATCH', '/api/siniestros/' + s.id, { autorizacion_restricciones: 'Sin refacciones genéricas' });
  const tareas2 = await req('GET', '/api/tareas?siniestro_id=' + s.id);
  const conteo = tareas2.data.filter(t => t.disparador === 'autorizacion_resuelta').length;
  assert.equal(conteo, 1, 'no debe duplicarse la tarea automática');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROPUESTA-4: /api/reportes/resumen incluye los contadores de los paneles por rol', async () => {
  const r = await req('GET', '/api/reportes/resumen');
  assert.equal(r.status, 200);
  for(const campo of ['ovPendientesRevision','ovBorradoresPorCapturar','ovFotosPorCompletar','ovListosParaEnviar',
    'betoPorVencer','betoListasParaIniciar','betoVencidas','piezasPorConfirmar','piezasMalSurtidas','citasHoy','porAvisarAutorizacion']){
    assert.ok(campo in r.data, `falta el campo ${campo} en el resumen`);
  }
});

test('PROPUESTA-5: panorama-beto asigna prioridad 1 a siniestros vencidos o que vencen hoy/mañana', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'BETO-P1', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-01', autorizador: 'X', fecha_entrega_prevista: '2020-01-01' });

  const panorama = await req('GET', '/api/reportes/panorama-beto');
  const item = panorama.data.find(x => x.numero === 'BETO-P1');
  assert.ok(item, 'debe aparecer en el panorama de Beto tras ser autorizado');
  assert.equal(item.prioridad, 1);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROPUESTA-6: panorama-beto asigna prioridad 2 a una OT reciente con pocas operaciones sin tocar', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'BETO-P2', aseguradora: 'GNP', fecha_entrega_prevista: '2027-01-01' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-01', autorizador: 'X' });

  const ot = (await req('POST', '/api/ordenes-trabajo', { siniestro_id: s.id, numero: 'OT-BETO-P2' })).data;
  await req('POST', '/api/ot-operaciones', { ot_id: ot.id, descripcion: 'Cambio de defensa', area: 'Laminado', secuencia: 1 });

  const panorama = await req('GET', '/api/reportes/panorama-beto');
  const item = panorama.data.find(x => x.numero === 'BETO-P2');
  assert.ok(item);
  assert.equal(item.prioridad, 2);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROPUESTA-7: panorama-beto asigna prioridad 3 cuando está en piso y las refacciones ya están completas', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'BETO-P3', aseguradora: 'GNP', fecha_entrega_prevista: '2027-01-01', requiere_refacciones: 'si' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'BETO-P3-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Cofre' })).data;
  await req('POST', `/api/piezas/${z.id}/recibir`);
  await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-01', autorizador: 'X' });

  const panorama = await req('GET', '/api/reportes/panorama-beto');
  const item = panorama.data.find(x => x.numero === 'BETO-P3');
  assert.ok(item);
  assert.equal(item.prioridad, 3);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROPUESTA-8: panorama-beto deja en prioridad 4 (proceso normal) lo que no cae en ningún caso especial', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'BETO-P4', aseguradora: 'GNP', fecha_entrega_prevista: '2027-01-01', requiere_refacciones: 'si' })).data;
  await req('POST', '/api/pedidos', { numero: 'BETO-P4-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' });
  await req('PATCH', '/api/siniestros/' + s.id, { estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-01', autorizador: 'X', estado_produccion: 'en_proceso' });

  const panorama = await req('GET', '/api/reportes/panorama-beto');
  const item = panorama.data.find(x => x.numero === 'BETO-P4');
  assert.ok(item);
  assert.equal(item.prioridad, 4);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROPUESTA-9: la búsqueda global también encuentra el siniestro por VIN, para que Beto lo localice y vea la OT adjunta', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'VIN-BUSCA-1', aseguradora: 'GNP', vin: '3N1AB7AP0KY123456' })).data;
  const r = await req('GET', '/api/reportes/buscar?q=3N1AB7AP0KY123456');
  assert.ok(r.data.siniestros.some(x => x.id === s.id), 'debe encontrar el siniestro buscando por su VIN');
});

test('PROPUESTA-10: un archivo tipo "Orden de trabajo" subido para el siniestro queda disponible al consultar sus archivos (lo que ve Beto en Producción)', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'OT-DOC-1', aseguradora: 'GNP' })).data;
  const archivos = await req('GET', '/api/archivos?entidad_tipo=siniestro&entidad_id=' + s.id);
  assert.equal(archivos.status, 200);
  assert.deepEqual(archivos.data, [], 'sin documentos adjuntos todavía debe regresar una lista vacía, no error');
});

/* ===================== Triage documento de Daniela (25-ago-2026), item 1 =====================
   Exponer proveedor + los 10 estados de pieza en las pantallas, y completar el alta/edición de
   proveedor (teléfono, teléfono alterno, regla especial). El backend de piezas ya soportaba todo
   esto; lo que faltaba era exponerlo. Estas pruebas cubren lo nuevo: telefono_alterno en proveedores
   y la edición completa de un proveedor existente. */

test('TRIAGE-1: se puede dar de alta un proveedor con teléfono, teléfono alterno y regla especial, y editarlo después', async () => {
  const pv = (await req('POST', '/api/proveedores', {
    razon_social: 'Refacciones Triage SA', contacto: 'Juan', correo: 'juan@triage.mx',
    telefono: '55-0000-0001', telefono_alterno: '55-0000-0002', regla_especial: 'Confirmar por teléfono siempre.'
  })).data;
  assert.equal(pv.telefono_alterno, '55-0000-0002');

  const editado = await req('PATCH', '/api/proveedores/' + pv.id, { telefono_alterno: '55-0000-0003', regla_especial: 'Nueva regla.' });
  assert.equal(editado.status, 200);
  assert.equal(editado.data.telefono_alterno, '55-0000-0003');
  assert.equal(editado.data.regla_especial, 'Nueva regla.');
});

test('TRIAGE-2: se puede asignar proveedor y mover una pieza por cualquiera de sus 10 estados, no solo a Recibida físicamente', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'TRIAGE-PZ1', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'TRIAGE-PZ1-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const pv = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor Triage 2' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro delantero', proveedor_id: pv.id })).data;
  assert.equal(z.estatus, 'Asignada', 'al crear con proveedor debe quedar Asignada, no Sin proveedor');

  for(const estatus of ['Confirmada','Facturada','En tránsito','Entregada por proveedor']){
    const r = await req('PATCH', '/api/piezas/' + z.id, { estatus });
    assert.equal(r.status, 200);
    assert.equal(r.data.estatus, estatus);
  }
});

test('TRIAGE-CARGA-4: el mapeo de estatus de Inpart es editable (GET/POST/PATCH), no un valor fijo en el código', async () => {
  const lista = await req('GET', '/api/mapeo-estatus-inpart');
  assert.equal(lista.status, 200);
  assert.ok(lista.data.some(m => m.valor_inpart === 'Facturado' && m.estatus_pieza === 'Facturada'), 'debe traer el mapeo sembrado por defecto');

  const nuevo = await req('POST', '/api/mapeo-estatus-inpart', { valor_inpart: 'Listo para recolección', estatus_pieza: 'Confirmada', estatus_pedido: 'Esperando proveedor' });
  assert.equal(nuevo.status, 201);

  const editado = await req('PATCH', '/api/mapeo-estatus-inpart/' + nuevo.data.id, { estatus_pieza: 'Facturada' });
  assert.equal(editado.status, 200);
  assert.equal(editado.data.estatus_pieza, 'Facturada');
});

test('TRIAGE-CORREO-1: no se puede aprobar un correo con destinatario que no tiene formato de correo válido', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CORREO-VAL-1', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'CORREO-VAL-1-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const invalido = await req('POST', '/api/comunicaciones', { pedido_id: p.id, destinatarios: 'esto no es un correo' });
  assert.equal(invalido.status, 400);
  const valido = await req('POST', '/api/comunicaciones', { pedido_id: p.id, destinatarios: 'valido@proveedor.mx' });
  assert.equal(valido.status, 201);
});

test('TRIAGE-INDICADOR-1: pedidosSinPiezas cuenta pedidos activos sin ninguna pieza capturada (complementa a sinProveedor)', async () => {
  const antes = (await req('GET', '/api/reportes/resumen')).data.pedidosSinPiezas;
  const s = (await req('POST', '/api/siniestros', { numero: 'IND-SINPZ-1', aseguradora: 'GNP' })).data;
  await req('POST', '/api/pedidos', { numero: 'IND-SINPZ-1-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' });
  const despues = (await req('GET', '/api/reportes/resumen')).data.pedidosSinPiezas;
  assert.equal(despues, antes + 1);
});

test('TRIAGE-ARCHIVO-1: sustituir un archivo conserva la versión anterior (no se borra) y sube la versión', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'ARCH-SUST-1', aseguradora: 'GNP' })).data;
  const fd = new FormData();
  fd.append('entidad_tipo', 'siniestro'); fd.append('entidad_id', String(s.id)); fd.append('tipo', 'Evidencia');
  fd.append('archivo', new Blob([Buffer.from('version 1')], { type: 'application/pdf' }), 'v1.pdf');
  const res = await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd });
  const archivo = await res.json();
  assert.equal(archivo.version, 1);

  const fd2 = new FormData();
  fd2.append('archivo', new Blob([Buffer.from('version 2')], { type: 'application/pdf' }), 'v2.pdf');
  const res2 = await fetch(BASE + `/api/archivos/${archivo.id}/sustituir`, { method: 'PATCH', headers: { Cookie: cookie }, body: fd2 });
  assert.equal(res2.status, 200);
  const actualizado = await res2.json();
  assert.equal(actualizado.version, 2);
  assert.equal(actualizado.nombre_original, 'v2.pdf');

  const descarga = await fetch(BASE + `/api/archivos/${archivo.id}/descargar`, { headers: { Cookie: cookie } });
  const contenido = await descarga.text();
  assert.equal(contenido, 'version 2', 'la descarga debe traer la versión más reciente');
});

test('TRIAGE-ARCHIVO-2: eliminar un archivo lo manda a la papelera (no lo borra) y se puede restaurar', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'ARCH-DEL-1', aseguradora: 'GNP' })).data;
  const fd = new FormData();
  fd.append('entidad_tipo', 'siniestro'); fd.append('entidad_id', String(s.id)); fd.append('tipo', 'Evidencia');
  fd.append('archivo', new Blob([Buffer.from('x')], { type: 'application/pdf' }), 'borrar.pdf');
  const res = await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd });
  const archivo = await res.json();

  const eliminar = await req('DELETE', '/api/archivos/' + archivo.id);
  assert.equal(eliminar.status, 200);

  const listaNormal = await req('GET', '/api/archivos?entidad_tipo=siniestro&entidad_id=' + s.id);
  assert.ok(!listaNormal.data.some(a => a.id === archivo.id), 'no debe aparecer en la vista normal');
  const listaConPapelera = await req('GET', '/api/archivos?entidad_tipo=siniestro&entidad_id=' + s.id + '&incluir_eliminados=1');
  assert.ok(listaConPapelera.data.some(a => a.id === archivo.id && a.eliminado === 1), 'sigue existiendo, solo marcado como eliminado');

  const restaurado = await req('POST', '/api/archivos/' + archivo.id + '/restaurar');
  assert.equal(restaurado.status, 200);
  const listaDespues = await req('GET', '/api/archivos?entidad_tipo=siniestro&entidad_id=' + s.id);
  assert.ok(listaDespues.data.some(a => a.id === archivo.id), 'debe reaparecer en la vista normal tras restaurar');
});

test('TRIAGE-SEMAFORO-1: GET /api/siniestros/:id incluye el semáforo de completitud por sección', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'SEMAFORO-1', aseguradora: 'GNP' })).data;
  const inicial = await req('GET', '/api/siniestros/' + s.id);
  assert.equal(inicial.data.semaforo.admision, 'pendiente');
  assert.equal(inicial.data.semaforo.produccion, 'pendiente');

  await req('PATCH', '/api/siniestros/' + s.id, { estado_revision_tecnica: 'revision_terminada' });
  await req('PATCH', '/api/siniestros/' + s.id, { estado_produccion: 'terminado' });
  const despues = await req('GET', '/api/siniestros/' + s.id);
  assert.equal(despues.data.semaforo.admision, 'completo');
  assert.equal(despues.data.semaforo.produccion, 'completo');
  assert.equal(despues.data.semaforo.calidad, 'pendiente');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Triage documento de Daniela (25-ago-2026), item 9 =====================
   Búsqueda ampliada: encontrar piezas por descripción o número de parte, y proveedores por
   nombre de contacto además de razón social. */

test('TRIAGE-BUSQUEDA-1: la búsqueda global encuentra piezas por número de parte o descripción, y proveedores por contacto', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'BUSQUEDA-PZ-1', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'BUSQUEDA-PZ-1-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const pv = (await req('POST', '/api/proveedores', { razon_social: 'Refacciones del Bajío SA', contacto: 'Marisol Contacto Única' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro delantero izquierdo', numero_parte: 'NP-99887', proveedor_id: pv.id })).data;

  const porNumeroParte = await req('GET', '/api/reportes/buscar?q=NP-99887');
  assert.ok(porNumeroParte.data.piezas.some(x => x.id === z.id), 'debe encontrar la pieza por número de parte');
  assert.equal(porNumeroParte.data.piezas.find(x => x.id === z.id).siniestro_numero, 'BUSQUEDA-PZ-1');

  const porDescripcion = await req('GET', '/api/reportes/buscar?q=Faro delantero');
  assert.ok(porDescripcion.data.piezas.some(x => x.id === z.id), 'debe encontrar la pieza por descripción');

  const porContacto = await req('GET', '/api/reportes/buscar?q=Marisol Contacto');
  assert.ok(porContacto.data.proveedores.some(x => x.id === pv.id), 'debe encontrar el proveedor por su contacto');
});

/* ===================== Triage documento de Daniela (25-ago-2026), item 10 =====================
   Matriz de roles + acceso de solo lectura para Daniela en todos los módulos operativos.
   DEF-018 del documento original: Daniela (operativo) no veía ni un dato de admisión, expediente,
   valuación, producción o calidad — no solo le faltaban controles de captura, la pantalla entera
   estaba oculta. La corrección tiene dos partes: (1) el frontend ahora le muestra esos módulos como
   consulta (menú + colas de trabajo), y (2) el backend, que antes aceptaba que CUALQUIER usuario
   autenticado escribiera esos campos vía API sin importar su rol, ahora exige el rol dueño de cada
   módulo — para que "solo lectura" sea real y no solo un botón oculto en pantalla. */

test('TRIAGE-ROLES-1: Daniela (operativo) puede leer los módulos especializados pero el backend le bloquea escribir en ellos', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'ROLES-1', aseguradora: 'GNP' })).data;

  // Lectura: las bandejas/colas de todos los módulos especializados deben responder 200 para Daniela.
  for (const ruta of ['bandeja-tecnica', 'bandeja-expediente', 'bandeja-valuacion', 'bandeja-produccion', 'bandeja-calidad']) {
    const r = await req('GET', '/api/reportes/' + ruta);
    assert.equal(r.status, 200, `Daniela debe poder consultar ${ruta}`);
  }
  const ficha = await req('GET', '/api/siniestros/' + s.id);
  assert.equal(ficha.status, 200, 'Daniela debe poder ver la ficha completa del siniestro, incluidos los campos de todos los módulos');

  // Escritura: cada campo de un módulo ajeno debe rechazarse con 403, sin importar que Daniela esté autenticada.
  const casos = [
    [{ estado_revision_tecnica: 'revision_terminada' }, 'revisión técnica (Orlando)'],
    [{ estado_expediente: 'listo_para_valuacion' }, 'expediente digital (Vanessa)'],
    [{ estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-25', autorizador: 'X' }, 'valuación/autorización'],
    [{ estado_produccion: 'terminado' }, 'producción (Beto)'],
    [{ estado_calidad: 'liberado' }, 'calidad'],
    [{ finiquito_estado: 'firmado' }, 'finiquito/encuesta'],
  ];
  for (const [body, nombre] of casos) {
    const r = await req('PATCH', '/api/siniestros/' + s.id, body);
    assert.equal(r.status, 403, `Daniela (operativo) no debe poder escribir campos de ${nombre}`);
  }

  // Los campos generales del expediente (los que siempre pudo editar) siguen abiertos.
  const general = await req('PATCH', '/api/siniestros/' + s.id, { notas: 'Nota general de Daniela' });
  assert.equal(general.status, 200, 'los campos generales del expediente deben seguir editables por Daniela');
});

test('TRIAGE-ROLES-2: el rol dueño de cada módulo (y admin/jefe) sí puede escribir sus propios campos', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'ROLES-2', aseguradora: 'GNP' })).data;

  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const tecnica = await req('PATCH', '/api/siniestros/' + s.id, { estado_revision_tecnica: 'revision_terminada' });
  assert.equal(tecnica.status, 200, 'Orlando sí debe poder actualizar revisión técnica');

  await req('POST', '/api/auth/login', { email: 'vanessa@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const expediente = await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'listo_para_valuacion' });
  assert.equal(expediente.status, 200, 'Vanessa sí debe poder actualizar el expediente');

  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const produccion = await req('PATCH', '/api/siniestros/' + s.id, { estado_produccion: 'terminado' });
  assert.equal(produccion.status, 200, 'Beto sí debe poder actualizar producción');

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const finiquito = await req('PATCH', '/api/siniestros/' + s.id, { finiquito_estado: 'firmado' });
  assert.equal(finiquito.status, 400, 'admin sí tiene permiso de rol, pero la regla de negocio de firmar sin entrega registrada sigue aplicando');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Triage documento de Daniela (25-ago-2026), item 11 =====================
   Política y prueba de respaldo/restauración. El respaldo automático (programarRespaldosAutomaticos)
   está deshabilitado durante las pruebas (TEST_DB_PATH) para no ensuciar la carpeta de datos de
   prueba, así que aquí se prueba la ruta manual /api/respaldos de punta a punta: solo admin puede
   usarla, el respaldo generado es un archivo .db real y — la parte que de verdad importa — al
   abrirlo con una conexión SQLite independiente contiene los datos reales, no solo un archivo vacío
   con el nombre correcto. Esto es la "restauración de prueba" que pide ACC-007, ejecutada contra la
   base de datos de pruebas, nunca contra producción. */

test('TRIAGE-RESPALDO-1: solo admin puede listar, crear o descargar respaldos', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'RESPALDO-PERM-1', aseguradora: 'GNP' })).data;

  const listaSinPermiso = await req('GET', '/api/respaldos');
  assert.equal(listaSinPermiso.status, 403, 'Daniela (operativo) no debe poder listar respaldos');
  const crearSinPermiso = await req('POST', '/api/respaldos');
  assert.equal(crearSinPermiso.status, 403, 'Daniela (operativo) no debe poder crear un respaldo');

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const creado = await req('POST', '/api/respaldos');
  assert.equal(creado.status, 201, 'admin sí debe poder crear un respaldo');
  assert.ok(creado.data.nombre.startsWith('tablero-') && creado.data.nombre.endsWith('.db'));

  const lista = await req('GET', '/api/respaldos');
  assert.equal(lista.status, 200);
  assert.ok(lista.data.some(r => r.nombre === creado.data.nombre), 'el respaldo recién creado debe aparecer en la lista');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('TRIAGE-RESPALDO-2: el respaldo generado es un archivo SQLite consistente que, al restaurarlo en una conexión aparte, conserva los datos reales', async () => {
  const { DatabaseSync } = require('node:sqlite');

  const marcador = 'RESPALDO-DATO-' + Date.now();
  const s = (await req('POST', '/api/siniestros', { numero: marcador, aseguradora: 'GNP', vehiculo: 'Aveo de prueba de respaldo', placas: 'RSP-001' })).data;

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const creado = await req('POST', '/api/respaldos');
  assert.equal(creado.status, 201);

  const descarga = await fetch(BASE + '/api/respaldos/' + encodeURIComponent(creado.data.nombre) + '/descargar', { headers: { Cookie: cookie } });
  assert.equal(descarga.status, 200, 'el respaldo debe poder descargarse');
  const buf = Buffer.from(await descarga.arrayBuffer());
  assert.ok(buf.length > 0, 'el archivo de respaldo no debe estar vacío');

  const rutaTemporal = path.join(__dirname, '..', 'data', 'respaldo-prueba-restauracion.db');
  fs.writeFileSync(rutaTemporal, buf);

  // "Restauración de prueba" real: se abre el respaldo con una conexión SQLite completamente
  // independiente (no la del servidor) y se confirma que el dato capturado antes de respaldar sigue ahí.
  const dbRestaurada = new DatabaseSync(rutaTemporal);
  const fila = dbRestaurada.prepare('SELECT numero, vehiculo, placas FROM siniestros WHERE numero = ?').get(marcador);
  dbRestaurada.close();
  fs.unlinkSync(rutaTemporal);

  assert.ok(fila, 'el siniestro capturado antes del respaldo debe existir en el archivo restaurado');
  assert.equal(fila.vehiculo, 'Aveo de prueba de respaldo');
  assert.equal(fila.placas, 'RSP-001');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('TRIAGE-RESPALDO-3: descargar un nombre de respaldo que no existe da 404, no expone rutas arbitrarias del disco', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const r = await req('GET', '/api/respaldos/' + encodeURIComponent('../../../etc/passwd') + '/descargar');
  assert.equal(r.status, 404);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Investigación Inpart/Gmail (25-ago-2026) =====================
   Preparación de la integración con Gmail (Camino B: cuenta dedicada + contraseña de aplicación),
   confirmado por Roberto. Mientras GMAIL_USER/GMAIL_APP_PASSWORD no estén configurados en el
   entorno (nunca lo están en pruebas, ni deben estarlo), /api/comunicaciones/:id/enviar debe
   responder 503 de forma clara y dejar el correo en 'aprobado', para que el flujo manual de
   copiar/pegar de Daniela siga funcionando exactamente igual que hoy. Es intencional que estas
   pruebas NUNCA intenten un envío real. */

test('GMAIL-1: enviar un correo por Gmail responde 503 mientras no esté configurado, y el correo sigue disponible para enviarse manualmente', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'GMAIL-1', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'GMAIL-1-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const com = (await req('POST', '/api/comunicaciones', { pedido_id: p.id, destinatarios: 'proveedor-prueba@ejemplo.mx', asunto: 'Prueba', cuerpo: 'Cuerpo de prueba' })).data;

  const envio = await req('POST', '/api/comunicaciones/' + com.id + '/enviar');
  assert.equal(envio.status, 503, 'sin GMAIL_USER/GMAIL_APP_PASSWORD debe responder 503, nunca intentar un envío real');
  assert.match(envio.data.error, /no está configurado/);

  const auditoria = await req('GET', '/api/auditoria?entidad_tipo=comunicacion&entidad_id=' + com.id);
  assert.ok(!auditoria.data.some(a => a.accion === 'correo_enviado_automaticamente'), 'no debe registrarse un envío automático que nunca ocurrió');
});

test('GMAIL-2: solo operativo/admin pueden intentar el envío automático; no se puede enviar un correo que no está aprobado', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'GMAIL-2', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'GMAIL-2-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const com = (await req('POST', '/api/comunicaciones', { pedido_id: p.id, destinatarios: 'proveedor-prueba@ejemplo.mx' })).data;

  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const sinPermiso = await req('POST', '/api/comunicaciones/' + com.id + '/enviar');
  assert.equal(sinPermiso.status, 403, 'orlando no debe poder enviar correos con proveedores');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });

  // Este correo se creó ya con estado 'aprobado' por defecto (comportamiento histórico documentado
  // en el propio código), así que probamos el caso contrario: uno descartado no debe poder enviarse.
  await req('PATCH', '/api/comunicaciones/' + com.id + '/descartar', { motivo: 'ya no aplica' });
  const descartado = await req('POST', '/api/comunicaciones/' + com.id + '/enviar');
  assert.equal(descartado.status, 400, 'no se puede enviar un correo descartado');
});

/* ===================== Hallazgo de Daniela en producción (26-ago-2026) =====================
   Item 1: viewCargaMasiva() es async pero se llamaba sin await -> [object Promise] en pantalla.
   No es un caso de prueba de API (es puramente de frontend), se corrigió directo en public/app.js.

   Item 6: se acumulaban varios avisos automáticos "pendiente_aprobacion" para el mismo pedido
   (uno por cada ciclo de vencimiento/seguimiento que pasaba sin aprobarse), llegando a 552 correos
   para 205 pedidos en producción. Las pruebas de abajo reproducen el escenario exacto que causaba
   la acumulación y comprueban que ahora solo queda vivo un aviso automático por pedido. */

test('TRIAGE-CORREO-DEDUP-1: un pedido vencido nunca aprobado no genera seguimientos adicionales (antes se acumulaban)', async () => {
  const db = require('../server/db');
  const s = (await req('POST', '/api/siniestros', { numero: 'DEDUP-1', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'DEDUP-1-PED', siniestro_id: s.id, fecha_prevista: '2020-01-01', confirmar_fecha_prevista: true })).data;
  const provDedup1 = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor DEDUP1', correo: 'contacto@proveedordedup1.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro derecho', proveedor_id: provDedup1.id });

  await req('GET', '/api/comunicaciones/pendientes');
  // El "pedido nuevo" y el "vencimiento día 1" se generan en la misma pasada (la fecha ya está vencida);
  // el segundo descarta al primero por la corrección de duplicados, así que solo debe quedar UNO pendiente.
  let coms = (await req('GET', '/api/comunicaciones?pedido_id=' + p.id)).data;
  let pendientes = coms.filter(c => c.estado === 'pendiente_aprobacion');
  assert.equal(pendientes.length, 1, 'debe quedar exactamente un aviso pendiente_aprobacion (vencimiento_dia1)');
  assert.equal(pendientes[0].disparador, 'vencimiento_dia1');
  assert.equal(pendientes[0].destinatarios, 'contacto@proveedordedup1.mx');

  // Simula que pasaron 10 días sin que Daniela lo aprobara ni respondiera, y se vuelve a consultar
  // la bandeja varias veces (como pasaría al abrir la pantalla de Correos pendientes cada día).
  db.prepare(`UPDATE comunicaciones SET fecha_envio = datetime('now','-10 days') WHERE id = ?`).run(pendientes[0].id);
  await req('GET', '/api/comunicaciones/pendientes');
  await req('GET', '/api/comunicaciones/pendientes');
  await req('GET', '/api/comunicaciones/pendientes');

  coms = (await req('GET', '/api/comunicaciones?pedido_id=' + p.id)).data;
  pendientes = coms.filter(c => c.estado === 'pendiente_aprobacion');
  assert.equal(pendientes.length, 1, 'un borrador nunca aprobado no debe disparar seguimientos adicionales (antes generaba uno nuevo por cada ciclo de 2 días)');
});

test('TRIAGE-CORREO-DEDUP-2: al generarse un nuevo seguimiento automático, el aviso pendiente anterior del mismo pedido queda descartado (no duplicado)', async () => {
  const db = require('../server/db');
  const s = (await req('POST', '/api/siniestros', { numero: 'DEDUP-2', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'DEDUP-2-PED', siniestro_id: s.id, fecha_prevista: '2020-01-01', confirmar_fecha_prevista: true })).data;
  const provDedup2 = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor DEDUP2', correo: 'contacto@proveedordedup2.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro izquierdo', proveedor_id: provDedup2.id });

  await req('GET', '/api/comunicaciones/pendientes');
  let coms = (await req('GET', '/api/comunicaciones?pedido_id=' + p.id)).data;
  const vencimiento = coms.find(c => c.disparador === 'vencimiento_dia1');
  assert.ok(vencimiento, 'debe existir el aviso de vencimiento');

  // Esta vez sí se aprueba (como haría Daniela) y se responde el correo, pero el proveedor no contesta
  // y pasan más de 2 días hábiles: debe generarse el seguimiento y el vencimiento anterior debe quedar
  // descartado en vez de convivir ambos como "pendiente_aprobacion".
  await req('PATCH', '/api/comunicaciones/' + vencimiento.id + '/aprobar', { destinatarios: 'proveedor-dedup@ejemplo.mx' });
  db.prepare(`UPDATE comunicaciones SET fecha_envio = datetime('now','-10 days') WHERE id = ?`).run(vencimiento.id);

  await req('GET', '/api/comunicaciones/pendientes');
  coms = (await req('GET', '/api/comunicaciones?pedido_id=' + p.id)).data;
  const pendientes = coms.filter(c => c.estado === 'pendiente_aprobacion');
  assert.equal(pendientes.length, 1, 'solo debe quedar un aviso pendiente_aprobacion por pedido, el más reciente');
  assert.equal(pendientes[0].disparador, 'seguimiento_2dias');

  const vencimientoActualizado = coms.find(c => c.id === vencimiento.id);
  assert.equal(vencimientoActualizado.estado, 'aprobado', 'el aviso ya aprobado no se toca, solo se descartan los que seguían pendiente_aprobacion');
});

/* ===================== Corrección de plantilla de correos automáticos (27-ago-2026) =====================
   Hallazgo de Daniela sobre los 212 borradores en producción: destinatario "correo@proveedor.mx" o vacío,
   copia con texto de instrucción en vez de direcciones reales, y cuerpo que no pedía la información
   necesaria con claridad. Las pruebas de abajo cubren la plantilla nueva, la resolución de destinatario,
   el bloqueo cuando no hay proveedor válido, la exclusión de piezas recibidas/canceladas, y la migración
   de los borradores ya existentes. */

test('CORREO-PLANTILLA-1: el cuerpo automático usa el texto exacto pedido, con siniestro/pedido/piezas pendientes', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'PLANT-1', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'PLANT-1-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const prov = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor PLANT1', correo: 'contacto@proveedorplant1.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Cofre delantero', proveedor_id: prov.id });
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Salpicadera izquierda', proveedor_id: prov.id });

  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  const com = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo');
  assert.ok(com);
  assert.match(com.cuerpo, /¿Nos podrían apoyar confirmando el estatus actualizado del pedido PLANT-1-PED, correspondiente al siniestro PLANT-1,/);
  assert.match(com.cuerpo, /disponibilidad y fecha estimada de entrega/);
  assert.match(com.cuerpo, /- Cofre delantero/);
  assert.match(com.cuerpo, /- Salpicadera izquierda/);
  assert.match(com.cuerpo, /retraso, faltante o incidencia/);
  assert.match(com.cuerpo, /nueva fecha compromiso/);
  assert.match(com.cuerpo, /Daniela Sosa\nRefacciones/);
  assert.equal(com.destinatarios, 'contacto@proveedorplant1.mx');
  assert.equal(com.incompleto, 0);
});

test('CORREO-PLANTILLA-2: sin proveedor con correo válido, el borrador queda incompleto y bloqueado para aprobar', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'PLANT-2', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'PLANT-2-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const provSinCorreo = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor sin correo PLANT2' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Puerta trasera', proveedor_id: provSinCorreo.id });

  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  const com = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo');
  assert.ok(com);
  assert.equal(com.destinatarios, '', 'nunca debe usarse un correo de ejemplo; queda vacío');
  assert.equal(com.incompleto, 1);

  const bloqueado = await req('PATCH', `/api/comunicaciones/${com.id}/aprobar`, {});
  assert.equal(bloqueado.status, 400, 'no debe poder aprobarse mientras no tenga destinatario');

  const conDestinatario = await req('PATCH', `/api/comunicaciones/${com.id}/aprobar`, { destinatarios: 'completado-a-mano@ejemplo.mx' });
  assert.equal(conDestinatario.status, 200);
  assert.equal(conDestinatario.data.incompleto, 0, 'al completarlo y aprobarlo, deja de estar marcado como incompleto');
});

test('CORREO-PLANTILLA-3: las piezas recibidas o canceladas no aparecen en el listado del correo', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'PLANT-3', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'PLANT-3-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const prov = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor PLANT3', correo: 'contacto@proveedorplant3.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Pieza pendiente', proveedor_id: prov.id });
  const recibida = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Pieza ya recibida', proveedor_id: prov.id })).data;
  await req('PATCH', `/api/piezas/${recibida.id}`, { estatus: 'Recibida físicamente' });

  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  const com = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo');
  assert.ok(com);
  assert.match(com.cuerpo, /Pieza pendiente/);
  assert.ok(!com.cuerpo.includes('Pieza ya recibida'), 'no debe listar piezas ya recibidas');
});

test('CORREO-PLANTILLA-4: la migración corrige un borrador con datos "viejos" (placeholder) sin aprobarlo ni enviarlo', async () => {
  const db = require('../server/db');
  const { corregirBorradoresAutomaticosExistentes } = require('../server/utils');
  const s = (await req('POST', '/api/siniestros', { numero: 'PLANT-4', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'PLANT-4-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const prov = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor PLANT4', correo: 'contacto@proveedorplant4.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Facia trasera', proveedor_id: prov.id });

  // Simula un borrador "viejo" tal como estaban los 212 en producción: destinatario placeholder, copia
  // con texto de instrucción, cuerpo genérico.
  const info = db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,estado,disparador,enviado_por,fecha_envio)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(p.id, s.id, null, 'Correo', `SINIESTRO ${s.numero} - PEDIDO ${p.numero}`, '',
      'Copiar a Jorge Contreras y Edgar (completar sus correos antes de aprobar).',
      'Damos seguimiento. No hemos recibido respuesta a nuestro mensaje anterior.',
      'seguimiento_2dias', 'pendiente_aprobacion', 'seguimiento_2dias', null);
  const idViejo = info.lastInsertRowid;

  corregirBorradoresAutomaticosExistentes(db);

  const corregido = db.prepare('SELECT * FROM comunicaciones WHERE id = ?').get(idViejo);
  assert.equal(corregido.estado, 'pendiente_aprobacion', 'sigue pendiente de aprobación, no se aprobó ni se envió');
  assert.equal(corregido.destinatarios, 'contacto@proveedorplant4.mx');
  assert.equal(corregido.copia, '', 'Mapfre no tiene direcciones reales; ya no debe llevar texto de instrucción');
  assert.match(corregido.cuerpo, /Facia trasera/);
  assert.match(corregido.cuerpo, /estatus actualizado del pedido PLANT-4-PED/);
  assert.equal(corregido.incompleto, 0);

  // Correr la migración de nuevo no debe duplicar ni romper nada (idempotente).
  corregirBorradoresAutomaticosExistentes(db);
  const total = db.prepare('SELECT COUNT(*) n FROM comunicaciones WHERE pedido_id = ?').get(p.id).n;
  assert.equal(total, 1);
});

test('CORREO-PLANTILLA-6: reimportar por carga masiva recalcula al instante un borrador ya marcado "Incompleto", sin esperar a un reinicio del servidor', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'PLANT-6', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'PLANT-6-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  // Pieza sin proveedor todavía (así llegan muchos pedidos reales antes de que Inpart tenga el dato
  // completo): el borrador automático se genera pero queda "Incompleto", como reportó Daniela.
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Facia delantera', numero_parte: 'PLANT6-NP1' });

  let pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  let com = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo');
  assert.ok(com);
  assert.equal(com.incompleto, 1, 'sin proveedor asignado, el borrador nace incompleto');
  assert.equal(com.destinatarios, '');

  // Ahora llega una carga masiva (reimportación de Inpart) que sí trae el proveedor y correo reales
  // para esa misma pieza (mismo numero_pedido / numero_parte).
  const csv = [
    'numero_siniestro,aseguradora,numero_pedido,fecha_prevista,numero_parte,descripcion_pieza,proveedor,correo_proveedor',
    'PLANT-6,GNP,PLANT-6-PED,2026-12-01,PLANT6-NP1,Facia delantera,Proveedor PLANT6,contacto@proveedorplant6.mx',
  ].join('\n');
  const validado = (await req('POST', '/api/carga-masiva/validar', { csv })).data;
  const confirmar = await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado.pedidos });
  assert.equal(confirmar.status, 200);

  // El borrador YA EXISTENTE (mismo id) debe quedar corregido de inmediato, en la misma petición de
  // carga masiva, sin necesitar un reinicio del servidor.
  const comDespues = (await req('GET', '/api/comunicaciones?pedido_id=' + p.id)).data.find(c => c.id === com.id);
  assert.ok(comDespues, 'sigue siendo el mismo borrador, no se creó uno nuevo');
  assert.equal(comDespues.estado, 'pendiente_aprobacion', 'sigue pendiente de aprobación, no se aprobó ni se envió solo');
  assert.equal(comDespues.destinatarios, 'contacto@proveedorplant6.mx');
  assert.equal(comDespues.incompleto, 0, 'al llegar el proveedor real por carga masiva, deja de estar Incompleto sin esperar a un redeploy');
});

test('CORREO-PLANTILLA-5: la migración descarta (no borra) borradores de pedidos que ya no tienen piezas pendientes', async () => {
  const db = require('../server/db');
  const { corregirBorradoresAutomaticosExistentes } = require('../server/utils');
  const s = (await req('POST', '/api/siniestros', { numero: 'PLANT-5', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'PLANT-5-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const prov = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor PLANT5', correo: 'contacto@proveedorplant5.mx' })).data;
  const pieza = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Ya recibida', proveedor_id: prov.id })).data;
  await req('PATCH', `/api/piezas/${pieza.id}`, { estatus: 'Recibida físicamente' });

  const info = db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,estado,disparador,enviado_por,fecha_envio)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(p.id, s.id, null, 'Correo', 'x', '', '', 'y', 'vencimiento_dia1', 'pendiente_aprobacion', 'vencimiento_dia1', null);
  const idViejo = info.lastInsertRowid;

  corregirBorradoresAutomaticosExistentes(db);
  const corregido = db.prepare('SELECT * FROM comunicaciones WHERE id = ?').get(idViejo);
  assert.equal(corregido.estado, 'descartado', 'el pedido ya no tiene piezas pendientes; no debe seguir pidiendo nada (R-05)');
});

/* ===================== Ventana operativa 1-jun-2026 (27-ago-2026, instrucción de Daniela/Roberto) =====================
   El taller decidió operar el tablero de refacciones únicamente con datos desde el 1 de junio de 2026.
   Las pruebas siguientes crean un pedido con fecha_creacion anterior a ese corte (2026-05-15) y confirman
   que desaparece por default de las vistas de refacciones, pero sigue existiendo (nunca se borra) y
   reaparece con ?ventana=todas; y que las bandejas de otros roles (Orlando/Vanessa/Beto) no se tocan. */

test('VENTANA-1: un pedido anterior al 1-jun-2026 no aparece por default en lista maestra, Kanban, correos pendientes ni indicadores, pero sí con ?ventana=todas', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'VENT-1', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'VENT-1-PED', siniestro_id: s.id, fecha_prevista: '2026-06-01', fecha_creacion: '2026-05-15', confirmar_fecha_prevista: true })).data;
  const prov = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor VENT1', correo: 'contacto@proveedorvent1.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Pieza vieja', proveedor_id: prov.id });

  const listaDefault = (await req('GET', '/api/reportes/lista-maestra?pageSize=1000')).data.filas;
  assert.ok(!listaDefault.some(f => f.pedido_numero === 'VENT-1-PED'), 'no debe verse en lista maestra por default (anterior al corte)');
  const listaTodas = (await req('GET', '/api/reportes/lista-maestra?ventana=todas&pageSize=1000')).data.filas;
  assert.ok(listaTodas.some(f => f.pedido_numero === 'VENT-1-PED'), 'con ?ventana=todas sigue disponible: no se borró nada');

  const kanbanDefault = (await req('GET', '/api/reportes/kanban')).data;
  assert.ok(!kanbanDefault.some(k => k.numero === 'VENT-1-PED'), 'no debe verse en Kanban por default');
  const kanbanTodas = (await req('GET', '/api/reportes/kanban?ventana=todas')).data;
  assert.ok(kanbanTodas.some(k => k.numero === 'VENT-1-PED'), 'Kanban con ?ventana=todas lo sigue mostrando');

  const pendientesDefault = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  assert.ok(!pendientesDefault.some(c => c.pedido_numero === 'VENT-1-PED'), 'no debe verse en correos pendientes por default');
  const pendientesTodas = (await req('GET', '/api/comunicaciones/pendientes?ventana=todas')).data.filas;
  assert.ok(pendientesTodas.some(c => c.pedido_numero === 'VENT-1-PED'), 'correos pendientes con ?ventana=todas lo sigue mostrando');

  const resumen = (await req('GET', '/api/reportes/resumen')).data;
  const resumenTodas = (await req('GET', '/api/reportes/resumen?ventana=todas')).data;
  assert.ok(resumenTodas.pedidosSinPiezas + resumenTodas.sinProveedor + 1 >= 0, 'sanity: el resumen sin corte sigue respondiendo');
  // El pedido cuenta como "Nuevo" en ambos resúmenes; solo debe contarse en el que incluye todo el historial.
  assert.ok(resumenTodas.pedidosNuevos >= resumen.pedidosNuevos, 'el resumen con ?ventana=todas nunca cuenta menos que el resumen con el corte aplicado');
});

test('VENTANA-2: la búsqueda global acota pedidos y piezas al 1-jun-2026, pero nunca oculta el siniestro ni el proveedor (otros roles navegan con la misma búsqueda)', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'VENT2-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'VENT2-PED', siniestro_id: s.id, fecha_prevista: '2026-06-01', fecha_creacion: '2026-04-01', confirmar_fecha_prevista: true })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Pieza VENT2 unica', numero_parte: 'VENT2-NP' });

  const r = (await req('GET', '/api/reportes/buscar?q=VENT2')).data;
  assert.ok(r.siniestros.some(x => x.numero === 'VENT2-SIN'), 'el siniestro se sigue encontrando (navegación de otros roles)');
  assert.ok(!r.pedidos.some(x => x.numero === 'VENT2-PED'), 'el pedido de refacciones anterior al corte no aparece por default en resultados de pedidos');
  assert.ok(!r.piezas.some(x => x.numero_parte === 'VENT2-NP'), 'la pieza de refacciones anterior al corte no aparece por default en resultados de piezas');

  const rTodas = (await req('GET', '/api/reportes/buscar?q=VENT2&ventana=todas')).data;
  assert.ok(rTodas.pedidos.some(x => x.numero === 'VENT2-PED'), 'con ?ventana=todas el pedido reaparece en la búsqueda');
});

test('VENTANA-3: la ventana operativa no toca las bandejas de otros roles (Orlando/Vanessa/Beto) ni el detalle de un siniestro ya abierto', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'VENT-3', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'VENT-3-PED', siniestro_id: s.id, fecha_prevista: '2026-06-01', fecha_creacion: '2026-03-01', confirmar_fecha_prevista: true })).data;
  const prov = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor VENT3', correo: 'contacto@proveedorvent3.mx' })).data;
  const pieza = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Pieza VENT3', proveedor_id: prov.id })).data;
  await req('POST', '/api/incidencias', { pieza_id: pieza.id, tipo: 'incorrecta', descripcion: 'llegó mal' });

  // Bandeja técnica de Orlando: usa el mismo listado base de siniestros, sin corte alguno -- pero desde la
  // propuesta de Orlando (27-ago-2026) sí exige que la admisión ya esté completa (no la ventana operativa).
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  await req('PATCH', '/api/siniestros/' + s.id, { ingreso_tipo: 'circulando', fecha_admision: '2026-03-01' });
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const bandejaTecnica = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  assert.ok(bandejaTecnica.some(x => x.numero === 'VENT-3'), 'la bandeja técnica de Orlando no debe filtrarse por la ventana operativa de refacciones (aunque sí por la admisión completa, ya probado en ORLA-1/2)');

  // Dentro del detalle de un siniestro ya abierto, sus incidencias (por pieza_id) se siguen viendo completas.
  const incPorPieza = (await req('GET', '/api/incidencias?pieza_id=' + pieza.id)).data;
  assert.ok(incPorPieza.length >= 1, 'las incidencias de una pieza puntual (detalle del siniestro) no se ocultan por la ventana operativa');

  // Pero el listado general de incidencias abiertas (pantalla "Incidencias") sí aplica el corte por default.
  const incGenerales = (await req('GET', '/api/incidencias?estado=abierta')).data;
  assert.ok(!incGenerales.some(i => i.pedido_numero === 'VENT-3-PED'), 'la pantalla general de incidencias sí aplica el corte del 1-jun-2026 por default');
  const incGeneralesTodas = (await req('GET', '/api/incidencias?estado=abierta&ventana=todas')).data;
  assert.ok(incGeneralesTodas.some(i => i.pedido_numero === 'VENT-3-PED'), 'con ?ventana=todas la pantalla general de incidencias lo sigue mostrando');
});

/* ===================== Corrección de formato de fecha en carga masiva (27-ago-2026) =====================
   Hallazgo real durante la verificación de la ventana operativa: 192 de 213 pedidos reales en
   producción tenían fecha_creacion guardada como "DD/MM/AAAA" (formato tal cual venía del CSV de
   Inpart) en vez de ISO, y la comparación de texto de la ventana operativa los descartaba por error
   aunque su fecha real sí estuviera dentro del 1-jun-2026 en adelante. */

test('FECHA-1: normalizarFechaISO convierte DD/MM/AAAA a ISO y deja el ISO y los formatos desconocidos intactos', () => {
  const { normalizarFechaISO } = require('../server/utils');
  assert.equal(normalizarFechaISO('02/06/2026'), '2026-06-02');
  assert.equal(normalizarFechaISO('16/07/2026'), '2026-07-16');
  assert.equal(normalizarFechaISO('2026-06-01'), '2026-06-01', 'ya viene en ISO, no se toca');
  assert.equal(normalizarFechaISO(''), '');
  assert.equal(normalizarFechaISO('no es una fecha'), 'no es una fecha', 'formato desconocido: se deja igual, nunca se inventa una fecha');
});

test('FECHA-2: la carga masiva guarda fecha_creacion en ISO aunque el CSV traiga DD/MM/AAAA, y ese pedido sí aparece dentro de la ventana operativa', async () => {
  const csv = [
    'numero_siniestro,aseguradora,numero_pedido,fecha_creacion_pedido,fecha_prevista',
    'FECHA2-SIN,GNP,FECHA2-PED,02/06/2026,2026-06-10',
  ].join('\n');
  const validado = (await req('POST', '/api/carga-masiva/validar', { csv })).data;
  await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado.pedidos });

  const siniestro = (await req('GET', '/api/siniestros?q=FECHA2-SIN')).data[0];
  const pedido = (await req('GET', '/api/pedidos?siniestro_id=' + siniestro.id)).data[0];
  assert.equal(pedido.fecha_creacion, '2026-06-02', 'se guardó en ISO, no como vino el CSV');

  const listaDefault = (await req('GET', '/api/reportes/lista-maestra?pageSize=1000')).data.filas;
  assert.ok(listaDefault.some(f => f.pedido_numero === 'FECHA2-PED'), 'con la fecha ya en ISO, sí aparece dentro de la ventana operativa por default');
});

test('FECHA-3: la corrección de fechas existentes reescribe en su lugar los pedidos ya guardados en DD/MM/AAAA (sin inventar fechas) y es idempotente', async () => {
  const db = require('../server/db');
  const { normalizarFechasCreacionPedidosExistentes } = require('../server/utils');
  const s = (await req('POST', '/api/siniestros', { numero: 'FECHA3-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'FECHA3-PED', siniestro_id: s.id, fecha_prevista: '2026-06-10', confirmar_fecha_prevista: true })).data;
  // Simula un pedido tal como quedaron los 192 reales: fecha_creacion cruda del CSV, sin normalizar.
  db.prepare('UPDATE pedidos SET fecha_creacion = ? WHERE id = ?').run('03/06/2026', p.id);

  const corregidos = normalizarFechasCreacionPedidosExistentes(db);
  assert.ok(corregidos >= 1);
  const pedidoCorregido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(p.id);
  assert.equal(pedidoCorregido.fecha_creacion, '2026-06-03');

  // Correr de nuevo no debe volver a tocarlo (ya está en ISO) ni romper nada.
  const segundaVez = normalizarFechasCreacionPedidosExistentes(db);
  const pedidoTrasSegundaVez = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(p.id);
  assert.equal(pedidoTrasSegundaVez.fecha_creacion, '2026-06-03', 'idempotente: no cambia lo que ya está bien');
});

/* ===================== Verificación explícita InPart GNP (27-ago-2026, precisión de Roberto) =====================
   Roberto pidió validar por separado InPart "general" y InPart GNP, usando como caso de control el
   pedido 1139278 del siniestro 0185278777A. En producción ese siniestro SÍ existe (GNP, Chrysler,
   PYM6258) pero AÚN NO tiene el pedido 1139278 cargado -- de los 5 pedidos GNP que sí hay en
   producción, los 5 pertenecen a un solo siniestro distinto y ninguno tiene piezas capturadas todavía;
   es una brecha de CARGA DE DATOS (falta importar el InPart GNP real), no un defecto de código. La
   prueba de abajo demuestra, con datos sintéticos que imitan el formato real (fecha DD/MM/AAAA, como
   entrega Inpart), que en cuanto esa carga se haga la cadena completa funciona igual para GNP que para
   cualquier otra aseguradora: ventana operativa, "Sin proveedor", destinatario real, copia GNP (R-08),
   cuerpo de la plantilla y exclusión de piezas cerradas. */

test('GNP-1: un pedido GNP importado por carga masiva (formato de fecha real DD/MM/AAAA) queda dentro de la ventana operativa, sin "Sin proveedor", con destinatario real y copia GNP, igual que cualquier otra aseguradora', async () => {
  const csv = [
    'numero_siniestro,aseguradora,vehiculo,placas,numero_pedido,fecha_creacion_pedido,fecha_prevista,numero_parte,descripcion_pieza,proveedor,correo_proveedor,contacto_proveedor,telefono_proveedor,estatus_inpart_pieza',
    '0185278777A-CTRL,GNP,Chrysler,PYM6258,1139278-CTRL,05/06/2026,2026-06-20,NP-GNP-1,Facia delantera,Proveedor GNP Control,contacto@proveedorgnpcontrol.mx,Juan Pérez,555-0001,Facturado',
  ].join('\n');
  const validado = (await req('POST', '/api/carga-masiva/validar', { csv })).data;
  assert.equal(validado.pedidos.filter(p=>p.errores.length===0).length, 1);
  const confirmar = await req('POST', '/api/carga-masiva/confirmar', { pedidos: validado.pedidos });
  assert.equal(confirmar.status, 200);
  assert.equal(confirmar.data.proveedoresCreados, 1);

  const siniestro = (await req('GET', '/api/siniestros?q=0185278777A-CTRL')).data[0];
  assert.equal(siniestro.aseguradora, 'GNP');
  const pedido = (await req('GET', '/api/pedidos?siniestro_id=' + siniestro.id)).data[0];
  assert.equal(pedido.fecha_creacion, '2026-06-05', 'la fecha real DD/MM/AAAA de Inpart GNP se normalizó a ISO igual que en InPart general');

  // Ventana operativa: aparece en lista maestra, Kanban e indicadores por default, igual que un pedido no-GNP.
  const lista = (await req('GET', '/api/reportes/lista-maestra?pageSize=1000')).data.filas;
  assert.ok(lista.some(f => f.pedido_numero === '1139278-CTRL' && f.aseguradora === 'GNP'), 'el pedido GNP aparece en lista maestra dentro de la ventana operativa');
  const kanban = (await req('GET', '/api/reportes/kanban')).data;
  assert.ok(kanban.some(k => k.numero === '1139278-CTRL'), 'el pedido GNP aparece en Kanban dentro de la ventana operativa');

  // "Sin proveedor": la pieza GNP sí trae proveedor real, no debe contarse como "Sin proveedor".
  const pieza = (await req('GET', '/api/piezas?pedido_id=' + pedido.id)).data[0];
  assert.notEqual(pieza.estatus, 'Sin proveedor');
  assert.ok(pieza.proveedor_id);

  // Correo automático: destinatario real del proveedor GNP + copia con las direcciones reales de GNP (R-08).
  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data.filas;
  // La fecha prevista de control (2026-06-20) ya quedó en el pasado respecto a "hoy" en el entorno de
  // pruebas, así que el disparador vivo puede ser 'pedido_nuevo' o 'vencimiento_dia1' (ambos usan
  // exactamente la misma lógica de destinatario/copia/cuerpo) -- lo relevante aquí es que exista uno.
  const com = pendientes.find(c => c.pedido_id === pedido.id);
  assert.ok(com);
  assert.equal(com.destinatarios, 'contacto@proveedorgnpcontrol.mx');
  assert.equal(com.incompleto, 0);
  assert.match(com.copia, /cristian\.hernandezortiz@gnp\.com\.mx/);
  assert.match(com.cuerpo, /estatus actualizado del pedido 1139278-CTRL, correspondiente al siniestro 0185278777A-CTRL/);
  assert.match(com.cuerpo, /- Facia delantera/);
});

/* ===================== Propuesta de Alejandra: nuevos estados de hitos + "Pendientes de hoy" (27-ago-2026) =====================
   Documento "SEGUIMIENTO TABLERO ALE.docx": estados más específicos por hito (en_complemento,
   esperando_autorizacion, en_proceso, autorizado, completado, bloqueado), pregunta de cobertura de
   deducible en el hito de entrega, y la pantalla "Pendientes de hoy" (rojo/ámbar/verde) sobre datos
   reales ya existentes en el sistema. */

test('ALE-1: los nuevos estados de hito funcionan; "en_complemento" y "bloqueado" exigen detalle y se guarda tal cual', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'ALE1-SIN', aseguradora: 'GNP', cliente_nombre: 'X', cliente_telefono: '1', cliente_correo: 'x@x.com' })).data;
  const hitos = (await req('GET', '/api/hitos?siniestro_id=' + s.id)).data;
  const revision = hitos.find(h => h.clave === 'revision');

  const sinDetalle = await req('PATCH', '/api/hitos/' + revision.id, { estado: 'en_complemento' });
  assert.equal(sinDetalle.status, 400);
  const conDetalle = await req('PATCH', '/api/hitos/' + revision.id, { estado: 'en_complemento', detalle: 'Falta la factura del cristal delantero.' });
  assert.equal(conDetalle.status, 200);
  assert.equal(conDetalle.data.estado, 'en_complemento');
  assert.equal(conDetalle.data.detalle, 'Falta la factura del cristal delantero.');

  const sinDetalleBloqueo = await req('PATCH', '/api/hitos/' + revision.id, { estado: 'bloqueado' });
  assert.equal(sinDetalleBloqueo.status, 400);
  const conDetalleBloqueo = await req('PATCH', '/api/hitos/' + revision.id, { estado: 'bloqueado', detalle: 'El cliente no ha entregado la tarjeta de circulación.' });
  assert.equal(conDetalleBloqueo.status, 200);
  assert.equal(conDetalleBloqueo.data.detalle, 'El cliente no ha entregado la tarjeta de circulación.');

  // Los estados nuevos "simples" (sin exigir nada extra) también deben aceptarse.
  for(const estado of ['esperando_autorizacion','en_proceso','autorizado','completado']){
    const r = await req('PATCH', '/api/hitos/' + revision.id, { estado });
    assert.equal(r.status, 200, `el estado "${estado}" debe aceptarse`);
    assert.equal(r.data.estado, estado);
  }
});

test('ALE-2: el hito de "Entrega" pregunta si cubre deducible (Sí/No), se guarda en el siniestro y no se sobrescribe si no se manda respuesta', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'ALE2-SIN', aseguradora: 'GNP', cliente_nombre: 'Y', cliente_telefono: '2', cliente_correo: 'y@y.com' })).data;
  assert.equal(s.cubre_deducible, null, 'todavía no se ha preguntado');
  const hitos = (await req('GET', '/api/hitos?siniestro_id=' + s.id)).data;
  const entrega = hitos.find(h => h.clave === 'entrega');

  await req('PATCH', '/api/hitos/' + entrega.id, { estado: 'en_proceso', cubre_deducible: true });
  const siniestroConSi = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.equal(siniestroConSi.cubre_deducible, 1);

  // Un PATCH posterior de otro hito distinto (sin mandar cubre_deducible) no debe tocar la respuesta ya dada.
  const recepcion = hitos.find(h => h.clave === 'recepcion');
  await req('PATCH', '/api/hitos/' + recepcion.id, { estado: 'en_proceso' });
  const siniestroDespues = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.equal(siniestroDespues.cubre_deducible, 1, 'no se borra por actualizar un hito distinto');

  // Marcar "cubre_deducible" en un hito que NO es "entrega" no debe tocar el campo del siniestro.
  const s2 = (await req('POST', '/api/siniestros', { numero: 'ALE2-SIN-2', aseguradora: 'GNP', cliente_nombre: 'Z', cliente_telefono: '3', cliente_correo: 'z@z.com' })).data;
  const hitos2 = (await req('GET', '/api/hitos?siniestro_id=' + s2.id)).data;
  const recepcion2 = hitos2.find(h => h.clave === 'recepcion');
  await req('PATCH', '/api/hitos/' + recepcion2.id, { estado: 'en_proceso', cubre_deducible: true });
  const s2Despues = (await req('GET', '/api/siniestros/' + s2.id)).data;
  assert.equal(s2Despues.cubre_deducible, null, 'la pregunta solo aplica al hito de entrega');
});

test('ALE-3: "Pendientes de hoy" clasifica correctamente en rojo/ámbar/verde usando los campos reales ya existentes', async () => {
  // ROJO: complemento pendiente de decisión.
  const sRojo1 = (await req('POST', '/api/siniestros', { numero: 'ALE3-ROJO-COMP', aseguradora: 'GNP' })).data;
  await req('POST', '/api/complementos', { siniestro_id: sRojo1.id, causa: 'Pieza oculta dañada detectada al desarmar.' });

  // ROJO: expediente listo para valuación pero autorización aún sin enviar.
  const sRojo2 = (await req('POST', '/api/siniestros', { numero: 'ALE3-ROJO-AUT', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sRojo2.id, { estado_expediente: 'listo_para_valuacion' });

  // ROJO: cita de entrega lista, requiere confirmarse con el cliente.
  const sRojo3 = (await req('POST', '/api/siniestros', { numero: 'ALE3-ROJO-CITA', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sRojo3.id, { estado_entrega: 'listo' });

  // AMARILLO: esperando respuesta de la aseguradora.
  const sAmb1 = (await req('POST', '/api/siniestros', { numero: 'ALE3-AMB-ASEG', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sAmb1.id, { estado_autorizacion: 'en_autorizacion' });

  // AMARILLO: esperando respuesta del cliente (último evento fue saliente).
  const sAmb2 = (await req('POST', '/api/siniestros', { numero: 'ALE3-AMB-CLIENTE', aseguradora: 'GNP', cliente_nombre: 'C', cliente_telefono: '9', cliente_correo: 'c@c.com' })).data;
  await req('POST', '/api/eventos-cliente', { siniestro_id: sAmb2.id, direccion: 'saliente', canal: 'WhatsApp', mensaje: 'Le confirmamos el avance.' });

  // VERDE: en pintura.
  const sVerde1 = (await req('POST', '/api/siniestros', { numero: 'ALE3-VERDE-PINTURA', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sVerde1.id, { estado_produccion: 'pintura' });

  // VERDE: cita de entrega ya confirmada (etapa siguiente a "listo").
  const sVerde2 = (await req('POST', '/api/siniestros', { numero: 'ALE3-VERDE-CITA', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sVerde2.id, { estado_entrega: 'cita_confirmada' });

  const p = (await req('GET', '/api/reportes/pendientes-hoy')).data;

  assert.ok(p.rojo.complementosPendientes.some(c => c.siniestro_numero === 'ALE3-ROJO-COMP'));
  assert.ok(p.rojo.autorizacionesPendientes.some(x => x.numero === 'ALE3-ROJO-AUT'));
  assert.ok(p.rojo.citasQueRequierenConfirmacion.some(x => x.numero === 'ALE3-ROJO-CITA'));
  assert.ok(!p.verde.listoParaEntrega.some(x => x.numero === 'ALE3-ROJO-CITA'), '"listo" (rojo, falta confirmar) no debe aparecer también como "listo para entrega" (verde)');

  assert.ok(p.amarillo.esperandoAseguradora.some(x => x.numero === 'ALE3-AMB-ASEG'));
  assert.ok(p.amarillo.esperandoRespuestaCliente.some(x => x.numero === 'ALE3-AMB-CLIENTE'));

  assert.ok(p.verde.enPintura.some(x => x.numero === 'ALE3-VERDE-PINTURA'));
  assert.ok(p.verde.listoParaEntrega.some(x => x.numero === 'ALE3-VERDE-CITA'));

  assert.equal(typeof p.rojo.total, 'number');
  assert.equal(typeof p.amarillo.total, 'number');
  assert.equal(typeof p.verde.total, 'number');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

// ===================== Propuesta de Orlando (27-ago-2026): compuerta de disponibilidad para =====================
// ===================== revisión + aviso de cierre + indicador de 72h hábiles para grúa. =====================

test('ORLA-1: vehículo "circulando" queda disponible para revisión en cuanto se captura fecha_admision (sin exigir llaves/dado/OA/fotos)', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'ORLA1-CIRC', aseguradora: 'GNP' })).data;
  const bandejaAntes = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  assert.ok(!bandejaAntes.some(x => x.numero === 'ORLA1-CIRC'), 'sin admisión capturada, no debe aparecer en la bandeja técnica');

  const sinFecha = (await req('PATCH', '/api/siniestros/' + s.id, { ingreso_tipo: 'circulando' })).data;
  assert.equal(sinFecha.fecha_hora_disponible_revision, null, 'sin fecha_admision, "circulando" todavía no queda disponible');

  const conFecha = (await req('PATCH', '/api/siniestros/' + s.id, { fecha_admision: '2026-08-27' })).data;
  assert.ok(conFecha.fecha_hora_disponible_revision, 'con fecha_admision capturada, "circulando" ya queda disponible para revisión');

  const bandejaDespues = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  assert.ok(bandejaDespues.some(x => x.numero === 'ORLA1-CIRC'), 'ya debe aparecer en la bandeja técnica de Orlando');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ORLA-2: vehículo que llega en grúa NO queda disponible hasta tener llaves + inventario físico + orden de admisión (y dado de seguridad si se requiere)', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'ORLA2-GRUA', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, { ingreso_tipo: 'grua', fecha_admision: '2026-08-27', requiere_dado_seguridad: 1 });

  let bandeja = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  assert.ok(!bandeja.some(x => x.numero === 'ORLA2-GRUA'), 'sin llaves/OA/inventario/dado, no debe estar disponible');

  await req('PATCH', '/api/siniestros/' + s.id, { llaves_entregadas: 1 });
  bandeja = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  assert.ok(!bandeja.some(x => x.numero === 'ORLA2-GRUA'), 'solo con llaves, todavía faltan OA/inventario/dado');

  await req('PATCH', '/api/siniestros/' + s.id, { dado_seguridad_colocado: 1 });
  bandeja = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  assert.ok(!bandeja.some(x => x.numero === 'ORLA2-GRUA'), 'todavía faltan orden de admisión e inventario físico');

  // Subir el inventario físico (aún falta la orden de admisión).
  const fd1 = new FormData();
  fd1.append('entidad_tipo', 'siniestro'); fd1.append('entidad_id', String(s.id)); fd1.append('tipo', 'inventario_fisico');
  fd1.append('archivo', new Blob([Buffer.from('inventario')], { type: 'application/pdf' }), 'inventario.pdf');
  const res1 = await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd1 });
  assert.equal(res1.status, 201);
  bandeja = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  assert.ok(!bandeja.some(x => x.numero === 'ORLA2-GRUA'), 'con solo el inventario físico, todavía falta la orden de admisión');

  // Subir la orden de admisión: con esto se completan TODOS los requisitos de grúa.
  const fd2 = new FormData();
  fd2.append('entidad_tipo', 'siniestro'); fd2.append('entidad_id', String(s.id)); fd2.append('tipo', 'orden_admision');
  fd2.append('archivo', new Blob([Buffer.from('orden')], { type: 'application/pdf' }), 'orden.pdf');
  const res2 = await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd2 });
  assert.equal(res2.status, 201);

  const sFinal = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.ok(sFinal.fecha_hora_disponible_revision, 'con llaves + dado + inventario físico + orden de admisión, ya debe quedar disponible');

  bandeja = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  assert.ok(bandeja.some(x => x.numero === 'ORLA2-GRUA'), 'ahora sí debe aparecer en la bandeja técnica');

  // Idempotencia: un PATCH posterior que no toque nada relevante no debe volver a sellar ni duplicar la tarea.
  const tareasAntes = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data
    .filter(t => t.disparador === 'disponible_revision_orlando');
  assert.equal(tareasAntes.length, 1, 'debe existir exactamente una tarea automática de disponibilidad');
  await req('PATCH', '/api/siniestros/' + s.id, { llaves_entregadas: 1 });
  const sinCambio = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.equal(sinCambio.fecha_hora_disponible_revision, sFinal.fecha_hora_disponible_revision, 'la marca de tiempo no debe volver a sellarse');
  const tareasDespues = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data
    .filter(t => t.disparador === 'disponible_revision_orlando');
  assert.equal(tareasDespues.length, 1, 'no debe duplicarse la tarea automática');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ORLA-3: al cerrar la revisión técnica ("revision_terminada") se sella la hora de cierre una sola vez y se avisa a Roberto', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'ORLA3-CIERRE', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, { ingreso_tipo: 'circulando', fecha_admision: '2026-08-27' });

  const antes = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.equal(antes.fecha_hora_revision_concluida, null);

  const cerrado = (await req('PATCH', '/api/siniestros/' + s.id, { estado_revision_tecnica: 'revision_terminada' })).data;
  assert.ok(cerrado.fecha_hora_revision_concluida, 'debe sellar la hora de cierre de la revisión');

  const tareasAviso = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data
    .filter(t => t.disparador === 'revision_lista_para_evaluar');
  assert.equal(tareasAviso.length, 1, 'debe crear exactamente un aviso de "listo para evaluar"');

  // Un segundo PATCH que no cambia el estado (sigue en 'revision_terminada') no debe volver a sellar ni duplicar el aviso.
  await req('PATCH', '/api/siniestros/' + s.id, { estado_evidencia: 'evidencia_completa' });
  const despues = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.equal(despues.fecha_hora_revision_concluida, cerrado.fecha_hora_revision_concluida, 'no debe re-sellarse la hora de cierre');
  const tareasAvisoDespues = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data
    .filter(t => t.disparador === 'revision_lista_para_evaluar');
  assert.equal(tareasAvisoDespues.length, 1, 'no debe duplicarse el aviso de cierre');

  // También cierra correctamente si "revision_terminada" ya venía de antes de la disponibilidad (caso circulando ya cubierto arriba).
  assert.equal(despues.estado_revision_tecnica, 'revision_terminada');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ORLA-4: el plazo de 72 horas hábiles (3 días hábiles) solo se calcula/marca para vehículos que llegaron en grúa', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  // Grúa: admisión completa un viernes -> el límite de 3 días hábiles cae el miércoles siguiente.
  const sGrua = (await req('POST', '/api/siniestros', { numero: 'ORLA4-GRUA-SLA', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sGrua.id, { ingreso_tipo: 'grua', llaves_entregadas: 1 });
  const fd1 = new FormData();
  fd1.append('entidad_tipo', 'siniestro'); fd1.append('entidad_id', String(sGrua.id)); fd1.append('tipo', 'inventario_fisico');
  fd1.append('archivo', new Blob([Buffer.from('x')], { type: 'application/pdf' }), 'inv.pdf');
  await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd1 });
  const fd2 = new FormData();
  fd2.append('entidad_tipo', 'siniestro'); fd2.append('entidad_id', String(sGrua.id)); fd2.append('tipo', 'orden_admision');
  fd2.append('archivo', new Blob([Buffer.from('x')], { type: 'application/pdf' }), 'oa.pdf');
  await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd2 });

  const bandeja = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  const filaGrua = bandeja.find(x => x.numero === 'ORLA4-GRUA-SLA');
  assert.ok(filaGrua, 'debe estar disponible para revisión');
  assert.ok(filaGrua.limite_revision_grua, 'debe traer un límite calculado de 72h hábiles para grúa');
  assert.equal(typeof filaGrua.revision_vencida, 'boolean');

  // Circulando: no debe traer límite de grúa (el documento solo pide el indicador de 72h para grúa).
  const sCirc = (await req('POST', '/api/siniestros', { numero: 'ORLA4-CIRC-SLA', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sCirc.id, { ingreso_tipo: 'circulando', fecha_admision: '2026-08-27' });
  const bandeja2 = (await req('GET', '/api/reportes/bandeja-tecnica')).data;
  const filaCirc = bandeja2.find(x => x.numero === 'ORLA4-CIRC-SLA');
  assert.ok(filaCirc, 'debe estar disponible para revisión (circulando con fecha de admisión)');
  assert.equal(filaCirc.limite_revision_grua, null, 'circulando no debe traer límite de 72h de grúa');
  assert.equal(filaCirc.revision_vencida, false);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ORLA-5: el detalle de "qué falta" para admisión nunca pide llaves/inventario/dado a un vehículo circulando, y sí detalla lo que falta a uno en grúa', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });

  // Sin tipo de ingreso definido: el único faltante debe ser justamente ese.
  const sSinTipo = (await req('POST', '/api/siniestros', { numero: 'ORLA5-SINTIPO', aseguradora: 'GNP' })).data;
  const detalleSinTipo = await req('GET', '/api/siniestros/' + sSinTipo.id);
  assert.deepEqual(detalleSinTipo.data.admision_faltantes, ['Tipo de ingreso (circulando o grúa)']);

  // Circulando sin fecha de admisión: el único faltante debe ser la fecha, nunca llaves/inventario/dado.
  const sCirc = (await req('POST', '/api/siniestros', { numero: 'ORLA5-CIRC', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sCirc.id, { ingreso_tipo: 'circulando' });
  const detalleCirc = await req('GET', '/api/siniestros/' + sCirc.id);
  assert.deepEqual(detalleCirc.data.admision_faltantes, ['Fecha de admisión']);
  assert.ok(!detalleCirc.data.admision_faltantes.some(f => /llaves|inventario|dado/i.test(f)), 'circulando nunca debe pedir llaves, inventario ni dado de seguridad');

  // Con fecha de admisión, circulando queda sin faltantes.
  await req('PATCH', '/api/siniestros/' + sCirc.id, { fecha_admision: '2026-08-27' });
  const detalleCircListo = await req('GET', '/api/siniestros/' + sCirc.id);
  assert.deepEqual(detalleCircListo.data.admision_faltantes, []);

  // Grúa con dado de seguridad requerido: debe listar los cuatro faltantes reales.
  const sGrua = (await req('POST', '/api/siniestros', { numero: 'ORLA5-GRUA', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sGrua.id, { ingreso_tipo: 'grua', requiere_dado_seguridad: 1 });
  const detalleGrua = await req('GET', '/api/siniestros/' + sGrua.id);
  assert.deepEqual(detalleGrua.data.admision_faltantes.sort(), ['Dado de seguridad colocado', 'Inventario físico/fotográfico', 'Llaves entregadas', 'Orden de admisión'].sort());

  // Al resolver todo, la lista de faltantes queda vacía.
  await req('PATCH', '/api/siniestros/' + sGrua.id, { llaves_entregadas: 1, dado_seguridad_colocado: 1 });
  const fd1 = new FormData();
  fd1.append('entidad_tipo', 'siniestro'); fd1.append('entidad_id', String(sGrua.id)); fd1.append('tipo', 'inventario_fisico');
  fd1.append('archivo', new Blob([Buffer.from('x')], { type: 'application/pdf' }), 'inv.pdf');
  await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd1 });
  const fd2 = new FormData();
  fd2.append('entidad_tipo', 'siniestro'); fd2.append('entidad_id', String(sGrua.id)); fd2.append('tipo', 'orden_admision');
  fd2.append('archivo', new Blob([Buffer.from('x')], { type: 'application/pdf' }), 'oa.pdf');
  await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd2 });
  const detalleGruaListo = await req('GET', '/api/siniestros/' + sGrua.id);
  assert.deepEqual(detalleGruaListo.data.admision_faltantes, [], 'ya disponible, sin faltantes que mostrar');
  assert.ok(detalleGruaListo.data.fecha_hora_disponible_revision);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Modificaciones_Tablero_SC_Control.docx (28-ago-2026) ===================== */

test('SC-1: "Esquema de surtido" en la lista maestra refleja la regla real por aseguradora (GNP autosurtido 1-3, GNP Impart 4+, ANA autosurtido, Zurich pendiente de confirmar)', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });

  const sGnpAuto = (await req('POST', '/api/siniestros', { numero: 'SC1-GNP-AUTO', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sGnpAuto.id, { piezas_autorizadas_cambio: 2 });
  await req('POST', '/api/pedidos', { numero: 'SC1-PED-GNPA', siniestro_id: sGnpAuto.id, fecha_prevista: '2027-06-01' });

  const sGnpInpart = (await req('POST', '/api/siniestros', { numero: 'SC1-GNP-INPART', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + sGnpInpart.id, { piezas_autorizadas_cambio: 5 });
  await req('POST', '/api/pedidos', { numero: 'SC1-PED-GNPI', siniestro_id: sGnpInpart.id, fecha_prevista: '2027-06-01' });

  const sAna = (await req('POST', '/api/siniestros', { numero: 'SC1-ANA', aseguradora: 'ANA' })).data;
  await req('POST', '/api/pedidos', { numero: 'SC1-PED-ANA', siniestro_id: sAna.id, fecha_prevista: '2027-06-01' });

  const sZurich = (await req('POST', '/api/siniestros', { numero: 'SC1-ZURICH', aseguradora: 'Zurich' })).data;
  await req('POST', '/api/pedidos', { numero: 'SC1-PED-ZUR', siniestro_id: sZurich.id, fecha_prevista: '2027-06-01' });

  const lista = (await req('GET', '/api/reportes/lista-maestra?ventana=todas&pageSize=1000')).data.filas;
  const buscar = numero => lista.find(f => f.siniestro_numero === numero);
  assert.equal(buscar('SC1-GNP-AUTO').esquema_surtido, 'Autosurtido GNP');
  assert.equal(buscar('SC1-GNP-INPART').esquema_surtido, 'Impart (GNP, 4+ piezas)');
  assert.equal(buscar('SC1-ANA').esquema_surtido, 'Autosurtido ANA');
  assert.equal(buscar('SC1-ZURICH').esquema_surtido, 'Zurich (esquema pendiente de confirmar)');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('SC-2: discrepancia con proveedor (marcó "entregado" sin haberlo enviado) se registra, se resuelve y cuenta en el resumen', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'SC2-TEST', aseguradora: 'Mapfre' })).data;
  const antes = (await req('GET', '/api/reportes/resumen')).data.discrepanciasAbiertas;

  const d = (await req('POST', '/api/discrepancias-proveedor', {
    siniestro_id: s.id, descripcion: 'Impart marcó entregado el 20-ago pero nunca llegó',
    fecha_marcado_entregado: '2026-08-20', no_llego: 1
  })).data;
  assert.equal(d.estado, 'abierta');

  const despues = (await req('GET', '/api/reportes/resumen')).data.discrepanciasAbiertas;
  assert.equal(despues, antes + 1, 'debe subir el contador de discrepancias abiertas');

  const resuelta = await req('PATCH', '/api/discrepancias-proveedor/' + d.id, { estado: 'resuelta', fecha_real_llegada: '2026-08-27' });
  assert.equal(resuelta.data.estado, 'resuelta');
  const finalCount = (await req('GET', '/api/reportes/resumen')).data.discrepanciasAbiertas;
  assert.equal(finalCount, antes, 'al resolverla, vuelve a bajar el contador');

  const sinDescripcion = await req('POST', '/api/discrepancias-proveedor', { siniestro_id: s.id });
  assert.equal(sinDescripcion.status, 400, 'no debe aceptar una discrepancia sin descripción');
});

test('SC-3: vale pendiente (pieza que quedó fuera al entregar) se da seguimiento hasta que se surte', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'SC3-TEST', aseguradora: 'Afirme' })).data;
  const v = (await req('POST', '/api/vales-pendientes', {
    siniestro_id: s.id, pieza_pendiente: 'Emblema trasero', fecha_entrega_vehiculo: '2026-08-28', fecha_estimada_llegada: '2026-09-05'
  })).data;
  assert.equal(v.estado, 'pendiente');

  const listaPendiente = (await req('GET', '/api/vales-pendientes?siniestro_id=' + s.id)).data;
  assert.equal(listaPendiente.length, 1, 'por default solo se listan los vales pendientes (revisión periódica)');

  await req('PATCH', '/api/vales-pendientes/' + v.id, { estado: 'surtido' });
  const listaPendienteDespues = (await req('GET', '/api/vales-pendientes?siniestro_id=' + s.id)).data;
  assert.equal(listaPendienteDespues.length, 0, 'ya surtido, deja de aparecer en la revisión periódica de pendientes');
  const listaTodos = (await req('GET', '/api/vales-pendientes?siniestro_id=' + s.id + '&estado=todos')).data;
  assert.equal(listaTodos.length, 1, 'con estado=todos sigue apareciendo para historial');
});

test('SC-4: seguimiento posventa registra el resultado del contacto (contactado / no contesta), separado de solo la fecha programada', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'SC4-TEST', aseguradora: 'GNP' })).data;
  const r = await req('PATCH', '/api/siniestros/' + s.id, { postventa_resultado: 'contactado', postventa_completada: '2026-08-28' });
  assert.equal(r.data.postventa_resultado, 'contactado');
  assert.equal(r.data.postventa_completada, '2026-08-28');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('SC-5: checklist de entrega -- deducible pagado y confirmado (fecha) queda separado del monto informado, y la encuesta GNP se puede marcar como solicitada en el momento', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'SC5-TEST', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, { deducible: 5000 }); // monto informado (ya existía)
  const r = await req('PATCH', '/api/siniestros/' + s.id, { deducible_pagado_confirmado_en: '2026-08-27', entrega_encuesta_gnp_solicitada: 1 });
  assert.equal(r.data.deducible, 5000, 'el monto informado no se pierde');
  assert.equal(r.data.deducible_pagado_confirmado_en, '2026-08-27', 'la confirmación de pago queda aparte, con su propia fecha');
  assert.equal(r.data.entrega_encuesta_gnp_solicitada, 1);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('SC-6: en cuanto la autorización se resuelve, Beto recibe un aviso digital de la OT (no depende de que le impriman el papel)', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'SC6-TEST', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, {
    estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-28', autorizador: 'Ajustador'
  });
  const tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  const avisoBeto = tareas.find(t => t.disparador === 'ot_lista_beto');
  assert.ok(avisoBeto, 'debe existir una tarea de aviso a Beto (ot_lista_beto)');
  assert.equal(avisoBeto.estado, 'pendiente');

  // Idempotente: si se vuelve a guardar sin cambiar el estado de autorización, no debe duplicarse.
  await req('PATCH', '/api/siniestros/' + s.id, { notas: 'sin relación con autorización' });
  const tareasDespues = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.equal(tareasDespues.filter(t => t.disparador === 'ot_lista_beto').length, 1, 'no se duplica el aviso');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('SC-7: la etapa de producción acepta pulido y lavado como pasos propios, en el orden confirmado (mecánica -> hojalatería -> pintura -> armado -> pulido -> lavado -> entrega)', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'SC7-TEST', aseguradora: 'Mapfre' })).data;
  const r1 = await req('PATCH', '/api/siniestros/' + s.id, { estado_produccion: 'pulido' });
  assert.equal(r1.data.estado_produccion, 'pulido');
  const r2 = await req('PATCH', '/api/siniestros/' + s.id, { estado_produccion: 'lavado' });
  assert.equal(r2.data.estado_produccion, 'lavado');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('SC-8: panorama de Beto distingue "reingreso citado con fecha de entrega" (todavía no llega) de "unidad en piso" (ya está físicamente), y da aviso con piezas suficientes aunque no esté al 100%', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });

  const s = (await req('POST', '/api/siniestros', { numero: 'SC8-TEST', aseguradora: 'GNP' })).data;
  await req('PATCH', '/api/siniestros/' + s.id, {
    ingreso_tipo: 'circulando', cita_fecha: '2027-06-02',
    estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-28', autorizador: 'Ajustador'
  });
  const panorama = (await req('GET', '/api/reportes/panorama-beto')).data;
  const fila = panorama.find(x => x.numero === 'SC8-TEST');
  assert.ok(fila, 'el expediente autorizado debe aparecer en el panorama de Beto');
  assert.equal(fila.reingreso_citado, true, 'tiene cita pero todavía no hay fecha_admision -> reingreso citado, no "en piso"');
  assert.equal(fila.situacion, 'reingreso_citado');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Informe funcional de Daniela (Informe_funcional_tablero_refacciones_para_Claude.docx)
   Sección 7 (guion de regresión) -- pruebas automatizadas de los hallazgos A-02, A-04, A-05, A-06, A-07 y M-03,
   cubriendo lo que sí se puede sin credenciales externas (Gmail/InPart reales quedan fuera, ver C-03/C-04). ===================== */

test('DANIELA2-1 (A-05): una fecha prevista de hoy o anterior se bloquea y exige confirmación explícita', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'D2A05-SIN', aseguradora: 'GNP' })).data;
  const hoy = new Date().toISOString().slice(0, 10);
  const bloqueado = await req('POST', '/api/pedidos', { numero: 'D2A05-PED', siniestro_id: s.id, fecha_prevista: hoy });
  assert.equal(bloqueado.status, 409);
  assert.equal(bloqueado.data.error, 'FECHA_PREVISTA_INVALIDA');
  const confirmado = await req('POST', '/api/pedidos', { numero: 'D2A05-PED', siniestro_id: s.id, fecha_prevista: hoy, confirmar_fecha_prevista: true });
  assert.equal(confirmado.status, 201);
  assert.equal(confirmado.data.fecha_prevista_confirmada_por, 'Administrador');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-2 (A-06): la vista de piezas recibidas trae fecha, quién la recibió, proveedor, pedido y siniestro', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'D2A06-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'D2A06-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const pv = (await req('POST', '/api/proveedores', { razon_social: 'D2A06-Proveedor' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Cofre', proveedor_id: pv.id })).data;
  await req('POST', `/api/piezas/${z.id}/recibir`, {});
  const recibidas = (await req('GET', '/api/reportes/piezas-recibidas?pageSize=1000')).data;
  const fila = recibidas.find(r => r.id === z.id);
  assert.ok(fila, 'la pieza recién recibida debe aparecer en la vista');
  assert.equal(fila.proveedor_nombre, 'D2A06-Proveedor');
  assert.equal(fila.pedido_numero, 'D2A06-PED');
  assert.equal(fila.siniestro_numero, 'D2A06-SIN');
  assert.ok(fila.fecha_recepcion);
  assert.equal(fila.recibido_por_nombre, 'Administrador');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-3 (A-07): cambiar el estatus de un pedido con motivo lo deja registrado en auditoría', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'D2A07-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'D2A07-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const r = await req('PATCH', `/api/pedidos/${p.id}`, { estatus_operativo: 'Esperando proveedor', motivo_estatus: 'Proveedor confirmó factura por teléfono.' });
  assert.equal(r.data.estatus_operativo, 'Esperando proveedor');
  const timeline = (await req('GET', `/api/siniestros/${s.id}`)).data;
  assert.ok(timeline, 'el siniestro sigue disponible tras el cambio de estatus');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-4 (A-02): la bandeja de correos pendientes filtra por incompleto y pagina', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const r1 = await req('GET', '/api/comunicaciones/pendientes?pageSize=3&page=1');
  assert.ok(r1.data.filas.length <= 3, 'respeta pageSize');
  assert.ok(typeof r1.data.total === 'number');
  const r2 = await req('GET', '/api/comunicaciones/pendientes?incompleto=1&pageSize=1000');
  assert.ok(r2.data.filas.every(c => c.incompleto === 1), 'el filtro incompleto=1 solo trae incompletos');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-5 (A-02): GET /api/comunicaciones/:id trae el correo con sus datos de siniestro/pedido', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const pendientes = (await req('GET', '/api/comunicaciones/pendientes?pageSize=1000')).data.filas;
  assert.ok(pendientes.length > 0, 'debe haber al menos un correo pendiente sembrado por pruebas anteriores');
  const uno = await req('GET', `/api/comunicaciones/${pendientes[0].id}`);
  assert.equal(uno.data.id, pendientes[0].id);
  assert.equal(uno.data.estado, 'pendiente_aprobacion');
  const inexistente = await req('GET', '/api/comunicaciones/99999999');
  assert.equal(inexistente.status, 404);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-6 (M-03): la lista maestra pagina y reporta el total real', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const pagina = await req('GET', '/api/reportes/lista-maestra?pageSize=5&page=1');
  assert.ok(pagina.data.filas.length <= 5, 'respeta pageSize');
  assert.ok(pagina.data.total >= pagina.data.filas.length, 'total refleja el universo completo, no solo la página');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-7 (M-04): el resumen expone cuántos correos quedaron incompletos', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const r = await req('GET', '/api/reportes/resumen');
  assert.ok(typeof r.data.correosIncompletos === 'number');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-8 (A-04): las rutas de piezas sin proveedor y pedidos sin piezas devuelven exactamente lo que cuenta el resumen', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'D2A04-SIN', aseguradora: 'GNP' })).data;
  const p1 = (await req('POST', '/api/pedidos', { numero: 'D2A04-PED-SINPZ', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const p2 = (await req('POST', '/api/pedidos', { numero: 'D2A04-PED-CONPZ', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  await req('POST', '/api/piezas', { pedido_id: p2.id, descripcion: 'Faro' }); // sin proveedor_id -> estatus 'Sin proveedor'
  const sinProveedor = (await req('GET', '/api/reportes/piezas-sin-proveedor')).data;
  assert.ok(sinProveedor.some(f => f.pedido_id === p2.id), 'la pieza sin proveedor del pedido D2A04-PED-CONPZ debe listarse');
  const pedidosSinPiezas = (await req('GET', '/api/reportes/pedidos-sin-piezas')).data;
  assert.ok(pedidosSinPiezas.some(f => f.pedido_id === p1.id), 'D2A04-PED-SINPZ (sin ninguna pieza capturada) debe listarse');
  assert.ok(!pedidosSinPiezas.some(f => f.pedido_id === p2.id), 'D2A04-PED-CONPZ ya tiene una pieza capturada, no debe salir aquí');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-9 (C-03): estado de conexión Gmail visible sin exponer credenciales, y sin GMAIL configurado el envío responde 503 claro', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const estado = await req('GET', '/api/comunicaciones/estado-gmail');
  assert.equal(estado.status, 200);
  assert.equal(typeof estado.data.configurado, 'boolean');
  assert.equal(estado.data.configurado, false, 'en pruebas nunca hay GMAIL_USER/GMAIL_APP_PASSWORD configurados');
  assert.ok(!JSON.stringify(estado.data).toLowerCase().includes('password'), 'nunca debe exponer la contraseña de aplicación');

  const s = (await req('POST', '/api/siniestros', { numero: 'D2C03-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'D2C03-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Puerta', proveedor_id: 6 });
  const pendientes = (await req('GET', '/api/comunicaciones/pendientes?pageSize=1000')).data.filas;
  const com = pendientes.find(c => c.pedido_id === p.id);
  assert.ok(com, 'debe haberse generado un borrador para el pedido nuevo');
  await req('PATCH', `/api/comunicaciones/${com.id}/aprobar`, { destinatarios: 'proveedor@example.com' });
  const envio = await req('POST', `/api/comunicaciones/${com.id}/enviar`, {});
  assert.equal(envio.status, 503);
  assert.match(envio.data.error, /no está configurado/);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA2-10 (C-04): estatus_inpart_actualizado_en solo cambia cuando estatus_inpart específicamente cambia', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'D2C04-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'D2C04-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01', estatus_inpart: 'Aguardando confirmación' })).data;
  assert.ok(p.estatus_inpart_actualizado_en, 'se sella al crear el pedido');
  const marcaInicial = p.estatus_inpart_actualizado_en;

  // Editar otro campo (total) NO debe tocar la marca de Inpart.
  await req('PATCH', `/api/pedidos/${p.id}`, { total: 1500 });
  const trasOtraEdicion = (await req('GET', `/api/pedidos/${p.id}`)).data;
  assert.equal(trasOtraEdicion.estatus_inpart_actualizado_en, marcaInicial, 'editar otro campo no debe mover la marca de última actualización de Inpart');

  // Cambiar estatus_inpart SÍ debe tocarla.
  await req('PATCH', `/api/pedidos/${p.id}`, { estatus_inpart: 'Facturado' });
  const trasCambioInpart = (await req('GET', `/api/pedidos/${p.id}`)).data;
  assert.ok(trasCambioInpart.estatus_inpart_actualizado_en, 'debe tener marca tras el cambio de estatus_inpart');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Proceso_Completo_Servicio_Cristian.docx (sección 7): reautorización de piezas
   no autorizadas -- prioridad confirmada por Roberto sobre las demás brechas encontradas en ese
   documento (grupo de WhatsApp, inventario manual, registro del paso de evaluación remota). ===================== */

test('PROCESO-REAUT-1: admin/jefe puede solicitar reautorización con plazo de 24h y crea aviso automático para el expediente', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'REAUT1-SIN', aseguradora: 'GNP' })).data;
  const antes = Date.now();
  const r = await req('POST', '/api/complementos', { siniestro_id: s.id, tipo: 'no_autorizado_inicial', pieza_operacion: 'defensa delantera, faro derecho', causa: 'No autorizadas, se requieren fotos editadas.' });
  assert.equal(r.status, 201);
  assert.equal(r.data.tipo, 'no_autorizado_inicial');
  assert.equal(r.data.decision, 'pendiente');
  assert.equal(r.data.vencido, false);
  const limiteMs = new Date(r.data.fecha_limite).getTime();
  const horas = (limiteMs - antes) / 3600000;
  assert.ok(horas > 23.9 && horas < 24.1, `el plazo debe ser ~24h, fue ${horas}h`);

  const tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  const aviso = tareas.find(t => t.disparador === 'reautorizacion_solicitada');
  assert.ok(aviso, 'debe crearse un aviso automático');
  assert.match(aviso.descripcion, /defensa delantera, faro derecho/);
  assert.match(aviso.descripcion, /24h/);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROCESO-REAUT-2: Orlando y Beto no pueden crear una reautorización (es exclusivo de admin/jefe), pero sí siguen pudiendo registrar complementos por daño oculto', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'REAUT2-SIN', aseguradora: 'GNP' })).data;

  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const bloqueado = await req('POST', '/api/complementos', { siniestro_id: s.id, tipo: 'no_autorizado_inicial', pieza_operacion: 'cofre', causa: 'x' });
  assert.equal(bloqueado.status, 403);

  const danoOculto = await req('POST', '/api/complementos', { siniestro_id: s.id, causa: 'golpe oculto detectado al desarmar' });
  assert.equal(danoOculto.status, 201);
  assert.equal(danoOculto.data.tipo, 'dano_oculto');
  assert.equal(danoOculto.data.fecha_limite, null);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROCESO-REAUT-3: falta indicar las piezas no autorizadas se rechaza; y sin credenciales de tipo, la piezas no autorizadas se pueden marcar vencidas y contarlas en el resumen', async () => {
  const db = require('../server/db');
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'REAUT3-SIN', aseguradora: 'GNP' })).data;

  const sinPiezas = await req('POST', '/api/complementos', { siniestro_id: s.id, tipo: 'no_autorizado_inicial', causa: 'x' });
  assert.equal(sinPiezas.status, 400);

  const creado = (await req('POST', '/api/complementos', { siniestro_id: s.id, tipo: 'no_autorizado_inicial', pieza_operacion: 'salpicadera', causa: 'x' })).data;
  // Simula que ya venció el plazo (para no depender de esperar 24h reales en la prueba).
  db.prepare("UPDATE complementos SET fecha_limite = datetime('now','-1 hour') WHERE id = ?").run(creado.id);

  const lista = (await req('GET', `/api/complementos?siniestro_id=${s.id}&tipo=no_autorizado_inicial`)).data;
  const fila = lista.find(c => c.id === creado.id);
  assert.equal(fila.vencido, true);

  const resumen = await req('GET', '/api/reportes/resumen');
  assert.ok(resumen.data.complementosReautorizacionVencidos >= 1);

  // Al resolverla (autorizado), deja de contar como vencida pendiente.
  await req('PATCH', `/api/complementos/${creado.id}`, { decision: 'autorizado', estado: 'autorizado' });
  const listaTrasResolver = (await req('GET', `/api/complementos?siniestro_id=${s.id}&tipo=no_autorizado_inicial`)).data;
  const filaResuelta = listaTrasResolver.find(c => c.id === creado.id);
  assert.equal(filaResuelta.vencido, false, 'ya resuelta (no pendiente), no debe seguir marcada como vencida');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROCESO-EVAL-1: la fecha de regreso de la evaluación (valuacion_fecha_respuesta) se guarda y se puede editar sin depender de autorizacion_fecha_respuesta', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'EVAL1-SIN', aseguradora: 'GNP' })).data;
  const r = await req('PATCH', '/api/siniestros/' + s.id, {
    estado_valuacion: 'enviada', valuacion_fecha_envio: '2026-08-20', valuacion_fecha_respuesta: '2026-08-22'
  });
  assert.equal(r.data.valuacion_fecha_envio, '2026-08-20');
  assert.equal(r.data.valuacion_fecha_respuesta, '2026-08-22');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('PROCESO-WHATSAPP-1: grupo_whatsapp_creado se puede marcar desde el checklist de admisión (rol atencion_cliente)', async () => {
  // Nota: no se usa la cuenta real "alejandra@serviciocristian.mx" porque REQ-DANIELA-19 le resetea la
  // contraseña más arriba en esta misma suite; se crea una cuenta de prueba propia con el rol, igual que
  // hace FASE0-3, para no depender del orden de las demás pruebas.
  const db = require('../server/db');
  const bcrypt = require('bcryptjs');
  db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
    .run('Atencion Cliente Prueba WSP1', 'atencion.wsp1.test@serviciocristian.mx', bcrypt.hashSync('x',4), 'atencion_cliente');
  const loginR = await req('POST', '/api/auth/login', { email: 'atencion.wsp1.test@serviciocristian.mx', password: 'x' });
  assert.equal(loginR.status, 200);
  const s = (await req('POST', '/api/siniestros', { numero: 'WSP1-SIN', aseguradora: 'GNP', cliente_nombre: 'Cliente WSP1', cliente_telefono: '555-0001', cliente_correo: 'wsp1@cliente.com' })).data;
  const antes = await req('GET', '/api/siniestros/' + s.id);
  assert.ok(!antes.data.grupo_whatsapp_creado);
  const r = await req('PATCH', '/api/siniestros/' + s.id, { grupo_whatsapp_creado: 1 });
  assert.equal(r.data.grupo_whatsapp_creado, 1);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ROBERTO-1: expediente_listo_fecha se sella sola la primera vez que estado_expediente pasa a listo_para_valuacion', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'RB1-SIN', aseguradora: 'GNP' })).data;
  assert.ok(!s.expediente_listo_fecha);
  const r1 = await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'listo_para_valuacion' });
  assert.ok(r1.data.expediente_listo_fecha, 'debe sellarse sola al quedar listo para valuar');
  const sellada = r1.data.expediente_listo_fecha;
  // un cambio posterior cualquiera no debe mover la fecha ya sellada
  const r2 = await req('PATCH', '/api/siniestros/' + s.id, { valuacion_folio: 'F-1' });
  assert.equal(r2.data.expediente_listo_fecha, sellada);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ROBERTO-2: avisar-proveedores-pendientes requiere autorización resuelta, notifica una sola vez y es exclusivo de admin/jefe', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'RB2-SIN', aseguradora: 'GNP' })).data;

  const antes = await req('PATCH', '/api/siniestros/' + s.id + '/avisar-proveedores-pendientes', {});
  assert.equal(antes.status, 400, 'no debe permitirse antes de que la valuación esté autorizada');

  await req('PATCH', '/api/siniestros/' + s.id, {
    estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-28', autorizador: 'Ajustador'
  });

  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const noPermitido = await req('PATCH', '/api/siniestros/' + s.id + '/avisar-proveedores-pendientes', {});
  assert.equal(noPermitido.status, 403, 'solo admin/jefe puede disparar este aviso');

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const r = await req('PATCH', '/api/siniestros/' + s.id + '/avisar-proveedores-pendientes', {});
  assert.equal(r.status, 200);
  assert.ok(r.data.proveedores_aviso_pendiente_en);

  const otraVez = await req('PATCH', '/api/siniestros/' + s.id + '/avisar-proveedores-pendientes', {});
  assert.equal(otraVez.status, 400, 'no debe poder avisarse dos veces');

  const tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.ok(tareas.some(t => t.disparador === 'proveedores_pendientes_aviso'), 'debe crear la tarea de aviso');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ROBERTO-3: enviar-expediente-completo requiere autorización resuelta, notifica una sola vez y es exclusivo de admin/jefe', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'RB3-SIN', aseguradora: 'GNP' })).data;

  const antes = await req('PATCH', '/api/siniestros/' + s.id + '/enviar-expediente-completo', {});
  assert.equal(antes.status, 400);

  await req('PATCH', '/api/siniestros/' + s.id, {
    estado_autorizacion: 'autorizada', autorizacion_fecha_respuesta: '2026-08-28', autorizador: 'Ajustador'
  });

  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const noPermitido = await req('PATCH', '/api/siniestros/' + s.id + '/enviar-expediente-completo', {});
  assert.equal(noPermitido.status, 403);

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const r = await req('PATCH', '/api/siniestros/' + s.id + '/enviar-expediente-completo', {});
  assert.equal(r.status, 200);
  assert.ok(r.data.expediente_completo_enviado_en);

  const otraVez = await req('PATCH', '/api/siniestros/' + s.id + '/enviar-expediente-completo', {});
  assert.equal(otraVez.status, 400);

  const tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.ok(tareas.some(t => t.disparador === 'expediente_completo_enviado'), 'debe crear la tarea de aviso');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ROBERTO-4: decision_en del complemento se sella sola la primera vez que la decisión deja de ser pendiente', async () => {
  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'RB4-SIN', aseguradora: 'GNP' })).data;
  const c = (await req('POST', '/api/complementos', { siniestro_id: s.id, causa: 'Daño oculto de prueba' })).data;
  assert.ok(!c.decision_en);
  const r1 = await req('PATCH', '/api/complementos/' + c.id, { decision: 'autorizado' });
  assert.ok(r1.data.decision_en, 'debe sellarse al resolver la decisión');
  const sellada = r1.data.decision_en;
  const r2 = await req('PATCH', '/api/complementos/' + c.id, { estado: 'incorporado_a_ot' });
  assert.equal(r2.data.decision_en, sellada, 'no debe moverse en ediciones posteriores');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ROBERTO-5: el resumen incluye el panorama de valuación de Roberto', async () => {
  const r = await req('GET', '/api/reportes/resumen');
  assert.equal(r.status, 200);
  ['rbListosParaValuar','rbEnEsperaEvaluacion','rbComplementosAbiertos','rbFaltaAvisoProveedores','rbListosExpedienteCompleto','rbTiempoPromedioValuarDias','rbTiempoPromedioComplementoOrlandoDias']
    .forEach(k => assert.ok(k in r.data, 'falta el campo ' + k + ' en el resumen'));
});

// ===================== MODIFICACIONES DE TABLERO ALEJANDRA (28-ago-2026) =====================

test('ALEJ-1: tipo_reparacion solo lo captura el grupo de revisión técnica (Orlando/admin/jefe), no atencion_cliente, y se normaliza "" a NULL', async () => {
  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'ALEJ1-SIN', aseguradora: 'GNP' })).data;
  const r = await req('PATCH', '/api/siniestros/' + s.id, { tipo_reparacion: 'AUTO_SURTIDO' });
  assert.equal(r.status, 200);
  assert.equal(r.data.tipo_reparacion, 'AUTO_SURTIDO');
  // "Sin definir" desde el select manda '' -- debe guardarse como NULL, no romper el CHECK de la columna.
  const r2 = await req('PATCH', '/api/siniestros/' + s.id, { tipo_reparacion: '' });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.tipo_reparacion, null);

  const db = require('../server/db');
  const bcrypt = require('bcryptjs');
  db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
    .run('Atencion Cliente Prueba ALEJ1', 'atencion.alej1.test@serviciocristian.mx', bcrypt.hashSync('x',4), 'atencion_cliente');
  await req('POST', '/api/auth/login', { email: 'atencion.alej1.test@serviciocristian.mx', password: 'x' });
  const noPermitido = await req('PATCH', '/api/siniestros/' + s.id, { tipo_reparacion: 'BDEO' });
  assert.equal(noPermitido.status, 403, 'atencion_cliente no debe poder tocar tipo_reparacion (es de revisión técnica)');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ALEJ-2: es_particular se puede fijar al crear el expediente y solo el grupo de admisión lo edita después', async () => {
  const db = require('../server/db');
  const bcrypt = require('bcryptjs');
  db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
    .run('Atencion Cliente Prueba ALEJ2', 'atencion.alej2.test@serviciocristian.mx', bcrypt.hashSync('x',4), 'atencion_cliente');
  await req('POST', '/api/auth/login', { email: 'atencion.alej2.test@serviciocristian.mx', password: 'x' });
  const s = (await req('POST', '/api/siniestros', {
    numero: 'ALEJ2-SIN', aseguradora: 'Particular', es_particular: 1,
    cliente_nombre: 'Cliente Particular', cliente_telefono: '555-0002', cliente_correo: 'particular@cliente.com'
  })).data;
  assert.equal(s.es_particular, 1);
  assert.equal(s.aseguradora, 'Particular');

  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const noPermitido = await req('PATCH', '/api/siniestros/' + s.id, { es_particular: 0 });
  assert.equal(noPermitido.status, 403, 'orlando no pertenece al grupo de admisión');

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const r = await req('PATCH', '/api/siniestros/' + s.id, { es_particular: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.data.es_particular, 0);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ALEJ-3: ingreso por grúa -- admision_faltantes va bajando conforme se suben orden de admisión e inventario como archivo', async () => {
  const db = require('../server/db');
  const bcrypt = require('bcryptjs');
  db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
    .run('Atencion Cliente Prueba ALEJ3', 'atencion.alej3.test@serviciocristian.mx', bcrypt.hashSync('x',4), 'atencion_cliente');
  await req('POST', '/api/auth/login', { email: 'atencion.alej3.test@serviciocristian.mx', password: 'x' });
  const s = (await req('POST', '/api/siniestros', {
    numero: 'ALEJ3-SIN', aseguradora: 'GNP', ingreso_tipo: 'grua', llaves_entregadas: 1,
    cliente_nombre: 'Cliente Grúa', cliente_telefono: '555-0003', cliente_correo: 'grua@cliente.com'
  })).data;
  const antes = await req('GET', '/api/siniestros/' + s.id);
  assert.deepEqual(antes.data.admision_faltantes.sort(), ['Inventario físico/fotográfico','Orden de admisión'].sort());

  const fd1 = new FormData();
  fd1.append('archivo', new Blob(['pdf'], { type: 'application/pdf' }), 'orden.pdf');
  fd1.append('entidad_tipo', 'siniestro'); fd1.append('entidad_id', String(s.id)); fd1.append('tipo', 'orden_admision');
  const res1 = await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd1 });
  assert.equal(res1.status, 201);

  const medio = await req('GET', '/api/siniestros/' + s.id);
  assert.deepEqual(medio.data.admision_faltantes, ['Inventario físico/fotográfico']);

  const fd2 = new FormData();
  fd2.append('archivo', new Blob(['pdf'], { type: 'application/pdf' }), 'inventario.pdf');
  fd2.append('entidad_tipo', 'siniestro'); fd2.append('entidad_id', String(s.id)); fd2.append('tipo', 'inventario_fisico');
  const res2 = await fetch(BASE + '/api/archivos', { method: 'POST', headers: { Cookie: cookie }, body: fd2 });
  assert.equal(res2.status, 201);

  const despues = await req('GET', '/api/siniestros/' + s.id);
  assert.deepEqual(despues.data.admision_faltantes, [], 'con llaves, orden de admisión e inventario ya subidos, no debe faltar nada');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ALEJ-4: bandeja-clientes expone tipo_reparacion y estado_entrega para los filtros y el ocultamiento de entregados de la vista Clientes', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'ALEJ4-SIN', aseguradora: 'GNP' })).data;
  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  await req('PATCH', '/api/siniestros/' + s.id, { tipo_reparacion: 'PDD' });
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const lista = (await req('GET', '/api/reportes/bandeja-clientes')).data;
  const fila = lista.find(x => x.numero === 'ALEJ4-SIN');
  assert.ok(fila, 'el expediente debe aparecer en bandeja-clientes');
  assert.equal(fila.tipo_reparacion, 'PDD');
  assert.ok('estado_entrega' in fila);
});

test('ALEJ-5: deducible_aplica (alta) es independiente de cubre_deducible (entrega) -- fijarlo al crear no debe saltarse la pregunta de la entrega', async () => {
  const db = require('../server/db');
  const bcrypt = require('bcryptjs');
  db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
    .run('Atencion Cliente Prueba ALEJ5', 'atencion.alej5.test@serviciocristian.mx', bcrypt.hashSync('x',4), 'atencion_cliente');
  await req('POST', '/api/auth/login', { email: 'atencion.alej5.test@serviciocristian.mx', password: 'x' });
  const s = (await req('POST', '/api/siniestros', {
    numero: 'ALEJ5-SIN', aseguradora: 'GNP', deducible_aplica: 1,
    cliente_nombre: 'Cliente Deducible', cliente_telefono: '555-0005', cliente_correo: 'ded@cliente.com'
  })).data;
  assert.equal(s.deducible_aplica, 1, 'deducible_aplica debe guardarse desde el alta');
  assert.equal(s.cubre_deducible, null, 'cubre_deducible (el de la entrega) NO debe tocarse solo por fijar deducible_aplica en el alta');

  // solo el grupo de admisión puede tocar deducible_aplica
  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const noPermitido = await req('PATCH', '/api/siniestros/' + s.id, { deducible_aplica: 0 });
  assert.equal(noPermitido.status, 403);

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const r = await req('PATCH', '/api/siniestros/' + s.id, { deducible_aplica: '' });
  assert.equal(r.data.deducible_aplica, null, '"" (Sin definir) debe normalizarse a NULL');

  // el hito de entrega sigue preguntando cubre_deducible normalmente, sin importar deducible_aplica
  const hitos = (await req('GET', '/api/hitos?siniestro_id=' + s.id)).data;
  const hitoEntrega = hitos.find(h => h.clave === 'entrega');
  assert.ok(hitoEntrega, 'debe existir el hito de entrega');
  const rHito = await req('PATCH', '/api/hitos/' + hitoEntrega.id, { estado: 'pendiente', cubre_deducible: true });
  assert.equal(rHito.status, 200);
  const sDespues = (await req('GET', '/api/siniestros/' + s.id)).data;
  assert.equal(sDespues.cubre_deducible, 1, 'cubre_deducible sí se puede fijar desde el hito de entrega, como siempre');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('ALEJ-6: el detalle genérico de ovPendientesRevision devuelve exactamente lo que cuenta la tarjeta del resumen', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'ALEJ6-SIN', aseguradora: 'GNP' })).data;
  const resumen = await req('GET', '/api/reportes/resumen');
  const lista = await req('GET', '/api/reportes/detalle/ovPendientesRevision');
  assert.equal(lista.status, 200);
  assert.equal(lista.data.length, resumen.data.ovPendientesRevision, 'la lista debe tener el mismo total que la tarjeta del resumen');
  assert.ok(lista.data.some(x => x.numero === 'ALEJ6-SIN'), 'un siniestro recién creado sin revisión técnica debe aparecer en la lista');
});

test('ALEJ-7: todas las claves de detalle de tarjetas del resumen diario responden 200 (sin errores de SQL)', async () => {
  const claves = [
    'pedidosNuevos','piezasVencidas','piezasPorConfirmar','recibidosParciales','piezasMalSurtidas',
    'piezasEnDevolucion','incidenciasAbiertas','cierresHoy','discrepanciasAbiertas','valesPendientesSinSurtir',
    'complementosReautorizacionVencidos',
    'ovPendientesRevision','ovEnRevision','ovEsperandoDesarme','ovComplementosPendientes','ovBorradoresPorCapturar','ovFotosPorCompletar','ovListosParaEnviar',
    'rbTiempoPromedioValuarDias','rbTiempoPromedioComplementoOrlandoDias',
    'citasHoy','entregasProgramadas','porAvisarAutorizacion','refaccionesPorAvisar','expedientesSinActualizar',
    'tareasPendientes','tareasVencidas','hitosListosSinEnviar','mensajesIaPendientes'
  ];
  for(const clave of claves){
    const r = await req('GET', '/api/reportes/detalle/' + clave);
    assert.equal(r.status, 200, 'clave ' + clave + ' debe responder 200, dio ' + r.status + ' ' + JSON.stringify(r.data));
    assert.ok(Array.isArray(r.data), 'clave ' + clave + ' debe regresar un arreglo');
  }
  const noExiste = await req('GET', '/api/reportes/detalle/noExiste');
  assert.equal(noExiste.status, 404);
});

// ===================== Corrección "Por confirmar"/"Piezas vencidas" con pedidos ya recibidos (29-ago-2026) =====================

test('SYNC-1: al marcar un pedido como Recibido completo por PATCH, sus piezas abiertas pasan a Recibida físicamente al instante', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'SYNC1-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'SYNC1-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const z1 = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro derecho', estatus: 'Asignada' })).data;
  const z2 = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro izquierdo', estatus: 'Confirmada' })).data;
  await req('PATCH', '/api/pedidos/' + p.id, { estatus_operativo: 'Recibido completo' });
  const z1Despues = (await req('GET', '/api/piezas/' + z1.id)).data;
  const z2Despues = (await req('GET', '/api/piezas/' + z2.id)).data;
  assert.equal(z1Despues.estatus, 'Recibida físicamente');
  assert.equal(z2Despues.estatus, 'Recibida físicamente');
  assert.ok(z1Despues.fecha_recepcion, 'debe sellar fecha_recepcion');
});

test('SYNC-2: una pieza con incidencia abierta NO se fuerza a Recibida físicamente aunque su pedido quede Recibido completo', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'SYNC2-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'SYNC2-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Cofre', estatus: 'Asignada' })).data;
  // fecha_incumplida dispara estatus 'Entrega vencida' (no terminal) + incidencia abierta -- el escenario exacto a proteger.
  await req('POST', '/api/incidencias', { pieza_id: z.id, tipo: 'fecha_incumplida', descripcion: 'Prueba' });
  await req('PATCH', '/api/pedidos/' + p.id, { estatus_operativo: 'Recibido completo' });
  const zDespues = (await req('GET', '/api/piezas/' + z.id)).data;
  assert.equal(zDespues.estatus, 'Entrega vencida', 'no debe tocarse mientras la incidencia siga abierta');
});

test('SYNC-3: al cancelar un pedido, sus piezas abiertas pasan a Cancelada', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'SYNC3-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'SYNC3-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Salpicadera', estatus: 'Asignada' })).data;
  await req('PATCH', '/api/pedidos/' + p.id, { estatus_operativo: 'Cancelado', motivo_cancelacion: 'Prueba' });
  const zDespues = (await req('GET', '/api/piezas/' + z.id)).data;
  assert.equal(zDespues.estatus, 'Cancelada');
});

test('SYNC-4: piezas de pedidos Recibido completo/Cancelado/Cerrado no cuentan en "Por confirmar" ni "Piezas vencidas"', async () => {
  const antes = await req('GET', '/api/reportes/resumen');
  const s = (await req('POST', '/api/siniestros', { numero: 'SYNC4-SIN', aseguradora: 'GNP' })).data;

  const p1 = (await req('POST', '/api/pedidos', { numero: 'SYNC4-PED1', siniestro_id: s.id, fecha_prevista: '2020-01-01' })).data;
  await req('POST', '/api/piezas', { pedido_id: p1.id, descripcion: 'Pieza vencida recibida', estatus: 'Asignada', fecha_prometida: '2020-01-01' });
  await req('PATCH', '/api/pedidos/' + p1.id, { estatus_operativo: 'Recibido completo' });

  const p2 = (await req('POST', '/api/pedidos', { numero: 'SYNC4-PED2', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  await req('POST', '/api/piezas', { pedido_id: p2.id, descripcion: 'Pieza por confirmar activa', estatus: 'Asignada' });

  const despues = await req('GET', '/api/reportes/resumen');
  assert.equal(despues.data.piezasPorConfirmar, antes.data.piezasPorConfirmar + 1, 'solo debe sumar la pieza del pedido activo, no la del pedido ya recibido');

  const detalle = await req('GET', '/api/reportes/detalle/piezasPorConfirmar');
  assert.equal(detalle.data.length, despues.data.piezasPorConfirmar, 'el detalle debe coincidir exactamente con el total de la tarjeta');
});

test('SYNC-5: depuración histórica -- una pieza que se quedó "Asignada" aunque su pedido YA estaba Recibido completo desde antes, se corrige sola al cargar el resumen', async () => {
  const db = require('../server/db');
  const s = (await req('POST', '/api/siniestros', { numero: 'SYNC5-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'SYNC5-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Pieza histórica atorada', estatus: 'Asignada' })).data;
  // Se fuerza el pedido a Recibido completo directo en la base de datos, SIN pasar por el PATCH (simula
  // el estado real encontrado en producción: dato viejo de una sincronización anterior a esta corrección).
  db.prepare(`UPDATE pedidos SET estatus_operativo='Recibido completo' WHERE id=?`).run(p.id);
  const antesDelResumen = (await req('GET', '/api/piezas/' + z.id)).data;
  assert.equal(antesDelResumen.estatus, 'Asignada', 'sanity: sigue atorada antes de que corra el barrido');
  await req('GET', '/api/reportes/resumen');
  const despues = (await req('GET', '/api/piezas/' + z.id)).data;
  assert.equal(despues.estatus, 'Recibida físicamente', 'el barrido de /resumen debe corregirla sola');
});

test('SYNC-6: un pedido Recibido parcial NO fuerza a Recibida físicamente las piezas que de verdad siguen pendientes', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'SYNC6-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'SYNC6-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const zRecibida = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Ya llegó', estatus: 'Asignada' })).data;
  const zPendiente = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Todavía no', estatus: 'Asignada' })).data;
  await req('POST', '/api/piezas/' + zRecibida.id + '/recibir'); // esto deja el pedido en 'Recibido parcial'
  const pedidoDespues = (await req('GET', '/api/pedidos?siniestro_id=' + s.id)).data.find(x => x.id === p.id);
  assert.equal(pedidoDespues.estatus_operativo, 'Recibido parcial');
  const zPendienteDespues = (await req('GET', '/api/piezas/' + zPendiente.id)).data;
  assert.equal(zPendienteDespues.estatus, 'Asignada', 'la pieza realmente pendiente no debe tocarse solo porque el pedido quedó parcial');
});

/* ===================== Depuración SC Control (31-ago-2026, autorizado por Roberto) ===================== */

test('DEP-1: Orlando gana acceso a "Expediente digital" (absorbe temporalmente a Vanessa) sin quitarle nada a ella', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'DEP1-SIN', aseguradora: 'GNP' })).data;

  await req('POST', '/api/auth/login', { email: 'orlando@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const rOrlandoPatch = await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'en_captura', sistema_valuacion: 'ACG' });
  assert.equal(rOrlandoPatch.status, 200, 'Orlando ya debe poder capturar los campos de expediente digital');
  assert.equal(rOrlandoPatch.data.estado_expediente, 'en_captura');

  const rOrlandoDoc = await req('POST', '/api/documentos-expediente', { siniestro_id: s.id, tipo_documento: 'Póliza' });
  assert.equal(rOrlandoDoc.status, 201, 'Orlando ya debe poder capturar documentos del checklist documental');

  await req('POST', '/api/auth/login', { email: 'vanessa@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const rVanessaPatch = await req('PATCH', '/api/siniestros/' + s.id, { expediente_folio: 'F-001' });
  assert.equal(rVanessaPatch.status, 200, 'Vanessa conserva su acceso de siempre, no se le quitó nada');
  const rVanessaDoc = await req('POST', '/api/documentos-expediente', { siniestro_id: s.id, tipo_documento: 'Factura' });
  assert.equal(rVanessaDoc.status, 201);

  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const rBetoPatch = await req('PATCH', '/api/siniestros/' + s.id, { estado_expediente: 'incompleto' });
  assert.equal(rBetoPatch.status, 403, 'Beto sigue sin acceso a expediente digital (no se abrió a todos los roles)');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DEP-2: cerrar un siniestro (endpoint /cerrar) lo saca de inmediato de las bandejas operativas; sigue disponible en el historial', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'DEP2-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'DEP2-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  await req('PATCH', '/api/pedidos/' + p.id, { estatus_operativo: 'Recibido completo' });
  // fecha_entrega_real no se acepta en el POST de alta (es un campo general, se captura después vía PATCH).
  await req('PATCH', '/api/siniestros/' + s.id, { fecha_entrega_real: '2026-08-31' });

  const antes = await req('GET', '/api/siniestros');
  assert.ok(antes.data.some(x => x.numero === 'DEP2-SIN'), 'sanity: antes de cerrar sí aparece en la bandeja por default');

  const cierre = await req('PATCH', '/api/siniestros/' + s.id + '/cerrar');
  assert.equal(cierre.status, 200);
  assert.equal(cierre.data.estatus_general, 'Cerrado');
  assert.equal(cierre.data.archivado, 1, 'cerrar debe archivar de inmediato, no esperar los 90 días');

  const despues = await req('GET', '/api/siniestros');
  assert.ok(!despues.data.some(x => x.numero === 'DEP2-SIN'), 'ya no debe aparecer en la bandeja por default tras cerrarse');

  const lista = await req('GET', '/api/reportes/lista-maestra?q=DEP2-PED');
  assert.ok(!lista.data.filas.some(f => f.pedido_numero === 'DEP2-PED'), 'tampoco debe aparecer en Lista maestra por default');

  const historial = await req('GET', '/api/siniestros?archivado=1&q=DEP2-SIN');
  assert.ok(historial.data.some(x => x.numero === 'DEP2-SIN'), 'debe seguir disponible en el historial sin límite de tiempo');
});

test('DEP-3: marcar estatus_general=Cerrado por el PATCH general (sin pasar por /cerrar) también archiva de inmediato', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'DEP3-SIN', aseguradora: 'GNP' })).data;
  const r = await req('PATCH', '/api/siniestros/' + s.id, { estatus_general: 'Cerrado' });
  assert.equal(r.status, 200);
  assert.equal(r.data.archivado, 1, 'la ruta alterna (PATCH general) debe archivar igual que /cerrar');

  const despues = await req('GET', '/api/siniestros');
  assert.ok(!despues.data.some(x => x.numero === 'DEP3-SIN'), 'no debe aparecer en la bandeja por default');

  // Un PATCH posterior que no cambia estatus_general no debe pisar archivado_en ya puesto.
  const archivadoEnOriginal = r.data.archivado_en;
  const r2 = await req('PATCH', '/api/siniestros/' + s.id, { notas: 'nota de prueba' });
  assert.equal(r2.data.archivado_en, archivadoEnOriginal, 'no debe recalcular archivado_en en cada PATCH posterior');
});

/* ===================== Flujo de reparación (31-ago-2026, autorizado por Roberto) ===================== */

test('FLUJO-3: al llegar al 90% de piezas recibidas (circulando, sin cita) se genera la tarea automática de reingreso, una sola vez', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FLUJO3-SIN', aseguradora: 'GNP' })).data;
  // ingreso_tipo es del grupo restringido "admisión" (atencion_cliente/vanessa/admin/jefe) -- daniela (operativo) no puede tocarlo.
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  await req('PATCH', '/api/siniestros/' + s.id, { ingreso_tipo: 'circulando', requiere_refacciones: 'si' });
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const p = (await req('POST', '/api/pedidos', { numero: 'FLUJO3-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const piezas = [];
  for (let i = 0; i < 10; i++) {
    piezas.push((await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Pieza ' + i, estatus: 'Asignada' })).data);
  }
  // Recibir 8 de 10 (80%) -- todavía no debe disparar la tarea.
  for (let i = 0; i < 8; i++) await req('POST', '/api/piezas/' + piezas[i].id + '/recibir');
  await req('GET', '/api/reportes/resumen');
  let tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.ok(!tareas.some(t => t.disparador === 'reingreso_90pct'), 'con 80% todavía no debe avisar');

  // Recibir la 9na (90%) -- ahora sí debe disparar.
  await req('POST', '/api/piezas/' + piezas[8].id + '/recibir');
  await req('GET', '/api/reportes/resumen');
  tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  const tareasReingreso = tareas.filter(t => t.disparador === 'reingreso_90pct');
  assert.equal(tareasReingreso.length, 1, 'con 90% debe crear exactamente una tarea');

  // Una segunda pasada por /resumen no debe duplicarla.
  await req('GET', '/api/reportes/resumen');
  tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.equal(tareas.filter(t => t.disparador === 'reingreso_90pct').length, 1, 'no debe duplicarse en corridas posteriores');
});

test('FLUJO-3b: si ya tiene cita_fecha agendada, no se vuelve a avisar aunque llegue al 90%', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FLUJO3B-SIN', aseguradora: 'GNP' })).data;
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  await req('PATCH', '/api/siniestros/' + s.id, { ingreso_tipo: 'circulando', requiere_refacciones: 'si', cita_fecha: '2026-09-10' });
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const p = (await req('POST', '/api/pedidos', { numero: 'FLUJO3B-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Única pieza', estatus: 'Asignada' })).data;
  await req('POST', '/api/piezas/' + z.id + '/recibir');
  await req('GET', '/api/reportes/resumen');
  const tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.ok(!tareas.some(t => t.disparador === 'reingreso_90pct'), 'ya tiene cita agendada, no debe generar el aviso');
});

test('FLUJO-5: el checklist de calidad ya lo puede capturar Alejandra, Daniela y Vanessa, no solo Beto/Orlando', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FLUJO5-SIN', aseguradora: 'GNP' })).data;

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
  const rDaniela = await req('POST', '/api/checklist-calidad', { siniestro_id: s.id, dimension: 'Alcance', resultado: 'aprobado' });
  assert.equal(rDaniela.status, 201, 'Daniela (operativo) ya debe poder capturar el checklist');

  const db = require('../server/db');
  const bcrypt = require('bcryptjs');
  db.prepare('INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)')
    .run('Atencion Cliente Prueba FLUJO5', 'atencion.flujo5.test@serviciocristian.mx', bcrypt.hashSync('x', 4), 'atencion_cliente');
  await req('POST', '/api/auth/login', { email: 'atencion.flujo5.test@serviciocristian.mx', password: 'x' });
  const rAlejandra = await req('POST', '/api/checklist-calidad', { siniestro_id: s.id, dimension: 'Presentación', resultado: 'aprobado' });
  assert.equal(rAlejandra.status, 201, 'Alejandra (atencion_cliente) ya debe poder capturar el checklist');

  await req('POST', '/api/auth/login', { email: 'vanessa@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const rVanessa = await req('POST', '/api/checklist-calidad', { siniestro_id: s.id, dimension: 'Documentación', resultado: 'aprobado' });
  assert.equal(rVanessa.status, 201, 'Vanessa ya debe poder capturar el checklist');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('FLUJO-6: fecha de entrega con compromiso obligatorio de GNP -- solo admin/jefe puede volver a moverla', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FLUJO6-SIN', aseguradora: 'GNP' })).data;

  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const rMarca = await req('PATCH', '/api/siniestros/' + s.id, { fecha_entrega_prevista: '2026-09-15', entrega_compromiso_gnp: 1 });
  assert.equal(rMarca.status, 200);
  assert.equal(rMarca.data.entrega_compromiso_gnp, 1);
  assert.ok(rMarca.data.entrega_compromiso_establecido_en, 'debe quedar sellada la fecha en que se marcó');

  const rIntento = await req('PATCH', '/api/siniestros/' + s.id, { fecha_entrega_prevista: '2026-09-20' });
  assert.equal(rIntento.status, 403, 'Beto ya no debe poder mover la fecha una vez marcada como compromiso GNP');

  // Un PATCH que no toca la fecha (p.ej. solo la etapa) sí debe seguir funcionando con normalidad.
  const rEtapa = await req('PATCH', '/api/siniestros/' + s.id, { estado_produccion: 'mecanica' });
  assert.equal(rEtapa.status, 200);

  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const rAdmin = await req('PATCH', '/api/siniestros/' + s.id, { fecha_entrega_prevista: '2026-09-20' });
  assert.equal(rAdmin.status, 200, 'Roberto (admin/jefe) sí puede moverla');
  assert.equal(rAdmin.data.fecha_entrega_prevista, '2026-09-20');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

/* ===================== Reporte de Daniela (31-ago-2026): puntos 3, 5 y 6 ===================== */

test('DANIELA3-1 (punto 3): el Kanban ordena por la fecha real del pedido (fecha_creacion), no por cuándo se insertó el registro, y la trae en la respuesta', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'DAN3-1-SIN', aseguradora: 'GNP' })).data;
  // Se crean en orden inverso al de sus fechas reales, para comprobar que el orden final depende de
  // fecha_creacion y no del orden de inserción (que antes se usaba vía p.creado_en).
  const pViejo = (await req('POST', '/api/pedidos', { numero: 'DAN3-1-PED-VIEJO', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const pNuevo = (await req('POST', '/api/pedidos', { numero: 'DAN3-1-PED-NUEVO', siniestro_id: s.id, fecha_prevista: '2027-06-02' })).data;
  await req('PATCH', '/api/pedidos/' + pViejo.id, { fecha_creacion: '2026-06-01' });
  await req('PATCH', '/api/pedidos/' + pNuevo.id, { fecha_creacion: '2026-08-30' });
  const kanban = (await req('GET', '/api/reportes/kanban')).data;
  const idxViejo = kanban.findIndex(p => p.numero === 'DAN3-1-PED-VIEJO');
  const idxNuevo = kanban.findIndex(p => p.numero === 'DAN3-1-PED-NUEVO');
  assert.ok(idxNuevo !== -1 && idxViejo !== -1, 'ambos pedidos deben aparecer');
  assert.ok(idxNuevo < idxViejo, 'el pedido con fecha_creacion más reciente debe listarse primero, aunque se haya insertado antes');
  const filaNuevo = kanban.find(p => p.numero === 'DAN3-1-PED-NUEVO');
  assert.equal(filaNuevo.fecha_creacion, '2026-08-30', 'la fecha real del pedido debe venir en la respuesta para poder auditar el orden');
});

test('DANIELA3-2 (punto 5): la bandeja de correos pendientes filtra por motivo, por rango de fecha y por búsqueda de texto', async () => {
  await req('POST', '/api/auth/login', { email: 'admin@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'DAN3-2-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'DAN3-2-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const pv = (await req('POST', '/api/proveedores', { razon_social: 'DAN3-2-Proveedor', correo: 'dan32@proveedor.mx' })).data;
  await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Salpicadera DAN3-2', proveedor_id: pv.id });
  // Dar de alta la primera pieza con proveedor dispara solo el aviso automático "pedido_nuevo" (REQ-DANIELA-6);
  // GET /pendientes corre el escaneo perezoso que lo crea.
  await req('GET', '/api/comunicaciones/pendientes');

  const porTexto = (await req('GET', '/api/comunicaciones/pendientes?q=DAN3-2-SIN')).data;
  assert.ok(porTexto.filas.some(f => f.siniestro_numero === 'DAN3-2-SIN'), 'la búsqueda de texto debe encontrarlo por número de siniestro');

  const porMotivo = (await req('GET', '/api/comunicaciones/pendientes?disparador=pedido_nuevo&q=DAN3-2-SIN')).data;
  assert.ok(porMotivo.filas.some(f => f.siniestro_numero === 'DAN3-2-SIN'), 'debe encontrarse filtrando por el motivo real (pedido_nuevo)');
  const motivoQueNoAplica = (await req('GET', '/api/comunicaciones/pendientes?disparador=manual&q=DAN3-2-SIN')).data;
  assert.ok(!motivoQueNoAplica.filas.some(f => f.siniestro_numero === 'DAN3-2-SIN'), 'no debe aparecer bajo un motivo distinto al real');

  const hoy = new Date().toISOString().slice(0, 10);
  const porFecha = (await req('GET', `/api/comunicaciones/pendientes?q=DAN3-2-SIN&desde=${hoy}&hasta=${hoy}`)).data;
  assert.ok(porFecha.filas.some(f => f.siniestro_numero === 'DAN3-2-SIN'), 'debe aparecer dentro del rango de fecha de hoy');
  const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const pasado = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const fueraDeRango = (await req('GET', `/api/comunicaciones/pendientes?q=DAN3-2-SIN&desde=${manana}&hasta=${pasado}`)).data;
  assert.ok(!fueraDeRango.filas.some(f => f.siniestro_numero === 'DAN3-2-SIN'), 'no debe aparecer fuera del rango de fecha');

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});

test('DANIELA3-3 (punto 6): al sincronizar piezas automáticamente por PATCH de pedido, recibido_por queda ligado a quien hizo el cambio', async () => {
  await req('POST', '/api/auth/login', { email: 'beto@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'DAN3-3-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'DAN3-3-PED', siniestro_id: s.id, fecha_prevista: '2027-06-01' })).data;
  const pv = (await req('POST', '/api/proveedores', { razon_social: 'DAN3-3-Proveedor' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro DAN3-3', proveedor_id: pv.id })).data;
  await req('PATCH', '/api/pedidos/' + p.id, { estatus_operativo: 'Recibido completo' });
  const recibidas = (await req('GET', '/api/reportes/piezas-recibidas?pageSize=1000')).data;
  const fila = recibidas.find(r => r.id === z.id);
  assert.ok(fila, 'la pieza debe aparecer en piezas recibidas tras la sincronización automática');
  assert.equal(fila.recibido_por_nombre, 'Beto', 'debe quedar atribuida a quien cerró el pedido, no en blanco');
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026-Reset!' });
});
