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

// Reglas de destinatario/copia conocidas por aseguradora (sección "CORREOS" del documento de Daniela).
// Donde no tenemos direcciones reales, dejamos una nota clara para que Daniela la complete antes de aprobar
// (decisión tomada con Roberto: nunca inventamos correos, siempre queda editable).
const CC_GNP = 'cristian.hernandezortiz@gnp.com.mx, luis.ramirezalvarez@gnp.com.mx, roveytia@hotmail.com';
const REGLAS_ASEGURADORA = {
  'GNP': CC_GNP,
  'Mapfre': 'Copiar a Jorge Contreras y Edgar (completar sus correos antes de aprobar).',
  'Inbursa': 'Copiar a Monserrat Ibáñez y Ana Lucero (completar sus correos antes de aprobar).',
  'Afirme': 'Copiar a Nancy Monserrat (completar su correo antes de aprobar).',
  'Allianz': 'Destinatario pendiente de definir según el hilo — revisar antes de aprobar.',
  'Zurich': 'Pendiente conforme al funcionamiento de eFile — revisar antes de aprobar.',
  'ANA': 'Revisar cada caso: algunos corresponden a pago de daños y podrían no requerir este correo.',
};
function copiaSugeridaPorAseguradora(aseguradora){
  return REGLAS_ASEGURADORA[aseguradora] || '';
}

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

function construirCuerpoAutomatico(disparador, { siniestroNumero, pedidoNumero, fechaPrevista }){
  const firma = '\n\nSaludos,\nDaniela Sosa\nRefacciones';
  if(disparador === 'pedido_nuevo'){
    return `Buen día.\n\nSe registró un nuevo pedido (${pedidoNumero}) para el siniestro ${siniestroNumero}. Quedamos atentos a la confirmación de refacciones, proveedor asignado y fecha estimada de entrega.${firma}`;
  }
  if(disparador === 'vencimiento_dia1'){
    return `Buen día.\n\nLa fecha promesa indicada por Inpart para el pedido ${pedidoNumero} del siniestro ${siniestroNumero} era ${fechaPrevista} y ya se cumplió sin confirmación de entrega. ¿Nos podrían indicar el estatus actualizado y la nueva fecha estimada?${firma}`;
  }
  if(disparador === 'seguimiento_2dias'){
    return `Buen día.\n\nDamos seguimiento al pedido ${pedidoNumero} del siniestro ${siniestroNumero}. No hemos recibido respuesta a nuestro mensaje anterior. Quedamos atentos a sus comentarios.${firma}`;
  }
  return '';
}

// Se llama al crear un pedido (F-04 de Daniela: "preparar correo cuando se detecte un pedido nuevo").
// Deja el correo PREPARADO y pendiente de aprobación; nunca se envía ni se aprueba solo.
function prepararCorreoPedidoNuevo(db, { pedido, siniestro }){
  const yaExiste = db.prepare(`SELECT id FROM comunicaciones WHERE pedido_id=? AND disparador='pedido_nuevo'`).get(pedido.id);
  if(yaExiste) return;
  db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,estado,disparador,enviado_por,fecha_envio)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(pedido.id, siniestro.id, null, 'Correo', `SINIESTRO ${siniestro.numero} - PEDIDO ${pedido.numero}`, '',
      copiaSugeridaPorAseguradora(siniestro.aseguradora),
      construirCuerpoAutomatico('pedido_nuevo', { siniestroNumero: siniestro.numero, pedidoNumero: pedido.numero }),
      'pedido_nuevo', 'pendiente_aprobacion', 'pedido_nuevo', null);
}

// Escaneo idempotente de vencimientos y seguimientos (F-DF-02/03 de Daniela). Se ejecuta de forma perezosa
// —igual que el backfill de hitos del módulo de Alejandra— cada vez que se consulta la bandeja de correos
// o el resumen diario, así no se necesita infraestructura de tareas programadas (cron) para operar.
const ESTATUS_TERMINALES_CORREO = ['Recibido completo','Cancelado','Cerrado'];
function verificarCorreosPendientes(db){
  const hoy = new Date().toISOString().slice(0,10);
  const pedidos = db.prepare(`SELECT * FROM pedidos WHERE estatus_operativo NOT IN (${ESTATUS_TERMINALES_CORREO.map(()=>'?').join(',')})`).all(...ESTATUS_TERMINALES_CORREO);

  for(const pedido of pedidos){
    const siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(pedido.siniestro_id);
    if(!siniestro) continue;

    // Por si el pedido se creó antes de esta fase (o el hook no corrió), aseguramos el correo de "pedido nuevo".
    prepararCorreoPedidoNuevo(db, { pedido, siniestro });

    // Primer día de vencimiento (solo una vez por pedido).
    if(pedido.fecha_prevista && pedido.fecha_prevista < hoy){
      const yaVencimiento = db.prepare(`SELECT id FROM comunicaciones WHERE pedido_id=? AND disparador='vencimiento_dia1'`).get(pedido.id);
      if(!yaVencimiento){
        db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,estado,disparador,enviado_por,fecha_envio)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
          .run(pedido.id, siniestro.id, null, 'Correo', `SINIESTRO ${siniestro.numero} - PEDIDO ${pedido.numero}`, '',
            copiaSugeridaPorAseguradora(siniestro.aseguradora),
            construirCuerpoAutomatico('vencimiento_dia1', { siniestroNumero: siniestro.numero, pedidoNumero: pedido.numero, fechaPrevista: pedido.fecha_prevista }),
            'vencimiento_dia1', 'pendiente_aprobacion', 'vencimiento_dia1', null);
      }
    }

    // Seguimiento cada 2 días hábiles mientras no haya respuesta del proveedor.
    const ultima = db.prepare(`SELECT * FROM comunicaciones WHERE pedido_id=? AND respuesta_texto IS NULL ORDER BY fecha_envio DESC LIMIT 1`).get(pedido.id);
    if(ultima){
      const fechaBase = (ultima.fecha_envio || '').slice(0,10);
      if(fechaBase){
        const limite = sumarDiasHabiles(fechaBase, 2);
        if(hoy >= limite){
          const yaSeguimiento = db.prepare(`SELECT id FROM comunicaciones WHERE pedido_id=? AND disparador='seguimiento_2dias' AND fecha_envio > ?`).get(pedido.id, ultima.fecha_envio);
          if(!yaSeguimiento){
            db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,estado,disparador,enviado_por,fecha_envio)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
              .run(pedido.id, siniestro.id, ultima.proveedor_id, 'Correo', `SINIESTRO ${siniestro.numero} - PEDIDO ${pedido.numero}`, ultima.destinatarios || '',
                copiaSugeridaPorAseguradora(siniestro.aseguradora),
                construirCuerpoAutomatico('seguimiento_2dias', { siniestroNumero: siniestro.numero, pedidoNumero: pedido.numero }),
                'seguimiento_2dias', 'pendiente_aprobacion', 'seguimiento_2dias', null);
          }
        }
      }
    }
  }
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

module.exports = { TZ, nowUTC, toLocal, toLocalDate, registrarAuditoria, auditarCambios, csvCell, csvTextForced,
  verificarRefaccionesCompletas, crearTareaFechaPromesaModificada,
  copiaSugeridaPorAseguradora, prepararCorreoPedidoNuevo, verificarCorreosPendientes, esDiaHabil, sumarDiasHabiles,
  archivarSiniestrosVencidos, calcularRutaAseguradora };
