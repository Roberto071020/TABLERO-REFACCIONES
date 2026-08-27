const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'America/Mexico_City';

function nowUTC(){
  return dayjs.utc().format('YYYY-MM-DD HH:mm:ss');
}
function toLocal(utcString){
  if(!utcString) return '';
  return dayjs.utc(utcString).tz(TZ).format('YYYY-MM-DD HH:mm');
}
function toLocalDate(utcString){
  if(!utcString) return '';
  return dayjs.utc(utcString).tz(TZ).format('YYYY-MM-DD');
}

// Registra un evento inmutable en la bitácora. No existen rutas UPDATE/DELETE para auditoria (F-22).
function registrarAuditoria(db, { entidad_tipo, entidad_id, accion, campo=null, valor_anterior=null, valor_nuevo=null, usuario }){
  db.prepare(`INSERT INTO auditoria (entidad_tipo, entidad_id, accion, campo, valor_anterior, valor_nuevo, usuario_id, usuario_nombre)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(entidad_tipo, entidad_id, accion, campo, valor_anterior==null?null:String(valor_anterior), valor_nuevo==null?null:String(valor_nuevo),
         usuario ? usuario.id : null, usuario ? usuario.nombre : 'sistema');
}

// Compara dos objetos plano y registra en auditoria cada campo que cambió (F-06 / F-22: valor anterior/nuevo).
function auditarCambios(db, { entidad_tipo, entidad_id, anterior, nuevo, usuario }){
  Object.keys(nuevo).forEach(campo=>{
    const av = anterior ? anterior[campo] : undefined;
    const nv = nuevo[campo];
    if(av !== undefined && String(av) !== String(nv)){
      registrarAuditoria(db, { entidad_tipo, entidad_id, accion:'edicion', campo, valor_anterior:av, valor_nuevo:nv, usuario });
    }
  });
}

// F-17: neutraliza fórmulas (=, +, -, @, tab, CR) y escapa comillas para CSV seguro (RFC4180 + anti CSV-injection).
function csvCell(value){
  let v = (value===null || value===undefined) ? '' : String(value);
  if(/^[=+\-@\t\r]/.test(v)){
    v = "'" + v; // Excel/Sheets tratan la celda como texto y no ejecutan la fórmula
  }
  v = v.replace(/"/g, '""');
  return '"' + v + '"';
}
// Fuerza texto preservando ceros a la izquierda al abrir en Excel (CA-10 real).
function csvTextForced(value){
  const v = String(value===null||value===undefined?'':value).replace(/"/g,'""');
  return '"=""' + v + '"""';
}


// Módulo Alejandra (Fase 5): si TODOS los pedidos del expediente quedaron en un estado terminal
// (Recibido completo / Cancelado / Cerrado), crea una tarea automática para Alejandra, una sola vez.
function verificarRefaccionesCompletas(db, siniestroId, usuario){
  const TERMINALES = ['Recibido completo','Cancelado','Cerrado'];
  const pedidos = db.prepare('SELECT estatus_operativo FROM pedidos WHERE siniestro_id = ?').all(siniestroId);
  if(pedidos.length === 0) return;
  const todosTerminales = pedidos.every(p => TERMINALES.includes(p.estatus_operativo));
  if(!todosTerminales) return;

  const yaExiste = db.prepare(`SELECT id FROM tareas WHERE siniestro_id=? AND disparador='refacciones_completas' AND estado IN ('pendiente','en_proceso')`).get(siniestroId);
  if(yaExiste) return;

  db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,responsable_id,fecha_limite,estado,origen,disparador,creado_por)
    VALUES (?,?,?,?,?,'pendiente','automatica','refacciones_completas',?)`)
    .run(siniestroId, 'mensaje', 'Refacciones completas: avisar al cliente y gestionar cita de reingreso.',
         usuario ? usuario.id : null, new Date().toISOString().slice(0,10), usuario ? usuario.id : null);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: siniestroId, accion:'automatico',
    valor_nuevo: 'Tarea automática creada: refacciones completas', usuario });
}

// Fase 5: si la fecha prometida de un pedido cambia, crea tarea para que Alejandra avise al cliente del cambio.
function crearTareaFechaPromesaModificada(db, { siniestroId, pedidoNumero, fechaAnterior, fechaNueva, usuario }){
  db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,responsable_id,fecha_limite,estado,origen,disparador,creado_por)
    VALUES (?,?,?,?,?,'pendiente','automatica','fecha_promesa_modificada',?)`)
    .run(siniestroId, 'mensaje',
         `Informar al cliente el cambio de fecha prometida del pedido ${pedidoNumero} (antes: ${fechaAnterior||'sin definir'}, ahora: ${fechaNueva}).`,
         usuario ? usuario.id : null, new Date().toISOString().slice(0,10), usuario ? usuario.id : null);
}


// ===================== Requerimientos de Daniela (Fase 4): correos automáticos =====================

// Reglas de copia conocidas por aseguradora (seccion "CORREOS" del documento de Daniela).
// Correccion del 27-ago-2026: antes se guardaba texto de INSTRUCCION ("Copiar a Jorge Contreras y
// Edgar...") directo en el campo de copia, y se mostraba como si fuera contenido real del correo.
// Ahora solo se usan direcciones reales confirmadas (por ahora, unicamente GNP); donde no hay una
// direccion real configurada, el campo de copia queda vacio -- nunca texto de instruccion ni
// direcciones inventadas.
const CC_GNP = 'cristian.hernandezortiz@gnp.com.mx, luis.ramirezalvarez@gnp.com.mx, roveytia@hotmail.com';
const REGLAS_ASEGURADORA = {
  'GNP': CC_GNP,
};
function copiaSugeridaPorAseguradora(aseguradora){
  return REGLAS_ASEGURADORA[aseguradora] || '';
}

const EMAIL_VALIDO_AUTOMATICO = /^[^\s@,;]+@[^\s@]+\.[^\s@]+$/;

function esDiaHabil(fecha){
  const d = new Date(fecha + 'T00:00:00Z').getUTCDay();
  return d !== 0 && d !== 6; // 0=domingo, 6=sábado
}
// Suma N días hábiles (lunes a viernes) a una fecha YYYY-MM-DD. No considera días festivos (no hay calendario
// oficial de festivos capturado en el sistema); queda documentado como simplificación conocida.
function sumarDiasHabiles(fechaStr, n){
  let d = new Date(fechaStr + 'T00:00:00Z');
  let agregados = 0;
  while(agregados < n){
    d.setUTCDate(d.getUTCDate() + 1);
    const dia = d.getUTCDay();
    if(dia !== 0 && dia !== 6) agregados++;
  }
  return d.toISOString().slice(0,10);
}

const ESTATUS_PIEZA_CERRADOS_CORREO = ['Recibida físicamente','Cancelada'];

// ===================== Ventana operativa (27-ago-2026, instrucción de Daniela/Roberto) =====================
// El taller decidió operar el tablero de refacciones únicamente con datos de InPart desde el 1 de
// junio de 2026 en adelante (la carga de enero-mayo no aporta a la operación real y solo saturaba las
// vistas). Este corte se aplica a las pantallas y reportes DE REFACCIONES (lista maestra, Kanban,
// indicadores, búsqueda de pedidos/piezas, correos pendientes, incidencias, exportaciones) filtrando por
// la fecha de creación del PEDIDO -- nunca se borra ni se deja de importar nada, solo se deja de mostrar
// por default. Los módulos de Alejandra/Orlando/Vanessa/Beto (admisión, técnica, expediente, valuación,
// producción, calidad, entrega) NO se tocan: siguen viendo el expediente completo sin este corte, porque
// ahí sí importa el historial real del vehículo sin importar cuándo se creó su pedido de refacciones.
const VENTANA_OPERATIVA_DESDE = '2026-06-01';

// Hallazgo real durante la verificación de la ventana operativa (27-ago-2026): la carga masiva
// guardaba "fecha_creacion_pedido" TAL CUAL venía del CSV de Inpart, sin normalizar a ISO. La
// mayoría de los pedidos reales llegaron en formato DD/MM/AAAA (ej. "02/06/2026"), y una comparación
// de texto contra '2026-06-01' los descartaba por error aunque su fecha real SÍ estuviera dentro de
// la ventana (192 de 213 pedidos en producción tenían este problema). fecha_prevista nunca tuvo este
// problema porque la carga masiva ya la validaba en formato ISO antes de aceptar el archivo (ISO_FECHA
// en cargaMasiva.js); fecha_creacion_pedido no tenía esa misma validación.
function normalizarFechaISO(valor){
  const v = String(valor||'').trim();
  if(!v) return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v; // ya viene en ISO
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // DD/MM/AAAA (formato real observado en producción)
  if(m){
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return v; // formato desconocido: se deja igual en vez de inventar una fecha
}

// Corrección de los datos ya importados con el problema de arriba: recorre los pedidos cuya
// fecha_creacion NO está en formato ISO y la reescribe (nunca inventa una fecha nueva, solo
// reordena/normaliza el mismo valor). Idempotente -- correr de nuevo no cambia nada ya corregido.
function normalizarFechasCreacionPedidosExistentes(db){
  const pedidos = db.prepare(`SELECT id, numero, fecha_creacion FROM pedidos WHERE fecha_creacion IS NOT NULL AND fecha_creacion != '' AND fecha_creacion NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`).all();
  let corregidos = 0;
  for(const p of pedidos){
    const nueva = normalizarFechaISO(p.fecha_creacion);
    if(nueva && nueva !== p.fecha_creacion && /^\d{4}-\d{2}-\d{2}$/.test(nueva)){
      db.prepare('UPDATE pedidos SET fecha_creacion = ? WHERE id = ?').run(nueva, p.id);
      registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id:p.id, accion:'fecha_creacion_normalizada', campo:'fecha_creacion',
        valor_anterior:p.fecha_creacion, valor_nuevo:nueva, usuario:null });
      corregidos++;
    }
  }
  if(corregidos > 0) console.log(`Normalización de fechas de creación de pedido: ${corregidos} corregida(s) a formato ISO.`);
  return corregidos;
}
// ?ventana=todas en cualquiera de esos endpoints regresa al comportamiento sin corte (para auditoría /
// soporte), igual que ya existe ?archivado=all para lo archivado.
function aplicaVentanaOperativa(query){
  return !(query && query.ventana === 'todas');
}

// Corrección de Daniela/Roberto (27-ago-2026): las piezas que van en el correo automático (para el
// listado y para resolver a qué proveedor escribir) son solo las que siguen pendientes -- nunca las ya
// recibidas o canceladas (regla R-04, ahora también aplicada a los tres disparadores automáticos, antes
// solo se aplicaba al borrador manual de generar-borrador).
function piezasPendientesDePedido(db, pedidoId){
  return db.prepare(`SELECT z.*, pv.correo as proveedor_correo, pv.razon_social as proveedor_nombre
                      FROM piezas z LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
                      WHERE z.pedido_id = ? AND z.estatus NOT IN (?,?)`)
    .all(pedidoId, ...ESTATUS_PIEZA_CERRADOS_CORREO);
}

// Corrección de Daniela/Roberto (27-ago-2026): el destinatario se obtiene SIEMPRE del proveedor real
// asignado a las piezas pendientes del pedido -- nunca un correo de ejemplo ni queda vacío sin marcar.
// Si las piezas pendientes tienen más de un proveedor distinto, o ninguna tiene proveedor con correo
// válido, el borrador se marca "incompleto" (bloqueado para aprobar hasta que alguien lo complete a mano).
function resolverDestinatarioAutomatico(piezasPendientes){
  const conProveedorValido = piezasPendientes.filter(z => z.proveedor_id && z.proveedor_correo && EMAIL_VALIDO_AUTOMATICO.test(z.proveedor_correo.trim()));
  const proveedoresUnicos = [...new Set(conProveedorValido.map(z => z.proveedor_id))];
  if(proveedoresUnicos.length === 1){
    return { destinatario: conProveedorValido[0].proveedor_correo.trim(), proveedorId: proveedoresUnicos[0], incompleto: 0 };
  }
  return { destinatario: '', proveedorId: null, incompleto: 1 };
}

// Plantilla única para los tres motivos automáticos (pedido nuevo, vencimiento día 1, seguimiento cada
// 2 días), según el texto exacto pedido por Daniela/Roberto el 27-ago-2026. Antes cada motivo tenía un
// mensaje distinto y ninguno pedía con claridad estatus + piezas + fecha compromiso + incidencias, ni
// listaba las piezas pendientes.
function construirCuerpoAutomatico(pedidoNumero, siniestroNumero, piezasPendientes){
  const listado = piezasPendientes.map(p => '- ' + p).join('\n');
  return `Buen día.\n\n¿Nos podrían apoyar confirmando el estatus actualizado del pedido ${pedidoNumero}, correspondiente al siniestro ${siniestroNumero}, así como la disponibilidad y fecha estimada de entrega de las siguientes piezas pendientes?\n\n${listado}\n\nEn caso de existir algún retraso, faltante o incidencia, agradeceremos nos indiquen la situación y la nueva fecha compromiso.\n\nQuedo atenta a sus comentarios.\n\nSaludos,\nDaniela Sosa\nRefacciones`;
}

// Se llama al crear un pedido (F-04 de Daniela: "preparar correo cuando se detecte un pedido nuevo").
// Deja el correo PREPARADO y pendiente de aprobación; nunca se envía ni se aprueba solo.
function prepararCorreoPedidoNuevo(db, { pedido, siniestro }){
  const yaExiste = db.prepare(`SELECT id FROM comunicaciones WHERE pedido_id=? AND disparador='pedido_nuevo'`).get(pedido.id);
  if(yaExiste) return;
  // Triage documento de Daniela (DEF-009), y R-05 (27-ago-2026): si el pedido no tiene ninguna pieza
  // pendiente (recién creado sin piezas capturadas, o todas ya recibidas/canceladas), no hay a quién
  // escribirle ni qué pedirle -- no se prepara nada todavía.
  const piezasPendientes = piezasPendientesDePedido(db, pedido.id);
  if(piezasPendientes.length === 0) return;
  const { destinatario, proveedorId, incompleto } = resolverDestinatarioAutomatico(piezasPendientes);
  db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,estado,disparador,enviado_por,fecha_envio,incompleto)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)`)
    .run(pedido.id, siniestro.id, proveedorId, 'Correo', `SINIESTRO ${siniestro.numero} - PEDIDO ${pedido.numero}`, destinatario,
      copiaSugeridaPorAseguradora(siniestro.aseguradora),
      construirCuerpoAutomatico(pedido.numero, siniestro.numero, piezasPendientes.map(z => z.descripcion)),
      'pedido_nuevo', 'pendiente_aprobacion', 'pedido_nuevo', null, incompleto);
}

// Escaneo idempotente de vencimientos y seguimientos (F-DF-02/03 de Daniela). Se ejecuta de forma perezosa
// —igual que el backfill de hitos del módulo de Alejandra— cada vez que se consulta la bandeja de correos
// o el resumen diario, así no se necesita infraestructura de tareas programadas (cron) para operar.
const ESTATUS_TERMINALES_CORREO = ['Recibido completo','Cancelado','Cerrado'];
const DISPARADORES_AUTOMATICOS = ['pedido_nuevo','vencimiento_dia1','seguimiento_2dias'];

// Hallazgo de Daniela (26-ago-2026): se acumulaban varios avisos automaticos "pendiente_aprobacion"
// para el mismo pedido (uno por cada ciclo de vencimiento/seguimiento que pasaba sin que ella lo
// aprobara o descartara a tiempo), en vez de reemplazar al anterior. Antes de insertar un nuevo aviso
// automatico para un pedido, se descarta cualquier otro aviso automatico que siga pendiente -- asi solo
// queda vivo el que corresponde al estado actual. No se borra nada: queda con estado='descartado' y
// auditado, visible en el historial.
function descartarPendientesAutomaticosPrevios(db, pedidoId){
  const previos = db.prepare(`SELECT id FROM comunicaciones WHERE pedido_id=? AND estado='pendiente_aprobacion' AND disparador IN (${DISPARADORES_AUTOMATICOS.map(()=>'?').join(',')})`).all(pedidoId, ...DISPARADORES_AUTOMATICOS);
  for(const p of previos){
    db.prepare(`UPDATE comunicaciones SET estado='descartado' WHERE id=?`).run(p.id);
    registrarAuditoria(db, { entidad_tipo:'comunicacion', entidad_id:p.id, accion:'correo_descartado', usuario:null, valor_nuevo:'Sustituido automaticamente por un aviso mas reciente del mismo pedido (correccion de duplicados, 26-ago-2026).' });
  }
}

function verificarCorreosPendientes(db){
  const hoy = new Date().toISOString().slice(0,10);
  const pedidos = db.prepare(`SELECT * FROM pedidos WHERE estatus_operativo NOT IN (${ESTATUS_TERMINALES_CORREO.map(()=>'?').join(',')})`).all(...ESTATUS_TERMINALES_CORREO);

  for(const pedido of pedidos){
    const siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(pedido.siniestro_id);
    if(!siniestro) continue;

    // R-05 (27-ago-2026): si el pedido ya no tiene ninguna pieza pendiente (todas recibidas o
    // canceladas), ningún aviso automático debe generarse ni renovarse para él.
    const piezasPendientes = piezasPendientesDePedido(db, pedido.id);
    if(piezasPendientes.length === 0) continue;

    // Por si el pedido se creo antes de esta fase (o el hook no corrio), aseguramos el correo de "pedido nuevo".
    prepararCorreoPedidoNuevo(db, { pedido, siniestro });

    // Primer dia de vencimiento (solo una vez por pedido).
    if(pedido.fecha_prevista && pedido.fecha_prevista < hoy){
      const yaVencimiento = db.prepare(`SELECT id FROM comunicaciones WHERE pedido_id=? AND disparador='vencimiento_dia1'`).get(pedido.id);
      if(!yaVencimiento){
        descartarPendientesAutomaticosPrevios(db, pedido.id);
        const { destinatario, proveedorId, incompleto } = resolverDestinatarioAutomatico(piezasPendientes);
        db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,estado,disparador,enviado_por,fecha_envio,incompleto)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)`)
          .run(pedido.id, siniestro.id, proveedorId, 'Correo', `SINIESTRO ${siniestro.numero} - PEDIDO ${pedido.numero}`, destinatario,
            copiaSugeridaPorAseguradora(siniestro.aseguradora),
            construirCuerpoAutomatico(pedido.numero, siniestro.numero, piezasPendientes.map(z => z.descripcion)),
            'vencimiento_dia1', 'pendiente_aprobacion', 'vencimiento_dia1', null, incompleto);
      }
    }

    // Seguimiento cada 2 dias habiles mientras no haya respuesta del proveedor.
    // Se calcula sobre el ultimo aviso realmente aprobado/enviado (con respuesta pendiente), no sobre
    // borradores que Daniela nunca llego a aprobar -- de lo contrario cada visita a la bandeja podia
    // generar un seguimiento adicional sobre un borrador que ni siquiera se habia mandado.
    const ultima = db.prepare(`SELECT * FROM comunicaciones WHERE pedido_id=? AND estado IN ('aprobado','enviado') AND respuesta_texto IS NULL ORDER BY fecha_envio DESC LIMIT 1`).get(pedido.id);
    if(ultima){
      const fechaBase = (ultima.fecha_envio || '').slice(0,10);
      if(fechaBase){
        const limite = sumarDiasHabiles(fechaBase, 2);
        if(hoy >= limite){
          const yaSeguimiento = db.prepare(`SELECT id FROM comunicaciones WHERE pedido_id=? AND disparador='seguimiento_2dias' AND fecha_envio > ?`).get(pedido.id, ultima.fecha_envio);
          if(!yaSeguimiento){
            descartarPendientesAutomaticosPrevios(db, pedido.id);
            const { destinatario, proveedorId, incompleto } = resolverDestinatarioAutomatico(piezasPendientes);
            db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,estado,disparador,enviado_por,fecha_envio,incompleto)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)`)
              .run(pedido.id, siniestro.id, proveedorId, 'Correo', `SINIESTRO ${siniestro.numero} - PEDIDO ${pedido.numero}`, destinatario,
                copiaSugeridaPorAseguradora(siniestro.aseguradora),
                construirCuerpoAutomatico(pedido.numero, siniestro.numero, piezasPendientes.map(z => z.descripcion)),
                'seguimiento_2dias', 'pendiente_aprobacion', 'seguimiento_2dias', null, incompleto);
          }
        }
      }
    }
  }
}

// Limpieza unica, idempotente, de los duplicados ya acumulados en produccion antes de esta correccion
// (26-ago-2026). Para cada pedido, si hay mas de un aviso automatico pendiente_aprobacion, conserva solo
// el mas reciente y descarta (no borra) los demas. Se corre una vez al arrancar el servidor, igual que
// los otros backfills perezosos del proyecto.
function limpiarDuplicadosCorreosPendientesExistentes(db){
  const pedidosConVarios = db.prepare(`SELECT pedido_id, COUNT(*) as n FROM comunicaciones WHERE estado='pendiente_aprobacion' AND disparador IN (${DISPARADORES_AUTOMATICOS.map(()=>'?').join(',')}) GROUP BY pedido_id HAVING n > 1`).all(...DISPARADORES_AUTOMATICOS);
  let total = 0;
  for(const { pedido_id } of pedidosConVarios){
    const avisos = db.prepare(`SELECT id FROM comunicaciones WHERE pedido_id=? AND estado='pendiente_aprobacion' AND disparador IN (${DISPARADORES_AUTOMATICOS.map(()=>'?').join(',')}) ORDER BY fecha_envio DESC`).all(pedido_id, ...DISPARADORES_AUTOMATICOS);
    for(let i=1;i<avisos.length;i++){
      db.prepare(`UPDATE comunicaciones SET estado='descartado' WHERE id=?`).run(avisos[i].id);
      registrarAuditoria(db, { entidad_tipo:'comunicacion', entidad_id:avisos[i].id, accion:'correo_descartado', usuario:null, valor_nuevo:'Limpieza unica de duplicados acumulados antes de la correccion del 26-ago-2026 (se conserva solo el aviso mas reciente por pedido).' });
      total++;
    }
  }
  if(total > 0) console.log(`Limpieza de correos duplicados: se descartaron ${total} avisos redundantes, conservando el mas reciente por pedido.`);
}

// Corrección única, idempotente, de la plantilla/destinatario/copia de los borradores automáticos ya
// existentes en producción (27-ago-2026, hallazgo de Daniela: 212 borradores con destinatario
// "correo@proveedor.mx" o vacío, copia con texto de instrucción, y cuerpo que no pedía la información
// necesaria). Para cada borrador automático que SIGUE pendiente de aprobación:
//  - si el pedido ya no tiene piezas pendientes, se descarta (R-05: no debería seguir pidiendo nada);
//  - si sí tiene, se recalculan destinatario/proveedor/incompleto, copia y cuerpo con la lógica nueva,
//    conservando el mismo id, el mismo estado 'pendiente_aprobacion' y sin tocar fecha_envio (no se
//    aprueba, no se marca como enviado, no se manda ningún correo real).
function corregirBorradoresAutomaticosExistentes(db){
  const pendientes = db.prepare(`SELECT c.*, p.numero as pedido_numero, s.numero as siniestro_numero, s.aseguradora
                                  FROM comunicaciones c JOIN pedidos p ON p.id = c.pedido_id JOIN siniestros s ON s.id = c.siniestro_id
                                  WHERE c.estado='pendiente_aprobacion' AND c.disparador IN (${DISPARADORES_AUTOMATICOS.map(()=>'?').join(',')})`)
    .all(...DISPARADORES_AUTOMATICOS);
  let corregidos = 0, descartadosSinPiezas = 0;
  for(const com of pendientes){
    const piezasPendientes = piezasPendientesDePedido(db, com.pedido_id);
    if(piezasPendientes.length === 0){
      db.prepare(`UPDATE comunicaciones SET estado='descartado' WHERE id=?`).run(com.id);
      registrarAuditoria(db, { entidad_tipo:'comunicacion', entidad_id:com.id, accion:'correo_descartado', usuario:null,
        valor_nuevo:'El pedido ya no tiene piezas pendientes (todas recibidas/canceladas); se descarta al corregir la plantilla (27-ago-2026, R-05).' });
      descartadosSinPiezas++;
      continue;
    }
    const { destinatario, proveedorId, incompleto } = resolverDestinatarioAutomatico(piezasPendientes);
    const nuevoCuerpo = construirCuerpoAutomatico(com.pedido_numero, com.siniestro_numero, piezasPendientes.map(z => z.descripcion));
    const nuevaCopia = copiaSugeridaPorAseguradora(com.aseguradora);
    db.prepare(`UPDATE comunicaciones SET destinatarios=?, copia=?, cuerpo=?, proveedor_id=?, incompleto=? WHERE id=?`)
      .run(destinatario, nuevaCopia, nuevoCuerpo, proveedorId, incompleto, com.id);
    registrarAuditoria(db, { entidad_tipo:'comunicacion', entidad_id:com.id, accion:'correo_plantilla_corregida', usuario:null,
      valor_nuevo:`Destinatario/copia/cuerpo recalculados con la plantilla corregida del 27-ago-2026 (incompleto=${incompleto}). Sigue pendiente_aprobacion, no se aprobó ni se envió.` });
    corregidos++;
  }
  if(corregidos > 0 || descartadosSinPiezas > 0) console.log(`Corrección de plantilla de correos: ${corregidos} borrador(es) actualizados, ${descartadosSinPiezas} descartados por no tener piezas pendientes.`);
}


// ===================== Requerimientos de Daniela (Fase 5): archivo automático a 3 meses =====================
// Nunca se borra nada: solo se marca "archivado" para sacarlo de las vistas diarias. Sigue disponible en
// búsqueda e historial. Escaneo idempotente, mismo patrón perezoso que los anteriores.
function archivarSiniestrosVencidos(db){
  const limite = new Date();
  limite.setUTCDate(limite.getUTCDate() - 90);
  const limiteStr = limite.toISOString().slice(0,10);
  const candidatos = db.prepare(`SELECT id, fecha_entrega_real FROM siniestros WHERE archivado = 0 AND no_auto_archivar = 0 AND fecha_entrega_real IS NOT NULL AND fecha_entrega_real != '' AND fecha_entrega_real <= ?`).all(limiteStr);
  for(const c of candidatos){
    db.prepare(`UPDATE siniestros SET archivado = 1, archivado_en = datetime('now') WHERE id = ?`).run(c.id);
    registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: c.id, accion:'archivado_automatico',
      valor_nuevo: `Archivado automáticamente (entrega ${c.fecha_entrega_real}, +90 días)`, usuario: null });
  }
}


// ===================== Documento Maestro / Fase D: motor de reglas por aseguradora =====================
// Árbol de decisión de la sección 12.2 del documento. Nunca migra silenciosamente: siempre regresa
// también el texto de la regla aplicada, para trazabilidad (sección 17: "guardar la regla utilizada").
function calcularRutaAseguradora(aseguradora, piezasAutorizadasCambio){
  const piezas = (piezasAutorizadasCambio===null || piezasAutorizadasCambio===undefined || piezasAutorizadasCambio==='') ? null
    : (Number.isFinite(Number(piezasAutorizadasCambio)) ? Number(piezasAutorizadasCambio) : null);

  if(aseguradora === 'ANA'){
    return { ruta: 'pago_danos', regla: 'ANA Seguros: valuación BDEO, pago de daños/autosurtido. Nunca migra a Inpart.' };
  }
  if(aseguradora === 'Zurich'){
    return { ruta: 'inpart', regla: 'Zurich: sistema propio de valuación (no ACG). Refacciones a Inpart según práctica vigente — CONFIRMAR CASO POR CASO si hay información contradictoria (pendiente de confirmación, sección 19 del documento maestro).' };
  }
  if(aseguradora === 'GNP'){
    if(piezas === null) return { ruta: 'pendiente_confirmar', regla: 'GNP: falta capturar el número de piezas autorizadas a cambio para determinar autosurtido (1-3) vs Inpart (4+).' };
    if(piezas >= 1 && piezas <= 3) return { ruta: 'autosurtido', regla: `GNP con ${piezas} pieza(s) a cambio: autosurtido OBLIGATORIO. Nunca debe figurar como pendiente de Inpart.` };
    return { ruta: 'inpart', regla: `GNP con ${piezas} piezas a cambio (más de 3): flujo normal Inpart, salvo excepción documentada.` };
  }
  // Inbursa, Allianz, La Latinoamericana, Mapfre, Afirme y cualquier otra: regla general ACG + Inpart.
  return { ruta: 'inpart', regla: `${aseguradora || 'Aseguradora'}: ACG y migración a Inpart, salvo excepción documentada.` };
}


// Documento Maestro / Fase C (5.5, tabla 9): "¿Sistema de valuación correcto según aseguradora?" es una
// decisión que Vanessa debe confirmar, no algo que el sistema imponga solo. Se ofrece como SUGERENCIA
// (Vanessa/Orlando la confirman o corrigen en el expediente), reutilizando la misma regla por aseguradora
// que ya rige la ruta de refacciones (sección 12), sin inventar un catálogo nuevo.
function sistemaValuacionSugerido(aseguradora){
  if(aseguradora === 'ANA') return 'BDEO';
  if(aseguradora === 'Zurich') return 'Sistema propio (Zurich)';
  if(aseguradora) return 'ACG';
  return '';
}

// Triage documento de Daniela (DEF-024/REQ-020): semáforo de completitud por sección, para que se
// vea de un vistazo qué falta en cada expediente sin tener que entrar a cada pestaña una por una.
function calcularSemaforo(s){
  const admision = s.estado_revision_tecnica === 'revision_terminada' ? 'completo'
    : (s.estado_admision || s.estado_revision_tecnica) ? 'en_proceso' : 'pendiente';
  const expediente = s.estado_expediente === 'listo_para_valuacion' ? 'completo'
    : s.estado_expediente ? 'en_proceso' : 'pendiente';
  const valuacion = ['autorizada','parcial'].includes(s.estado_autorizacion) ? 'completo'
    : (s.valuacion_folio || s.estado_autorizacion) ? 'en_proceso' : 'pendiente';
  const produccion = s.estado_produccion === 'terminado' ? 'completo'
    : s.estado_produccion ? 'en_proceso' : 'pendiente';
  const calidad = s.estado_calidad === 'liberado' ? 'completo'
    : s.estado_calidad ? 'en_proceso' : 'pendiente';
  return { admision, expediente, valuacion, produccion, calidad };
}

module.exports = { TZ, nowUTC, toLocal, toLocalDate, registrarAuditoria, auditarCambios, csvCell, csvTextForced,
  verificarRefaccionesCompletas, crearTareaFechaPromesaModificada,
  copiaSugeridaPorAseguradora, prepararCorreoPedidoNuevo, verificarCorreosPendientes, limpiarDuplicadosCorreosPendientesExistentes, corregirBorradoresAutomaticosExistentes, piezasPendientesDePedido, resolverDestinatarioAutomatico, esDiaHabil, sumarDiasHabiles,
  archivarSiniestrosVencidos, calcularRutaAseguradora, sistemaValuacionSugerido, calcularSemaforo,
  VENTANA_OPERATIVA_DESDE, aplicaVentanaOperativa, normalizarFechaISO, normalizarFechasCreacionPedidosExistentes };
