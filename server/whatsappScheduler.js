// ===================== WhatsApp Fase A -- barrido programado independiente (punto 1, quinta revisión) =====
// Roberto (3-sep-2026, quinta revisión): la automatización no puede depender de que alguien abra el
// resumen diario -- si nadie lo abre durante horas o días, los eventos se registrarían tarde o no se
// registrarían cuando corresponde. Este módulo corre por sí solo, sin depender de ninguna pantalla, con:
//   - Tarea programada del servidor (setInterval, mismo patrón ya usado por server/backup.js).
//   - Zona horaria de Ciudad de México (heredada de whatsappFaseA.js, que ya usa America/Mexico_City).
//   - Protección contra ejecuciones simultáneas (bandera en memoria -- ver nota más abajo sobre por qué
//     eso es suficiente aquí).
//   - Registro de cada ejecución (tabla whatsapp_scheduler_ejecuciones: cuándo empezó, cuándo terminó,
//     si falló y por qué, quién la disparó).
//   - Recuperación después de una caída o reinicio: al arrancar, corre una vez de inmediato (por si el
//     proceso estuvo caído) y limpia cualquier ejecución previa que se haya quedado "corriendo" para
//     siempre por una caída a media ejecución.
//   - Idempotencia: hereda la de whatsappFaseA.js (cada registro usa una clave de deduplicación fija) --
//     correr el barrido dos veces nunca duplica nada.
//   - Alerta si el proceso deja de ejecutarse: ver detectarYAlertarAtraso(), llamada como respaldo desde
//     el resumen diario (sección "qué NO hace este módulo" más abajo explica por qué no puede ser 100%
//     autónoma sin un servicio de monitoreo externo).
//
// Nota sobre la "protección de ejecuciones simultáneas": todas las funciones de whatsappFaseA.js son
// síncronas (usan node:sqlite de forma síncrona, sin async/await). JavaScript es de un solo hilo, así que
// DENTRO de un mismo proceso Node.js es estructuralmente imposible que el temporizador dispare una segunda
// ejecución mientras la primera sigue corriendo -- el bucle de eventos no libera el control hasta que la
// función síncrona actual termina. El riesgo real y distinto es que el barrido programado y una llamada
// humana al resumen diario (que también reconcilia, como respaldo) coincidan en el mismo instante; para
// ESE caso sí sirve la bandera en memoria de abajo.
//
// Qué NO hace este módulo (límites, igual que whatsappFaseA.js): no hace ninguna llamada HTTP externa, no
// envía nada real, no modifica ninguna tabla de Daniela/Alejandra, no agrega ninguna pantalla nueva.
//
// Punto 10 (sexta revisión, 4-sep-2026): investigación real del servicio en Render antes de confiar en
// setInterval como mecanismo -- consultada directamente vía la API de Render (solo lectura, sin cambiar
// nada, como pidió Roberto explícitamente: "no cambies el plan ni contrates servicios"). Hallazgos del
// servicio real "tablero-refacciones" (srv-da1lh6v40ujc73btvvpg):
//   - plan: "starter" (de pago) -- a diferencia del plan gratuito de Render, el plan starter NO suspende
//     el servicio por inactividad. Un setInterval en memoria SÍ es viable aquí porque el proceso Node no
//     se apaga solo entre peticiones -- en el plan gratuito habría sido inviable (el proceso se duerme y
//     el temporizador se pierde con él).
//   - numInstances: 1 -- una sola instancia corriendo. Esto es justo lo que permite que la deduplicación
//     por clave fija sea suficiente: si hubiera más de una instancia, dos procesos Node distintos podrían
//     disparar el mismo barrido al mismo tiempo en paralelo real (ahí la bandera en memoria de este
//     archivo YA NO alcanzaría, porque cada instancia tiene su propia memoria) -- no es el caso hoy.
//   - autoDeploy: solo desde la rama "main" (autoDeployTrigger: "commit" sobre branch "main"). La rama de
//     este módulo, whatsapp-fase-a-solo-registro, NO dispara ningún despliegue -- confirma, desde el lado
//     de Render (no solo desde git), que nada de este trabajo llega a producción sin una acción explícita.
//   - El proceso SÍ se reinicia en cada nuevo despliegue de main (visto en el historial de deploys) -- el
//     diseño de recuperación tras caída/reinicio de este módulo (correr una vez de inmediato al arrancar,
//     limpiarEjecucionesColgadas) ya cubre exactamente ese caso, confirmado con datos reales, no solo en
//     teoría.
// Conclusión: el diseño actual (setInterval + registro en disco + protección de concurrencia en memoria)
// es viable con la configuración REAL de Render, sin necesitar un servicio de cron externo ni cambiar de
// plan. Si en el futuro se aumentara a más de una instancia (no es el caso hoy), este diseño SÍ tendría que
// revisarse -- se deja documentado para cuando corresponda, no se implementa una protección que hoy no
// hace falta.

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);
const whatsappFaseA = require('./whatsappFaseA');

const INTERVALO_MS_DEFAULT = 15 * 60 * 1000; // cada 15 minutos
const UMBRAL_ATRASO_MINUTOS = 45; // 3x el intervalo esperado -- a partir de aquí se considera "atrasado"

let corriendoAhora = false;

// Autosanación: una fila que sigue en 'corriendo' después de más tiempo del que una ejecución síncrona
// puede tardar nunca es una ejecución real en curso -- solo puede ser el rastro de una caída del proceso
// a media ejecución. Se marca 'fallido' para no confundir la lectura del historial ni el cálculo de atraso.
function limpiarEjecucionesColgadas(db){
  const limite = dayjs.utc().subtract(UMBRAL_ATRASO_MINUTOS, 'minute').format('YYYY-MM-DD HH:mm:ss');
  db.prepare(`UPDATE whatsapp_scheduler_ejecuciones SET estado='fallido', terminado_en=datetime('now'),
    error='No se registró un cierre normal (posible caída o reinicio del proceso a media ejecución); marcada automáticamente al detectarla.'
    WHERE estado='corriendo' AND iniciado_en < ?`).run(limite);
}

// Núcleo del barrido: agrupa TODO lo que hoy corre "cuando alguien abre el resumen diario" -- continuidad
// de 72h/postventa, revisión de bloqueados resueltos, reconciliación del ciclo principal (reintento
// seguro), y la revalidación de eventos liberados antes de un futuro envío (punto 5). Se puede llamar
// tantas veces como se quiera: cada pieza interna ya es idempotente por su propia clave de deduplicación.
function ejecutarBarridoProgramado(db, { disparadoPor = 'scheduler' } = {}){
  if(corriendoAhora){
    return { omitido:true, motivo:'Ya hay una ejecución en curso en este mismo proceso (protección de concurrencia).' };
  }
  corriendoAhora = true;
  try{
    limpiarEjecucionesColgadas(db);
    const info = db.prepare(`INSERT INTO whatsapp_scheduler_ejecuciones (iniciado_en, estado, disparado_por) VALUES (datetime('now'), 'corriendo', ?)`).run(disparadoPor);
    const ejecucionId = info.lastInsertRowid;
    try{
      whatsappFaseA.barrerContinuidadYPostventa(db);
      whatsappFaseA.revisarBloqueadosResueltos(db);
      whatsappFaseA.reconciliarEventosPrincipales(db);
      whatsappFaseA.revalidarEventosLiberados(db);
      db.prepare(`UPDATE whatsapp_scheduler_ejecuciones SET estado='completado', terminado_en=datetime('now') WHERE id=?`).run(ejecucionId);
      return { omitido:false, ejecucionId, estado:'completado' };
    } catch(e){
      db.prepare(`UPDATE whatsapp_scheduler_ejecuciones SET estado='fallido', terminado_en=datetime('now'), error=? WHERE id=?`)
        .run(String((e && e.message) || e).slice(0,500), ejecucionId);
      whatsappFaseA.registrarError(db, { contexto:'scheduler:ejecutarBarridoProgramado', error:e });
      return { omitido:false, ejecucionId, estado:'fallido', error: e.message };
    }
  } finally {
    corriendoAhora = false;
  }
}

// Estado consultable del scheduler (para el endpoint de solo lectura y para detectarYAlertarAtraso).
function estadoScheduler(db){
  const ultima = db.prepare(`SELECT * FROM whatsapp_scheduler_ejecuciones ORDER BY id DESC LIMIT 1`).get();
  if(!ultima) return { ultimaEjecucion:null, minutosDesdeUltima:null, atrasado:false, nuncaHaCorrido:true };
  const minutos = dayjs.utc().diff(dayjs.utc(ultima.iniciado_en), 'minute');
  return { ultimaEjecucion: ultima, minutosDesdeUltima: minutos, atrasado: minutos > UMBRAL_ATRASO_MINUTOS, nuncaHaCorrido:false };
}

// Respaldo de detección de atraso (punto 1: "alerta si el proceso deja de ejecutarse"). Sin un servicio de
// monitoreo externo (fuera de alcance de "solo registro", y requeriría una llamada saliente que este
// módulo tiene prohibido hacer), la única forma honesta de detectar que el propio proceso dejó de
// ejecutarse es que ALGO MÁS lo revise -- aquí se aprovecha que el resumen diario ya se abre rutinariamente
// (por Daniela o admin) para hacer esa comprobación como respaldo, NO como mecanismo principal (el
// mecanismo principal sigue siendo el setInterval de iniciarSchedulerWhatsApp).
function detectarYAlertarAtraso(db){
  try{
    const estado = estadoScheduler(db);
    if(estado.nuncaHaCorrido) return; // el proceso recién arrancó; dale tiempo antes de alarmar.
    if(estado.atrasado){
      whatsappFaseA.registrarError(db, {
        contexto:'scheduler:atraso', siniestroId:null, plantillaCodigo:null,
        error:new Error(`El barrido programado de WhatsApp Fase A no corre desde hace ${estado.minutosDesdeUltima} minutos (umbral: ${UMBRAL_ATRASO_MINUTOS}).`),
      });
    }
  } catch(e){ whatsappFaseA.registrarError(db, { contexto:'scheduler:detectarYAlertarAtraso', error:e }); }
}

// Se llama una vez al arrancar el servidor (mismo patrón que server/backup.js). Corre de inmediato
// (recuperación tras una caída/reinicio: si el proceso estuvo abajo, no hay que esperar 15 minutos más
// para ponerse al día) y programa la ejecución periódica. Se omite por completo durante las pruebas
// automatizadas para no dejar temporizadores activos que compliquen el cierre del test runner -- las
// pruebas llaman ejecutarBarridoProgramado() directamente, sin pasar por el temporizador.
function iniciarSchedulerWhatsApp(db, { intervaloMs = INTERVALO_MS_DEFAULT } = {}){
  if(process.env.TEST_DB_PATH) return null;
  ejecutarBarridoProgramado(db, { disparadoPor:'arranque' });
  const intervalo = setInterval(() => ejecutarBarridoProgramado(db, { disparadoPor:'scheduler' }), intervaloMs);
  intervalo.unref();
  return intervalo;
}

module.exports = {
  INTERVALO_MS_DEFAULT, UMBRAL_ATRASO_MINUTOS,
  ejecutarBarridoProgramado, estadoScheduler, detectarYAlertarAtraso, iniciarSchedulerWhatsApp,
};
