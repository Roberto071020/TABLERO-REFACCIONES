// ===================== Unidades detenidas (10-nov-2026) =====================
// Roberto: cuando Beto marca una unidad como "Detenido", el sistema pregunta POR QUÉ y le avisa a quien le toca
// destrabarla. La unidad le aparece en su pantalla (con los días que lleva detenida) hasta que Beto la regresa a
// una etapa de trabajo; también sale en las alertas de Roberto y en el corte de las 3.
const MOTIVOS = {
  falta_pieza:         { etiqueta:'Falta pieza',          quien:'Daniela', para:'daniela' },
  pieza_mal:           { etiqueta:'Pieza llegó mal',      quien:'Daniela', para:'daniela' },
  dano_oculto:         { etiqueta:'Daño oculto',          quien:'Orlando', para:'orlando' },
  espera_autorizacion: { etiqueta:'Espera autorización',  quien:'Roberto', para:'roberto' },
  falta_material:      { etiqueta:'Falta material',       quien:'Roberto', para:'roberto' },
  otro:                { etiqueta:'Otro',                 quien:'Roberto', para:'roberto' },
};
const SIN_MOTIVO = { etiqueta:'Sin motivo registrado', quien:'Beto', para:'beto' };

function aMs(v){ if(!v) return NaN; const t = String(v); return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); }

// 12-nov-2026 (Roberto): si la detuvo un técnico de patio con fotos (pieza mal surtida, daño oculto), la evidencia
// le llega a quien la tiene que destrabar junto con el aviso.
function evidencia(db, s){
  try{
    const e = require('./patio').evidenciaParo(db, s.id);
    return e && e.motivo === s.detenido_motivo ? e.fotos : [];
  }catch(x){ return []; }
}

// Todas las unidades activas detenidas, de la que lleva más días a la que menos.
function listarDetenidas(db){
  const filas = db.prepare(`SELECT id, numero, vehiculo, placas, aseguradora, detenido_motivo, detenido_nota, detenido_desde, actualizado_en
    FROM siniestros WHERE archivado = 0 AND estado_produccion = 'detenido' AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '')`).all();
  const ahora = Date.now();
  return filas.map(s => {
    let desde = s.detenido_desde;
    if(!desde){
      const a = db.prepare(`SELECT fecha FROM auditoria WHERE entidad_tipo='siniestro' AND entidad_id=? AND campo='estado_produccion' AND valor_nuevo='detenido' ORDER BY id DESC LIMIT 1`).get(s.id);
      desde = (a && a.fecha) || s.actualizado_en;
    }
    const m = MOTIVOS[s.detenido_motivo] || SIN_MOTIVO;
    const dias = Math.max(0, Math.floor((ahora - aMs(desde)) / 86400000)) || 0;
    return { id: s.id, numero: s.numero, vehiculo: s.vehiculo, placas: s.placas, aseguradora: s.aseguradora,
      motivo: s.detenido_motivo || null, motivo_etiqueta: m.etiqueta, nota: s.detenido_nota || null, quien: m.quien, para: m.para, desde, dias,
      fotos: evidencia(db, s) };
  }).sort((a, b) => b.dias - a.dias);
}

// Qué le toca a cada rol: Daniela (operativo) y Orlando ven las suyas; Beto las que no tienen motivo; Roberto todas.
function detenidasPara(db, rol){
  const todas = listarDetenidas(db);
  if(rol === 'admin' || rol === 'jefe') return todas;
  const para = { operativo:'daniela', orlando:'orlando', beto:'beto' }[rol];
  return para ? todas.filter(d => d.para === para) : [];
}

function textoDetalle(d){
  return `${d.motivo_etiqueta}${d.nota ? ' (' + d.nota + ')' : ''} · ${d.dias === 0 ? 'desde hoy' : d.dias === 1 ? 'hace 1 día' : 'hace ' + d.dias + ' días'} · le toca a ${d.quien}`;
}

module.exports = { MOTIVOS, listarDetenidas, detenidasPara, textoDetalle };
