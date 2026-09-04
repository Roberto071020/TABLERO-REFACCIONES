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

// Procedimiento de reversión del piloto (punto 1): borra ÚNICAMENTE los datos generados para los
// expedientes indicados -- nunca toca nada de otro expediente ni de las tablas de Daniela/Alejandra. Si no
// se pasa una lista explícita, usa la lista de piloto configurada actualmente.
function revertirDatosPiloto(db, numeros){
  const lista = (Array.isArray(numeros) && numeros.length) ? numeros : listaPiloto(db);
  if(!lista.length) return { eventosBorrados:0, comunicacionesBorradas:0, erroresBorrados:0, expedientes:[] };
  const ph = lista.map(()=>'?').join(',');
  const ids = db.prepare(`SELECT id FROM siniestros WHERE numero IN (${ph})`).all(...lista).map(r=>r.id);
  if(!ids.length) return { eventosBorrados:0, comunicacionesBorradas:0, erroresBorrados:0, expedientes:lista };
  const idPh = ids.map(()=>'?').join(',');
  const eventosBorrados = db.prepare(`DELETE FROM whatsapp_eventos_registrados WHERE siniestro_id IN (${idPh})`).run(...ids).changes;
  const comunicacionesBorradas = db.prepare(`DELETE FROM whatsapp_comunicaciones_manuales WHERE siniestro_id IN (${idPh})`).run(...ids).changes;
  const erroresBorrados = db.prepare(`DELETE FROM whatsapp_errores WHERE siniestro_id IN (${idPh})`).run(...ids).changes;
  return { eventosBorrados, comunicacionesBorradas, erroresBorrados, expedientes:lista };
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
  siniestroElegible, revertirDatosPiloto, desactivar, establecerConfig,
};
