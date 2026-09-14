// ===================== WhatsApp -- bandeja manual asistida (rama aislada whatsapp-bandeja-manual) =====
// Autorización de Roberto (14-sep-2026): construir, en una rama aislada y sin desplegar, una bandeja MUY
// simple para que Alejandra (atencion_cliente), Vanessa (vanessa) y Daniela (operativo) empiecen a usar
// YA los mensajes que el motor de WhatsApp Fase A (server/whatsappFaseA.js) ya detecta y registra,
// enviándolos a mano por WhatsApp Web (enlace wa.me) -- SIN 360dialog, SIN credenciales, SIN API, SIN WABA.
//
// LÍMITES DUROS (no removerlos sin autorización explícita de Roberto):
//   - Este archivo NUNCA modifica server/whatsappFaseA.js, server/whatsappFaseAActivacion.js,
//     server/whatsappScheduler.js, server/whatsappWebhook.js ni server/whatsappProviders/* -- los USA
//     (whatsapp_eventos_registrados, validarAntesDeEnviar, etc.), nunca los toca.
//   - Este archivo JAMÁS hace una llamada HTTP real a WhatsApp/Meta. El único "envío" es abrir, en el
//     navegador de la persona, el enlace oficial https://wa.me/<telefono>?text=<texto> -- la persona
//     manda el mensaje ella misma, con su propia sesión de WhatsApp Web.
//   - El texto que se prepara es EXACTAMENTE el texto acordado de la plantilla (ver PLANTILLAS_TEXTO),
//     firmado únicamente como Servicio Cristian -- nunca se le agrega el nombre de quien lo envía, ni
//     ninguna nota interna.
//
// Diseño de la cola (whatsapp_envios_manuales, ver server/db.js):
//   - Cada fila es el intento de envío MANUAL de un evento concreto de whatsapp_eventos_registrados
//     (evento_id es UNIQUE): un mensaje confirmado ('enviado') no puede volver a reclamarse ni duplicarse
//     -- estructural, no depende de que nadie recuerde revisar nada.
//   - 'pendiente' -> 'reservado' (reclamar, con vencimiento) -> 'enviado' (confirmar Sí) o de vuelta a
//     'pendiente' (confirmar No, o la reserva expira sola) -> 'cancelado' (la etapa del expediente cambió,
//     o el expediente ya no está activo, antes de que alguien alcanzara a enviarlo -- punto 10 de Roberto).
//   - Un evento que sigue bloqueado (incidencia delicada, teléfono inválido, o que nació 'bloqueado' /
//     'pendiente_revision' en el motor de detección) NUNCA se cancela por eso solo: se muestra en la
//     misma lista, de forma informativa, sin botón de envío -- exactamente como lo pidió Roberto.

const whatsappFaseA = require('./whatsappFaseA');

const ROLES_ENVIO = ['atencion_cliente', 'vanessa', 'operativo'];
const RESERVA_TTL_MINUTOS = 10; // "periodo breve y seguro" -- alcanza para abrir WhatsApp Web, pegar y enviar.

// ----- Catálogo de texto EXACTO de las 18 plantillas -----------------------------------------------------
// Fuente: "SC CONTROL - Fase A WhatsApp - Segunda entrega (correcciones y fuentes oficiales).docx", tabla
// de las 18 plantillas (columna "Texto exacto"). El texto de 5.1 se reemplaza por la versión VIGENTE de
// "SC CONTROL - Fase A WhatsApp - Tercera entrega (diseño técnico...).docx" (sección "5.1 BIENVENIDA (texto
// vigente)"), que Roberto corrigió después para agregar el canal preferente. Ninguna otra plantilla cambió
// en entregas posteriores. Copiado tal cual, sin modificar una sola palabra -- "el texto enviado debe ser
// exactamente la plantilla acordada".
const PLANTILLAS_TEXTO = {
  '5.1': 'Hola, [Nombre]. Te damos la bienvenida a Servicio Cristian. Hemos registrado tu unidad [Vehículo] y, a partir de este momento, te mantendremos informado por este chat individual sobre los avances importantes de tu proceso. Si tienes alguna duda sobre estos avisos, puedes responder directamente por este mismo medio. Gracias por tu confianza.',
  '5.2': 'Tu unidad ya fue revisada y el presupuesto correspondiente fue enviado a autorización de la compañía de seguros. Este proceso puede tomar hasta 72 horas. En cuanto tengamos una respuesta, te lo haremos saber.',
  '5.3': 'Tenemos autorización para continuar con el proceso de tu unidad. En este momento nos encontramos dando seguimiento a la asignación y surtido de las refacciones necesarias. Te mantendremos informado conforme tengamos avances.',
  '5.4': 'Ya contamos con las refacciones necesarias para continuar con el proceso de tu unidad. Es momento de programar su reingreso al taller. Nos pondremos en contacto contigo para acordar la fecha de ingreso.',
  '5.5': 'Ya contamos con las refacciones necesarias para continuar con el proceso de tu unidad. A partir de este momento será asignada para iniciar su proceso de reparación. Te mantendremos informado sobre sus avances.',
  '5.6': 'La reparación de tu unidad ya se encuentra autorizada. A partir de este momento será asignada para iniciar su proceso de reparación. Te mantendremos informado sobre sus avances.',
  '5.7': 'La reparación de tu unidad ya se encuentra autorizada. Es momento de coordinar su reingreso al taller para continuar con el proceso. Nos pondremos en contacto contigo para acordar la fecha.',
  '5.8': 'Tu unidad ya se encuentra en proceso de hojalatería. Continuaremos informándote conforme avance por las siguientes etapas de reparación. En caso de que tu siniestro aplique deducible, te sugerimos ir gestionando su pago para facilitar la entrega cuando tu unidad esté lista.',
  '5.9': 'Tu unidad ha avanzado a proceso de pintura. Continuamos trabajando en ella y te mantendremos informado sobre los siguientes avances.',
  '5.10': 'Tu unidad ha concluido las principales etapas de reparación y se encuentra en nuestro proceso de revisión de calidad. Estamos verificando los trabajos realizados antes de confirmar que está lista para entrega.',
  '5.11': 'Nos complace informarte que tu unidad está lista para entrega. Nos pondremos en contacto contigo para coordinarla. Para la entrega te pedimos traer identificación oficial (INE), el inventario que te fue entregado al ingreso y, en caso de aplicar deducible, el comprobante de pago correspondiente.',
  '5.12': 'Hola, [Nombre]. Queremos dar seguimiento a la reparación de tu unidad después de su entrega. Esperamos que todo se encuentre correctamente. Si tienes cualquier comentario u observación, por favor escríbenos por este medio. Seguimos a tus órdenes y agradecemos tu confianza en Servicio Cristian.',
  '6.1': 'Hola, [Nombre]. Queremos mantenerte informado sobre tu unidad [Vehículo]. Actualmente continuamos en espera de la autorización correspondiente. Seguimos dando seguimiento al proceso y te notificaremos en cuanto tengamos una actualización.',
  '6.2': 'Hola, [Nombre]. Queremos mantenerte informado sobre tu unidad. La reparación se encuentra autorizada y actualmente continuamos dando seguimiento a la asignación y/o surtido de las refacciones necesarias. Te informaremos en cuanto tengamos un avance importante.',
  '6.3': 'Hola, [Nombre]. Queremos mantenerte informado sobre tu unidad. Actualmente se encuentra pendiente de asignación para continuar con su proceso de reparación. Seguimos dando seguimiento y te informaremos cuando inicie la siguiente etapa.',
  '6.4': 'Hola, [Nombre]. Tu unidad continúa en proceso de hojalatería. Seguimos trabajando en esta etapa y te notificaremos cuando avance al siguiente proceso.',
  '6.5': 'Hola, [Nombre]. Tu unidad continúa en proceso de pintura. Seguimos trabajando en ella y te notificaremos cuando avance a la siguiente etapa.',
  '6.6': 'Hola, [Nombre]. Tu unidad continúa en proceso de revisión de calidad. Estamos verificando los trabajos realizados antes de confirmar que se encuentra lista para entrega. Te mantendremos informado.',
};

// Sustituye [Nombre] y [Vehículo]/[Vehiculo] (con o sin acento -- las dos formas aparecen en el catálogo
// fuente) por las variables reales del expediente. Si una variable llega vacía, se deja un texto neutro
// en vez de una plantilla rota con corchetes visibles para el cliente.
function renderTexto(codigo, variables){
  const plantilla = PLANTILLAS_TEXTO[codigo];
  if(!plantilla) return null;
  const nombre = (variables && variables.nombre && String(variables.nombre).trim()) || 'estimado cliente';
  const vehiculo = (variables && variables.vehiculo && String(variables.vehiculo).trim()) || 'tu unidad';
  return plantilla
    .replace(/\[Nombre\]/g, nombre)
    .replace(/\[Veh[ií]culo\]/g, vehiculo);
}

function registrarHistorial(db, envioId, evento, usuarioId, detalle){
  db.prepare(`INSERT INTO whatsapp_envios_manuales_historial (envio_id, evento, usuario_id, detalle) VALUES (?,?,?,?)`)
    .run(envioId, evento, usuarioId || null, detalle || null);
}

// Reutiliza EXACTAMENTE whatsappFaseA.validarAntesDeEnviar (el diseño, ya construido y probado, de la
// comprobación final antes de un envío real) -- nunca se reimplementa esa lógica aquí. La única diferencia
// es cómo se interpreta un rechazo por horario: al MATERIALIZAR/LISTAR la bandeja (exigirHorario:false) un
// mensaje fuera de horario se sigue mostrando como accionable (para que el equipo pueda prepararlo), pero
// al RECLAMAR de verdad (exigirHorario:true, el valor por defecto) el horario síse exige, igual que en
// cualquier envío real -- Roberto pidió explícitamente "reutilizar... horarios ya construidos".
function evaluarVigencia(db, eventoId, { exigirHorario = true } = {}){
  const v = whatsappFaseA.validarAntesDeEnviar(db, eventoId);
  if(v.puedeEnviarse) return v;
  if(!exigirHorario && v.motivo === 'Fuera del horario permitido de envío (L-V 9-18, Sáb 9-14).'){
    return { puedeEnviarse: true, motivo: null, fueraDeHorario: true };
  }
  return v;
}

function esCambioDeEtapaOExpedienteInactivo(motivo){
  if(!motivo) return false;
  // whatsappFaseA.validarAntesDeEnviar usa DOS textos distintos para "la etapa ya no corresponde", según
  // el tipo de plantilla: uno para continuidad (6.x, "La etapa cambió: ...") y otro para el ciclo
  // principal (5.x, "La condición que originó... ya no se cumple..."). Ambos son, en sustancia, el mismo
  // caso del punto 10 de Roberto -- se reconocen los dos, sin reescribir ni un carácter de esos textos.
  return motivo.startsWith('La etapa cambió')
    || motivo.startsWith('La condición que originó')
    || motivo === 'El expediente ya no está activo (cerrado o archivado).';
}

// Punto 8: libera sola cualquier reserva cuyo periodo breve de seguridad ya venció -- si alguien abrió el
// flujo y lo abandonó (cerró la pestaña, se distrajo), el mensaje vuelve a Pendientes sin que nadie tenga
// que hacer nada manualmente.
function liberarReservasExpiradas(db){
  const vencidas = db.prepare(`SELECT id FROM whatsapp_envios_manuales WHERE estado='reservado' AND reserva_expira_en IS NOT NULL AND reserva_expira_en < datetime('now')`).all();
  for(const fila of vencidas){
    db.prepare(`UPDATE whatsapp_envios_manuales SET estado='pendiente', abierto_por=NULL, abierto_en=NULL, reserva_expira_en=NULL, actualizado_en=datetime('now') WHERE id=? AND estado='reservado'`).run(fila.id);
    registrarHistorial(db, fila.id, 'reserva_expirada', null, 'La reserva venció sin confirmación (periodo de '+RESERVA_TTL_MINUTOS+' minutos); vuelve a Pendientes automáticamente.');
  }
  return vencidas.length;
}

// Punto 10: si la etapa del expediente (o su estado activo/cerrado) cambió desde que se generó el mensaje,
// se retira automáticamente -- nunca se envía algo que ya quedó obsoleto. El evento vigente nuevo (si
// corresponde) lo genera solo el motor de detección ya existente (evaluarYRegistrarCicloPrincipal, que ya
// corre en cada PATCH de siniestro y en el barrido periódico); esta función solo lo MATERIALIZA en la
// bandeja en el siguiente paso (materializarPendientes).
function retirarObsoletos(db){
  const activos = db.prepare(`SELECT * FROM whatsapp_envios_manuales WHERE estado IN ('pendiente','reservado')`).all();
  let retirados = 0;
  for(const envio of activos){
    const v = evaluarVigencia(db, envio.evento_id, { exigirHorario: false });
    if(v.puedeEnviarse) continue;
    if(!esCambioDeEtapaOExpedienteInactivo(v.motivo)) continue; // delicado/teléfono inválido: se queda, informativo.
    db.prepare(`UPDATE whatsapp_envios_manuales SET estado='cancelado', cancelado_motivo=?, actualizado_en=datetime('now') WHERE id=?`)
      .run(v.motivo, envio.id);
    registrarHistorial(db, envio.id, 'cancelado_automatico', null, v.motivo);
    retirados++;
  }
  return retirados;
}

// Crea una fila 'pendiente' nueva por cada evento del motor de detección que ya esté vigente y todavía no
// tenga fila en la bandeja manual -- evento_id es UNIQUE, así que esto nunca duplica un mensaje ya
// materializado (esté pendiente, reservado, enviado o incluso ya cancelado: un evento cancelado por cambio
// de etapa no debe "revivir" con la misma fila; si vuelve a ser vigente, el motor de detección genera un
// evento NUEVO con su propia clave de deduplicación, que sí se materializa aquí).
function materializarPendientes(db){
  const candidatos = db.prepare(`
    SELECT e.* FROM whatsapp_eventos_registrados e
    LEFT JOIN whatsapp_envios_manuales m ON m.evento_id = e.id
    WHERE e.estado = 'registrado' AND e.es_plantilla_meta = 1 AND m.id IS NULL
  `).all();
  let creados = 0;
  for(const evento of candidatos){
    const v = evaluarVigencia(db, evento.id, { exigirHorario: false });
    if(!v.puedeEnviarse) continue; // delicado/inválido/inactivo: no se materializa como accionable; se lista aparte, informativo.
    const siniestro = db.prepare('SELECT * FROM siniestros WHERE id=?').get(evento.siniestro_id);
    if(!siniestro) continue;
    let variables = {};
    try{ variables = JSON.parse(evento.variables_json || '{}'); } catch(e){ variables = {}; }
    const texto = renderTexto(evento.plantilla_codigo, variables);
    if(!texto) continue; // código de plantilla desconocido -- por seguridad, no se materializa nada.
    const destino = whatsappFaseA.validarDestino(db, siniestro.id);
    const info = db.prepare(`INSERT INTO whatsapp_envios_manuales (evento_id, siniestro_id, plantilla_codigo, estado, texto, telefono) VALUES (?,?,?, 'pendiente', ?, ?)`)
      .run(evento.id, siniestro.id, evento.plantilla_codigo, texto, destino.valido ? destino.telefonoNormalizado : null);
    registrarHistorial(db, info.lastInsertRowid, 'creado', null, 'Materializado desde whatsapp_eventos_registrados #' + evento.id + ' (' + evento.disparador + ').');
    creados++;
  }
  return creados;
}

// Punto único de sincronización -- se llama al inicio de cada GET de la bandeja, así la lista siempre
// refleja el estado real del expediente sin depender de que el barrido periódico ya haya corrido.
function sincronizarBandeja(db){
  const liberadas = liberarReservasExpiradas(db);
  const retirados = retirarObsoletos(db);
  const creados = materializarPendientes(db);
  return { liberadas, retirados, creados };
}

// Eventos "delicados/bloqueados" que nunca llegaron a materializarse (nacieron bloqueados en el motor de
// detección, o quedaron con teléfono inválido/incidencia delicada desde el inicio) -- se listan aparte,
// informativos, para el mismo apartado único ("una lista única"), sin fila propia en whatsapp_envios_manuales.
function listarInformativosBloqueados(db, { q } = {}){
  let sql = `
    SELECT e.id AS evento_id, e.siniestro_id, e.plantilla_codigo, e.estado AS estado_evento, e.motivo_bloqueo,
           e.disparador, COALESCE(e.detectado_en, e.creado_en) AS detectado_en,
           s.numero AS siniestro_numero, s.cliente_nombre, s.vehiculo, s.archivado, s.estatus_general
    FROM whatsapp_eventos_registrados e
    JOIN siniestros s ON s.id = e.siniestro_id
    LEFT JOIN whatsapp_envios_manuales m ON m.evento_id = e.id
    WHERE e.es_plantilla_meta = 1 AND e.estado IN ('bloqueado','pendiente_revision') AND m.id IS NULL
      AND (s.archivado IS NULL OR s.archivado = 0) AND s.estatus_general != 'Cerrado'
  `;
  const params = [];
  if(q){
    sql += ` AND (s.numero LIKE ? OR s.cliente_nombre LIKE ?)`;
    const like = '%' + q + '%';
    params.push(like, like);
  }
  sql += ' ORDER BY detectado_en DESC';
  const filas = db.prepare(sql).all(...params);
  return filas.map(f => ({
    tipo: 'informativo',
    accionable: false,
    evento_id: f.evento_id,
    envio_id: null,
    siniestro_id: f.siniestro_id,
    siniestro_numero: f.siniestro_numero,
    cliente_nombre: f.cliente_nombre,
    vehiculo: f.vehiculo,
    plantilla_codigo: f.plantilla_codigo,
    plantilla_nombre: (whatsappFaseA.PLANTILLAS[f.plantilla_codigo] || {}).nombre || f.plantilla_codigo,
    motivo: f.motivo_bloqueo || 'En revisión interna.',
    detectado_en: f.detectado_en,
  }));
}

// Lista principal de Pendientes: fusiona (a) filas 'pendiente' de la bandeja (accionables, salvo que una
// revalidación en vivo detecte que ya no lo son -- p. ej. una incidencia delicada que se abrió DESPUÉS de
// materializado el mensaje) con (b) los informativos bloqueados de arriba. Todo en una sola lista, como
// pidió Roberto ("una lista única").
function listarPendientes(db, { q } = {}){
  let sql = `
    SELECT m.*, s.numero AS siniestro_numero, s.cliente_nombre, s.vehiculo, s.archivado, s.estatus_general
    FROM whatsapp_envios_manuales m
    JOIN siniestros s ON s.id = m.siniestro_id
    WHERE m.estado = 'pendiente'
  `;
  const params = [];
  if(q){
    sql += ` AND (s.numero LIKE ? OR s.cliente_nombre LIKE ?)`;
    const like = '%' + q + '%';
    params.push(like, like);
  }
  sql += ' ORDER BY m.creado_en DESC';
  const filas = db.prepare(sql).all(...params);
  const accionables = filas.map(f => {
    const v = evaluarVigencia(db, f.evento_id, { exigirHorario: false });
    const bloqueada = !v.puedeEnviarse;
    return {
      tipo: 'pendiente',
      accionable: !bloqueada,
      envio_id: f.id,
      evento_id: f.evento_id,
      siniestro_id: f.siniestro_id,
      siniestro_numero: f.siniestro_numero,
      cliente_nombre: f.cliente_nombre,
      vehiculo: f.vehiculo,
      plantilla_codigo: f.plantilla_codigo,
      plantilla_nombre: (whatsappFaseA.PLANTILLAS[f.plantilla_codigo] || {}).nombre || f.plantilla_codigo,
      motivo: bloqueada ? v.motivo : null,
      fuera_de_horario: !!v.fueraDeHorario,
      detectado_en: f.creado_en,
    };
  });
  const informativos = listarInformativosBloqueados(db, { q });
  return [...accionables, ...informativos].sort((a,b)=> String(b.detectado_en).localeCompare(String(a.detectado_en)));
}

function listarEnProceso(db, { q } = {}){
  let sql = `
    SELECT m.*, s.numero AS siniestro_numero, s.cliente_nombre, s.vehiculo, u.nombre AS abierto_por_nombre
    FROM whatsapp_envios_manuales m
    JOIN siniestros s ON s.id = m.siniestro_id
    LEFT JOIN usuarios u ON u.id = m.abierto_por
    WHERE m.estado = 'reservado'
  `;
  const params = [];
  if(q){
    sql += ` AND (s.numero LIKE ? OR s.cliente_nombre LIKE ?)`;
    const like = '%' + q + '%';
    params.push(like, like);
  }
  sql += ' ORDER BY m.abierto_en DESC';
  return db.prepare(sql).all(...params).map(f => ({
    tipo: 'en_proceso',
    envio_id: f.id,
    evento_id: f.evento_id,
    siniestro_id: f.siniestro_id,
    siniestro_numero: f.siniestro_numero,
    cliente_nombre: f.cliente_nombre,
    vehiculo: f.vehiculo,
    plantilla_codigo: f.plantilla_codigo,
    plantilla_nombre: (whatsappFaseA.PLANTILLAS[f.plantilla_codigo] || {}).nombre || f.plantilla_codigo,
    abierto_por: f.abierto_por,
    abierto_por_nombre: f.abierto_por_nombre, // visible SOLO internamente (bandeja) -- nunca en el texto enviado al cliente.
    abierto_en: f.abierto_en,
    reserva_expira_en: f.reserva_expira_en,
  }));
}

// Recupera un envío 'reservado' propio (para reabrir el enlace de WhatsApp Web si la persona navegó a
// otra pantalla antes de confirmar, sin tener que reclamarlo de nuevo). Solo quien lo reservó puede verlo
// con su teléfono/texto -- cualquier otro usuario recibe 403, igual que confirmar().
function obtenerEnvioReservadoPropio(db, { envioId, usuarioId }){
  const envio = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(envioId);
  if(!envio) return { ok:false, status:404, error:'Mensaje no encontrado.' };
  if(envio.estado !== 'reservado') return { ok:false, status:409, error:'Este mensaje ya no está reservado.' };
  if(envio.abierto_por !== usuarioId) return { ok:false, status:403, error:'Este mensaje fue reservado por otra persona.' };
  const siniestro = db.prepare('SELECT numero FROM siniestros WHERE id=?').get(envio.siniestro_id);
  const link = envio.telefono ? ('https://wa.me/52' + envio.telefono + '?text=' + encodeURIComponent(envio.texto)) : null;
  return { ok:true, status:200, envio: { id: envio.id, siniestro_numero: siniestro && siniestro.numero, plantilla_codigo: envio.plantilla_codigo, telefono: envio.telefono, texto: envio.texto, link, reserva_minutos: RESERVA_TTL_MINUTOS } };
}

function listarEnviados(db, { q, limit } = {}){
  let sql = `
    SELECT m.*, s.numero AS siniestro_numero, s.cliente_nombre, s.vehiculo, u.nombre AS confirmado_por_nombre
    FROM whatsapp_envios_manuales m
    JOIN siniestros s ON s.id = m.siniestro_id
    LEFT JOIN usuarios u ON u.id = m.confirmado_por
    WHERE m.estado = 'enviado'
  `;
  const params = [];
  if(q){
    sql += ` AND (s.numero LIKE ? OR s.cliente_nombre LIKE ?)`;
    const like = '%' + q + '%';
    params.push(like, like);
  }
  sql += ' ORDER BY m.confirmado_en DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 1000));
  return db.prepare(sql).all(...params).map(f => ({
    tipo: 'enviado',
    envio_id: f.id,
    evento_id: f.evento_id,
    siniestro_id: f.siniestro_id,
    siniestro_numero: f.siniestro_numero,
    cliente_nombre: f.cliente_nombre,
    vehiculo: f.vehiculo,
    plantilla_codigo: f.plantilla_codigo,
    plantilla_nombre: (whatsappFaseA.PLANTILLAS[f.plantilla_codigo] || {}).nombre || f.plantilla_codigo,
    telefono: f.telefono,
    texto: f.texto,
    confirmado_por_nombre: f.confirmado_por_nombre, // interno -- nunca se manda al cliente.
    confirmado_en: f.confirmado_en,
  }));
}

function resumen(db){
  const pendientes = db.prepare(`SELECT COUNT(*) c FROM whatsapp_envios_manuales WHERE estado='pendiente'`).get().c
    + db.prepare(`
        SELECT COUNT(*) c FROM whatsapp_eventos_registrados e
        JOIN siniestros s ON s.id = e.siniestro_id
        LEFT JOIN whatsapp_envios_manuales m ON m.evento_id = e.id
        WHERE e.es_plantilla_meta = 1 AND e.estado IN ('bloqueado','pendiente_revision') AND m.id IS NULL
          AND (s.archivado IS NULL OR s.archivado = 0) AND s.estatus_general != 'Cerrado'
      `).get().c;
  const enProceso = db.prepare(`SELECT COUNT(*) c FROM whatsapp_envios_manuales WHERE estado='reservado'`).get().c;
  const enviados = db.prepare(`SELECT COUNT(*) c FROM whatsapp_envios_manuales WHERE estado='enviado'`).get().c;
  return { pendientes, en_proceso: enProceso, enviados };
}

// Punto 2 del flujo: reclamar atómicamente. El UPDATE con WHERE estado='pendiente' es la propia operación
// atómica -- node:sqlite (DatabaseSync) ejecuta cada .run() de forma síncrona y bloqueante sobre el mismo
// hilo de Node, así que dos solicitudes "simultáneas" nunca pueden intercalarse entre el SELECT y el
// UPDATE: la segunda siempre ve ya aplicado el cambio de la primera y su propio UPDATE afecta 0 filas.
function reclamar(db, { envioId, usuarioId }){
  const envio = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(envioId);
  if(!envio) return { ok:false, status:404, error:'Mensaje no encontrado.' };

  const upd = db.prepare(`UPDATE whatsapp_envios_manuales SET estado='reservado', abierto_por=?, abierto_en=datetime('now'), reserva_expira_en=datetime('now','+${RESERVA_TTL_MINUTOS} minutes'), actualizado_en=datetime('now') WHERE id=? AND estado='pendiente'`)
    .run(usuarioId, envioId);
  if(upd.changes === 0){
    return { ok:false, status:409, error:'Este mensaje ya no está disponible (alguien más lo tomó, o ya no está pendiente). Actualiza la lista.' };
  }
  registrarHistorial(db, envioId, 'reservado', usuarioId, 'Reservado por ' + RESERVA_TTL_MINUTOS + ' minutos.');

  // Punto 3: revalidar INMEDIATAMENTE -- vigencia, teléfono, incidencia delicada, horario. Reutiliza
  // exactamente validarAntesDeEnviar (exigirHorario:true, el valor por defecto).
  const v = evaluarVigencia(db, envio.evento_id);
  if(!v.puedeEnviarse){
    if(esCambioDeEtapaOExpedienteInactivo(v.motivo)){
      db.prepare(`UPDATE whatsapp_envios_manuales SET estado='cancelado', cancelado_motivo=?, actualizado_en=datetime('now') WHERE id=?`).run(v.motivo, envioId);
      registrarHistorial(db, envioId, 'cancelado_automatico', usuarioId, 'Detectado al reclamar: ' + v.motivo);
      return { ok:false, status:409, error:'La etapa del expediente cambió justo ahora; este mensaje ya no aplica. Actualiza la lista.' };
    }
    db.prepare(`UPDATE whatsapp_envios_manuales SET estado='pendiente', abierto_por=NULL, abierto_en=NULL, reserva_expira_en=NULL, actualizado_en=datetime('now') WHERE id=?`).run(envioId);
    registrarHistorial(db, envioId, 'liberado_revalidacion', usuarioId, v.motivo);
    return { ok:false, status:409, error: v.motivo };
  }

  // Re-renderiza el texto con los datos MÁS RECIENTES del expediente (el nombre/vehículo pudieron
  // capturarse o corregirse después de que el mensaje se materializó) y refresca el teléfono validado.
  const siniestro = db.prepare('SELECT * FROM siniestros WHERE id=?').get(envio.siniestro_id);
  const evento = db.prepare('SELECT * FROM whatsapp_eventos_registrados WHERE id=?').get(envio.evento_id);
  let variables = {};
  try{ variables = JSON.parse(evento.variables_json || '{}'); } catch(e){ variables = {}; }
  variables = { nombre: siniestro.cliente_nombre || variables.nombre, vehiculo: siniestro.vehiculo || variables.vehiculo };
  const texto = renderTexto(envio.plantilla_codigo, variables) || envio.texto;
  const destino = whatsappFaseA.validarDestino(db, siniestro.id);
  const telefono = destino.valido ? destino.telefonoNormalizado : envio.telefono;
  db.prepare(`UPDATE whatsapp_envios_manuales SET texto=?, telefono=?, actualizado_en=datetime('now') WHERE id=?`).run(texto, telefono, envioId);

  const link = telefono ? ('https://wa.me/52' + telefono + '?text=' + encodeURIComponent(texto)) : null;
  return { ok:true, status:200, envio: { id: envioId, siniestro_numero: siniestro.numero, plantilla_codigo: envio.plantilla_codigo, telefono, texto, link, reserva_minutos: RESERVA_TTL_MINUTOS } };
}

// Puntos 6/7: confirmar Sí/No. Solo quien reservó puede confirmar (evita que otra persona cierre un envío
// que no hizo).
function confirmar(db, { envioId, usuarioId, enviado }){
  const envio = db.prepare('SELECT * FROM whatsapp_envios_manuales WHERE id=?').get(envioId);
  if(!envio) return { ok:false, status:404, error:'Mensaje no encontrado.' };
  if(envio.estado !== 'reservado'){
    return { ok:false, status:409, error:'Este mensaje ya no está reservado (puede que la reserva haya expirado). Actualiza la lista.' };
  }
  if(envio.abierto_por !== usuarioId){
    return { ok:false, status:403, error:'Este mensaje fue reservado por otra persona.' };
  }
  if(enviado){
    db.prepare(`UPDATE whatsapp_envios_manuales SET estado='enviado', confirmado_por=?, confirmado_en=datetime('now'), actualizado_en=datetime('now') WHERE id=?`).run(usuarioId, envioId);
    registrarHistorial(db, envioId, 'confirmado_enviado', usuarioId, 'Confirmado como enviado por WhatsApp Web.');
    return { ok:true, status:200 };
  }
  db.prepare(`UPDATE whatsapp_envios_manuales SET estado='pendiente', abierto_por=NULL, abierto_en=NULL, reserva_expira_en=NULL, actualizado_en=datetime('now') WHERE id=?`).run(envioId);
  registrarHistorial(db, envioId, 'liberado_no_enviado', usuarioId, 'El usuario indicó que NO se envió; vuelve a Pendientes.');
  return { ok:true, status:200 };
}

module.exports = {
  ROLES_ENVIO, RESERVA_TTL_MINUTOS, PLANTILLAS_TEXTO,
  renderTexto, sincronizarBandeja, resumen,
  listarPendientes, listarEnProceso, listarEnviados,
  reclamar, confirmar, obtenerEnvioReservadoPropio,
  liberarReservasExpiradas, retirarObsoletos, materializarPendientes, // exportados para pruebas dirigidas.
};
