// Endpoint de solo lectura / revisión explícita, exclusivo para admin, para verificar el modo "solo
// registro" de WhatsApp Fase A (autorizado por Roberto, 3-sep-2026, ampliado en la quinta revisión el
// mismo día). No está enlazado desde ninguna pantalla del frontend -- es una herramienta de
// verificación/revisión, no un componente nuevo expuesto a ningún rol operativo. La acción de revisión
// (PATCH) NUNCA envía nada real: solo mueve un evento de "pendiente_revision" (o, para una alerta interna,
// "registrado") a "descartado" o "liberado_para_programacion", con justificación obligatoria.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const whatsappFaseA = require('../whatsappFaseA');
const whatsappScheduler = require('../whatsappScheduler');
const whatsappWebhook = require('../whatsappWebhook');
const activacion = require('../whatsappFaseAActivacion');
const router = express.Router();

// LEFT JOIN (no INNER): un evento puede ser una alerta de SISTEMA (punto 1/2, quinta revisión) sin
// siniestro_id -- con INNER JOIN esas filas desaparecerían silenciosamente de este listado.
router.get('/eventos', requireAuth, requireRole('admin'), (req, res)=>{
  const { siniestro_id, plantilla_codigo, estado, limit } = req.query;
  let sql = `SELECT e.*, s.numero AS siniestro_numero FROM whatsapp_eventos_registrados e
             LEFT JOIN siniestros s ON s.id = e.siniestro_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND e.siniestro_id = ?'; params.push(siniestro_id); }
  if(plantilla_codigo){ sql += ' AND e.plantilla_codigo = ?'; params.push(plantilla_codigo); }
  if(estado){ sql += ' AND e.estado = ?'; params.push(estado); }
  sql += ' ORDER BY e.creado_en DESC LIMIT ?';
  params.push(Math.min(Number(limit)||200, 1000));
  const filas = db.prepare(sql).all(...params);
  // Enriquecer las alertas internas con su catálogo (punto 2, quinta revisión): nombre legible, prioridad
  // ya guardada en la fila, responsable sugerido y regla de cierre -- estas dos últimas no se guardan por
  // fila (son propiedades del TIPO de alerta, no de cada instancia), se calculan aquí para la lectura.
  const enriquecidas = filas.map(f => {
    if(f.es_plantilla_meta === 0 && whatsappFaseA.EVENTOS_INTERNOS[f.plantilla_codigo]){
      const cat = whatsappFaseA.EVENTOS_INTERNOS[f.plantilla_codigo];
      return { ...f, alerta_nombre: cat.nombre, alerta_responsable_sugerido: cat.responsableSugerido, alerta_regla_cierre: cat.reglaCierre };
    }
    return f;
  });
  res.json(enriquecidas);
});

router.get('/errores', requireAuth, requireRole('admin'), (req, res)=>{
  const { resuelto, limit } = req.query;
  let sql = `SELECT er.*, s.numero AS siniestro_numero FROM whatsapp_errores er
             LEFT JOIN siniestros s ON s.id = er.siniestro_id WHERE 1=1`;
  const params = [];
  // Ojo: "resuelto=0" en query string es un string NO vacío ("0"), por lo tanto truthy en JS -- no se
  // puede usar `resuelto ? 1 : 0` (convertiría "0" en 1). Se compara explícitamente contra el string '0'.
  if(resuelto !== undefined){ sql += ' AND er.resuelto = ?'; params.push(resuelto === '0' || resuelto === 0 || resuelto === false ? 0 : 1); }
  sql += ' ORDER BY er.ultimo_intento_en DESC LIMIT ?';
  params.push(Math.min(Number(limit)||200, 1000));
  res.json(db.prepare(sql).all(...params));
});

// Punto 1 (quinta revisión): estado consultable del barrido programado -- última ejecución, hace cuánto
// corrió, y si está atrasado. Solo lectura, admin, sin pantalla.
router.get('/scheduler', requireAuth, requireRole('admin'), (req, res)=>{
  const { limit } = req.query;
  const estado = whatsappScheduler.estadoScheduler(db);
  const historial = db.prepare('SELECT * FROM whatsapp_scheduler_ejecuciones ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit)||20, 200));
  res.json({ ...estado, historial });
});

// Punto 9 (sexta revisión): el POST manual que existía aquí en la quinta entrega (que exigía que alguien
// -- Alejandra o quien fuera -- decidiera a mano "informativa_avance" vs "administrativa" cada vez) se
// RETIRÓ deliberadamente: es exactamente la carga operativa que Roberto rechazó ("sin agregar trabajo").
// Se investigó la documentación oficial de Meta antes de rediseñar: la API de Coexistencia SÍ expone el
// evento necesario (webhook "smb_message_echoes", disparado automáticamente por cada mensaje que se manda
// desde la app de WhatsApp Business) -- ver el comentario completo sobre registrarComunicacionSaliente()
// en server/whatsappFaseA.js. Ese webhook real todavía no existe en este modo (sigue sin vincularse ningún
// número real, límite duro sin cambios), así que por ahora NO hay ningún endpoint público que reciba esto
// -- la función vive lista y probada, para conectarse al webhook real el día que Roberto lo autorice, sin
// necesitar ningún endpoint de captura manual ni ninguna pantalla nueva para Alejandra.
// Se conserva el GET de solo lectura (admin, sin pantalla) para poder auditar lo que se haya registrado.
router.get('/comunicaciones-manuales', requireAuth, requireRole('admin'), (req, res)=>{
  const { siniestro_id, limit } = req.query;
  let sql = `SELECT c.*, s.numero AS siniestro_numero FROM whatsapp_comunicaciones_manuales c
             JOIN siniestros s ON s.id = c.siniestro_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND c.siniestro_id = ?'; params.push(siniestro_id); }
  sql += ' ORDER BY c.registrado_en DESC LIMIT ?';
  params.push(Math.min(Number(limit)||200, 1000));
  res.json(db.prepare(sql).all(...params));
});

// Acción explícita de revisión humana. Requiere justificación. Nunca envía nada real. Sirve tanto para
// eventos bloqueados de cliente (pendiente_revision -> descartado/liberado_para_programacion) como para
// cerrar una alerta interna (registrado -> descartado; ver resolverPendienteRevision para el detalle).
router.patch('/eventos/:id/revision', requireAuth, requireRole('admin'), (req, res)=>{
  const { decision, justificacion } = req.body;
  try{
    const evento = whatsappFaseA.resolverPendienteRevision(db, {
      eventoId: req.params.id, decision, justificacion, usuarioId: req.session.user.id,
    });
    res.json(evento);
  } catch(e){
    res.status(400).json({ error: e.message });
  }
});

// ===================== Punto 1 (séptima revisión): activación controlada, solo lectura/escritura admin =====
// GET expone la configuración actual (activo, piloto_todos, piloto_numeros, fecha_corte). PATCH la
// modifica -- una sola instrucción HTTP (o SQL directo, ver whatsappFaseAActivacion.js) para prender,
// apagar, o ajustar el piloto, sin redeploy: el scheduler relee esta tabla en cada ciclo (máximo 15 min) y
// cualquier acción del tablero la respeta al instante (cada hook la relee en cada llamada).
router.get('/config', requireAuth, requireRole('admin'), (req, res)=>{
  res.json(activacion.leerConfig(db));
});
router.patch('/config', requireAuth, requireRole('admin'), (req, res)=>{
  const CLAVES_VALIDAS = ['activo','piloto_todos','piloto_numeros','fecha_corte'];
  const cambios = {};
  try{
    for(const clave of CLAVES_VALIDAS){
      if(req.body[clave] !== undefined){
        activacion.establecerConfig(db, clave, req.body[clave]);
        cambios[clave] = req.body[clave];
      }
    }
    if(Object.keys(cambios).length === 0){
      return res.status(400).json({ error: 'No se envió ninguna clave válida. Usa: ' + CLAVES_VALIDAS.join(', ') + '.' });
    }
    res.json({ actualizado: cambios, configActual: activacion.leerConfig(db) });
  } catch(e){
    res.status(400).json({ error: e.message });
  }
});
// Procedimiento de reversión del piloto (punto 1): borra ÚNICAMENTE los datos generados para los
// expedientes indicados (o los de la lista de piloto configurada actualmente, si no se especifica ninguno).
router.post('/config/revertir-piloto', requireAuth, requireRole('admin'), (req, res)=>{
  // Octava revisión (punto 1): admite runId explícito para revertir una corrida concreta (p. ej. una ya
  // detenida); si no se especifica, revertirDatosPiloto usa la corrida ACTUAL (pilotoRunActual()). Sin
  // ninguna corrida identificable, no borra nada -- ver el comentario de seguridad en
  // whatsappFaseAActivacion.js.
  const { numeros, runId } = req.body || {};
  const resultado = activacion.revertirDatosPiloto(db, { numeros: Array.isArray(numeros) ? numeros : undefined, runId });
  res.json(resultado);
});
// Octava revisión (punto 1): inicia una nueva corrida de piloto identificable (piloto_run_id). Se llama
// explícitamente antes de activar el piloto -- así, cada corrida queda etiquetada por separado y se puede
// revertir sin arrastrar datos de una corrida anterior sobre el mismo expediente.
router.post('/config/nuevo-piloto-run', requireAuth, requireRole('admin'), (req, res)=>{
  const runId = activacion.iniciarPilotoRun(db);
  res.json({ runId });
});

// ===================== Punto 3 (séptima revisión): webhook de Coexistencia (smb_message_echoes) ==========
// NO requiere sesión (Meta no tiene una) -- se autentica exclusivamente con la firma HMAC del header
// X-Hub-Signature-256, calculada sobre el cuerpo crudo (req.rawBody, capturado en server/index.js). Sin
// WHATSAPP_APP_SECRET configurado (nunca lo está hoy: no hay número real vinculado), rechaza TODO --
// estructuralmente inerte hasta que Roberto autorice la vinculación real y se configure el secreto real.
router.post('/webhooks/echo', (req, res)=>{
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if(!appSecret){
    return res.status(503).json({ error: 'Webhook no configurado (falta WHATSAPP_APP_SECRET) -- este módulo sigue sin vincular ningún número real.' });
  }
  const firma = req.headers['x-hub-signature-256'];
  if(!whatsappWebhook.verificarFirma(appSecret, req.rawBody, firma)){
    return res.status(401).json({ error: 'Firma inválida.' });
  }
  try{
    const resultado = whatsappWebhook.procesarEventoEcho(db, req.body);
    res.json(resultado);
  } catch(e){
    whatsappFaseA.registrarError(db, { contexto:'webhook:echo', error:e });
    // 200 a propósito: si Meta recibe un error, reintenta agresivamente el mismo webhook -- el error ya
    // quedó auditado en whatsapp_errores, no hace falta provocar una tormenta de reintentos por lo mismo.
    res.status(200).json({ procesado:false, motivo:'Error interno, registrado para revisión técnica.' });
  }
});

module.exports = router;
