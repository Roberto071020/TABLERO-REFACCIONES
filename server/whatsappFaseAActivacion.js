// ===================== WhatsApp Fase A -- activación controlada (séptima revisión, punto 1) =====================
// Roberto (4-sep-2026): antes de autorizar cualquier despliegue, el módulo completo debe nacer INACTIVO por
// defecto, y cuando se active, debe poder limitarse a una lista explícita de expedientes (piloto), con una
// fecha de corte que evite reconstruir automáticamente etapas anteriores a la activación.
//
// Se implementa con una tabla de configuración EN BASE DE DATOS (whatsapp_config, ver server/db.js) -- no
// con variables de entorno -- por dos razones concretas: (1) detener el piloto se vuelve una sola
// instrucción SQL/API, sin depender de un redeploy en Render; (2) el scheduler (server/whatsappScheduler.js)
// ya corre cada 15 minutos y relee esta tabla en cada ejecución, así que un cambio de configuración se
// aplica solo, en el siguiente ciclo, sin reiniciar el proceso.
//
// Estado por defecto (fila sembrada en la migración de server/db.js): activo='0'. Con esto DESACTIVADO,
// ninguna función de este módulo escribe una sola fila en whatsapp_eventos_registrados,
// whatsapp_comunicaciones_manuales ni whatsapp_errores -- ver el gate en cada punto de entrada de
// server/whatsappFaseA.js (procesarCreacionSiniestro, procesarTransicionSiniestro, procesarRefaccionesCompletas,
// los dos barridos de barrerContinuidadYPostventa, y reconciliarEventosPrincipales) y de
// server/whatsappScheduler.js (ejecutarBarridoProgramado sale ANTES de escribir ninguna fila, ni siquiera la
// de su propio historial de ejecuciones).

const crypto = require('crypto');

function leerConfig(db){
  const filas = db.prepare('SELECT clave, valor FROM whatsapp_config').all();
  const cfg = {};
  for(const f of filas) cfg[f.clave] = f.valor;
  return cfg;
}

function activacionHabilitada(db){
  return leerConfig(db).activo === '1';
}

function modoPilotoTodos(db){
  return leerConfig(db).piloto_todos === '1';
}

function listaPiloto(db){
  const cfg = leerConfig(db);
  return String(cfg.piloto_numeros || '').split(',').map(s => s.trim()).filter(Boolean);
}

function fechaCorte(db){
  const f = String(leerConfig(db).fecha_corte || '').trim();
  return f || null;
}

// Octava revisión (Roberto, 4-sep-2026, punto 1): "identifica cada ejecución mediante un campo como
// piloto_run_id". Cada corrida del piloto (desde que se activa hasta que se detiene) tiene un identificador
// propio -- así, revertirDatosPiloto() puede borrar EXCLUSIVAMENTE lo que generó ESA corrida, sin arrastrar
// datos de una corrida anterior sobre el mismo expediente (p. ej. si el mismo expediente ficticio se usa
// en dos pilotos sucesivos). No se expone como una clave editable libremente en PATCH /config -- solo se
// genera con iniciarPilotoRun(), para que nunca se pueda "adivinar" o reutilizar un id a mano por error.
function pilotoRunActual(db){
  const v = String(leerConfig(db).piloto_run_id || '').trim();
  return v || null;
}
function iniciarPilotoRun(db){
  const runId = 'run-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  db.prepare(`INSERT INTO whatsapp_config (clave,valor) VALUES ('piloto_run_id',?)
    ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor`).run(runId);
  return runId;
}

// Decide si UN expediente concreto debe procesarse ahora mismo. Es el único lugar que decide esto -- para
// no repetir la misma lógica de gate en cinco sitios distintos del módulo con el riesgo de que alguno se
// quede desactualizado y procese algo que no debería.
//   1) Si el módulo está apagado -> nunca.
//   2) Si el expediente está en la lista explícita de piloto (por número) -> siempre, sin importar la
//      fecha de corte (es una selección manual y deliberada, no un barrido masivo).
//   3) Si no está en la lista Y no está activo el modo "todos" -> nunca (evita "toda la cartera activa"
//      por accidente, como pidió Roberto explícitamente).
//   4) Si está activo el modo "todos" -> se procesa, salvo que sea más viejo que la fecha de corte (no se
//      reconstruyen automáticamente etapas anteriores a la activación).
function siniestroElegible(db, siniestro){
  if(!siniestro) return false;
  if(!activacionHabilitada(db)) return false;
  const piloto = listaPiloto(db);
  if(piloto.includes(String(siniestro.numero))) return true;
  if(!modoPilotoTodos(db)) return false;
  const corte = fechaCorte(db);
  if(corte && siniestro.creado_en && String(siniestro.creado_en) < corte) return false;
  return true;
}

// Procedimiento de reversión del piloto -- REDISEÑADO (octava revisión, Roberto, punto 1). El diseño
// anterior borraba TODAS las filas de los expedientes indicados, sin importar cuándo se hubieran creado --
// eso podía borrar datos de una corrida anterior del piloto sobre el mismo expediente, o (en el futuro,
// una vez autorizada la operación real) datos legítimos anteriores al piloto. Ahora la reversión exige un
// piloto_run_id y borra EXCLUSIVAMENTE las filas que ese identificador de corrida generó -- nunca toca
// otro expediente, otra corrida, ni ninguna tabla de Daniela/Alejandra. Corre dentro de una transacción:
// si cualquiera de los tres DELETE fallara, no queda ningún borrado parcial.
//
// Acepta dos formas de llamada por compatibilidad: revertirDatosPiloto(db, ['NUM1','NUM2']) (arreglo de
// números -- usa la corrida ACTUAL, pilotoRunActual()) o revertirDatosPiloto(db, { numeros, runId }) para
// especificar explícitamente qué corrida revertir (p. ej. una corrida ya detenida, distinta de la actual).
// Si no hay ninguna corrida identificable (nunca se llamó iniciarPilotoRun), no borra nada -- por
// seguridad: sin un piloto_run_id no hay forma de distinguir "esto lo generó el piloto" de cualquier otra
// fila, así que la opción segura es no tocar nada en vez de adivinar.
function revertirDatosPiloto(db, opts){
  let numeros, runId;
  if(Array.isArray(opts)){ numeros = opts; runId = undefined; }
  else if(opts && typeof opts === 'object'){ numeros = opts.numeros; runId = opts.runId; }
  numeros = (Array.isArray(numeros) && numeros.length) ? numeros : listaPiloto(db);
  if(runId === undefined || runId === null || runId === '') runId = pilotoRunActual(db);
  if(!numeros.length){
    return { eventosBorrados:0, comunicacionesBorradas:0, erroresBorrados:0, expedientes:[], runId: runId || null };
  }
  if(!runId){
    return { eventosBorrados:0, comunicacionesBorradas:0, erroresBorrados:0, expedientes:numeros, runId:null,
      motivo:'No hay ninguna ejecución de piloto identificada (piloto_run_id) para revertir -- no se borra nada por seguridad.' };
  }
  const ph = numeros.map(()=>'?').join(',');
  const ids = db.prepare(`SELECT id FROM siniestros WHERE numero IN (${ph})`).all(...numeros).map(r=>r.id);
  if(!ids.length) return { eventosBorrados:0, comunicacionesBorradas:0, erroresBorrados:0, expedientes:numeros, runId };
  const idPh = ids.map(()=>'?').join(',');
  let eventosBorrados = 0, comunicacionesBorradas = 0, erroresBorrados = 0;
  db.exec('BEGIN');
  try{
    eventosBorrados = db.prepare(`DELETE FROM whatsapp_eventos_registrados WHERE siniestro_id IN (${idPh}) AND piloto_run_id = ?`).run(...ids, runId).changes;
    comunicacionesBorradas = db.prepare(`DELETE FROM whatsapp_comunicaciones_manuales WHERE siniestro_id IN (${idPh}) AND piloto_run_id = ?`).run(...ids, runId).changes;
    erroresBorrados = db.prepare(`DELETE FROM whatsapp_errores WHERE siniestro_id IN (${idPh}) AND piloto_run_id = ?`).run(...ids, runId).changes;
    db.exec('COMMIT');
  } catch(e){
    db.exec('ROLLBACK');
    throw e;
  }
  return { eventosBorrados, comunicacionesBorradas, erroresBorrados, expedientes:numeros, runId };
}

// Apagado total inmediato (no solo el piloto): activo='0'. La instrucción más simple para "detener todo
// ya" -- una fila de configuración, sin redeploy; el scheduler lo recoge en su siguiente ciclo (máximo 15
// minutos) y cualquier hook inmediato (una acción de Alejandra/Orlando/Beto en el tablero) lo respeta al
// instante, porque cada punto de entrada relee la tabla en cada llamada.
function desactivar(db){
  db.prepare(`INSERT INTO whatsapp_config (clave,valor) VALUES ('activo','0')
    ON CONFLICT(clave) DO UPDATE SET valor='0'`).run();
}

function establecerConfig(db, clave, valor){
  const CLAVES_VALIDAS = ['activo','piloto_todos','piloto_numeros','fecha_corte'];
  if(!CLAVES_VALIDAS.includes(clave)) throw new Error('Clave de configuración desconocida: ' + clave);
  db.prepare(`INSERT INTO whatsapp_config (clave,valor) VALUES (?,?)
    ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor`).run(clave, String(valor==null?'':valor));
}

module.exports = {
  leerConfig, activacionHabilitada, modoPilotoTodos, listaPiloto, fechaCorte,
  pilotoRunActual, iniciarPilotoRun,
  siniestroElegible, revertirDatosPiloto, desactivar, establecerConfig,
};
