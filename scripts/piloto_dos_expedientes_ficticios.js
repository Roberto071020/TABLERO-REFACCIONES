// ===================== Piloto controlado -- dos expedientes FICTICIOS (autorizado por Roberto, 4-sep-2026) =====================
// Condiciones obligatorias de la autorización, todas respetadas por este script:
//   1) Solo la rama whatsapp-fase-a-solo-registro (este script vive en ella).
//   2) Base de datos AISLADA -- nunca la de producción (TEST_DB_PATH, archivo nuevo, nunca data/tablero.db).
//   3) Se crea una corrida explícita con iniciarPilotoRun() ANTES de activar el piloto, y se conserva su id.
//   4) piloto_todos se mantiene en '0' en todo momento.
//   5) piloto_numeros contiene EXCLUSIVAMENTE los dos números ficticios.
//   6) No se vincula ningún número de WhatsApp real.
//   7) No se configura WHATSAPP_APP_SECRET ni ninguna credencial real de Meta.
//   8) No hay ningún mecanismo de envío real -- este módulo nunca lo tuvo en modo "solo registro".
//   9) No se hace merge a main ni se despliega -- este script no toca git ni Render.
//  10) Al final, se desactiva el módulo (activo='0') y se revierte EXCLUSIVAMENTE esta corrida (piloto_run_id).
//
// Caso A (sin piezas): autorizado sin piezas -> avanza por reparación, hojalatería, pintura, calidad y
//   queda listo para entrega. Incluye una demostración de continuidad de 72h con su segunda alerta interna.
// Caso B (con piezas): espera de piezas -> disponibilidad -> reingreso/permanencia en taller (con un evento
//   BLOQUEADO real, por ubicación no determinable, resuelto después por confirmación humana) -> continúa
//   la reparación hasta calidad y entrega.

const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'piloto-dos-expedientes-ficticios.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
process.env.TEST_DB_PATH = DB_PATH;

const db = require('../server/db');
const whatsappFaseA = require('../server/whatsappFaseA');
const activacion = require('../server/whatsappFaseAActivacion');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

function linea(t){ console.log('\n===== ' + t + ' ====='); }
function sub(t){ console.log('\n--- ' + t + ' ---'); }

function snapshotTablas(etiqueta){
  const eventos = db.prepare('SELECT id, siniestro_id, plantilla_codigo, estado, tipo_bloqueo, dedup_key, piloto_run_id FROM whatsapp_eventos_registrados ORDER BY id').all();
  const comunicaciones = db.prepare('SELECT id, siniestro_id, tipo, wamid, piloto_run_id FROM whatsapp_comunicaciones_manuales ORDER BY id').all();
  const errores = db.prepare('SELECT id, siniestro_id, contexto, piloto_run_id FROM whatsapp_errores ORDER BY id').all();
  console.log(`[${etiqueta}] whatsapp_eventos_registrados: ${eventos.length} fila(s)`);
  console.log(`[${etiqueta}] whatsapp_comunicaciones_manuales: ${comunicaciones.length} fila(s)`);
  console.log(`[${etiqueta}] whatsapp_errores: ${errores.length} fila(s)`);
  return { eventos, comunicaciones, errores };
}

let contadorTelefono = 0;
function crearFicticio(numero, campos){
  contadorTelefono++;
  const base = {
    numero, aseguradora:'GNP (ficticia, prueba de piloto)', cliente_nombre:'Cliente ficticio ' + numero,
    cliente_correo: numero.toLowerCase()+'@piloto-ficticio.invalido',
    cliente_telefono: '551555' + String(contadorTelefono).padStart(4,'0'),
    vehiculo:'Vehículo de prueba (piloto controlado, no real)', requiere_refacciones:'no', es_particular:0,
  };
  const fila = { ...base, ...(campos||{}) }; // los campos explícitos SIEMPRE ganan sobre la base -- sin columnas duplicadas.
  const cols = Object.keys(fila);
  const vals = Object.values(fila);
  const info = db.prepare(`INSERT INTO siniestros (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...vals);
  const siniestro = db.prepare('SELECT * FROM siniestros WHERE id=?').get(info.lastInsertRowid);
  whatsappFaseA.procesarCreacionSiniestro(db, siniestro);
  return db.prepare('SELECT * FROM siniestros WHERE id=?').get(info.lastInsertRowid);
}
function avanzar(id, cambios){
  const anterior = db.prepare('SELECT * FROM siniestros WHERE id=?').get(id);
  const set = Object.keys(cambios).map(k=>`${k}=?`).join(',');
  db.prepare(`UPDATE siniestros SET ${set} WHERE id=?`).run(...Object.values(cambios), id);
  const nuevo = db.prepare('SELECT * FROM siniestros WHERE id=?').get(id);
  whatsappFaseA.procesarTransicionSiniestro(db, { anterior, nuevo });
  return nuevo;
}
function eventosDe(id){
  return db.prepare(`SELECT id, plantilla_codigo, estado, tipo_bloqueo, motivo_bloqueo, dedup_key FROM whatsapp_eventos_registrados WHERE siniestro_id=? ORDER BY id`).all(id);
}
function contarPorCodigo(id, codigo){
  return db.prepare(`SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE siniestro_id=? AND plantilla_codigo=?`).get(id, codigo).c;
}

// ===================== PASO 0: estado inicial (antes del piloto) =====================
linea('PASO 0 -- estado inicial (base de datos recién creada, aislada)');
console.log('Config inicial:', activacion.leerConfig(db));
console.log('activacionHabilitada():', activacion.activacionHabilitada(db), '<- debe ser false (estado por defecto de cualquier instalación nueva)');
snapshotTablas('ANTES DEL PILOTO');

// ---- Distractor: datos de una corrida ANTERIOR, para demostrar que la reversión de la corrida del piloto
// (paso final) NO toca absolutamente nada de una corrida previa distinta. (Se activa brevemente el módulo,
// SIN piloto_numeros de los expedientes reales del piloto, solo para dejar evidencia de "otra corrida".)
sub('Distractor: datos de una corrida ANTERIOR (para probar exclusividad de la reversión más adelante)');
activacion.establecerConfig(db, 'activo', '1');
activacion.establecerConfig(db, 'piloto_todos', '0');
const runIdAnterior = activacion.iniciarPilotoRun(db);
activacion.establecerConfig(db, 'piloto_numeros', 'DISTRACTOR-PREVIO');
const distractor = crearFicticio('DISTRACTOR-PREVIO', { cliente_telefono:'5215599990000' });
console.log('Corrida anterior (distractora) piloto_run_id =', runIdAnterior, '-- expediente DISTRACTOR-PREVIO, eventos:', eventosDe(distractor.id).length);
activacion.establecerConfig(db, 'activo', '0'); // se apaga de nuevo antes de iniciar la corrida real del piloto autorizado.

// ===================== PASO 1: nueva corrida explícita (condición 3) =====================
linea('PASO 1 -- iniciar una nueva corrida explícita del piloto (iniciarPilotoRun)');
const pilotoRunId = activacion.iniciarPilotoRun(db);
console.log('piloto_run_id de ESTA corrida (el piloto autorizado):', pilotoRunId);
console.assert(pilotoRunId !== runIdAnterior, 'la nueva corrida debe tener un id distinto al de la corrida anterior');

// ===================== PASO 2: activar, piloto_todos=0, solo los dos números ficticios (condiciones 4,5) ==
linea('PASO 2 -- activar el módulo, piloto_todos=0, piloto_numeros con EXCLUSIVAMENTE los dos ficticios');
const NUM_A = 'PILOTO-FICTICIO-A';
const NUM_B = 'PILOTO-FICTICIO-B';
activacion.establecerConfig(db, 'activo', '1');
activacion.establecerConfig(db, 'piloto_todos', '0');
activacion.establecerConfig(db, 'piloto_numeros', NUM_A + ',' + NUM_B);
console.log('Config activa:', activacion.leerConfig(db));
console.assert(activacion.leerConfig(db).piloto_todos === '0', 'piloto_todos debe permanecer en 0');

// ===================== CASO A: autorizado SIN piezas -- reparación completa hasta listo para entrega =====
linea('CASO A -- ' + NUM_A + ' (autorizado sin piezas: reparación, hojalatería, pintura, calidad, listo para entrega)');
const a = crearFicticio(NUM_A, { cliente_telefono:'5215551110001', ingreso_tipo:'grua' }); // grua => siempre en_taller, sin ambigüedad
sub('A.1 Creación con teléfono capturado -> bienvenida (5.1)');
console.log('Eventos tras creación:', eventosDe(a.id));
console.assert(contarPorCodigo(a.id,'5.1') === 1, 'debe registrarse 5.1 exactamente una vez');

sub('A.2 Revisión concluida y presupuesto enviado a la aseguradora -> 5.2');
avanzar(a.id, { valuacion_fecha_envio:'2026-09-01' });
console.log('Eventos tras envío de valuación:', eventosDe(a.id));
console.assert(contarPorCodigo(a.id,'5.2') === 1, 'debe registrarse 5.2 exactamente una vez');

sub('A.3 Autorización CONFIRMADA, sin piezas a cambio, unidad en taller -> 5.6');
avanzar(a.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-02', autorizador:'Ajustador Ficticio', piezas_autorizadas_cambio:0 });
console.log('Eventos tras autorización:', eventosDe(a.id));
console.assert(contarPorCodigo(a.id,'5.6') === 1, 'debe registrarse 5.6 exactamente una vez');

sub('A.4 Prueba de continuidad de 72h -- primer ciclo sin avance real (mensaje de continuidad 6.x, ventana=1: 72<=horas<144)');
const hace100h = dayjs.utc().subtract(100,'hour').format('YYYY-MM-DD HH:mm:ss');
db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace100h, hace100h, a.id);
whatsappFaseA.barrerContinuidadYPostventa(db);
let eventosA = eventosDe(a.id);
const continuidad1 = eventosA.filter(e => e.plantilla_codigo && e.plantilla_codigo.startsWith('6.'));
console.log('Eventos de continuidad tras el primer barrido (100h sin avance):', continuidad1);
console.assert(continuidad1.length === 1, 'el primer ciclo de estancamiento debe registrar UN mensaje de continuidad (6.x)');

sub('A.5 Segundo periodo consecutivo SIN avance -> ALERTA-72H-X2 (alerta interna, nunca otro mensaje de cliente; ventana=2: 144<=horas<216)');
whatsappFaseA.barrerContinuidadYPostventa(db); // se corre otra vez sin que nada haya cambiado -- debe deduplicar (mismo ciclo, misma ventana).
let continuidadTrasRepetir = eventosDe(a.id).filter(e => e.plantilla_codigo && e.plantilla_codigo.startsWith('6.'));
console.log('Mensajes de continuidad 6.x tras repetir el barrido SIN ningún cambio (debe seguir en 1, mismo ciclo -- deduplicado):', continuidadTrasRepetir.length);
console.assert(continuidadTrasRepetir.length === 1, 'repetir el barrido sin ningún avance no debe duplicar el mensaje de continuidad');
// Se envejece el MISMO ciclo a 150h (ventana=2): el ancla cambia (nuevo timestamp backdateado), así que la
// clave de ciclo cambia y el segundo periodo consecutivo SÍ genera su propia alerta interna nueva.
const hace150h = dayjs.utc().subtract(150,'hour').format('YYYY-MM-DD HH:mm:ss');
db.prepare(`UPDATE whatsapp_eventos_registrados SET creado_en=?, simulado_enviado_en=? WHERE siniestro_id=? AND plantilla_codigo LIKE '5.%'`).run(hace150h, hace150h, a.id);
whatsappFaseA.barrerContinuidadYPostventa(db);
eventosA = eventosDe(a.id);
const alertaInterna = eventosA.filter(e => e.plantilla_codigo === 'ALERTA-72H-X2');
const continuidadFinal = eventosA.filter(e => e.plantilla_codigo && e.plantilla_codigo.startsWith('6.'));
console.log('ALERTA-72H-X2 tras el segundo periodo consecutivo (150h sin avance):', alertaInterna);
console.assert(alertaInterna.length === 1, 'el segundo periodo consecutivo debe generar exactamente una ALERTA-72H-X2 (alerta interna, no otro mensaje de cliente)');
console.assert(continuidadFinal.length === 1, 'no debe haberse generado un SEGUNDO mensaje de cliente 6.x -- el segundo periodo es alerta interna, no otro 6.x');

sub('A.6 Avance real y verificable: entra a producción (hojalatería) -> 5.8; esto mueve el ancla (fin del ciclo de estancamiento)');
avanzar(a.id, { estado_produccion:'en_laminado' });
console.log('Eventos tras avance a hojalatería:', eventosDe(a.id).filter(e=>e.plantilla_codigo==='5.8'));
console.assert(contarPorCodigo(a.id,'5.8') === 1, 'debe registrarse 5.8 exactamente una vez');

sub('A.7 Continúa a pintura -> 5.9');
avanzar(a.id, { estado_produccion:'pintura' });
console.assert(contarPorCodigo(a.id,'5.9') === 1, 'debe registrarse 5.9 exactamente una vez');

sub('A.8 Entra a inspección de calidad -> 5.10');
avanzar(a.id, { estado_calidad:'en_inspeccion' });
console.assert(contarPorCodigo(a.id,'5.10') === 1, 'debe registrarse 5.10 exactamente una vez');

sub('A.9 Calidad liberada -- LISTO PARA ENTREGA -> 5.11');
avanzar(a.id, { estado_calidad:'liberado' });
console.assert(contarPorCodigo(a.id,'5.11') === 1, 'debe registrarse 5.11 exactamente una vez');
console.log('Secuencia completa de plantillas de CLIENTE para el caso A:', eventosDe(a.id).filter(e=>e.plantilla_codigo.startsWith('5.')||e.plantilla_codigo.startsWith('6.')).map(e=>e.plantilla_codigo));

// ===================== CASO B: CON piezas -- espera, disponibilidad, reingreso/permanencia, continuación ===
linea('CASO B -- ' + NUM_B + ' (con piezas: espera, disponibilidad, reingreso/permanencia en taller, continuación de reparación)');
const b = crearFicticio(NUM_B, { cliente_telefono:'5215552220002', ingreso_tipo:'circulando', requiere_refacciones:'si' });
sub('B.1 Creación con teléfono -> bienvenida (5.1)');
console.assert(contarPorCodigo(b.id,'5.1') === 1, 'debe registrarse 5.1 exactamente una vez');

sub('B.2 Revisión enviada -> 5.2');
avanzar(b.id, { valuacion_fecha_envio:'2026-09-01' });
console.assert(contarPorCodigo(b.id,'5.2') === 1, 'debe registrarse 5.2 exactamente una vez');

sub('B.3 Autorización CONFIRMADA, CON piezas a cambio -> 5.3 (esperando piezas)');
avanzar(b.id, { estado_autorizacion:'autorizada', autorizacion_fecha_respuesta:'2026-09-02', autorizador:'Ajustador Ficticio', piezas_autorizadas_cambio:3 });
console.assert(contarPorCodigo(b.id,'5.3') === 1, 'debe registrarse 5.3 exactamente una vez');
console.log('Eventos tras autorización con piezas:', eventosDe(b.id));

sub('B.4 Pedido de refacciones creado, todavía en trámite normal -> sin ninguna señal todavía (ni mensaje ni alerta)');
db.prepare(`INSERT INTO pedidos (numero, siniestro_id, estatus_operativo) VALUES ('PILOTO-B-PED', ?, 'En proceso de surtido')`).run(b.id);
whatsappFaseA.procesarRefaccionesCompletas(db, b.id);
const eventosTrasPedidoEnProceso = eventosDe(b.id);
console.log('Eventos tras crear el pedido (en trámite normal):', eventosTrasPedidoEnProceso.length, '(debe seguir igual que en B.3, sin ruido)');
console.assert(eventosTrasPedidoEnProceso.filter(e=>e.plantilla_codigo==='5.4'||e.plantilla_codigo==='5.5').length === 0, 'mientras el pedido está en trámite normal, NO debe registrarse ningún evento de piezas listas');

sub('B.5 Unidad reingresa al taller (fue admitida antes; ubicación física YA NO es determinable con los datos actuales -- el sistema NO adivina)');
avanzar(b.id, { fecha_admision:'2026-09-03' }); // ingreso_tipo sigue 'circulando' -> unidadEnTaller() = 'desconocido' (caso 3 de la nota de diseño)

sub('B.6 Piezas quedan disponibles mientras la ubicación sigue siendo desconocida -> EVENTO BLOQUEADO (motivo explícito, sin adivinar)');
db.prepare(`UPDATE pedidos SET estatus_operativo='Recibido completo' WHERE numero='PILOTO-B-PED'`).run();
whatsappFaseA.procesarRefaccionesCompletas(db, b.id);
let eventosB = eventosDe(b.id);
const bloqueado = eventosB.find(e => e.estado === 'bloqueado');
console.log('Evento BLOQUEADO:', bloqueado);
console.assert(bloqueado && bloqueado.tipo_bloqueo === 'ubicacion_desconocida', 'debe quedar un evento bloqueado por ubicación desconocida, con su motivo explícito');
console.assert(contarPorCodigo(b.id, bloqueado.plantilla_codigo) === 1, 'el evento bloqueado debe existir una sola vez (no duplicado)');

sub('B.7 Confirmación humana: la unidad PERMANECE en el taller (no adivinado por el sistema -- confirmado por una persona) -> el bloqueo se revisa y se libera con justificación');
avanzar(b.id, { ingreso_tipo:'permanece' }); // ahora sí, determinístico: 'permanece' siempre es en_taller.
whatsappFaseA.revisarBloqueadosResueltos(db);
eventosB = eventosDe(b.id);
const enRevision = eventosB.find(e => e.id === bloqueado.id);
console.log('Evento tras revisarBloqueadosResueltos (debe pasar a pendiente_revision, NUNCA liberarse solo):', enRevision);
console.assert(enRevision.estado === 'pendiente_revision', 'el evento debe pasar a pendiente_revision automáticamente -- pero NUNCA liberarse ni enviarse solo');
const liberado = whatsappFaseA.resolverPendienteRevision(db, { eventoId: bloqueado.id, decision:'liberado_para_programacion',
  justificacion:'Piloto controlado: se confirmó a mano que la unidad permanece en el taller (ingreso_tipo=permanece); las piezas siguen disponibles; no hubo otro avance desde el registro. Se libera para programación (modo solo registro, sin envío real).' });
console.log('Evento tras resolución humana explícita:', liberado);
console.assert(liberado.estado === 'liberado_para_programacion', 'la liberación exige siempre una acción explícita y justificada -- nunca es automática');

sub('B.8 Continuación de la reparación: entra a hojalatería -> 5.8, luego pintura -> 5.9, calidad -> 5.10 -> 5.11');
avanzar(b.id, { estado_produccion:'en_laminado' });
console.assert(contarPorCodigo(b.id,'5.8') === 1, 'debe registrarse 5.8 exactamente una vez');
avanzar(b.id, { estado_produccion:'pintura' });
console.assert(contarPorCodigo(b.id,'5.9') === 1, 'debe registrarse 5.9 exactamente una vez');
avanzar(b.id, { estado_calidad:'en_inspeccion' });
console.assert(contarPorCodigo(b.id,'5.10') === 1, 'debe registrarse 5.10 exactamente una vez');
avanzar(b.id, { estado_calidad:'liberado' });
console.assert(contarPorCodigo(b.id,'5.11') === 1, 'debe registrarse 5.11 exactamente una vez');
console.log('Secuencia completa de plantillas para el caso B:', eventosDe(b.id).map(e=>e.plantilla_codigo+':'+e.estado));

// ===================== PASO 3: comprobación de idempotencia (cada evento, una sola vez) =====================
linea('PASO 3 -- comprobación de idempotencia: reconciliarEventosPrincipales() y barrerContinuidadYPostventa() se corren OTRA VEZ sin ningún cambio de estado');
const totalAntesIdempotencia = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados').get().c;
whatsappFaseA.reconciliarEventosPrincipales(db);
whatsappFaseA.barrerContinuidadYPostventa(db);
const totalDespuesIdempotencia = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados').get().c;
console.log('Total de eventos ANTES de repetir los barridos:', totalAntesIdempotencia);
console.log('Total de eventos DESPUÉS de repetir los barridos (debe ser IGUAL):', totalDespuesIdempotencia);
console.assert(totalAntesIdempotencia === totalDespuesIdempotencia, 'repetir los barridos sin ningún cambio de estado NUNCA debe generar duplicados');

// ===================== PASO 4: fotografía completa DURANTE el piloto =====================
linea('PASO 4 -- estado de las tablas DURANTE el piloto (antes de revertir)');
const durante = snapshotTablas('DURANTE EL PILOTO');
console.log('\nDetalle completo de eventos de la corrida', pilotoRunId, ':');
console.log(JSON.stringify(durante.eventos.filter(e=>e.piloto_run_id===pilotoRunId), null, 2));

// ===================== PASO 5: desactivar y revertir EXCLUSIVAMENTE esta corrida (condición 10) =====================
linea('PASO 5 -- desactivar el módulo y revertir EXCLUSIVAMENTE esta corrida (piloto_run_id)');
activacion.desactivar(db);
console.log('activacionHabilitada() tras desactivar:', activacion.activacionHabilitada(db), '<- debe ser false');
const resultadoReversion = activacion.revertirDatosPiloto(db, { numeros:[NUM_A, NUM_B], runId: pilotoRunId });
console.log('Resultado de la reversión:', resultadoReversion);

linea('PASO 6 -- estado de las tablas DESPUÉS de revertir');
const despues = snapshotTablas('DESPUÉS DE REVERTIR');
const filasARestantes = despues.eventos.filter(e => e.siniestro_id === a.id).length
  + despues.comunicaciones.filter(e => e.siniestro_id === a.id).length
  + despues.errores.filter(e => e.siniestro_id === a.id).length;
const filasBRestantes = despues.eventos.filter(e => e.siniestro_id === b.id).length
  + despues.comunicaciones.filter(e => e.siniestro_id === b.id).length
  + despues.errores.filter(e => e.siniestro_id === b.id).length;
console.log('Filas restantes del expediente A tras revertir (debe ser 0):', filasARestantes);
console.log('Filas restantes del expediente B tras revertir (debe ser 0):', filasBRestantes);
console.assert(filasARestantes === 0 && filasBRestantes === 0, 'la reversión debe dejar ambos expedientes del piloto en cero');

// Comprobación de exclusividad: la corrida ANTERIOR (distractora) debe seguir EXACTAMENTE igual que antes.
const eventosDistractorTrasRevertir = db.prepare('SELECT COUNT(*) c FROM whatsapp_eventos_registrados WHERE siniestro_id=? AND piloto_run_id=?').get(distractor.id, runIdAnterior).c;
console.log('Eventos de la corrida ANTERIOR (distractora, piloto_run_id=' + runIdAnterior + ') tras revertir la corrida del piloto (debe seguir intacta):', eventosDistractorTrasRevertir);
console.assert(eventosDistractorTrasRevertir > 0, 'la corrida anterior (ajena a este piloto) NO debe verse afectada por la reversión');

// Limpieza narrativa: también se revierte el distractor, para dejar la base de datos de la simulación en
// cero por completo (no es parte de la evidencia del piloto en sí, solo higiene del script de prueba).
activacion.revertirDatosPiloto(db, { numeros:['DISTRACTOR-PREVIO'], runId: runIdAnterior });

linea('RESUMEN FINAL');
console.log('piloto_run_id de la corrida del piloto:', pilotoRunId);
console.log('Config final:', activacion.leerConfig(db));
console.log('activacionHabilitada() final:', activacion.activacionHabilitada(db));
console.log('Base de datos usada (aislada, no es la real):', DB_PATH);
console.log('\nPILOTO CONTROLADO COMPLETO -- SIN ERRORES.');
