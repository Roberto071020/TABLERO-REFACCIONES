// ===================== Registro de entrada del personal (9-nov-2026) =====================
// Roberto: "que el personal registre su entrada a oficina en SC Control; con esto los obligo a abrirlo desde que
// llegan". Candado (Roberto descartó un código compartido porque "el primero que llegue se lo puede pasar"):
//   1) Ubicación del celular de la persona: debe estar dentro del taller (RADIO_M + margen por precisión).
//   2) Foto tomada en ese momento con la cámara frontal (en el celular no se puede elegir de la galería).
// Registran todos los que tienen usuario excepto el propietario (admin/jefe). Retardo: después de las 9:00.
const fs = require('fs');
const path = require('path');

const RADIO_M = 100;               // "a menos de unos 100 m" del taller
const MARGEN_MAX_M = 50;           // tolerancia extra por la precisión del GPS (máximo)
const PRECISION_MAX_M = 300;       // con una ubicación peor que esto no se puede saber si está en el taller
const HORA_ENTRADA = process.env.HORA_ENTRADA || '09:00';
const ROLES_EXENTOS = ['admin', 'jefe'];
const FOTO_MAX_BYTES = 1500000;

const DIR_FOTOS = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads', 'asistencia')
  : path.join(__dirname, '..', 'uploads', 'asistencia');

// Hora de Veracruz (UTC-6, sin horario de verano) -- mismo criterio que el resto del tablero.
function ahoraMX(){ const d = new Date(Date.now() - 6 * 3600000).toISOString(); return { fecha: d.slice(0, 10), hora: d.slice(11, 16) }; }

function requiereRegistro(rol){ return !ROLES_EXENTOS.includes(rol); }

function leerTaller(db){
  const f = db.prepare(`SELECT valor FROM configuracion WHERE clave='taller_ubicacion'`).get();
  if(!f) return null;
  try{ const t = JSON.parse(f.valor); return Number.isFinite(t.lat) && Number.isFinite(t.lng) ? t : null; }catch(e){ return null; }
}
function guardarTaller(db, { lat, lng, precision }){
  const valor = JSON.stringify({ lat, lng, precision: precision ?? null });
  db.prepare(`INSERT INTO configuracion (clave, valor, actualizado_en) VALUES ('taller_ubicacion', ?, datetime('now'))
    ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor, actualizado_en=excluded.actualizado_en`).run(valor);
}

function distanciaM(a, b){
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Revisa ubicación y foto. Regresa { ok:true, distancia } o { ok:false, error, distancia? }.
function validarEntrada(taller, { lat, lng, precision, foto }){
  if(!taller) return { ok:false, error:'Roberto todavía no marca la ubicación del taller.' };
  lat = Number(lat); lng = Number(lng); precision = Number(precision);
  if(!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok:false, error:'No se recibió tu ubicación. Activa la ubicación del celular y vuelve a intentar.' };
  if(!Number.isFinite(precision) || precision > PRECISION_MAX_M)
    return { ok:false, error:'Tu ubicación no es precisa. Activa la "ubicación precisa" del celular y vuelve a intentar.' };
  const distancia = Math.round(distanciaM(taller, { lat, lng }));
  if(distancia > RADIO_M + Math.min(precision, MARGEN_MAX_M))
    return { ok:false, distancia, error:`Estás a ${distancia >= 1000 ? (distancia / 1000).toFixed(1) + ' km' : distancia + ' m'} del taller. Regístrate cuando llegues.` };
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(foto || ''));
  if(!m) return { ok:false, error:'Falta la foto. Tómala con la cámara al registrarte.' };
  const buf = Buffer.from(m[1], 'base64');
  if(buf.length < 2000 || buf.length > FOTO_MAX_BYTES || buf[0] !== 0xFF || buf[1] !== 0xD8) return { ok:false, error:'La foto no es válida. Vuelve a tomarla.' };
  return { ok:true, distancia, lat, lng, precision, buf };
}

function guardarFoto(fecha, usuarioId, buf){
  const dir = path.join(DIR_FOTOS, fecha);
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `u${usuarioId}-${Date.now()}.jpg`);
  fs.writeFileSync(archivo, buf);
  return path.relative(DIR_FOTOS, archivo);
}
function rutaFoto(relativa){
  const p = path.resolve(DIR_FOTOS, String(relativa || ''));
  return p.startsWith(path.resolve(DIR_FOTOS) + path.sep) ? p : null;
}

function esRetardo(hora){ return hora > HORA_ENTRADA; }

// Racha (9-nov-2026, Roberto: "todo lo que motive al personal"): días seguidos llegando a tiempo. Solo cuentan
// los días en que el taller abrió (alguien registró entrada), para que un día festivo o domingo no la rompa.
// Un retardo o un día sin registro (estando abierto el taller) la corta.
function racha(db, usuarioId, hastaFecha){
  const dias = db.prepare(`SELECT DISTINCT fecha FROM asistencia WHERE fecha <= ? ORDER BY fecha DESC LIMIT 400`).all(hastaFecha).map(r => r.fecha);
  const mios = new Map(db.prepare(`SELECT fecha, retardo FROM asistencia WHERE usuario_id = ? AND fecha <= ?`).all(usuarioId, hastaFecha).map(r => [r.fecha, r.retardo]));
  let n = 0;
  for(const f of dias){
    if(!mios.has(f)){ if(f === hastaFecha) continue; break; } // hoy todavía puede registrarse
    if(mios.get(f)) break;
    n++;
  }
  return n;
}
function esPrimeroDelDia(db, usuarioId, fecha){
  const p = db.prepare(`SELECT usuario_id FROM asistencia WHERE fecha = ? ORDER BY hora_local ASC, id ASC LIMIT 1`).get(fecha);
  return !!p && p.usuario_id === usuarioId;
}

// Para el inicio de Roberto: cada persona que debe registrarse, con su registro de hoy (o sin registro).
function entradasDeHoy(db){
  const { fecha } = ahoraMX();
  const ph = ROLES_EXENTOS.map(() => '?').join(',');
  const conPuesto = !!db.prepare(`SELECT 1 FROM pragma_table_info('usuarios') WHERE name='puesto'`).get();
  const personas = db.prepare(`SELECT id, nombre${conPuesto ? ', puesto' : ''} FROM usuarios WHERE activo = 1 AND rol NOT IN (${ph}) ORDER BY nombre`).all(...ROLES_EXENTOS);
  const regs = db.prepare(`SELECT id, usuario_id, hora_local, retardo, distancia_m, foto_ruta FROM asistencia WHERE fecha = ?`).all(fecha);
  const porUsuario = new Map(regs.map(r => [r.usuario_id, r]));
  const lista = personas.map(p => {
    const r = porUsuario.get(p.id);
    return r ? { usuario_id: p.id, nombre: p.nombre, puesto: p.puesto || null, registro_id: r.id, hora: r.hora_local, retardo: !!r.retardo, distancia_m: r.distancia_m, con_foto: !!r.foto_ruta, racha: racha(db, p.id, fecha) }
      : { usuario_id: p.id, nombre: p.nombre, puesto: p.puesto || null, registro_id: null, hora: null, retardo: false };
  }).sort((a, b) => (a.hora ? 0 : 1) - (b.hora ? 0 : 1) || String(a.hora || '').localeCompare(String(b.hora || '')) || a.nombre.localeCompare(b.nombre));
  return { fecha, hora_entrada: HORA_ENTRADA, taller_configurado: !!leerTaller(db), personas: lista,
    resumen: { a_tiempo: lista.filter(x => x.hora && !x.retardo).length, retardos: lista.filter(x => x.retardo).length, sin_registro: lista.filter(x => !x.hora).length } };
}

module.exports = { RADIO_M, HORA_ENTRADA, ahoraMX, requiereRegistro, leerTaller, guardarTaller, validarEntrada, guardarFoto, rutaFoto, esRetardo, entradasDeHoy, distanciaM, racha, esPrimeroDelDia };
