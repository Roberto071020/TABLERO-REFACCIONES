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

module.exports = { TZ, nowUTC, toLocal, toLocalDate, registrarAuditoria, auditarCambios, csvCell, csvTextForced };
