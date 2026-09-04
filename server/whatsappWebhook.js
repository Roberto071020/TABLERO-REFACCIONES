// ===================== WhatsApp Fase A -- webhook de Coexistencia (séptima revisión, punto 3) =====================
// Diseño completo del flujo que consumiría el webhook real "smb_message_echoes" de Meta (ver el comentario
// extenso sobre registrarComunicacionSaliente en server/whatsappFaseA.js, y el hallazgo 9 de la sexta
// entrega, donde se confirmó con la documentación oficial de Meta que este evento SÍ existe).
//
// LÍMITE DURO sin cambios: este módulo sigue sin vincular ningún número real ni crear ningún activo en
// Meta -- así que TODAVÍA no hay ningún webhook real apuntando aquí. Esta ruta y estas funciones existen
// completas y probadas (con payloads y firmas sintéticas que imitan exactamente la forma real) para que,
// el día que Roberto autorice la vinculación real del número, conectar el webhook real sea configurar la
// URL en Meta -- no escribir código nuevo.
//
// Punto 3 (séptima revisión) exige demostrar el flujo COMPLETO, no solo la función interna que recibe un
// siniestroId (eso ya estaba desde la sexta entrega). Este archivo agrega, en orden:
//   1) verificarFirma(): validación auténtica de la firma del webhook (X-Hub-Signature-256, HMAC-SHA256
//      con el secreto de la app de Meta) -- documentado por Meta como el mecanismo oficial para confirmar
//      que una petición a un webhook realmente viene de Meta y no de un tercero.
//   2) esTipoConContenido(): filtro ESTRUCTURAL (no semántico) de qué tipos de eco cuentan como
//      comunicación real -- ver el razonamiento completo abajo, junto a la declaración explícita del
//      límite que pidió Roberto.
//   3) procesarEventoEcho(): junta normalización de teléfono, resolución de expediente (incluida la
//      ambigüedad de varios expedientes activos con el mismo teléfono), deduplicación por wamid (ya vive en
//      registrarComunicacionSaliente, server/whatsappFaseA.js) y el registro final.
//
// ===== Declaración explícita del límite de clasificación (punto 3: "si Meta no distingue informativo de
// administrativo, decláralo, no lo automatices") =====
// Meta NO publica, en ninguna documentación oficial encontrada, un campo que distinga semánticamente un
// mensaje "informativo sobre el avance de la reparación" de uno "administrativo" (un saludo, un acuse de
// recibo, una nota interna escrita al cliente por error). El único dato estructural disponible es el TIPO
// de mensaje (text, image, document, audio, video, sticker, location, contacts, reaction, etc.) -- y el
// tipo NO equivale a la intención: un mensaje de texto puede ser tanto "ya casi terminamos" como "ok".
// Interpretar el CONTENIDO del texto para decidir la intención requeriría leerlo -- este módulo, por
// diseño explícito desde la primera entrega, NUNCA lee ni interpreta el contenido de los mensajes (ni por
// privacidad ni porque Roberto pidió, repetidamente, no automatizar nada que requiera criterio humano).
// Por eso la única distinción que SÍ se aplica aquí es estructural y defendible sin interpretación: un eco
// de tipo "reaction" no es un mensaje nuevo (es una reacción -- un emoji -- sobre un mensaje YA enviado
// antes), así que NO cuenta como una comunicación nueva y no reinicia el contador. Cualquier otro tipo con
// contenido propio (texto, imagen, documento, audio, video, ubicación, contacto) SÍ cuenta como
// comunicación real -- sin importar su motivo específico, porque distinguir el motivo exigiría
// interpretación humana que este módulo no automatiza.

const crypto = require('crypto');
const whatsappFaseA = require('./whatsappFaseA');

const TIPOS_SIN_CONTENIDO_NUEVO = ['reaction'];

// Verificación de firma (X-Hub-Signature-256) -- comparación en tiempo constante para no filtrar
// información por temporización, tal como recomienda la práctica estándar para HMAC.
function verificarFirma(appSecret, rawBody, firmaHeader){
  if(!appSecret || !firmaHeader || !rawBody) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(esperada);
  const b = Buffer.from(String(firmaHeader));
  if(a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function esTipoConContenido(tipo){
  return !TIPOS_SIN_CONTENIDO_NUEVO.includes(String(tipo || '').toLowerCase());
}

// payload esperado (forma simplificada del evento real smb_message_echoes de Meta):
//   { id: 'wamid.XXXX', type: 'text'|'image'|...|'reaction', from: '52551234...', timestamp: '...' }
// 'from' es el teléfono del NEGOCIO (quien envía el eco), no del cliente -- el destinatario real del
// mensaje (el cliente) viaja en 'to' según la documentación de Meta; se usa 'to' para resolver el
// expediente, con 'from' como respaldo si 'to' no viniera (defensivo, nunca debería faltar en un eco real).
function procesarEventoEcho(db, payload){
  if(!payload || !payload.id){
    return { procesado:false, motivo:'Payload inválido: falta el identificador único del mensaje (wamid).' };
  }
  if(!esTipoConContenido(payload.type)){
    return { procesado:false, motivo:`Tipo "${payload.type}" no representa contenido nuevo (p. ej. una reacción) -- no cuenta como comunicación real.` };
  }
  const telefonoDestino = payload.to || payload.from;
  const resolucion = whatsappFaseA.resolverExpedientePorTelefono(db, telefonoDestino);

  if(resolucion.resultado === 'sin_telefono'){
    return { procesado:false, motivo:'El eco no trae un teléfono reconocible.' };
  }
  if(resolucion.resultado === 'sin_expediente_activo'){
    // Un eco de un número sin ningún expediente activo vinculado no es, por sí solo, motivo de alerta --
    // podría ser un número mal capturado en otro sistema o un cliente sin expediente todavía. No se
    // registra nada (evita ruido); queda disponible en el log de la aplicación para depuración manual.
    return { procesado:false, motivo:'Ningún expediente activo vinculado a este teléfono.' };
  }
  if(resolucion.resultado === 'ambiguo_pendiente_asignacion'){
    // Punto 3: NUNCA se elige un expediente arbitrariamente ni se reinicia el contador de todos los
    // candidatos -- se registra una alerta interna (una sola por teléfono, no una por mensaje, para no
    // generar trabajo recurrente) y se espera resolución humana explícita.
    const norm = whatsappFaseA.normalizarTelefonoMX(telefonoDestino);
    whatsappFaseA.registrarEventoInterno(db, {
      siniestroId: null, codigo:'ALERTA-TELEFONO-AMBIGUO',
      disparador: `Teléfono ${telefonoDestino} corresponde a ${resolucion.candidatos.length} expedientes activos (${resolucion.candidatos.map(c=>c.numero).join(', ')}) -- requiere asignación manual antes de registrar ninguna comunicación.`,
      variables: {}, dedupKey: 'telefono_ambiguo:' + (norm.valido ? norm.local : telefonoDestino),
    });
    return { procesado:false, motivo:'Teléfono ambiguo (varios expedientes activos) -- alerta interna registrada, sin elegir ninguno.', candidatos: resolucion.candidatos.map(c=>c.numero) };
  }

  // resuelto_automatico: un solo expediente activo con ese teléfono.
  const resultado = whatsappFaseA.registrarComunicacionSaliente(db, {
    siniestroId: resolucion.siniestro.id,
    wamid: payload.id,
    referenciaExterna: payload.id,
  });
  if(resultado && resultado.duplicado){
    return { procesado:false, motivo:'Mensaje duplicado (mismo wamid ya procesado -- probable reintento de entrega del webhook).' };
  }
  if(resultado && resultado.omitido){
    return { procesado:false, motivo: resultado.motivo };
  }
  return { procesado:true, siniestroId: resolucion.siniestro.id, siniestroNumero: resolucion.siniestro.numero, comunicacionId: resultado.id };
}

module.exports = { verificarFirma, esTipoConContenido, TIPOS_SIN_CONTENIDO_NUEVO, procesarEventoEcho };
