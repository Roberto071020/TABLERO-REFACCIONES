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

module.exports = { TZ, nowUTC, toLocal, toLocalDate, registrarAuditoria, auditarCambios, csvCell, csvTextForced,
  verificarRefaccionesCompletas, crearTareaFechaPromesaModificada };
