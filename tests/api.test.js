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
  const r = await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
  assert.equal(r.status, 200, 'login inicial debe funcionar con la contraseña temporal sembrada');
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

test('CA-01: dos pedidos del mismo siniestro aparecen juntos en su ficha', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CA01-TEST', aseguradora: 'GNP', vehiculo: 'Aveo', placas: 'AAA-000-A' })).data;
  await req('POST', '/api/pedidos', { numero: 'CA01-PED-1', siniestro_id: s.id, fecha_prevista: '2026-09-01' });
  await req('POST', '/api/pedidos', { numero: 'CA01-PED-2', siniestro_id: s.id, fecha_prevista: '2026-09-02' });
  const r = await req('GET', '/api/pedidos?siniestro_id=' + s.id);
  assert.equal(r.data.length, 2, 'ambos pedidos deben listarse bajo el mismo siniestro');
});

test('CA-03 / F-01 / F-02: una pieza con incidencia NUNCA aparece en el borrador de correo', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CA03-TEST', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'CA03-PED', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
  const z1 = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Espejo lateral derecho' })).data;
  const z2 = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Faro delantero' })).data;
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
  const p = (await req('POST', '/api/pedidos', { numero: 'CA04-PED', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
  const z = (await req('POST', '/api/piezas', { pedido_id: p.id, descripcion: 'Cofre' })).data;
  await req('POST', `/api/piezas/${z.id}/recibir`);
  const borrador = (await req('GET', `/api/comunicaciones/generar-borrador/${p.id}`)).data;
  assert.equal(borrador.requiereCorreo, false, 'no debe requerir correo si todo está recibido');
});

test('CA-05 / R-07 / F-14: la exclusión de proveedor es temporal, no bloquea envíos futuros', async () => {
  const prov = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor CA05 SA' })).data;
  const s = (await req('POST', '/api/siniestros', { numero: 'CA05-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'CA05-PED', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
  const exSinMotivo = await req('POST', '/api/comunicaciones/exclusiones', { pedido_id: p.id, proveedor_id: prov.id });
  assert.equal(exSinMotivo.status, 400, 'el motivo debe ser obligatorio');
  const ex = await req('POST', '/api/comunicaciones/exclusiones', { pedido_id: p.id, proveedor_id: prov.id, motivo: 'Revisión de precio, solo este envío' });
  assert.equal(ex.status, 201);
  const provDespues = (await req('GET', '/api/proveedores/' + prov.id)).data;
  assert.equal(provDespues.activo, 1, 'el proveedor sigue activo, no queda bloqueado permanentemente');
});

test('CA-06 / R-06: un pedido Facturado en Inpart sigue como pendiente hasta recepción física', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'CA06-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'CA06-PED', siniestro_id: s.id, estatus_inpart: 'Facturado' , fecha_prevista: '2026-09-01' })).data;
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
  const p = (await req('POST', '/api/pedidos', { numero: '00777', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
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
  const p = (await req('POST', '/api/pedidos', { numero: 'F03-PED', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
  await req('PATCH', '/api/pedidos/' + p.id, { estatus_operativo: 'Cancelado' });
  const kanban = (await req('GET', '/api/reportes/kanban')).data;
  assert.ok(kanban.some(k => k.numero === 'F03-PED'), 'el pedido cancelado debe seguir presente en la respuesta del Kanban');
});

test('F-05: un pedido sin piezas capturadas es visible en la Lista maestra', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'F05-TEST', aseguradora: 'GNP' })).data;
  await req('POST', '/api/pedidos', { numero: 'F05-PED', siniestro_id: s.id , fecha_prevista: '2026-09-01' });
  const filas = (await req('GET', '/api/reportes/lista-maestra?q=F05-PED')).data;
  assert.equal(filas.length, 1);
  assert.equal(filas[0].pieza_id, null, 'no debe tener pieza asociada');
});

test('F-10 / F-11: no se puede recibir una pieza con incidencia abierta; recibir queda ligado al usuario autenticado', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'F1011-TEST', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'F1011-PED', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
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
  const p = (await req('POST', '/api/pedidos', { numero: 'F12-PED', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
  const com = (await req('POST', '/api/comunicaciones', { pedido_id: p.id, destinatarios: 'prueba@proveedor.mx', asunto: 'Test', cuerpo: 'Cuerpo' })).data;
  const resp = await req('PATCH', `/api/comunicaciones/${com.id}/respuesta`, { respuesta_texto: 'Llega la próxima semana', compromiso_fecha: '2026-09-05' });
  assert.equal(resp.status, 200);
  assert.equal(resp.data.respuesta_texto, 'Llega la próxima semana');
});

test('F-15: las comunicaciones quedan ligadas al proveedor correcto cuando el pedido tiene varios proveedores', async () => {
  const provA = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor A F15' })).data;
  const provB = (await req('POST', '/api/proveedores', { razon_social: 'Proveedor B F15' })).data;
  const s = (await req('POST', '/api/siniestros', { numero: 'F15-TEST', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'F15-PED', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
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

  r = await req('POST', '/api/pedidos', { numero: '337196-REPRO', siniestro_id: siniestro.id, estatus_inpart: 'Entregado' , fecha_prevista: '2026-09-01' });
  const pedido = r.data;

  // 2. Agregar la pieza Espejo lateral derecho.
  r = await req('POST', '/api/piezas', { pedido_id: pedido.id, descripcion: 'Espejo lateral derecho' });
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
  const lista = (await req('GET', '/api/reportes/lista-maestra?q=337196-REPRO')).data;
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
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
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

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
});

test('FASE1-3: la vista de Daniela oculta los expedientes marcados "no requiere refacciones", pero conserva "por definir" y "sí"', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const sSi = (await req('POST', '/api/siniestros', { numero: 'FASE1-REQ-SI', aseguradora: 'GNP', cliente_nombre: 'A', cliente_telefono: '1', cliente_correo: 'a@a.com', requiere_refacciones: 'si' })).data;
  const sNo = (await req('POST', '/api/siniestros', { numero: 'FASE1-REQ-NO', aseguradora: 'GNP', cliente_nombre: 'B', cliente_telefono: '2', cliente_correo: 'b@b.com', requiere_refacciones: 'no' })).data;
  const sPorDefinir = (await req('POST', '/api/siniestros', { numero: 'FASE1-REQ-PD', aseguradora: 'GNP', cliente_nombre: 'C', cliente_telefono: '3', cliente_correo: 'c@c.com' })).data;

  // Alejandra (y admin) deben poder ver los tres, incluidos los que no requieren refacciones
  const listaAlejandra = (await req('GET', '/api/siniestros')).data.map(x => x.numero);
  assert.ok(listaAlejandra.includes('FASE1-REQ-SI') && listaAlejandra.includes('FASE1-REQ-NO') && listaAlejandra.includes('FASE1-REQ-PD'));

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const listaDaniela = (await req('GET', '/api/siniestros')).data.map(x => x.numero);
  assert.ok(listaDaniela.includes('FASE1-REQ-SI'), 'Daniela debe ver los que sí requieren refacciones');
  assert.ok(listaDaniela.includes('FASE1-REQ-PD'), 'Daniela debe ver los que están por definir (podría ser ella quien lo determine)');
  assert.ok(!listaDaniela.includes('FASE1-REQ-NO'), 'Daniela NO debe ver los que explícitamente no requieren refacciones');
});

test('FASE1-4: crear el primer pedido sobre un expediente "por definir" lo confirma automáticamente como "sí", y queda auditado', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE1-AUTOFLIP', aseguradora: 'GNP' })).data;
  assert.equal(s.requiere_refacciones, 'por_definir');
  await req('POST', '/api/pedidos', { numero: 'FASE1-AUTOFLIP-PED1', siniestro_id: s.id , fecha_prevista: '2026-09-01' });
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

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
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

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
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

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
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

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
});

/* ===================== FASE 5 — Módulo Alejandra: automatizaciones cruzadas ===================== */
test('FASE5-1: cuando TODOS los pedidos de un expediente quedan en estado terminal, se crea una sola tarea automática (no duplicada)', async () => {
  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'FASE5-REFCOMP', aseguradora: 'GNP', cliente_nombre: 'X', cliente_telefono: '1', cliente_correo: 'x@x.com' })).data;

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const p1 = (await req('POST', '/api/pedidos', { numero: 'FASE5-PED-1', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;
  const p2 = (await req('POST', '/api/pedidos', { numero: 'FASE5-PED-2', siniestro_id: s.id , fecha_prevista: '2026-09-01' })).data;

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
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const p = (await req('POST', '/api/pedidos', { numero: 'FASE5-PED-FECHA', siniestro_id: s.id, fecha_prevista: '2026-09-01' })).data;

  await req('PATCH', '/api/pedidos/' + p.id, { cotizacion: 'sin cambio de fecha' });
  let tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  assert.ok(!tareas.some(t => t.disparador === 'fecha_promesa_modificada'), 'no debe crear tarea si la fecha no cambió');

  await req('PATCH', '/api/pedidos/' + p.id, { fecha_prevista: '2026-09-10' });
  tareas = (await req('GET', '/api/tareas?siniestro_id=' + s.id)).data;
  const tarea = tareas.find(t => t.disparador === 'fecha_promesa_modificada');
  assert.ok(tarea, 'debe crear la tarea al cambiar la fecha prometida');
  assert.match(tarea.descripcion, /2026-09-01/);
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

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
});

test('REQ-DANIELA-1: solo Daniela (operativo) o admin pueden aprobar/registrar un correo; consulta no puede', async () => {
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ1-SIN', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ1-PED', siniestro_id: s.id, fecha_prevista: '2026-09-01' })).data;

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

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
});

test('REQ-DANIELA-2: no se puede cerrar un siniestro con pedidos pendientes o sin fecha de entrega; sí cuando ambos se cumplen', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ2-SIN', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ2-PED', siniestro_id: s.id, fecha_prevista: '2026-09-01' })).data;

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
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ3-PED', siniestro_id: s.id, fecha_prevista: '2026-09-01' })).data;
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

  const conFecha = await req('POST', '/api/pedidos', { numero: 'REQ4-PED-OK', siniestro_id: s.id, fecha_prevista: '2026-09-01' });
  assert.equal(conFecha.status, 201);
});

test('REQ-DANIELA-5: cancelar un pedido exige motivo y lo conserva', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ5-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ5-PED', siniestro_id: s.id, fecha_prevista: '2026-09-01' })).data;

  const sinMotivo = await req('PATCH', `/api/pedidos/${p.id}`, { estatus_operativo: 'Cancelado' });
  assert.equal(sinMotivo.status, 400);
  assert.match(sinMotivo.data.error, /motivo/i);

  const conMotivo = await req('PATCH', `/api/pedidos/${p.id}`, { estatus_operativo: 'Cancelado', motivo_cancelacion: 'Reasignación de proveedor' });
  assert.equal(conMotivo.status, 200);
  assert.equal(conMotivo.data.motivo_cancelacion, 'Reasignación de proveedor');
});

test('REQ-DANIELA-6: crear un pedido prepara automáticamente un correo de "pedido nuevo", pendiente de aprobación', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ6-SIN', aseguradora: 'Mapfre' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ6-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;

  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data;
  const propio = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo');
  assert.ok(propio, 'debe existir un correo automático de pedido nuevo pendiente de aprobación');
  assert.equal(propio.estado, 'pendiente_aprobacion');
  assert.match(propio.copia, /Jorge Contreras/, 'debe sugerir la copia conocida de Mapfre');

  // No debe duplicarse si se vuelve a consultar la bandeja.
  const pendientes2 = (await req('GET', '/api/comunicaciones/pendientes')).data;
  assert.equal(pendientes2.filter(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo').length, 1);
});

test('REQ-DANIELA-7: un pedido con fecha promesa vencida genera correo automático de vencimiento (día 1)', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ7-SIN', aseguradora: 'Afirme' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ7-PED', siniestro_id: s.id, fecha_prevista: '2020-01-01' })).data;

  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data;
  const vencido = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'vencimiento_dia1');
  assert.ok(vencido, 'debe prepararse el correo de vencimiento');
  assert.match(vencido.copia, /Nancy Monserrat/, 'debe sugerir la copia conocida de Afirme');
});

test('REQ-DANIELA-8: solo Daniela/admin pueden aprobar o descartar un correo de la bandeja; aprobar exige destinatario', async () => {
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ8-SIN', aseguradora: 'GNP' })).data;
  const p = (await req('POST', '/api/pedidos', { numero: 'REQ8-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' })).data;
  const pendientes = (await req('GET', '/api/comunicaciones/pendientes')).data;
  const com = pendientes.find(c => c.pedido_id === p.id && c.disparador === 'pedido_nuevo');

  const sinDestinatario = await req('PATCH', `/api/comunicaciones/${com.id}/aprobar`, {});
  assert.equal(sinDestinatario.status, 400);

  const aprobado = await req('PATCH', `/api/comunicaciones/${com.id}/aprobar`, { destinatarios: 'proveedor@ejemplo.mx' });
  assert.equal(aprobado.status, 200);
  assert.equal(aprobado.data.estado, 'aprobado');
  assert.ok(aprobado.data.aprobado_en);

  // Descartar: crear otro caso y verificar el permiso.
  const p2 = (await req('POST', '/api/pedidos', { numero: 'REQ8-PED-2', siniestro_id: s.id, fecha_prevista: '2026-12-02' })).data;
  const pendientes2 = (await req('GET', '/api/comunicaciones/pendientes')).data;
  const com2 = pendientes2.find(c => c.pedido_id === p2.id && c.disparador === 'pedido_nuevo');

  await req('POST', '/api/auth/login', { email: 'alejandra@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const bloqueadoAprobar = await req('PATCH', `/api/comunicaciones/${com2.id}/aprobar`, { destinatarios: 'x@x.com' });
  assert.equal(bloqueadoAprobar.status, 403);
  const bloqueadoDescartar = await req('PATCH', `/api/comunicaciones/${com2.id}/descartar`, {});
  assert.equal(bloqueadoDescartar.status, 403);

  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
  const descartado = await req('PATCH', `/api/comunicaciones/${com2.id}/descartar`, { motivo: 'Duplicado' });
  assert.equal(descartado.status, 200);
});

test('REQ-DANIELA-9: el resumen diario refleja los correos realmente pendientes de aprobación', async () => {
  const antes = (await req('GET', '/api/reportes/resumen')).data.correosPendientes;
  const s = (await req('POST', '/api/siniestros', { numero: 'REQ9-SIN', aseguradora: 'Inbursa' })).data;
  await req('POST', '/api/pedidos', { numero: 'REQ9-PED', siniestro_id: s.id, fecha_prevista: '2026-12-01' });
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

test('REQ-DANIELA-12: carga masiva - validar detecta filas correctas, duplicados dentro del archivo y errores de columnas', async () => {
  const csv = [
    'numero_siniestro,aseguradora,vehiculo,placas,fecha_ingreso,responsable,numero_pedido,fecha_creacion_pedido,fecha_prevista,estatus_inpart,estatus_operativo,proveedor,telefono_proveedor,contacto_proveedor',
    'CM-SIN-1,GNP,Nissan Versa,ABC123,2026-08-01,Daniela,CM-PED-1,2026-08-01,2026-09-01,Aguardando confirmación,Nuevo,Proveedor Uno,555-1111,Juan',
    'CM-SIN-1,GNP,Nissan Versa,ABC123,2026-08-01,Daniela,CM-PED-2,2026-08-02,2026-09-05,Aguardando confirmación,Nuevo,Proveedor Uno,555-1111,Juan',
    'CM-SIN-2,Mapfre,,,,,CM-PED-3,,,,,,,',
    'CM-SIN-3,Afirme,,,,,CM-PED-1,,2026-09-10,,,,,',
  ].join('\n');

  const r = await req('POST', '/api/carga-masiva/validar', { csv });
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 4);
  assert.equal(r.data.validas.length, 2, 'las primeras 2 filas están completas y sin duplicado');
  assert.equal(r.data.errores.length, 2);
  const errorFaltantes = r.data.errores.find(e => e.dato.numero_pedido === 'CM-PED-3');
  assert.ok(errorFaltantes.motivos.some(m => /fecha promesa/i.test(m)));
  const errorDup = r.data.errores.find(e => e.dato.numero_pedido === 'CM-PED-1' && e.dato.numero_siniestro === 'CM-SIN-3');
  assert.ok(errorDup.motivos.some(m => /duplicado dentro del mismo archivo/i.test(m)));
});

test('REQ-DANIELA-13: carga masiva - confirmar registra solo lo válido, agrupa pedidos bajo el mismo siniestro y evita duplicados reales', async () => {
  const csv = [
    'numero_siniestro,aseguradora,vehiculo,placas,numero_pedido,fecha_prevista,proveedor',
    'CM2-SIN-1,GNP,Chevrolet Aveo,XYZ999,CM2-PED-1,2026-09-01,Proveedor Dos',
    'CM2-SIN-1,GNP,Chevrolet Aveo,XYZ999,CM2-PED-2,2026-09-03,Proveedor Dos',
  ].join('\n');
  const validado = (await req('POST', '/api/carga-masiva/validar', { csv })).data;
  assert.equal(validado.validas.length, 2);

  const confirmar = await req('POST', '/api/carga-masiva/confirmar', { filas: validado.validas.map(v => v.dato) });
  assert.equal(confirmar.status, 200);
  assert.equal(confirmar.data.siniestrosCreados, 1, 'un solo siniestro para los 2 pedidos');
  assert.equal(confirmar.data.pedidosCreados, 2);

  const siniestro = (await req('GET', '/api/siniestros?q=CM2-SIN-1')).data[0];
  const pedidos = (await req('GET', '/api/pedidos?siniestro_id=' + siniestro.id)).data;
  assert.equal(pedidos.length, 2, 'ambos pedidos quedaron bajo el mismo expediente (no solo el encabezado)');

  // Reintentar la misma carga no debe duplicar (los pedidos ya existen).
  const segundaVez = await req('POST', '/api/carga-masiva/confirmar', { filas: validado.validas.map(v => v.dato) });
  assert.equal(segundaVez.data.pedidosCreados, 0);
  assert.equal(segundaVez.data.omitidos.length, 2);
});

test('REQ-DANIELA-14: carga masiva exclusiva de Daniela/admin; consulta no puede', async () => {
  await req('POST', '/api/auth/login', { email: 'consulta.req1@serviciocristian.mx', password: 'Password123!' });
  const bloqueado = await req('POST', '/api/carga-masiva/validar', { csv: 'numero_siniestro,aseguradora,numero_pedido,fecha_prevista\nA,B,C,2026-01-01' });
  assert.equal(bloqueado.status, 403);
  await req('POST', '/api/auth/login', { email: 'daniela@serviciocristian.mx', password: 'ServicioCristian2026!' });
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
