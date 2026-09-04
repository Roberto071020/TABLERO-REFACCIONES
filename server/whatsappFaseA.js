// ===================== WhatsApp Fase A -- modo "solo registro" =====================
// Autorización de Roberto (3-sep-2026, ampliada el mismo día tras revisar la tercera entrega): SOLO
// detectar y registrar qué plantilla se habría disparado (expediente, fecha, hora, motivo, variables),
// aplicar condiciones bloqueantes con un ciclo de revisión explícito, deduplicar, calcular horario de
// envío (cola L-V 9-18 / Sáb 9-14) y continuidad de 72 HORAS NATURALES (no hábiles).
//
// LÍMITES DUROS DE ESTE MÓDULO (no removerlos sin autorización explícita de Roberto):
//   - JAMÁS hace una llamada HTTP real a WhatsApp/Meta/Graph API. No existe ningún fetch/axios/request
//     hacia un servicio externo en este archivo.
//   - No modifica ninguna tabla ni endpoint del módulo de Daniela (las LEE para detectar eventos, nunca
//     las ESCRIBE).
//   - No expone ningún botón, pantalla ni menú nuevo a ningún rol. El único endpoint que expone es de
//     solo lectura/revisión explícita, exclusivo para admin, sin enlazar desde ninguna vista.
//   - "liberado_para_programacion" NUNCA dispara un envío real -- en modo "solo registro" no existe
//     ningún mecanismo de envío; ese estado solo indica que un humano ya revalidó el mensaje retenido.
//
// Notas de diseño (con evidencia concreta, para revisión de Roberto):
//   1) Ubicación física del vehículo (5.4/5.5, 5.6/5.7): investigado en server/routes/reportes.js
//      (bandeja de Beto, variable "reingresoCitado"), que ya distingue "en piso" de "reingreso citado"
//      con esta misma lógica. Se documenta con ejemplos en unidadEnTaller() más abajo. Cuando no hay
//      certeza, el sistema NO adivina: deja el evento en un estado de revisión interna.
//   2) La etapa de continuidad (6.1-6.6) se deriva de estado_autorizacion / piezas_autorizadas_cambio /
//      estado_produccion / estado_calidad, en ese orden de prioridad -- ver etapaContinuidadActual().

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Mexico_City';
const activacion = require('./whatsappFaseAActivacion'); // punto 1, séptima revisión: activación controlada

// ----- Catálogo de las 18 plantillas reales (van a Meta). -----
const PLANTILLAS = {
  '5.1': { nombre:'Bienvenida', categoria:'Utility', ciclo:'principal' },
  '5.2': { nombre:'Revisión enviada', categoria:'Utility', ciclo:'principal' },
  '5.3': { nombre:'Autorizado, con piezas', categoria:'Utility', ciclo:'principal' },
  '5.4': { nombre:'Piezas listas, en tránsito', categoria:'Utility', ciclo:'principal' },
  '5.5': { nombre:'Piezas listas, en piso', categoria:'Utility', ciclo:'principal' },
  '5.6': { nombre:'Autorizado sin piezas, en piso', categoria:'Utility', ciclo:'principal' },
  '5.7': { nombre:'Autorizado sin piezas, en tránsito', categoria:'Utility', ciclo:'principal' },
  '5.8': { nombre:'Hojalatería (inicio)', categoria:'Utility', ciclo:'principal' },
  '5.9': { nombre:'Pintura (inicio)', categoria:'Utility', ciclo:'principal' },
  '5.10': { nombre:'Revisión de calidad', categoria:'Utility', ciclo:'principal' },
  '5.11': { nombre:'Listo para entrega', categoria:'Utility', ciclo:'principal' },
  '5.12': { nombre:'Postventa', categoria:'Utility', ciclo:'principal' },
  '6.1': { nombre:'Continuidad - esperando autorización', categoria:'Utility', ciclo:'continuidad' },
  '6.2': { nombre:'Continuidad - esperando refacciones', categoria:'Utility', ciclo:'continuidad' },
  '6.3': { nombre:'Continuidad - pendiente de asignación', categoria:'Utility', ciclo:'continuidad' },
  '6.4': { nombre:'Continuidad - hojalatería', categoria:'Utility', ciclo:'continuidad' },
  '6.5': { nombre:'Continuidad - pintura', categoria:'Utility', ciclo:'continuidad' },
  '6.6': { nombre:'Continuidad - revisión de calidad', categoria:'Utility', ciclo:'continuidad' },
};
// ----- Catálogo de eventos INTERNOS (punto 2 de la cuarta revisión, y punto 2 de la quinta): nunca van a
// Meta, nunca los consume un servicio de envíos. Son DOS tipos completamente separados a propósito (no se
// reutiliza uno para el otro): un expediente estancado no es lo mismo que un fallo técnico del detector.
// Cada uno trae su propia prioridad y responsable sugerido -- el "historial" y la "deduplicación" ya los
// da gratis la infraestructura general de whatsapp_eventos_registrados (estado, dedup_key, revisado_por/
// revisado_en/justificacion); no hace falta una tabla aparte por tipo de alerta.
const EVENTOS_INTERNOS = {
  'ALERTA-72H-X2': {
    nombre:'Alerta interna: segundo periodo de 72h consecutivo sin avance real',
    prioridad:'media',
    responsableSugerido:'Daniela y el responsable operativo del expediente',
    reglaCierre:'Se cierra (descartado) cuando un humano revisa el expediente y decide la siguiente comunicación manual, o confirma que ya hubo avance real. Nunca se cierra sola.',
  },
  'ALERTA-WA-ERROR': {
    nombre:'Alerta interna: error técnico persistente en la detección de WhatsApp Fase A',
    prioridad:'alta',
    responsableSugerido:'Soporte técnico / Roberto',
    reglaCierre:'Se cierra (descartado) cuando el error deja de repetirse tras una corrección técnica y un humano lo confirma; el renglón de origen en whatsapp_errores debe marcarse resuelto=1 por separado.',
  },
  // Punto 4 (sexta revisión): un pedido con un problema REAL (con incidencia, cancelado, entrega vencida)
  // es una señal real que merece atención humana -- pero NO es un mensaje de cliente (nunca hay que
  // "avisar" al cliente de un problema interno de proveedor a través de una plantilla automática), así
  // que es una alerta interna, tan separada de las otras dos como ellas lo son entre sí.
  'ALERTA-PEDIDO-PROBLEMA': {
    nombre:'Alerta interna: pedido de refacciones con un problema real (incidencia, cancelado o entrega vencida)',
    prioridad:'media',
    responsableSugerido:'Responsable de refacciones del expediente',
    reglaCierre:'Se cierra (descartado) cuando un humano revisa el/los pedidos señalados y confirma que ya se resolvió o que no requiere más acción. Nunca se cierra sola.',
  },
  // Punto 3 (séptima revisión): cuando un mensaje entrante (o un eco de mensaje saliente) llega de un
  // teléfono vinculado a MÁS DE UN expediente activo, el sistema NUNCA elige uno arbitrariamente ni
  // reinicia el contador de los dos/varios a la vez -- eso podría enmascarar estancamiento real en el
  // expediente equivocado. Se registra esta alerta (una sola por teléfono ambiguo, no una por mensaje) para
  // que un humano decida a cuál expediente corresponde -- sin crear ningún trabajo recurrente para
  // Alejandra (es interna, admin-only, igual que las otras tres).
  'ALERTA-TELEFONO-AMBIGUO': {
    nombre:'Alerta interna: un teléfono con mensaje entrante/eco corresponde a más de un expediente activo',
    prioridad:'media',
    responsableSugerido:'Atención a clientes (Alejandra) -- resolución manual, sin capturas nuevas',
    reglaCierre:'Se cierra (descartado) cuando un humano confirma a cuál expediente corresponde el teléfono, o que la ambigüedad ya no aplica (uno de los expedientes se cerró/archivó). Nunca se cierra sola.',
  },
};

// ----- Horario hábil confirmado por Roberto: L-V 9:00-18:00, Sáb 9:00-14:00, domingo cerrado. -----
const HORARIO_HABIL = { 1:{ini:9,fin:18}, 2:{ini:9,fin:18}, 3:{ini:9,fin:18}, 4:{ini:9,fin:18}, 5:{ini:9,fin:18}, 6:{ini:9,fin:14}, 0:null };

function esHorarioHabil(dLocal){
  const cfg = HORARIO_HABIL[dLocal.day()];
  if(!cfg) return false;
  const minutos = dLocal.hour()*60 + dLocal.minute();
  return minutos >= cfg.ini*60 && minutos < cfg.fin*60;
}
function siguienteMomentoHabil(dLocal){
  let cur = dLocal;
  for(let i=0;i<14;i++){
    const cfg = HORARIO_HABIL[cur.day()];
    if(cfg){
      const inicioDia = cur.hour(cfg.ini).minute(0).second(0).millisecond(0);
      const finDia = cur.hour(cfg.fin).minute(0).second(0).millisecond(0);
      if(cur.isBefore(inicioDia)) return inicioDia;
      if(cur.isBefore(finDia)) return cur;
    }
    cur = cur.add(1,'day').hour(0).minute(0).second(0).millisecond(0);
  }
  return cur;
}
// Horas NATURALES (reloj/calendario) transcurridas -- punto 1: la continuidad de 72h usa esto, NO horas hábiles.
function horasNaturalesTranscurridas(desdeUTC, hastaUTC){
  if(!desdeUTC || !hastaUTC) return 0;
  const desde = dayjs.utc(desdeUTC);
  const hasta = dayjs.utc(hastaUTC);
  if(!desde.isValid() || !hasta.isValid() || !hasta.isAfter(desde)) return 0;
  return hasta.diff(desde, 'minute') / 60;
}
// Horas HÁBILES transcurridas -- se conserva para el diseño futuro de escalamiento de mensajes entrantes
// (30 min / 2 h, sección 3.6 de la tercera entrega), que si debe contar solo horario hábil por instrucción
// explícita de Roberto. Ya NO se usa para el gate de continuidad de 72h (ver horasNaturalesTranscurridas).
function horasHabilesTranscurridas(desdeUTC, hastaUTC){
  if(!desdeUTC || !hastaUTC) return 0;
  let cur = dayjs.utc(desdeUTC).tz(TZ);
  const fin = dayjs.utc(hastaUTC).tz(TZ);
  if(!cur.isValid() || !fin.isValid() || !fin.isAfter(cur)) return 0;
  let minutos = 0;
  let guard = 0;
  while(cur.isBefore(fin) && guard < 400){
    guard++;
    const cfg = HORARIO_HABIL[cur.day()];
    const medianocheSiguiente = cur.add(1,'day').hour(0).minute(0).second(0).millisecond(0);
    const limite = fin.isBefore(medianocheSiguiente) ? fin : medianocheSiguiente;
    if(cfg){
      const iniDia = cur.hour(cfg.ini).minute(0).second(0).millisecond(0);
      const finDia = cur.hour(cfg.fin).minute(0).second(0).millisecond(0);
      const desdeEfectivo = cur.isBefore(iniDia) ? iniDia : cur;
      const hastaEfectivo = limite.isAfter(finDia) ? finDia : limite;
      if(hastaEfectivo.isAfter(desdeEfectivo)) minutos += hastaEfectivo.diff(desdeEfectivo, 'minute');
    }
    cur = limite;
  }
  return minutos / 60;
}

// ----- Bloqueo: situación delicada activa sobre el expediente (punto 5, sexta revisión) -----
// Roberto pidió cobertura COMPLETA, no solo incidencias de piezas. Inventario real (verificado leyendo
// server/db.js, no supuesto), de todo lo que representa un problema humano/operativo abierto sobre el
// expediente, con la tabla y condición exacta usada para cada uno:
//   1) incidencias (piezas incorrectas/dañadas/incompletas/devueltas/canceladas/fecha incumplida),
//      estado IN ('abierta','en_proceso') -- YA cubierto desde la tercera entrega.
//   2) retrabajos con severidad='critica' (no conformidad de calidad seria) todavía sin cerrar
//      (estado IN ('abierto','en_correccion','reinspeccion')): no tiene sentido avisar avance de
//      producción con una no conformidad grave sin resolver.
//   3) discrepancias_proveedor abiertas (estado='abierta') -- incluye las marcadas no_llego=1 (algo que
//      el proveedor dijo que entregó pero nunca llegó).
//   4) complementos con decision='pendiente' -- costo/tiempo adicional todavía sin autorizar por el
//      cliente/aseguradora; comunicar avance normal mientras esto sigue en el aire puede contradecir lo
//      que el cliente ya sabe.
//   5) checklist_calidad con resultado='rechazado' y sin corrección registrada todavía (correccion
//      NULL o vacío) -- hallazgo de calidad detectado y aún sin resolver.
//   6) finiquito_estado='inconformidad_abierta' -- inconformidad formal abierta tras la entrega (aplica
//      sobre todo a la plantilla 5.12/postventa, que se evalúa después de entregado el vehículo).
//   7) entrega_compromiso_gnp=1 con fecha_entrega_prevista ya vencida y sin fecha_entrega_real -- un
//      compromiso de fecha YA INFORMADO al cliente/aseguradora que no se cumplió (punto 4, séptima
//      revisión: "incumplimiento de una fecha o compromiso informado").
//   8) pedidos.estatus_operativo='Entrega vencida' -- una pieza con entrega vencida también es delicada
//      para el ciclo principal completo, no solo para la alerta interna de refacciones (punto 4, séptima
//      revisión).
// Evaluado y descartado explícitamente, con el motivo declarado (punto 4, séptima revisión -- matriz
// completa de las 8 categorías acordadas, con su tabla/campo real o su limitación, en la sección 4 de la
// séptima entrega):
//   - "Queja o inconformidad del cliente" ANTES de la entrega: SC Control no tiene ningún campo o tabla
//     estructurada para esto hoy (solo texto libre disperso en notas/observaciones, que este módulo nunca
//     lee ni interpreta, por diseño). LIMITACIÓN DECLARADA: no hay señal real que bloquear antes de la
//     entrega; después de la entrega SÍ se cubre con finiquito_estado (punto 6 arriba).
//   - "Daño adicional o accidente" durante el proceso: danos_evidencia es un registro de EVIDENCIA
//     (fotos/observaciones de daños, capturado sobre todo en admisión), sin ningún campo de estado
//     abierto/resuelto -- casi todo expediente tiene filas ahí desde el día uno, así que usarlo bloquearía
//     prácticamente siempre (falso positivo permanente). LIMITACIÓN DECLARADA: no se usa como bloqueo por
//     no tener una señal confiable de "sin resolver" vs. "ya documentado y superado".
//   - vales_pendientes: ocurre DESPUÉS de la entrega; ninguna plantilla de este módulo (5.1-5.12/6.x) cae
//     en esa ventana operativa -- no hay nada que bloquear ahí.
//   - exclusiones_envio: exclusivo de los correos de Daniela a proveedores, sin relación con el cliente
//     final.
function tieneIncidenciaDelicadaActiva(db, siniestroId){
  const incidencias = db.prepare(`
    SELECT COUNT(*) c FROM incidencias i
    JOIN piezas p ON p.id = i.pieza_id
    JOIN pedidos pe ON pe.id = p.pedido_id
    WHERE pe.siniestro_id = ? AND i.estado IN ('abierta','en_proceso')
  `).get(siniestroId).c;
  if(incidencias > 0) return true;

  const retrabajos = db.prepare(`
    SELECT COUNT(*) c FROM retrabajos
    WHERE siniestro_id = ? AND severidad = 'critica' AND estado IN ('abierto','en_correccion','reinspeccion')
  `).get(siniestroId).c;
  if(retrabajos > 0) return true;

  const discrepancias = db.prepare(`
    SELECT COUNT(*) c FROM discrepancias_proveedor WHERE siniestro_id = ? AND estado = 'abierta'
  `).get(siniestroId).c;
  if(discrepancias > 0) return true;

  const complementosPendientes = db.prepare(`
    SELECT COUNT(*) c FROM complementos WHERE siniestro_id = ? AND decision = 'pendiente'
  `).get(siniestroId).c;
  if(complementosPendientes > 0) return true;

  const checklistRechazado = db.prepare(`
    SELECT COUNT(*) c FROM checklist_calidad
    WHERE siniestro_id = ? AND resultado = 'rechazado' AND (correccion IS NULL OR TRIM(correccion) = '')
  `).get(siniestroId).c;
  if(checklistRechazado > 0) return true;

  const s2 = db.prepare(`SELECT finiquito_estado, entrega_compromiso_gnp, fecha_entrega_prevista, fecha_entrega_real FROM siniestros WHERE id = ?`).get(siniestroId);
  if(s2 && s2.finiquito_estado === 'inconformidad_abierta') return true;

  // Punto 4 (séptima revisión, matriz de incidencias delicadas): "incumplimiento de una fecha o compromiso
  // informado" -- entrega_compromiso_gnp=1 significa que YA se le informó al cliente/aseguradora una fecha
  // de entrega comprometida (campo que se bloquea al capturarse, ver server/routes/siniestros.js). Si esa
  // fecha (fecha_entrega_prevista) ya pasó y el vehículo todavía no se entrega, es un compromiso incumplido
  // -- delicado para seguir mandando avisos de rutina como si nada.
  if(s2 && s2.entrega_compromiso_gnp === 1 && s2.fecha_entrega_prevista && !s2.fecha_entrega_real){
    const hoy = dayjs.utc().tz(TZ).format('YYYY-MM-DD');
    if(String(s2.fecha_entrega_prevista).slice(0,10) < hoy) return true;
  }

  // Un pedido de refacciones con estatus "Entrega vencida" ya genera su propia alerta interna
  // (ALERTA-PEDIDO-PROBLEMA, punto 4 de la sexta revisión) pero NO bloqueaba, hasta ahora, otras plantillas
  // del ciclo principal (p. ej. avisar que "inicia pintura" mientras una pieza tiene entrega vencida). Se
  // agrega aquí para que también cuente como situación delicada de cara al cliente.
  const pedidoVencido = db.prepare(`
    SELECT COUNT(*) c FROM pedidos WHERE siniestro_id = ? AND estatus_operativo = 'Entrega vencida'
  `).get(siniestroId).c;
  if(pedidoVencido > 0) return true;

  return false;
}

// ----- Ubicación física del vehículo (punto 6) -----
// Investigado en server/routes/reportes.js (bandeja de Beto): el sistema YA distingue "en piso" de
// "reingreso citado" con esta misma lógica (variable reingresoCitado). Se documenta aquí con ejemplos:
//
//   Caso 1 -- ingreso_tipo IN ('grua','permanece'): por regla de negocio ya establecida (ver
//     catalogo_hitos, hito 'cita_reingreso': "Solo si la unidad está circulando"), estos vehículos NUNCA
//     salen del taller durante el proceso. Certeza: SIEMPRE "en_taller".
//     Ejemplo: expediente llega en grúa, se queda todo el proceso -> en_taller, sin importar la etapa.
//
//   Caso 2 -- ingreso_tipo = 'circulando' Y fecha_admision está vacía: el vehículo todavía no ha sido
//     admitido físicamente ni una sola vez. Certeza: SIEMPRE "fuera_taller".
//     Ejemplo: expediente recién creado con cita a futuro, cliente todavía no lo lleva -> fuera_taller.
//
//   Caso 3 -- ingreso_tipo = 'circulando' Y fecha_admision YA tiene valor: aquí NO hay certeza con los
//     datos actuales. fecha_admision se captura UNA SOLA VEZ (nunca se borra ni se vuelve a capturar,
//     confirmado revisando cada lugar del código que la escribe) y representa "fue admitido al menos una
//     vez", no "está físicamente aquí ahora mismo". Un vehículo circulando puede haber sido admitido,
//     diagnosticado, y devuelto al cliente en lo que llegan las piezas (ese es exactamente el propósito
//     del hito "cita de reingreso") -- el sistema hoy NO tiene ningún campo que capture el momento en que
//     ese vehículo vuelve a salir ni el momento en que reingresa de verdad. Por instrucción explícita de
//     Roberto, en este caso el sistema NO ADIVINA.
//     Ejemplo: expediente admitido el 1-sep (fecha_admision=2026-09-01), circulando, con cita de
//     reingreso agendada para el 10-sep. El 5 de septiembre no hay forma de saber, solo con estos campos,
//     si el auto sigue en el taller esperando piezas o si ya se fue con el cliente.
//
// Devuelve 'en_taller' | 'fuera_taller' | 'desconocido'.
function unidadEnTaller(db, siniestroId){
  const s = db.prepare('SELECT ingreso_tipo, fecha_admision FROM siniestros WHERE id = ?').get(siniestroId);
  if(!s) return 'desconocido';
  if(s.ingreso_tipo === 'grua' || s.ingreso_tipo === 'permanece') return 'en_taller';
  if(s.ingreso_tipo === 'circulando'){
    if(!s.fecha_admision || !String(s.fecha_admision).trim()) return 'fuera_taller';
    return 'desconocido'; // Caso 3: ya fue admitido alguna vez, no hay certeza de si sigue ahí ahora.
  }
  return 'desconocido'; // ingreso_tipo sin capturar todavía.
}

// ----- Refacciones realmente disponibles (punto 7) -----
// "Todos los pedidos en estado terminal" (usado por la tarea automática existente de Daniela/Alejandra,
// verificarRefaccionesCompletas en server/utils.js) NO es lo mismo que "las refacciones están realmente
// disponibles para continuar la reparación": ese chequeo trata Cancelado/Cerrado igual que Recibido
// completo porque para ESA tarea (avisar y cerrar el pendiente) cualquier estado terminal sirve. Para
// WhatsApp, un pedido cancelado, con incidencia, o no recibido en su totalidad NO significa que el
// cliente ya pueda continuar -- por eso esta función es más estricta y vive separada, sin tocar la
// función existente de Daniela/Alejandra.
// Punto 4 (sexta revisión): la versión anterior trataba "sin pedidos todavía" y "pedidos en trámite
// normal" exactamente igual que "pedido con un problema real" -- las tres devolvían disponible:false con
// el mismo motivo genérico, y quien llamaba a esta función terminaba registrando un evento bloqueado de
// cliente en los tres casos por igual (puro ruido en los dos primeros). Ahora se distinguen 4 estados:
//   'sin_pedidos'  -- todavía no existe ningún pedido. No es una señal de nada, es la ausencia de señal.
//   'en_proceso'   -- hay pedidos, ninguno tiene un problema real, simplemente no han llegado todos.
//   'problema'     -- al menos un pedido está en un estatus que SÍ representa un problema real (con
//                     incidencia, cancelado, o con entrega vencida) -- esto sí merece una alerta interna.
//   'completo'     -- todos los pedidos están en "Recibido completo": las refacciones sí están disponibles.
// PROBLEMATICOS son los 3 estatus operativos (de la lista real ESTATUS_OPERATIVO de server/routes/
// pedidos.js) que reflejan un problema de verdad, no solo "todavía no". 'Cerrado' se deja fuera a propósito:
// es un cierre manual legítimo (p. ej. un pedido sustituido por otro) y no siempre implica un problema.
function refaccionesRealmenteDisponibles(db, siniestroId){
  const PROBLEMATICOS = ['Con incidencia', 'Cancelado', 'Entrega vencida'];
  const pedidos = db.prepare('SELECT numero, estatus_operativo FROM pedidos WHERE siniestro_id = ?').all(siniestroId);
  if(pedidos.length === 0){
    return { disponible:false, estado:'sin_pedidos', motivo:'Todavía no existe ningún pedido de refacciones para este expediente.' };
  }
  const noCompletos = pedidos.filter(p => p.estatus_operativo !== 'Recibido completo');
  if(noCompletos.length === 0){
    return { disponible:true, estado:'completo', motivo:null };
  }
  const problematicos = noCompletos.filter(p => PROBLEMATICOS.includes(p.estatus_operativo));
  if(problematicos.length){
    const firma = problematicos.map(p => `${p.numero}:${p.estatus_operativo}`).sort().join('|');
    const detalle = problematicos.map(p => `${p.numero} (${p.estatus_operativo})`).join(', ');
    return { disponible:false, estado:'problema', firma,
      motivo:`Hay pedidos con un problema real que requiere atención (con incidencia, cancelados o con entrega vencida): ${detalle}.` };
  }
  return { disponible:false, estado:'en_proceso', motivo:'Los pedidos siguen en trámite normal (todavía no llegan todos); no hay ningún problema real que reportar.' };
}

// ----- Validación de destino (punto 4, quinta revisión) -----
// Ninguna plantilla de cliente (5.1 a 6.6) puede registrarse como lista para programar si no hay un
// destino válido. Regla simple y explícita, sin heurísticas de "adivinar" un número mal capturado:
//   - Vacío -> 'destino_no_vinculado' (nunca se capturó ningún teléfono).
//   - Con valor pero que no corresponde a un teléfono mexicano de 10 dígitos (con o sin +52/52 de
//     código de país), o que es un valor claramente de prueba (mismo dígito repetido 10 veces) ->
//     'destino_invalido'.
// Nota de diseño: que el MISMO teléfono esté vinculado a otro siniestro activo distinto NO se bloquea
// aquí -- es una situación operativa legítima (un mismo cliente con dos vehículos en el taller a la vez),
// no un error de captura. Ese es un problema distinto (a quién se le atribuye un mensaje ENTRANTE), ya
// resuelto por resolverExpedientePorTelefono(), que nunca asigna automáticamente un caso ambiguo.
// Punto 3 (sexta revisión): UNA SOLA función de normalización de teléfono, reusada tanto para el
// DESTINO (validarDestino, salida) como para la BÚSQUEDA de expediente por teléfono ENTRANTE
// (resolverExpedientePorTelefono) -- antes cada una tenía su propia lógica (la búsqueda entrante no tenía
// ninguna: comparaba el string crudo tal cual se guardó en cliente_telefono). Un mismo número capturado
// como "55 1234 5678" en el expediente y recibido como "5215512345678" desde WhatsApp nunca habría hecho
// match con la lógica anterior. Devuelve { valido:true, local:'5512345678' } o
// { valido:false, motivo:'vacio'|'formato_invalido'|'placeholder' }.
function normalizarTelefonoMX(telefonoCrudo){
  const telefono = telefonoCrudo == null ? '' : String(telefonoCrudo).trim();
  if(!telefono) return { valido:false, motivo:'vacio' };
  const digitos = telefono.replace(/\D/g, '');
  let local = digitos;
  if(digitos.length === 12 && digitos.startsWith('52')) local = digitos.slice(2);
  else if(digitos.length === 13 && digitos.startsWith('521')) local = digitos.slice(3);
  if(local.length !== 10) return { valido:false, motivo:'formato_invalido' };
  if(/^(\d)\1{9}$/.test(local)) return { valido:false, motivo:'placeholder' };
  return { valido:true, local };
}

function validarDestino(db, siniestroId){
  const s = db.prepare('SELECT cliente_telefono FROM siniestros WHERE id = ?').get(siniestroId);
  const telefono = s && s.cliente_telefono;
  const norm = normalizarTelefonoMX(telefono);
  if(!norm.valido){
    if(norm.motivo === 'vacio'){
      return { valido:false, motivo:'destino_no_vinculado', detalle:'No hay ningún teléfono capturado para este expediente; no se puede enviar ninguna comunicación individual todavía.' };
    }
    if(norm.motivo === 'placeholder'){
      return { valido:false, motivo:'destino_invalido', detalle:`El teléfono capturado ("${telefono}") parece un valor de prueba o placeholder (mismo dígito repetido), no un número real.` };
    }
    return { valido:false, motivo:'destino_invalido', detalle:`El teléfono capturado ("${telefono}") no tiene un formato mexicano válido (se esperan 10 dígitos locales, con o sin +52/52 de código de país).` };
  }
  return { valido:true, telefonoNormalizado: norm.local };
}

// ===================== Registro persistente de errores (punto 8) =====================
// Un error del detector NUNCA debe quedar solo en el log del servidor: si se pierde el log, se pierde
// también la evidencia de que algo no se registró. Esta función nunca lanza (doble try/catch) para no
// arriesgar la operación principal que la llama.
const UMBRAL_ALERTA_ERROR = 3;
function registrarError(db, { contexto, siniestroId=null, plantillaCodigo=null, error }){
  try{
    const mensaje = (error && error.message) ? String(error.message).slice(0,500) : String(error).slice(0,500);
    const detalle = (error && error.stack) ? String(error.stack).slice(0,2000) : null;
    const existente = db.prepare(`SELECT id, intentos, alerta_generada FROM whatsapp_errores
      WHERE contexto = ? AND resuelto = 0
      AND (siniestro_id IS ? ) AND (plantilla_codigo IS ?)`).get(contexto, siniestroId, plantillaCodigo);
    if(existente){
      const nuevosIntentos = existente.intentos + 1;
      db.prepare(`UPDATE whatsapp_errores SET intentos=?, ultimo_intento_en=datetime('now'), mensaje=?, detalle=? WHERE id=?`)
        .run(nuevosIntentos, mensaje, detalle, existente.id);
      if(nuevosIntentos >= UMBRAL_ALERTA_ERROR && !existente.alerta_generada){
        db.prepare(`UPDATE whatsapp_errores SET alerta_generada=1 WHERE id=?`).run(existente.id);
        // Punto 2 (quinta revisión): código PROPIO para errores técnicos (ALERTA-WA-ERROR), nunca
        // ALERTA-72H-X2 -- un fallo del detector no es lo mismo que un expediente sin avance real, y no
        // debe aparecer mezclado con esas alertas. Funciona con o sin siniestroId (un error puede ser de
        // sistema, p. ej. el barrido programado atrasado, sin pertenecer a ningún expediente concreto).
        // Punto 7 (sexta revisión): la clave incluye el id de ESTE renglón de whatsapp_errores, no solo
        // contexto+plantilla. Así, si el error se marca resuelto=1 (whatsapp_errores) y luego el MISMO tipo
        // de error vuelve a ocurrir, registrarError abre un renglón NUEVO (el filtro de "existente" exige
        // resuelto=0) con un id distinto -> nueva clave de deduplicación -> nueva alerta. Con la clave
        // anterior (fija por contexto+plantilla, sin el id) un segundo ciclo del mismo error jamás habría
        // generado una alerta nueva: habría chocado con el registro ya cerrado del primer ciclo y quedado
        // deduplicado en silencio, sin que nadie se enterara de la recurrencia.
        registrarEventoInterno(db, { siniestroId: siniestroId || null, codigo:'ALERTA-WA-ERROR',
          disparador:`Error persistente en la detección de WhatsApp Fase A (contexto: ${contexto}${plantillaCodigo ? ', plantilla '+plantillaCodigo : ''}, ${nuevosIntentos} intentos) -- requiere revisión técnica.`,
          variables:{}, dedupKey:'error:'+contexto+':'+plantillaCodigo+':'+existente.id });
      }
    } else {
      db.prepare(`INSERT INTO whatsapp_errores (contexto,siniestro_id,plantilla_codigo,mensaje,detalle,piloto_run_id) VALUES (?,?,?,?,?,?)`)
        .run(contexto, siniestroId, plantillaCodigo, mensaje, detalle, activacion.pilotoRunActual(db));
    }
  } catch(e2){ console.error('[whatsappFaseA] registrarError también falló (no se interrumpe la operación principal):', e2.message); }
}

// ----- Registro central: aplica dedup, calcula horario o marca bloqueado. Nunca envía nada real. -----
// siniestroId puede ser null (alerta de sistema, sin expediente asociado -- punto 1/2 de la quinta
// revisión). Por eso el chequeo de deduplicación usa "IS ?" en vez de "= ?": en SQL, "columna = NULL"
// nunca es verdadero (ni siquiera comparando NULL contra NULL), así que con "=" el mismo evento de
// sistema se habría vuelto a insertar cada vez, sin deduplicar nunca.
function registrarEvento(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey, bloqueadoPorMotivo=null, tipoBloqueo=null, esPlantillaMeta=1, ahoraUTC=null }){
  const dedup = String(dedupKey || '');
  const sid = (siniestroId === undefined || siniestroId === null) ? null : siniestroId;
  const existente = db.prepare(`SELECT id, estado FROM whatsapp_eventos_registrados WHERE siniestro_id IS ? AND plantilla_codigo=? AND dedup_key=?`)
    .get(sid, plantillaCodigo, dedup);
  if(existente) return { creado:false, id: existente.id, motivo:'ya registrado (deduplicado); su ciclo de vida se actualiza con UPDATE, no se pierde al re-detectarse' };

  // Punto 4 (quinta revisión): ninguna plantilla de CLIENTE puede registrarse como lista si el destino no
  // es válido -- esta comprobación tiene prioridad sobre cualquier otro motivo de bloqueo que se le haya
  // pasado a la función, porque sin destino ningún otro chequeo importa todavía. No aplica a los eventos
  // internos (es_plantilla_meta=0): esos nunca se envían a un cliente, así que no necesitan un teléfono.
  let tipoBloqueoFinal = tipoBloqueo;
  let bloqueadoPorMotivoFinal = bloqueadoPorMotivo;
  if(esPlantillaMeta && sid){
    const destino = validarDestino(db, sid);
    if(!destino.valido){
      tipoBloqueoFinal = destino.motivo;
      bloqueadoPorMotivoFinal = destino.detalle;
    }
  }

  const ahora = ahoraUTC ? dayjs.utc(ahoraUTC) : dayjs.utc();
  let estado = 'registrado';
  let motivoBloqueo = null;
  let programadoPara = null;
  if(bloqueadoPorMotivoFinal){
    estado = 'bloqueado';
    motivoBloqueo = bloqueadoPorMotivoFinal;
  } else {
    const local = ahora.tz(TZ);
    const momentoHabil = esHorarioHabil(local) ? local : siguienteMomentoHabil(local);
    programadoPara = momentoHabil.utc().format('YYYY-MM-DD HH:mm:ss');
  }
  const prioridad = (!esPlantillaMeta && EVENTOS_INTERNOS[plantillaCodigo]) ? EVENTOS_INTERNOS[plantillaCodigo].prioridad : null;
  // Punto 8 (sexta revisión): campos de tiempo EXPLÍCITOS, no solo creado_en. detectado_en es el mismo
  // instante que creado_en (cuándo el detector evaluó y registró esto), pero con nombre propio. Sin
  // mecanismo de envío real en este modo, simulado_enviado_en es el momento SIMULADO en el que el mensaje
  // se habría enviado -- igual a programado_para cuando el evento no queda bloqueado, NULL si sí queda
  // bloqueado (un evento bloqueado nunca llega a un "momento simulado de envío"). enviado_en/entregado_en/
  // error_en quedan SIEMPRE NULL aquí a propósito: son del futuro servicio de envío real, no de este.
  const detectadoEn = ahora.format('YYYY-MM-DD HH:mm:ss');
  const simuladoEnviadoEn = estado === 'registrado' ? programadoPara : null;
  const info = db.prepare(`INSERT INTO whatsapp_eventos_registrados
      (siniestro_id,plantilla_codigo,estado,tipo_bloqueo,prioridad,motivo_bloqueo,disparador,variables_json,programado_para,dedup_key,es_plantilla_meta,detectado_en,simulado_enviado_en,piloto_run_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sid, plantillaCodigo, estado, tipoBloqueoFinal, prioridad, motivoBloqueo, disparador, JSON.stringify(variables||{}), programadoPara, dedup, esPlantillaMeta?1:0, detectadoEn, simuladoEnviadoEn, activacion.pilotoRunActual(db));
  return { creado:true, id: info.lastInsertRowid, estado };
}

// Registra un evento INTERNO (no es una de las 18 plantillas de Meta; punto 2). Se guarda en la misma
// tabla para tener un solo historial consultable, pero con es_plantilla_meta=0 -- cualquier filtro futuro
// que solo tome plantillas reales para enviar (WHERE es_plantilla_meta=1) lo excluye automáticamente.
function registrarEventoInterno(db, { siniestroId, codigo, disparador, variables, dedupKey }){
  if(!EVENTOS_INTERNOS[codigo]) throw new Error('Evento interno desconocido: ' + codigo);
  return registrarEvento(db, { siniestroId, plantillaCodigo:codigo, disparador, variables, dedupKey, esPlantillaMeta:0 });
}

// Envoltura que evalúa el bloqueo por incidencia delicada. tipoBloqueo='incidencia_delicada' permite que
// revisarBloqueadosResueltos() sepa exactamente qué condición debe volver a comprobar más adelante.
function registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey, aplicaChequeoDelicada=true }){
  const bloqueado = aplicaChequeoDelicada && tieneIncidenciaDelicadaActiva(db, siniestroId)
    ? 'Existe una incidencia delicada abierta o en proceso sobre este expediente; el envío queda suspendido hasta que se resuelva (no se genera ninguna explicación automática).'
    : null;
  return registrarEvento(db, { siniestroId, plantillaCodigo, disparador, variables, dedupKey,
    bloqueadoPorMotivo: bloqueado, tipoBloqueo: bloqueado ? 'incidencia_delicada' : null });
}

// ===================== Ciclo de vida de eventos bloqueados (punto 3) =====================
// bloqueado -> pendiente_revision: AUTOMÁTICO, cuando la condición específica que originó el bloqueo
//   (tipo_bloqueo) ya no se cumple. Esto NO reenvía ni reprograma nada -- solo mueve el evento a la
//   bandeja de revisión humana, con la clave de deduplicación intacta (el mismo renglón, no uno nuevo).
// pendiente_revision -> descartado | liberado_para_programacion: SOLO mediante acción explícita
//   (resolverPendienteRevision), nunca automático. "liberado_para_programacion" NUNCA implica un envío
//   real -- no existe ningún mecanismo de envío en este modo.
function condicionDeBloqueoSigueActiva(db, evento){
  if(evento.tipo_bloqueo === 'incidencia_delicada') return tieneIncidenciaDelicadaActiva(db, evento.siniestro_id);
  // Punto 4 (sexta revisión): 'refacciones_no_disponibles' ya NO se genera (procesarRefaccionesCompletas
  // fue rediseñado: "sin pedidos"/"en proceso" ya no bloquean nada, y "problema" genera una alerta interna,
  // no un evento bloqueado de cliente) -- se deja el chequeo por compatibilidad con filas antiguas que ya
  // existan con ese tipo_bloqueo; para esas, refaccionesRealmenteDisponibles ahora requiere disp.disponible.
  if(evento.tipo_bloqueo === 'refacciones_no_disponibles') return !refaccionesRealmenteDisponibles(db, evento.siniestro_id).disponible;
  if(evento.tipo_bloqueo === 'ubicacion_desconocida') return unidadEnTaller(db, evento.siniestro_id) === 'desconocido';
  if(evento.tipo_bloqueo === 'autorizacion_parcial'){
    const s = db.prepare('SELECT estado_autorizacion FROM siniestros WHERE id=?').get(evento.siniestro_id);
    return !!s && s.estado_autorizacion === 'parcial';
  }
  // Punto 4 (quinta revisión): mientras el teléfono siga vacío o con formato inválido, el bloqueo sigue
  // vigente. En cuanto se corrige, revisarBloqueadosResueltos() lo mueve a pendiente_revision -- nunca se
  // libera ni se envía solo (ver resolverPendienteRevision: siempre exige revisión y justificación humana).
  if(evento.tipo_bloqueo === 'destino_invalido' || evento.tipo_bloqueo === 'destino_no_vinculado'){
    return !validarDestino(db, evento.siniestro_id).valido;
  }
  return true; // tipo_bloqueo desconocido/nulo: por seguridad, no se mueve solo -- requiere revisión manual directa.
}
function revisarBloqueadosResueltos(db){
  try{
    const bloqueados = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE estado='bloqueado'`).all();
    for(const ev of bloqueados){
      try{
        if(!condicionDeBloqueoSigueActiva(db, ev)){
          db.prepare(`UPDATE whatsapp_eventos_registrados SET estado='pendiente_revision' WHERE id=?`).run(ev.id);
        }
      } catch(e){ registrarError(db, { contexto:'revisarBloqueadosResueltos', siniestroId:ev.siniestro_id, plantillaCodigo:ev.plantilla_codigo, error:e }); }
    }
  } catch(e){ registrarError(db, { contexto:'revisarBloqueadosResueltos', error:e }); }
}

// Acción explícita (admin, vía endpoint de solo revisión) -- exige justificación y no envía nada nunca.
// Punto 2 (quinta revisión) -- "regla de cierre" de una alerta interna: una alerta (es_plantilla_meta=0)
// no pasa por "bloqueado" ni "pendiente_revision" (esos estados son del ciclo de mensajes de cliente); se
// abre directo en "registrado" y se cierra directo con la MISMA acción explícita y la MISMA exigencia de
// justificación que ya regía para los eventos de cliente -- sin inventar un mecanismo de cierre aparte.
function resolverPendienteRevision(db, { eventoId, decision, justificacion, usuarioId }){
  if(!['descartado','liberado_para_programacion'].includes(decision)){
    throw new Error('Decisión inválida. Usa "descartado" o "liberado_para_programacion".');
  }
  if(!justificacion || !String(justificacion).trim()){
    throw new Error('La justificación es obligatoria: debe confirmar que se revalidó el estado actual del expediente, la vigencia del mensaje, si ya ocurrió otro avance, si el texto todavía corresponde, y si requiere decisión de Daniela.');
  }
  const evento = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE id=?`).get(eventoId);
  if(!evento) throw new Error('Evento no encontrado.');
  const esAlertaInterna = evento.es_plantilla_meta === 0;
  if(esAlertaInterna){
    if(evento.estado !== 'registrado'){
      throw new Error('Esta alerta interna ya fue cerrada (o no está en un estado que se pueda cerrar).');
    }
    if(decision !== 'descartado'){
      throw new Error('Una alerta interna solo se puede cerrar ("descartado"); "liberado_para_programacion" no aplica porque no es un mensaje de cliente.');
    }
  } else if(evento.estado !== 'pendiente_revision'){
    throw new Error('Solo se puede resolver un evento que esté en estado "pendiente_revision".');
  }
  db.prepare(`UPDATE whatsapp_eventos_registrados SET estado=?, revisado_por=?, revisado_en=datetime('now'), justificacion=? WHERE id=?`)
    .run(decision, usuarioId||null, String(justificacion).trim(), eventoId);
  return db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE id=?`).get(eventoId);
}

// ===================== Validación final antes de un futuro envío real (punto 5, quinta revisión) =====
// Todavía no existe ningún mecanismo de envío real en este modo -- esta función es el DISEÑO, ya
// implementado y probado, de la comprobación que un futuro servicio de envío deberá correr INMEDIATAMENTE
// antes de enviar cada mensaje, sin confiar ciegamente en que "liberado_para_programacion" siga vigente.
// "Liberado" es una fotografía del momento en que un humano lo revisó -- no una garantía permanente.
function validarAntesDeEnviar(db, eventoId){
  const evento = db.prepare('SELECT * FROM whatsapp_eventos_registrados WHERE id=?').get(eventoId);
  if(!evento) return { puedeEnviarse:false, motivo:'Evento no encontrado.' };
  if(!['registrado','liberado_para_programacion'].includes(evento.estado)){
    return { puedeEnviarse:false, motivo:`El evento está en estado "${evento.estado}", no en un estado que permita envío.` };
  }
  if(evento.es_plantilla_meta !== 1){
    return { puedeEnviarse:false, motivo:'Es un evento interno (alerta), no una plantilla de cliente -- nunca se envía.' };
  }
  const siniestro = db.prepare('SELECT * FROM siniestros WHERE id=?').get(evento.siniestro_id);
  if(!siniestro || siniestro.archivado || siniestro.estatus_general === 'Cerrado'){
    return { puedeEnviarse:false, motivo:'El expediente ya no está activo (cerrado o archivado).' };
  }
  const destino = validarDestino(db, evento.siniestro_id);
  if(!destino.valido){
    return { puedeEnviarse:false, motivo:'El destino ya no es válido: ' + destino.detalle };
  }
  if(tieneIncidenciaDelicadaActiva(db, evento.siniestro_id)){
    return { puedeEnviarse:false, motivo:'Existe una incidencia delicada activa sobre el expediente.' };
  }
  const local = dayjs.utc().tz(TZ);
  if(!esHorarioHabil(local)){
    return { puedeEnviarse:false, motivo:'Fuera del horario permitido de envío (L-V 9-18, Sáb 9-14).' };
  }
  // La etapa/condición real vigente todavía corresponde a lo que este evento representa (no se envía algo
  // que ya quedó obsoleto porque el expediente avanzó o cambió desde que se liberó). Punto 2 (sexta
  // revisión): esto ya NO es exclusivo de continuidad (6.x) -- se extiende a las 12 plantillas del ciclo
  // principal (5.1-5.12), cada una con su propia condición (ver vigenciaPlantillaPrincipal).
  if(evento.plantilla_codigo.startsWith('6.')){
    const etapaVigente = etapaContinuidadActual(db, siniestro);
    if(etapaVigente !== evento.plantilla_codigo){
      return { puedeEnviarse:false, motivo:`La etapa cambió: el evento es de "${evento.plantilla_codigo}" pero la etapa vigente ahora es "${etapaVigente || 'ninguna'}".` };
    }
  } else if(evento.plantilla_codigo.startsWith('5.')){
    if(!vigenciaPlantillaPrincipal(db, siniestro, evento.plantilla_codigo)){
      return { puedeEnviarse:false, motivo:`La condición que originó "${evento.plantilla_codigo}" ya no se cumple (el expediente avanzó o cambió desde que se registró/liberó este evento).` };
    }
  }
  return { puedeEnviarse:true, motivo:null };
}

// Punto 2 (séptima revisión -- reemplaza el diseño de la sexta): la versión anterior comparaba cada
// plantilla contra su condición de origen de forma AISLADA (p. ej. "¿sigue autorizado con piezas?"), sin
// comprobar que el expediente no hubiera avanzado ADEMÁS a una etapa posterior -- por eso Roberto encontró
// que 5.2 seguía vigente aun ya autorizado, que 5.3 seguía vigente aun con piezas ya recibidas o producción
// ya iniciada, que 5.6/5.7 no descartaban producción ya iniciada, que 5.11 no comprobaba que ya se hubiera
// entregado, y que 5.12 no comprobaba nada más allá de la fecha de entrega. Y un código desconocido
// devolvía true (autorizaba por defecto) en vez de bloquear.
//
// Rediseño: UNA sola función, etapaCicloPrincipalActual(), calcula la etapa actual del expediente en el
// ciclo principal (igual patrón que etapaContinuidadActual() ya usa para 6.x) revisando las condiciones de
// la MÁS avanzada a la MENOS avanzada -- así que devuelve siempre la etapa más reciente alcanzada, nunca
// una etapa vieja que técnicamente "sigue siendo cierta" en aislado. vigenciaPlantillaPrincipal() compara
// el código contra esa etapa única: un mensaje es vigente si y solo si el expediente está EXACTAMENTE en
// la etapa que ese mensaje representa -- ninguno vigente si ya se pasó a la siguiente.
function etapaCicloPrincipalActual(db, siniestro){
  if(siniestro.archivado || siniestro.estatus_general === 'Cerrado') return null;
  if(siniestro.estado_autorizacion === 'rechazada') return null;
  if(siniestro.estado_autorizacion === 'parcial') return null; // igual que etapaContinuidadActual: en revisión, ningún 5.x vigente.

  // Eje de postventa: una vez entregado, es una etapa aparte -- nada del ciclo principal previo a la
  // entrega sigue vigente (si se entregó, ya pasó por todo lo anterior).
  if(siniestro.fecha_entrega_real && String(siniestro.fecha_entrega_real).trim()) return 'postventa';

  if(siniestro.estado_calidad === 'liberado') return '5.11';
  if(siniestro.estado_calidad === 'en_inspeccion') return '5.10';
  if(siniestro.estado_produccion === 'pintura') return '5.9';
  if(siniestro.estado_produccion === 'en_laminado') return '5.8';

  if(siniestro.estado_autorizacion === 'autorizada'){
    const conPiezas = Number(siniestro.piezas_autorizadas_cambio || 0) > 0;
    if(conPiezas){
      if(refaccionesRealmenteDisponibles(db, siniestro.id).disponible) return 'piezas_listas'; // 5.4/5.5, según ubicación.
      return '5.3';
    }
    return 'autorizado_sin_piezas'; // 5.6/5.7, según ubicación.
  }

  if(siniestro.valuacion_fecha_envio && String(siniestro.valuacion_fecha_envio).trim()) return '5.2';
  return '5.1';
}

function vigenciaPlantillaPrincipal(db, siniestro, codigo){
  const etapa = etapaCicloPrincipalActual(db, siniestro);
  if(etapa === null) return false;
  switch(codigo){
    case '5.1': return etapa === '5.1';
    case '5.2': return etapa === '5.2';
    case '5.3': return etapa === '5.3';
    case '5.4': return etapa === 'piezas_listas' && unidadEnTaller(db, siniestro.id) === 'fuera_taller';
    case '5.5': return etapa === 'piezas_listas' && unidadEnTaller(db, siniestro.id) === 'en_taller';
    case '5.6': return etapa === 'autorizado_sin_piezas' && unidadEnTaller(db, siniestro.id) === 'en_taller';
    case '5.7': return etapa === 'autorizado_sin_piezas' && unidadEnTaller(db, siniestro.id) === 'fuera_taller';
    case '5.8': return etapa === '5.8';
    case '5.9': return etapa === '5.9';
    case '5.10': return etapa === '5.10';
    case '5.11': return etapa === '5.11';
    case '5.12': return etapa === 'postventa' && siniestro.encuesta_estado !== 'respondida'; // ya hubo seguimiento -> deja de ser vigente.
    // Punto 2 (séptima revisión): fail-safe explícito. Un código que este módulo no reconoce NUNCA se
    // autoriza por defecto -- se bloquea de forma segura, igual que cualquier otro motivo de bloqueo.
    default: return false;
  }
}

// Se corre en el mismo barrido periódico (punto 8/1). Revalida cada evento "liberado_para_programacion":
// si alguna condición cambió desde que se liberó, NUNCA se envía por inercia -- vuelve a pendiente_revision
// para que un humano decida de nuevo (nunca se descarta solo, ni se envía solo).
function revalidarEventosLiberados(db){
  try{
    const liberados = db.prepare(`SELECT * FROM whatsapp_eventos_registrados WHERE estado='liberado_para_programacion'`).all();
    for(const ev of liberados){
      try{
        const v = validarAntesDeEnviar(db, ev.id);
        if(!v.puedeEnviarse){
          db.prepare(`UPDATE whatsapp_eventos_registrados SET estado='pendiente_revision', justificacion=? WHERE id=?`)
            .run('Revalidación automática: ' + v.motivo + ' (vuelve a revisión, no se descarta ni se envía solo).', ev.id);
        }
      } catch(e){ registrarError(db, { contexto:'revalidarEventosLiberados', siniestroId:ev.siniestro_id, plantillaCodigo:ev.plantilla_codigo, error:e }); }
    }
  } catch(e){ registrarError(db, { contexto:'revalidarEventosLiberados', error:e }); }
}

// ===================== Ciclo principal (5.1, 5.2, autorización, 5.8-5.11) =====================
// Una sola función idempotente, llamada tanto al momento del evento (PATCH/POST) como periódicamente
// (reconciliarEventosPrincipales, punto 8) para reintentar cualquier detección que se haya perdido. Es
// segura de llamar repetidas veces: cada intento de registro está protegido por su propia clave de
// deduplicación (fija, no depende del momento en que se evalúa), así que llamar dos veces sobre el mismo
// expediente en el mismo estado NUNCA produce un duplicado.
function evaluarYRegistrarCicloPrincipal(db, siniestro){
  const siniestroId = siniestro.id;
  const nombre = siniestro.cliente_nombre || '';
  const vehiculo = siniestro.vehiculo || '';

  // 5.1 Bienvenida -- punto 5: no depende solo de la creación. Se evalúa cada vez que el expediente
  // tiene teléfono capturado (aquí o después); la clave de deduplicación fija ('creacion') garantiza que
  // se registre una sola vez por siniestro, sin importar cuántas veces se edite el teléfono después.
  if(siniestro.cliente_telefono && String(siniestro.cliente_telefono).trim()){
    try{
      registrarConChequeoDelicada(db, {
        siniestroId, plantillaCodigo:'5.1',
        disparador:'Creación del expediente y vinculación del destino (o captura posterior del teléfono)',
        variables:{ nombre, vehiculo }, dedupKey:'creacion', aplicaChequeoDelicada:false,
      });
    } catch(e){ registrarError(db, { contexto:'ciclo_principal:5.1', siniestroId, plantillaCodigo:'5.1', error:e }); }
  }

  // 5.2 Revisión enviada.
  if(siniestro.valuacion_fecha_envio && String(siniestro.valuacion_fecha_envio).trim()){
    try{
      registrarConChequeoDelicada(db, {
        siniestroId, plantillaCodigo:'5.2',
        disparador:'Revisión concluida y presupuesto enviado a la aseguradora',
        variables:{ nombre, vehiculo }, dedupKey:'envio:' + siniestro.valuacion_fecha_envio,
      });
    } catch(e){ registrarError(db, { contexto:'ciclo_principal:5.2', siniestroId, plantillaCodigo:'5.2', error:e }); }
  }

  // Autorización -- punto 4: 'parcial' YA NO dispara 5.3/5.6/5.7. Bloquea y pide revisión humana.
  // Solo 'autorizada' (completa y confirmada) evalúa el disparador normal.
  try{
    if(siniestro.estado_autorizacion === 'autorizada'){
      const conPiezas = Number(siniestro.piezas_autorizadas_cambio || 0) > 0;
      if(conPiezas){
        registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.3',
          disparador:'Autorización confirmada y existen piezas a cambio', variables:{ nombre }, dedupKey:'autorizacion' });
      } else {
        const ubicacion = unidadEnTaller(db, siniestroId);
        if(ubicacion === 'desconocido'){
          registrarEvento(db, { siniestroId, plantillaCodigo:'5.6',
            disparador:'Autorización confirmada; sin piezas a cambio; NO se puede determinar con certeza si la unidad está en el taller o circulando (ver nota de diseño, punto 6)',
            variables:{ nombre }, dedupKey:'autorizacion',
            bloqueadoPorMotivo:'Ubicación física de la unidad no determinable con los datos actuales; requiere confirmación humana antes de elegir entre "en piso" y "en tránsito".',
            tipoBloqueo:'ubicacion_desconocida' });
        } else if(ubicacion === 'en_taller'){
          registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.6',
            disparador:'Autorización confirmada; sin piezas a cambio; unidad en piso', variables:{ nombre }, dedupKey:'autorizacion' });
        } else {
          registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.7',
            disparador:'Autorización confirmada; sin piezas a cambio; unidad fuera del taller', variables:{ nombre }, dedupKey:'autorizacion' });
        }
      }
    } else if(siniestro.estado_autorizacion === 'parcial'){
      const conPiezas = Number(siniestro.piezas_autorizadas_cambio || 0) > 0;
      const candidato = conPiezas ? '5.3' : '5.6'; // candidato solo informativo -- ver comentario en el módulo de bloqueo.
      registrarEvento(db, { siniestroId, plantillaCodigo:candidato,
        disparador:'Autorización PARCIAL (no completa): la comunicación automática queda bloqueada por definición, requiere revisión de Daniela antes de decidir qué comunicar',
        variables:{ nombre }, dedupKey:'autorizacion_parcial',
        bloqueadoPorMotivo:'Autorización parcial: no se genera comunicación automática. Solo si posteriormente se registra autorización completa se evalúa el disparador normal.',
        tipoBloqueo:'autorizacion_parcial' });
    }
  } catch(e){ registrarError(db, { contexto:'ciclo_principal:autorizacion', siniestroId, error:e }); }

  // 5.8 Hojalatería / 5.9 Pintura (inicio de etapa).
  try{
    if(siniestro.estado_produccion === 'en_laminado'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.8',
        disparador:'Cambio efectivo a Hojalatería', variables:{ nombre }, dedupKey:'hojalateria' });
    }
    if(siniestro.estado_produccion === 'pintura'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.9',
        disparador:'Cambio efectivo a Pintura', variables:{ nombre }, dedupKey:'pintura' });
    }
  } catch(e){ registrarError(db, { contexto:'ciclo_principal:produccion', siniestroId, error:e }); }

  // 5.10 Revisión de calidad / 5.11 Listo para entrega.
  try{
    if(siniestro.estado_calidad === 'en_inspeccion'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.10',
        disparador:'Entrada real al checklist / filtro final de calidad', variables:{ nombre }, dedupKey:'calidad_inspeccion' });
    }
    if(siniestro.estado_calidad === 'liberado'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.11',
        disparador:'Aprobación de calidad', variables:{ nombre }, dedupKey:'calidad_liberado' });
    }
  } catch(e){ registrarError(db, { contexto:'ciclo_principal:calidad', siniestroId, error:e }); }
}

// Punto 1 (séptima revisión): gate de activación -- si el módulo está apagado, o si este expediente en
// particular no está en el piloto (o no aplica "todos"), NINGUNA de estas tres funciones toca la base de
// datos. Se hace aquí, en los tres puntos de entrada reales del módulo (creación, transición, refacciones),
// para que un solo lugar (whatsappFaseAActivacion.siniestroElegible) decida todo -- nada se repite ni se
// puede quedar desactualizado en un cuarto sitio nuevo que alguien agregue después.
function procesarCreacionSiniestro(db, siniestro){
  if(!activacion.siniestroElegible(db, siniestro)) return;
  try{ evaluarYRegistrarCicloPrincipal(db, siniestro); }
  catch(e){ registrarError(db, { contexto:'procesarCreacionSiniestro', siniestroId: siniestro && siniestro.id, error:e }); }
}
function procesarTransicionSiniestro(db, { anterior, nuevo }){
  if(!activacion.siniestroElegible(db, nuevo)) return;
  try{ evaluarYRegistrarCicloPrincipal(db, nuevo); }
  catch(e){ registrarError(db, { contexto:'procesarTransicionSiniestro', siniestroId: anterior && anterior.id, error:e }); }
}

// 5.4 / 5.5 Piezas listas -- puntos 6 y 7. Se llama junto a verificarRefaccionesCompletas (pedidos.js,
// piezas.js) para reaccionar de inmediato, y también se reevalúa en el barrido de reconciliación.
function procesarRefaccionesCompletas(db, siniestroId){
  try{
    const siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(siniestroId);
    if(!siniestro || siniestro.requiere_refacciones !== 'si') return;
    if(!activacion.siniestroElegible(db, siniestro)) return;
    const variables = { nombre: siniestro.cliente_nombre||'' };
    const disp = refaccionesRealmenteDisponibles(db, siniestroId);

    if(disp.estado === 'sin_pedidos' || disp.estado === 'en_proceso'){
      // Punto 4 (sexta revisión): sin pedidos todavía, o en trámite normal -- todavía NO hay ninguna
      // señal real que reportar. Antes esto registraba un evento 5.5 "bloqueado" en ambos casos, aunque el
      // propio comentario del código decía lo contrario ("evita ruido..."); el código no hacía lo que el
      // comentario prometía. Ahora, de verdad, no se registra nada: ni un mensaje de cliente ni una alerta.
      return;
    }
    if(disp.estado === 'problema'){
      // Pedido(s) con un problema real: SÍ es una señal real que merece atención humana, pero NO es un
      // mensaje de cliente -- es una alerta interna (ALERTA-PEDIDO-PROBLEMA), separada de las otras dos.
      // dedupKey incluye la "firma" del problema actual (qué pedidos, en qué estatus): si se resuelve y
      // más adelante aparece un problema distinto (u otro pedido cae en el mismo estatus), la firma cambia
      // y se genera una alerta nueva -- no queda silenciada para siempre por la primera.
      registrarEventoInterno(db, { siniestroId, codigo:'ALERTA-PEDIDO-PROBLEMA',
        disparador: disp.motivo, variables, dedupKey:'pedido_problema:' + disp.firma });
      return;
    }
    // disp.estado === 'completo': las refacciones sí están disponibles -- sigue el flujo normal.
    const ubicacion = unidadEnTaller(db, siniestroId);
    if(ubicacion === 'desconocido'){
      registrarEvento(db, { siniestroId, plantillaCodigo:'5.5',
        disparador:'Piezas disponibles; NO se puede determinar con certeza si la unidad está en el taller o circulando (ver nota de diseño, punto 6)',
        variables, dedupKey:'refacciones_completas',
        bloqueadoPorMotivo:'Ubicación física de la unidad no determinable con los datos actuales; requiere confirmación humana antes de elegir entre "en piso" y "en tránsito".',
        tipoBloqueo:'ubicacion_desconocida' });
    } else if(ubicacion === 'en_taller'){
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.5',
        disparador:'Piezas disponibles; unidad ya en el taller', variables, dedupKey:'refacciones_completas' });
    } else {
      registrarConChequeoDelicada(db, { siniestroId, plantillaCodigo:'5.4',
        disparador:'Piezas disponibles; unidad fuera del taller', variables, dedupKey:'refacciones_completas' });
    }
  } catch(e){ registrarError(db, { contexto:'procesarRefaccionesCompletas', siniestroId, error:e }); }
}

// ----- Etapa actual para continuidad -----
// Regresa el código 6.x que aplica ahora, o null si no aplica ninguna (expediente cerrado/archivado,
// calidad ya liberada, autorización rechazada o PARCIAL, sin ningún 6.x que la represente).
function etapaContinuidadActual(db, siniestro){
  if(siniestro.archivado || siniestro.estatus_general === 'Cerrado') return null;
  if(siniestro.estado_calidad === 'liberado') return null;
  if(siniestro.estado_autorizacion === 'rechazada') return null;
  // Punto 1 (sexta revisión): la versión anterior trataba 'parcial' igual que "todavía sin autorizar"
  // (ambas caían en el mismo `!== 'autorizada'` y devolvían 6.1, "esperando autorización" -- como si nada
  // hubiera pasado todavía). Pero una autorización PARCIAL ya generó una decisión humana bloqueada
  // (tipo_bloqueo 'autorizacion_parcial' en el ciclo principal, ver evaluarYRegistrarCicloPrincipal): el
  // caso está en revisión de Daniela, no "esperando" en el sentido de 6.1. Por eso NO se registra ningún
  // 6.x mientras la autorización siga parcial -- ni continuidad de cliente ni confusión con "esperando".
  if(siniestro.estado_autorizacion === 'parcial') return null;

  if(siniestro.estado_autorizacion !== 'autorizada') return '6.1';

  if(siniestro.estado_calidad === 'en_inspeccion') return '6.6';
  if(siniestro.estado_produccion === 'pintura') return '6.5';
  if(siniestro.estado_produccion === 'en_laminado') return '6.4';

  const requierePiezas = Number(siniestro.piezas_autorizadas_cambio || 0) > 0;
  if(requierePiezas && !refaccionesRealmenteDisponibles(db, siniestro.id).disponible) return '6.2';
  return '6.3';
}

// ===================== Comunicación saliente detectada (punto 3 quinta revisión; REDISEÑADO por el =====
// ===================== punto 9 de la sexta revisión; corregido por el punto 2 de la octava revisión) =====
// LA QUINTA ENTREGA hacía que Alejandra (o quien registrara) decidiera A MANO, cada vez, si una
// comunicación fue "informativa de avance" o "administrativa" -- eso es exactamente la carga operativa
// que Roberto rechazó en la sexta revisión: "sin agregar trabajo".
//
// Antes de rediseñar, se investigó la documentación OFICIAL de Meta (punto 9 lo pide explícitamente: "con
// documentación y pruebas", no solo código) para confirmar si existe una forma de detectar esto sin que
// nadie tenga que capturar ni clasificar nada. SÍ existe: cuando un número está en modo Coexistencia
// (vinculado a Cloud API y usado también desde la app de WhatsApp Business), cada mensaje que se envía
// manualmente desde esa app dispara un webhook "smb_message_echoes" hacia el número configurado -- Meta ya
// distingue automáticamente "el negocio le escribió al cliente por la app".
//   Fuente: developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview -- evento
//   smb_message_echoes: "describes any new messages the business customer sends with the WhatsApp
//   Business app after onboarding".
//
// CORRECCIÓN (octava revisión, punto 2): "Meta no distingue un avance real de un saludo o mensaje
// administrativo. Por ello, los ecos manuales deben conservarse en el historial y deduplicarse mediante
// wamid, pero no deben reiniciar automáticamente el contador de 72 horas." Esta función SIGUE registrando
// cada eco (historial completo, deduplicado por wamid, sin que nadie tenga que clasificar nada) -- lo que
// cambió es que ultimoAncla() (más abajo) ya NO la consulta. El contador de continuidad de 72h se reinicia
// EXCLUSIVAMENTE por una comunicación automática del propio sistema (una de las 12 plantillas 5.x,
// registrada porque el expediente tuvo un cambio de estado real y verificable en SC Control) -- nunca por
// un eco de mensaje manual, sin importar su contenido.
function registrarComunicacionSaliente(db, { siniestroId, referenciaExterna=null, nota=null, wamid=null }){
  const s = db.prepare('SELECT * FROM siniestros WHERE id=?').get(siniestroId);
  if(!s) throw new Error('Siniestro no encontrado.');
  // Punto 1 (séptima revisión): mismo gate de activación/piloto que el resto del módulo -- un eco
  // detectado sobre un expediente fuera del piloto tampoco debe escribir nada.
  if(!activacion.siniestroElegible(db, s)){
    return { omitido:true, motivo:'Módulo desactivado o expediente fuera del piloto (whatsapp_config).' };
  }
  // Punto 3 (séptima revisión): deduplicación por wamid -- el identificador único que Meta asigna a cada
  // mensaje. Si Meta reintenta la entrega del webhook (lo hace si no recibe 200 a tiempo), el mismo wamid
  // llega dos veces; sin este chequeo, se habría registrado dos veces la misma comunicación en el
  // historial.
  if(wamid){
    const existente = db.prepare('SELECT * FROM whatsapp_comunicaciones_manuales WHERE wamid=?').get(wamid);
    if(existente) return { ...existente, duplicado:true };
  }
  const notaFinal = nota || (referenciaExterna ? ('echo:' + referenciaExterna) : null);
  const info = db.prepare(`INSERT INTO whatsapp_comunicaciones_manuales (siniestro_id,tipo,nota,registrado_por,wamid,piloto_run_id) VALUES (?,?,?,?,?,?)`)
    .run(siniestroId, 'informativa_avance', notaFinal, null, wamid, activacion.pilotoRunActual(db));
  return db.prepare('SELECT * FROM whatsapp_comunicaciones_manuales WHERE id=?').get(info.lastInsertRowid);
}

// Ancla de tiempo para medir continuidad (punto 1) -- REDISEÑADO (octava revisión, punto 2). Hasta la
// séptima entrega, esta función tomaba la más reciente entre (a) la última plantilla del ciclo principal
// (5.x) registrada automáticamente y (b) la última comunicación MANUAL (un eco de smb_message_echoes).
// Roberto corrigió esto: "Meta no distingue un avance real de un saludo o mensaje administrativo" -- así
// que un eco manual NUNCA puede ser una señal confiable de que el expediente tuvo avance real. Ahora el
// ancla usa EXCLUSIVAMENTE la última plantilla del ciclo principal (5.x) ya registrada -- es decir, un
// cambio de estado REAL y VERIFICABLE del expediente en SC Control (autorización, cambio de etapa de
// producción, calidad, etc.), nunca un mensaje. Un mensaje de continuidad (6.x) tampoco cuenta como
// "avance" (eso es lo que permite detectar el segundo periodo consecutivo, punto 2 de la cuarta revisión).
// Si nunca hubo ninguna plantilla automática registrada, se usa la creación del expediente.
function ultimoAncla(db, siniestroId, siniestroCreadoEn){
  // Punto 8 (sexta revisión): el ancla ya no usa el crudo creado_en (momento de DETECCIÓN) sino
  // COALESCE(simulado_enviado_en, creado_en) -- el momento SIMULADO en que ese mensaje se habría enviado
  // de verdad (igual a "momento real de la comunicación" que pidió Roberto, dentro de lo que "solo
  // registro" permite sin mecanismo de envío real). El COALESCE es compatibilidad hacia atrás: filas
  // creadas antes de esta migración no tienen simulado_enviado_en y siguen usando creado_en como antes.
  const ultimoAutomatico = db.prepare(`
    SELECT COALESCE(simulado_enviado_en, creado_en) AS creado_en FROM whatsapp_eventos_registrados
    WHERE siniestro_id = ? AND estado = 'registrado' AND es_plantilla_meta = 1 AND plantilla_codigo LIKE '5.%'
    ORDER BY COALESCE(simulado_enviado_en, creado_en) DESC LIMIT 1
  `).get(siniestroId);
  // OJO: siniestroCreadoEn es solo el valor de RESPALDO cuando nunca hubo ninguna comunicación automática
  // real -- no compite contra ella. Si compitiera, la fecha de creación (casi siempre más reciente que un
  // ancla intencionalmente vieja) ganaría siempre y el contador nunca avanzaría.
  if(!ultimoAutomatico || !ultimoAutomatico.creado_en) return siniestroCreadoEn;
  return ultimoAutomatico.creado_en;
}

// ----- Barrido periódico: continuidad de 72h NATURALES (6.1-6.6 / alerta interna) + postventa 48h (5.12). -----
function barrerContinuidadYPostventa(db){
  try{
    const ahora = dayjs.utc();
    const ahoraStr = ahora.format('YYYY-MM-DD HH:mm:ss');

    const activos = db.prepare(`SELECT * FROM siniestros WHERE (archivado IS NULL OR archivado = 0) AND estatus_general != 'Cerrado'`).all();
    for(const s of activos){
      if(!activacion.siniestroElegible(db, s)) continue; // punto 1, séptima revisión: gate de activación/piloto.
      try{
        const codigo = etapaContinuidadActual(db, s);
        if(!codigo) continue;
        const anclaUTC = ultimoAncla(db, s.id, s.creado_en);
        const horas = horasNaturalesTranscurridas(anclaUTC, ahoraStr); // NATURALES, punto 1.
        if(horas < 72) continue;
        const ventana = Math.floor(horas / 72); // 1 = primer periodo sin novedad; 2+ = periodos consecutivos.
        const variables = { nombre: s.cliente_nombre || '', vehiculo: s.vehiculo || '' };
        // Punto 6 (sexta revisión): dedupKey anclada al CICLO de estancamiento (ancla + etapa), no a la
        // ventana numérica. Con 'ventana:1' / 'ventana:'+ventana (versión anterior) pasaban dos cosas
        // mal: (a) 'ventana:1' era un literal FIJO que nunca cambiaba, así que una vez registrado el
        // primer mensaje de continuidad, un ciclo de estancamiento POSTERIOR (después de que el cliente sí
        // recibió avance real y el ancla se movió) jamás habría vuelto a generarlo -- chocaba para siempre
        // con la fila del primer ciclo; y (b) 'ventana:'+ventana generaba una ALERTA NUEVA por cada
        // ventana de 72h que pasara sin avance (2, 3, 4...), en vez de una sola por ciclo, como pidió
        // Roberto. Ahora la clave incluye anclaUTC (que solo cambia cuando hay avance real o cambio de
        // etapa): mientras el ciclo siga activo, todas las corridas del barrido comparten la misma clave y
        // deduplican; en cuanto el ancla se mueve (nuevo ciclo), la clave cambia y se genera una nueva.
        const claveCiclo = 'ciclo:' + anclaUTC + ':' + codigo;
        if(ventana === 1){
          registrarConChequeoDelicada(db, {
            siniestroId: s.id, plantillaCodigo: codigo,
            disparador: '72 horas naturales sin comunicación informativa real en la etapa actual (' + codigo + ')',
            variables, dedupKey: claveCiclo,
          });
        } else {
          // Punto 2: segundo periodo consecutivo (y siguientes) sin avance real -> alerta interna,
          // NUNCA otra plantilla de Meta. No se vuelve a tranquilizar automáticamente al cliente. Una sola
          // alerta por ciclo (punto 6): la MISMA clave de ciclo se reusa sin importar si ya van 2, 3 o 10
          // ventanas consecutivas -- deduplica hasta que el ciclo termine de verdad.
          registrarEventoInterno(db, {
            siniestroId: s.id, codigo:'ALERTA-72H-X2',
            disparador: `Periodo consecutivo #${ventana} de 72h naturales sin avance real en la etapa ${codigo} -- requiere revisión humana antes de decidir cualquier nueva comunicación.`,
            variables, dedupKey: claveCiclo,
          });
        }
      } catch(e){ registrarError(db, { contexto:'barrerContinuidadYPostventa:continuidad', siniestroId: s.id, error:e }); }
    }

    const entregados = db.prepare(`SELECT * FROM siniestros WHERE fecha_entrega_real IS NOT NULL AND fecha_entrega_real != ''`).all();
    for(const s of entregados){
      if(!activacion.siniestroElegible(db, s)) continue; // punto 1, séptima revisión.
      try{
        const entrega = dayjs.utc(s.fecha_entrega_real);
        if(!entrega.isValid()) continue;
        if(ahora.diff(entrega, 'hour') < 48) continue;
        registrarConChequeoDelicada(db, {
          siniestroId: s.id, plantillaCodigo: '5.12',
          disparador: '48 h después de registrar la entrega',
          variables: { nombre: s.cliente_nombre || '' }, dedupKey: 'postventa:' + s.fecha_entrega_real,
        });
      } catch(e){ registrarError(db, { contexto:'barrerContinuidadYPostventa:postventa', siniestroId: s.id, error:e }); }
    }
  } catch(e){ registrarError(db, { contexto:'barrerContinuidadYPostventa', error:e }); }
}

// ===================== Reconciliación / reintento seguro (punto 8) =====================
// Se llama desde el mismo barrido periódico ya existente. Reevalúa el ciclo principal (5.1, 5.2,
// autorización, 5.8-5.11) y las refacciones completas (5.4/5.5) para todos los expedientes activos.
// Como cada registro usa una clave de deduplicación FIJA (no depende de "ahora"), llamar esto una y
// otra vez sobre expedientes que ya tienen su evento registrado no produce ningún duplicado -- es
// exactamente el mecanismo de "reintento seguro" que pidió Roberto: si un enganche puntual falló (quedó
// su error en whatsapp_errores), este barrido lo vuelve a intentar automáticamente en la siguiente carga
// del resumen diario, sin ninguna acción manual.
function reconciliarEventosPrincipales(db){
  try{
    const activos = db.prepare(`SELECT * FROM siniestros WHERE (archivado IS NULL OR archivado = 0) AND estatus_general != 'Cerrado'`).all();
    for(const s of activos){
      if(!activacion.siniestroElegible(db, s)) continue; // punto 1, séptima revisión: nunca reconstruye toda la cartera sin permiso explícito.
      try{ evaluarYRegistrarCicloPrincipal(db, s); }
      catch(e){ registrarError(db, { contexto:'reconciliarEventosPrincipales:ciclo', siniestroId: s.id, error:e }); }
      try{ procesarRefaccionesCompletas(db, s.id); }
      catch(e){ registrarError(db, { contexto:'reconciliarEventosPrincipales:refacciones', siniestroId: s.id, error:e }); }
    }
  } catch(e){ registrarError(db, { contexto:'reconciliarEventosPrincipales', error:e }); }
}

// ===================== Resolución de expediente por teléfono (para mensajes entrantes) =====================
// Punto 3 (sexta revisión): usa normalizarTelefonoMX -- la MISMA función que valida el destino de salida
// -- para comparar. SQLite no tiene ninguna función nativa para normalizar teléfonos (quitar +52/52,
// guiones, espacios), así que la comparación exacta "cliente_telefono = ?" de la versión anterior solo
// hacía match si el teléfono entrante estaba guardado carácter por carácter igual al capturado en el
// expediente -- un mismo número recibido como "5215512345678" y capturado como "55-1234-5678" nunca habría
// hecho match. Se trae el universo de candidatos con teléfono capturado y se normaliza cada uno en JS.
function resolverExpedientePorTelefono(db, telefono){
  const norm = normalizarTelefonoMX(telefono);
  if(!norm.valido) return { resultado:'sin_telefono', siniestro: null, candidatos: [] };
  const candidatosCrudos = db.prepare(`
    SELECT id, numero, cliente_nombre, vehiculo, estatus_general, cliente_telefono
    FROM siniestros
    WHERE cliente_telefono IS NOT NULL AND cliente_telefono != '' AND (archivado IS NULL OR archivado = 0) AND estatus_general != 'Cerrado'
    ORDER BY id DESC
  `).all();
  const activos = candidatosCrudos
    .filter(c => { const n = normalizarTelefonoMX(c.cliente_telefono); return n.valido && n.local === norm.local; })
    .map(({ cliente_telefono, ...resto }) => resto);
  if(activos.length === 0) return { resultado:'sin_expediente_activo', siniestro: null, candidatos: [] };
  if(activos.length === 1) return { resultado:'resuelto_automatico', siniestro: activos[0], candidatos: activos };
  return { resultado:'ambiguo_pendiente_asignacion', siniestro: null, candidatos: activos };
}

module.exports = {
  PLANTILLAS, EVENTOS_INTERNOS,
  esHorarioHabil, siguienteMomentoHabil, horasHabilesTranscurridas, horasNaturalesTranscurridas,
  normalizarTelefonoMX,
  tieneIncidenciaDelicadaActiva, unidadEnTaller, refaccionesRealmenteDisponibles, validarDestino,
  registrarEvento, registrarEventoInterno, registrarConChequeoDelicada, registrarError,
  condicionDeBloqueoSigueActiva, revisarBloqueadosResueltos, resolverPendienteRevision,
  registrarComunicacionSaliente,
  validarAntesDeEnviar, vigenciaPlantillaPrincipal, etapaCicloPrincipalActual, revalidarEventosLiberados,
  evaluarYRegistrarCicloPrincipal,
  procesarCreacionSiniestro, procesarTransicionSiniestro, procesarRefaccionesCompletas,
  etapaContinuidadActual, ultimoAncla, barrerContinuidadYPostventa, reconciliarEventosPrincipales,
  resolverExpedientePorTelefono,
};
