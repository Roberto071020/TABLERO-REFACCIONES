// ===================== Particulares (24-nov-2026) =====================
// Roberto: "sería bueno tener en SC Control un apartado para las unidades particulares ... algo sencillo y que tenga su
// proceso independiente solo para particulares". Su proceso real (24-nov-2026):
//   - Beto sale con el cliente, revisa daños, le da un costo y le explica el trabajo. "Muchas veces se pierde el
//     seguimiento y en muchos casos no recuerda Beto el monto ni lo autorizado a reparar" -> Beto lo captura en su
//     celular en ese momento (cliente, vehículo, qué se va a hacer, monto).
//   - Si acepta y lo deja: pasa con Ale para el inventario (ya conoce su fecha de entrega).
//   - Si lo programa para otro día: "lo traigo tal día y me lo entregas tal día" -> queda citado.
//   - Con refacciones: "se cotizan y se pide tiempo de surtido" (Daniela "o directo Beto al momento"); si autoriza,
//     anticipo del costo de las piezas para pedirlas y fecha de reingreso según el surtido. A veces lo dejan aunque
//     no estén las piezas.
//   - Cobra Angélica y si no está, Ale ("de momento que lo registre Ale").
// Tabla propia: no se mezcla con las listas, indicadores ni reportes de aseguradoras.

const DIAS_SEGUIMIENTO = 2; // "lo va a pensar" -> Alejandra le da seguimiento a los 2 días

function asegurarTabla(db){
  db.exec(`CREATE TABLE IF NOT EXISTS particulares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_nombre TEXT NOT NULL,
    cliente_telefono TEXT,
    vehiculo TEXT NOT NULL,
    placas TEXT,
    trabajo TEXT NOT NULL,
    monto REAL,
    decision TEXT NOT NULL DEFAULT 'pensando',      -- acepta | pensando | rechaza
    motivo_rechazo TEXT,
    en_taller INTEGER NOT NULL DEFAULT 0,             -- 1 = la unidad está en el taller
    fecha_cita TEXT,                                  -- día en que el cliente la trae
    fecha_entrega TEXT,
    lleva_piezas INTEGER NOT NULL DEFAULT 0,
    piezas TEXT,
    piezas_costo REAL,
    piezas_dias INTEGER,
    anticipo_monto REAL,
    anticipo_en TEXT,
    piezas_llegaron_en TEXT,
    recibido_en TEXT,
    terminado_en TEXT,
    pagado_monto REAL,
    pagado_en TEXT,
    entregado_en TEXT,
    notas TEXT,
    creado_por INTEGER,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // 24-nov-2026: fotos del daño (la tabla archivos solo acepta siniestros/pedidos/piezas/incidencias).
  db.exec(`CREATE TABLE IF NOT EXISTS particulares_fotos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    particular_id INTEGER NOT NULL,
    nombre_almacenado TEXT NOT NULL,
    miniatura TEXT,
    mime TEXT,
    tamano INTEGER,
    subido_por INTEGER,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    eliminado INTEGER NOT NULL DEFAULT 0
  )`);
}

const hoyMx = (f = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Mexico_City', year:'numeric', month:'2-digit', day:'2-digit' }).format(f);
const diasDesde = v => { const t = Date.parse(String(v || '').replace(' ', 'T') + (/[zZ]$/.test(String(v)) ? '' : 'Z')); return isNaN(t) ? 0 : Math.floor((Date.now() - t) / 86400000); };
const dinero = n => n == null || n === '' ? '' : '$' + Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 });

// Siguiente paso de cada unidad: qué falta, a quién le toca y qué botón ve.
function siguientePaso(p, hoy = hoyMx()){
  if(p.decision === 'rechaza') return { paso:'rechazado', texto:'No aceptó', quien:null };
  if(p.entregado_en) return { paso:'entregado', texto:'Entregada', quien:null };
  if(p.decision === 'pensando'){
    const d = diasDesde(p.creado_en);
    return { paso:'seguimiento', texto: d >= DIAS_SEGUIMIENTO ? `Lo iba a pensar: llámale (hace ${d} días)` : 'Lo va a pensar', quien:'alejandra', urgente: d >= DIAS_SEGUIMIENTO };
  }
  // Si la dejó en el taller, el inventario va primero (aunque esté esperando piezas).
  if(p.en_taller && !p.recibido_en) return { paso:'recibir', texto:'La dejó en el taller: hacer su inventario', quien:'alejandra', urgente:true };
  if(p.lleva_piezas && (p.piezas_costo == null || p.piezas_costo === '')) return { paso:'cotizar', texto:'Cotizar piezas (costo y días de surtido)', quien:'daniela' };
  if(p.lleva_piezas && !p.anticipo_en) return { paso:'anticipo', texto:`Pasarle la cotización y cobrar anticipo (${dinero(p.piezas_costo)})`, quien:'alejandra' };
  if(p.lleva_piezas && !p.piezas_llegaron_en) return { paso:'piezas', texto:'Anticipo pagado: pedir piezas y marcar cuando lleguen', quien:'daniela' };
  if(!p.en_taller){
    const cita = p.fecha_cita ? String(p.fecha_cita).slice(0, 10) : '';
    const noLlego = cita && cita < hoy;
    return { paso:'recibir', texto: !cita ? 'Darle cita para que traiga la unidad' : noLlego ? `No llegó a su cita del ${cita.split('-').reverse().join('/')}: llámale` : cita === hoy ? 'La trae hoy: recibirla e inventario' : `Cita el ${cita.split('-').reverse().join('/')}`, quien:'alejandra', urgente: !!noLlego || cita === hoy };
  }
  if(!p.terminado_en) return { paso:'reparar', texto: p.fecha_entrega ? `En reparación · entrega ${String(p.fecha_entrega).slice(0, 10).split('-').reverse().join('/')}` : 'En reparación · falta fecha de entrega', quien:'beto', urgente: !p.fecha_entrega || String(p.fecha_entrega).slice(0, 10) <= hoy };
  if(!p.pagado_en) return { paso:'cobrar', texto:`Terminada: cobrar saldo (${dinero(saldo(p))})`, quien:'alejandra', urgente:true };
  return { paso:'entregar', texto:'Pagada: entregar al cliente', quien:'alejandra', urgente:true };
}
function saldo(p){ return Math.max(0, Number(p.monto || 0) - Number(p.anticipo_monto || 0)); }

function listar(db, { historial = false } = {}){
  asegurarTabla(db);
  const filas = db.prepare(`SELECT * FROM particulares WHERE ${historial ? "(decision = 'rechaza' OR entregado_en IS NOT NULL)" : "decision != 'rechaza' AND entregado_en IS NULL"} ORDER BY ${historial ? 'actualizado_en DESC LIMIT 100' : 'creado_en ASC'}`).all();
  const hoy = hoyMx();
  return filas.map(p => ({ ...p, saldo: saldo(p), fotos: fotosDe(db, p.id), ...siguientePaso(p, hoy) }));
}

const TEXTO = v => (v == null ? '' : String(v).trim());
const FECHA = v => { const t = TEXTO(v); return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null; };
const NUM = v => { if(v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return isNaN(n) ? NaN : n; };

function crear(db, b, usuario){
  asegurarTabla(db);
  const f = { cliente_nombre: TEXTO(b.cliente_nombre), cliente_telefono: TEXTO(b.cliente_telefono), vehiculo: TEXTO(b.vehiculo),
    placas: TEXTO(b.placas).toUpperCase(), trabajo: TEXTO(b.trabajo), monto: NUM(b.monto), lleva_piezas: b.lleva_piezas ? 1 : 0,
    piezas: TEXTO(b.piezas), piezas_costo: NUM(b.piezas_costo), piezas_dias: NUM(b.piezas_dias), notas: TEXTO(b.notas) };
  const faltan = [];
  if(!f.cliente_nombre) faltan.push('nombre del cliente');
  if(!f.vehiculo) faltan.push('vehículo');
  if(!f.trabajo) faltan.push('qué se va a hacer');
  if(f.monto == null || isNaN(f.monto) || f.monto <= 0) faltan.push('monto');
  if(f.lleva_piezas && !f.piezas) faltan.push('qué piezas lleva');
  if(faltan.length) throw Object.assign(new Error('Falta: ' + faltan.join(', ') + '.'), { status:400 });
  if(isNaN(f.piezas_costo) || isNaN(f.piezas_dias)) throw Object.assign(new Error('El costo o los días de las piezas no son un número.'), { status:400 });
  const decision = ['acepta','pensando','rechaza'].includes(b.decision) ? b.decision : 'pensando';
  const enTaller = decision === 'acepta' && (b.en_taller === 1 || b.en_taller === true || b.en_taller === '1') ? 1 : 0;
  const info = db.prepare(`INSERT INTO particulares (cliente_nombre, cliente_telefono, vehiculo, placas, trabajo, monto, decision, motivo_rechazo, en_taller,
      fecha_cita, fecha_entrega, lleva_piezas, piezas, piezas_costo, piezas_dias, notas, creado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.cliente_nombre, f.cliente_telefono, f.vehiculo, f.placas, f.trabajo, f.monto, decision, decision === 'rechaza' ? TEXTO(b.motivo_rechazo) : null, enTaller,
      decision === 'acepta' && !enTaller ? FECHA(b.fecha_cita) : null, decision === 'acepta' ? FECHA(b.fecha_entrega) : null,
      f.lleva_piezas, f.piezas || null, f.lleva_piezas ? f.piezas_costo : null, f.lleva_piezas ? f.piezas_dias : null, f.notas || null, usuario ? usuario.id : null);
  return obtener(db, info.lastInsertRowid);
}

// 24-nov-2026: fotos del daño (Beto al presupuestar; Ale las compara al recibir la unidad).
function fotosDe(db, id){
  try{ return db.prepare(`SELECT id FROM particulares_fotos WHERE particular_id=? AND eliminado=0 ORDER BY id`).all(id).map(f => f.id); }catch(e){ return []; }
}
function obtener(db, id){
  asegurarTabla(db);
  const p = db.prepare('SELECT * FROM particulares WHERE id = ?').get(id);
  return p ? { ...p, saldo: saldo(p), fotos: fotosDe(db, p.id), ...siguientePaso(p) } : null;
}

// Cada botón de la pantalla es una acción. Regresa los campos que cambian.
function accion(db, p, a, b){
  const ahora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const err = m => Object.assign(new Error(m), { status:400 });
  switch(a){
    case 'decision': {
      const d = b.decision;
      if(!['acepta','pensando','rechaza'].includes(d)) throw err('Respuesta no válida.');
      if(d === 'rechaza') return { decision:'rechaza', motivo_rechazo: TEXTO(b.motivo_rechazo) || null };
      if(d === 'pensando') return { decision:'pensando' };
      const enTaller = b.en_taller === 1 || b.en_taller === true || b.en_taller === '1' ? 1 : 0;
      if(!enTaller && !FECHA(b.fecha_cita) && !p.lleva_piezas) throw err('Pon el día en que trae la unidad.');
      return { decision:'acepta', en_taller: enTaller, fecha_cita: enTaller ? null : FECHA(b.fecha_cita), fecha_entrega: FECHA(b.fecha_entrega) || p.fecha_entrega || null };
    }
    case 'cotizar': {
      const c = NUM(b.piezas_costo), d = NUM(b.piezas_dias);
      if(c == null || isNaN(c) || c <= 0) throw err('Pon el costo de las piezas.');
      if(d == null || isNaN(d) || d < 0) throw err('Pon los días de surtido.');
      return { piezas_costo: c, piezas_dias: Math.round(d) };
    }
    case 'anticipo': {
      const m = NUM(b.monto);
      if(m == null || isNaN(m) || m <= 0) throw err('Pon el monto del anticipo.');
      return { anticipo_monto: m, anticipo_en: ahora };
    }
    case 'piezas_llegaron': {
      const c = {};
      if(!p.anticipo_en) throw err('Primero se registra el anticipo.');
      c.piezas_llegaron_en = ahora;
      if(!p.en_taller && FECHA(b.fecha_cita)) c.fecha_cita = FECHA(b.fecha_cita);
      return c;
    }
    case 'cita': {
      if(!FECHA(b.fecha_cita)) throw err('Pon el día de la cita.');
      return { fecha_cita: FECHA(b.fecha_cita), ...(FECHA(b.fecha_entrega) ? { fecha_entrega: FECHA(b.fecha_entrega) } : {}) };
    }
    case 'recibir': return { en_taller: 1, recibido_en: ahora, ...(FECHA(b.fecha_entrega) ? { fecha_entrega: FECHA(b.fecha_entrega) } : {}) };
    case 'fecha_entrega': {
      if(!FECHA(b.fecha_entrega)) throw err('Pon la fecha de entrega.');
      return { fecha_entrega: FECHA(b.fecha_entrega) };
    }
    case 'terminado': {
      if(!p.recibido_en) throw err('La unidad no se ha recibido en el taller.');
      return { terminado_en: ahora };
    }
    case 'pago': {
      if(!p.terminado_en) throw err('Primero Beto la marca como terminada.');
      const m = NUM(b.monto);
      if(m == null || isNaN(m) || m < 0) throw err('Pon el monto que pagó.');
      return { pagado_monto: m, pagado_en: ahora };
    }
    case 'entregar': {
      if(!p.pagado_en) throw err('No se puede entregar sin registrar el pago.');
      return { entregado_en: ahora };
    }
    default: throw err('Acción no válida.');
  }
}

// Quién puede tocar cada acción (admin y jefe, todas).
const QUIEN_ACCION = {
  decision: ['beto','atencion_cliente'], cotizar: ['operativo','beto'], anticipo: ['atencion_cliente'], piezas_llegaron: ['operativo'],
  cita: ['atencion_cliente','beto'], recibir: ['atencion_cliente'], fecha_entrega: ['beto','atencion_cliente','operativo'],
  terminado: ['beto'], pago: ['atencion_cliente'], entregar: ['atencion_cliente'],
};
function puede(rol, a){ return ['admin','jefe'].includes(rol) || (QUIEN_ACCION[a] || []).includes(rol); }

// Avisos al celular (push): solo lo que le toca a cada quien.
function pendientesPush(db, quien){
  let l = [];
  try{ l = listar(db); }catch(e){ return []; }
  return l.filter(p => p.quien === quien && (p.urgente || ['cotizar','anticipo','piezas','cobrar','entregar'].includes(p.paso)))
    .map(p => ({ clave:`part-${p.id}-${p.paso}${p.paso === 'seguimiento' || p.paso === 'recibir' ? '-' + hoyMx() : ''}`, titulo:'🙋 Particular: ' + p.texto.split(':')[0], cuerpo:`${[p.vehiculo, p.placas, p.cliente_nombre].filter(Boolean).join(' · ')}: ${p.texto}` }));
}

module.exports = { asegurarTabla, listar, obtener, crear, accion, puede, siguientePaso, saldo, pendientesPush, QUIEN_ACCION, DIAS_SEGUIMIENTO };
