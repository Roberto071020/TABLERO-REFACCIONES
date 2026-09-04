// ===================== Simulación controlada -- séptima entrega (WhatsApp Fase A) =====================
// Roberto (séptima revisión, 4-sep-2026) exigió, como parte de los entregables: "una simulación controlada
// con uno o dos expedientes ficticios y la lista exacta de renglones creados." Este script hace exactamente
// eso, contra una base de datos NUEVA y AISLADA (nunca toca data/tablero.db, ni ninguna base de datos
// real) -- se puede correr las veces que haga falta para volver a producir la misma evidencia.
//
// Demuestra, en orden, los tres compromisos del punto 1 (activación controlada):
//   1) Con el módulo en su estado por defecto (activo='0', el mismo con el que nace CUALQUIER instalación
//      nueva), dos expedientes ficticios con teléfono capturado NO generan ni una sola fila.
//   2) Al activar el piloto limitado a UNO solo de los dos expedientes (piloto_numeros), únicamente ese
//      expediente genera registros -- el otro, aunque activo y con teléfono, permanece en cero.
//   3) El procedimiento de reversión (revertirDatosPiloto) borra EXCLUSIVAMENTE lo que generó el piloto,
//      dejando la base de datos otra vez en cero para ese expediente, sin tocar nada más.
//
// Uso: node scripts/simulacion_piloto_septima.js
// Salida: imprime cada paso y, al final, la lista exacta (tabla, id, columnas clave) de cada renglón
// creado -- esa salida es la que se anexa como evidencia en el documento de la séptima entrega.

const path = require('node:path');
const fs = require('node:fs');

const DB_SIM_PATH = path.join(__dirname, '..', 'data', 'simulacion-septima-entrega.db');
if (fs.existsSync(DB_SIM_PATH)) fs.unlinkSync(DB_SIM_PATH);
process.env.TEST_DB_PATH = DB_SIM_PATH;

const db = require('../server/db');
const whatsappFaseA = require('../server/whatsappFaseA');
const activacion = require('../server/whatsappFaseAActivacion');

function linea(titulo){ console.log('\n===== ' + titulo + ' ====='); }

function crearExpedienteFicticio(numero, telefono){
  const info = db.prepare(`
    INSERT INTO siniestros (numero, aseguradora, cliente_nombre, cliente_telefono, cliente_correo, vehiculo, requiere_refacciones, es_particular)
    VALUES (?, 'GNP', ?, ?, ?, 'Vehículo de prueba (simulación, no real)', 'no', 0)
  `).run(numero, 'Cliente ficticio ' + numero, telefono, numero.toLowerCase() + '@simulacion.invalido');
  return db.prepare('SELECT * FROM siniestros WHERE id=?').get(info.lastInsertRowid);
}

function filasWA(siniestroId){
  const eventos = db.prepare('SELECT id, plantilla_codigo, estado, dedup_key, creado_en FROM whatsapp_eventos_registrados WHERE siniestro_id=? ORDER BY id').all(siniestroId);
  const comunicaciones = db.prepare('SELECT id, tipo, nota, registrado_en FROM whatsapp_comunicaciones_manuales WHERE siniestro_id=? ORDER BY id').all(siniestroId);
  const errores = db.prepare('SELECT id, contexto, primer_intento_en, ultimo_intento_en, intentos FROM whatsapp_errores WHERE siniestro_id=? ORDER BY id').all(siniestroId);
  return { eventos, comunicaciones, errores, total: eventos.length + comunicaciones.length + errores.length };
}

linea('PASO 0 -- estado inicial de la configuración (recién creada la base de datos)');
console.log(activacion.leerConfig(db));
console.log('activacionHabilitada():', activacion.activacionHabilitada(db), '<- debe ser false: éste es el estado con el que nace CUALQUIER instalación nueva.');

linea('PASO 1 -- crear dos expedientes FICTICIOS con teléfono, módulo TODAVÍA desactivado');
const piloto = crearExpedienteFicticio('SIM-PILOTO-1', '5215500000001');
const fuera = crearExpedienteFicticio('SIM-PILOTO-2', '5215500000002');
console.log('SIM-PILOTO-1 id=' + piloto.id + ', SIM-PILOTO-2 id=' + fuera.id);

// Se llama exactamente el mismo punto de entrada que usa la aplicación real al dar de alta un expediente.
whatsappFaseA.procesarCreacionSiniestro(db, piloto);
whatsappFaseA.procesarCreacionSiniestro(db, fuera);
whatsappFaseA.reconciliarEventosPrincipales(db);
whatsappFaseA.barrerContinuidadYPostventa(db);

const filasPilotoAntes = filasWA(piloto.id);
const filasFueraAntes = filasWA(fuera.id);
console.log('Filas generadas para SIM-PILOTO-1 con el módulo apagado:', filasPilotoAntes.total, '<- debe ser 0');
console.log('Filas generadas para SIM-PILOTO-2 con el módulo apagado:', filasFueraAntes.total, '<- debe ser 0');
if (filasPilotoAntes.total !== 0 || filasFueraAntes.total !== 0) {
  throw new Error('FALLO DE SIMULACIÓN: el módulo escribió filas estando desactivado por defecto.');
}

linea('PASO 2 -- activar el piloto, limitado EXCLUSIVAMENTE a SIM-PILOTO-1 (SIM-PILOTO-2 se queda fuera)');
activacion.establecerConfig(db, 'activo', '1');
activacion.establecerConfig(db, 'piloto_todos', '0');
activacion.establecerConfig(db, 'piloto_numeros', 'SIM-PILOTO-1');
console.log(activacion.leerConfig(db));

whatsappFaseA.procesarCreacionSiniestro(db, piloto);
whatsappFaseA.procesarCreacionSiniestro(db, fuera);
whatsappFaseA.reconciliarEventosPrincipales(db);
whatsappFaseA.barrerContinuidadYPostventa(db);

const filasPilotoDespues = filasWA(piloto.id);
const filasFueraDespues = filasWA(fuera.id);
console.log('\nRenglones EXACTOS creados para SIM-PILOTO-1 (en el piloto):');
console.log(JSON.stringify(filasPilotoDespues, null, 2));
console.log('\nRenglones EXACTOS creados para SIM-PILOTO-2 (fuera del piloto):');
console.log(JSON.stringify(filasFueraDespues, null, 2));
if (filasFueraDespues.total !== 0) {
  throw new Error('FALLO DE SIMULACIÓN: un expediente fuera de la lista de piloto generó filas.');
}
if (filasPilotoDespues.total === 0) {
  throw new Error('FALLO DE SIMULACIÓN: el expediente EN la lista de piloto no generó ninguna fila.');
}

linea('PASO 3 -- procedimiento de reversión del piloto (revertirDatosPiloto)');
const resultadoReversion = activacion.revertirDatosPiloto(db, ['SIM-PILOTO-1']);
console.log('Resultado de la reversión:', resultadoReversion);
const filasPilotoTrasRevertir = filasWA(piloto.id);
console.log('Filas de SIM-PILOTO-1 tras revertir:', filasPilotoTrasRevertir.total, '<- debe ser 0 otra vez');
if (filasPilotoTrasRevertir.total !== 0) {
  throw new Error('FALLO DE SIMULACIÓN: la reversión no dejó al expediente piloto en cero filas.');
}

linea('PASO 4 -- apagado total (desactivar) -- confirmación final');
activacion.desactivar(db);
console.log(activacion.leerConfig(db));
console.log('activacionHabilitada():', activacion.activacionHabilitada(db), '<- debe volver a false.');

linea('RESUMEN');
console.log('Base de datos de la simulación (aislada, no es la base de datos real):', DB_SIM_PATH);
console.log('Renglones totales creados durante TODA la simulación (antes de revertir):', filasPilotoDespues.total, '(todos para SIM-PILOTO-1; SIM-PILOTO-2 se mantuvo en 0 en todo momento).');
console.log('Tras el paso 3, el expediente piloto también quedó en 0: la simulación no deja ningún dato residual.');
console.log('\nSIMULACIÓN COMPLETA -- SIN ERRORES.');
