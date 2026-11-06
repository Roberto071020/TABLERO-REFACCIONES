// ===================== Fotos de la unidad (4-nov-2026) =====================
// Roberto: "todas las imágenes necesito que todos las puedan ver y descargar". Las fotos viven en la misma
// tabla `archivos` (entidad 'siniestro', tipo 'foto') con dos columnas nuevas:
//   - etapa:     recepcion | mecanica | en_laminado | preparacion | pintura | armado | pulido | lavado | terminado | otra
//   - miniatura: nombre del archivo chico (~400 px) que genera el celular, para que la galería cargue rápido.
// El celular comprime cada foto antes de subirla (~1600 px, JPEG) -- ver public/fotos.js.
//
// Reglas:
//   - Fotos obligatorias al cambiar de etapa de producción (ver fotosFaltantesCambioEtapa).
//   - Borrado automático por antigüedad y por espacio (ver limpiezaFotos), solo de unidades ENTREGADAS.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const UPLOAD_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, '..', 'uploads');

// 6-nov-2026: 'reautorizacion' = fotos editadas que Orlando sube para pedir que se autoricen piezas no autorizadas.
const ETAPAS_FOTO = ['recepcion','mecanica','en_laminado','preparacion','pintura','armado','pulido','lavado','terminado','reautorizacion','otra'];
const ETIQUETA_ETAPA_FOTO = { recepcion:'Recepción', mecanica:'Mecánica', en_laminado:'Hojalatería', preparacion:'Preparación',
  pintura:'Pintura', armado:'Armado', pulido:'Pulido', lavado:'Lavado', terminado:'Terminado', reautorizacion:'Fotos editadas (reautorización)', otra:'Otras' };

// Etapas de producción que exigen al menos una foto ANTES de poder salir de ellas. Pulido y lavado quedan
// opcionales (no dejan evidencia útil para la aseguradora); se pueden agregar aquí si se decide lo contrario.
const ETAPAS_CON_FOTO_OBLIGATORIA = ['mecanica','en_laminado','preparacion','pintura','armado'];

function asegurarEsquemaFotos(db){
  const cols = db.prepare(`PRAGMA table_info(archivos)`).all().map(c => c.name);
  if(!cols.includes('etapa')) db.exec(`ALTER TABLE archivos ADD COLUMN etapa TEXT;`);
  if(!cols.includes('miniatura')) db.exec(`ALTER TABLE archivos ADD COLUMN miniatura TEXT;`);
  if(!cols.includes('purgado_en')) db.exec(`ALTER TABLE archivos ADD COLUMN purgado_en TEXT;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_archivos_entidad ON archivos(entidad_tipo, entidad_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS fotos_limpieza (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL DEFAULT (datetime('now')),
    motivo TEXT NOT NULL,           -- 'antiguedad' | 'espacio'
    unidades INTEGER NOT NULL DEFAULT 0,
    fotos INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    uso_antes REAL, uso_despues REAL
  );`);
}

function contarFotosEtapa(db, siniestroId, etapa){
  return db.prepare(`SELECT COUNT(*) n FROM archivos WHERE entidad_tipo='siniestro' AND entidad_id=? AND tipo='foto' AND etapa=? AND eliminado=0`)
    .get(siniestroId, etapa).n;
}

// Regresa null si se puede cambiar de etapa, o { etapa, etiqueta, mensaje } con la etapa que necesita fotos.
function fotosFaltantesCambioEtapa(db, siniestroId, etapaAnterior, etapaNueva){
  if(!etapaNueva || etapaNueva === etapaAnterior || etapaNueva === 'detenido') return null;
  if(etapaAnterior && ETAPAS_CON_FOTO_OBLIGATORIA.includes(etapaAnterior) && contarFotosEtapa(db, siniestroId, etapaAnterior) === 0){
    const e = ETIQUETA_ETAPA_FOTO[etapaAnterior];
    return { etapa: etapaAnterior, etiqueta: e, mensaje: `Para salir de ${e} sube al menos una foto del trabajo de ${e}.` };
  }
  if(etapaNueva === 'terminado' && contarFotosEtapa(db, siniestroId, 'terminado') === 0){
    return { etapa: 'terminado', etiqueta: 'Terminado', mensaje: 'Para marcarla como Terminada sube al menos una foto de la unidad ya terminada.' };
  }
  return null;
}

/* ---------- Espacio en disco ---------- */
function usoDisco(dir = UPLOAD_DIR){
  try{
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize, libre = s.bavail * s.bsize;
    return { total, libre, usado: total - libre, pct: total ? (total - libre) / total : 0 };
  }catch(e){ return null; }
}

function borrarArchivoFisico(nombre){
  if(!nombre) return 0;
  const p = path.join(UPLOAD_DIR, nombre);
  try{ const t = fs.statSync(p).size; fs.unlinkSync(p); return t; }catch(e){ return 0; }
}

// Borra DEFINITIVAMENTE (libera espacio) las fotos indicadas y deja rastro en la auditoría por unidad.
function purgarFotos(db, filas, motivo, registrarAuditoria){
  let bytes = 0;
  const porUnidad = new Map();
  for(const f of filas){
    bytes += borrarArchivoFisico(f.nombre_almacenado) + borrarArchivoFisico(f.miniatura);
    db.prepare(`UPDATE archivos SET eliminado=1, eliminado_en=COALESCE(eliminado_en, datetime('now')), purgado_en=datetime('now') WHERE id=?`).run(f.id);
    porUnidad.set(f.entidad_id, (porUnidad.get(f.entidad_id) || 0) + 1);
  }
  if(registrarAuditoria){
    for(const [sid, n] of porUnidad){
      registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:sid, accion:'fotos_borradas_automaticamente',
        valor_nuevo: `${n} foto(s) — ${motivo === 'antiguedad' ? 'más de 12 meses de entregada' : 'disco casi lleno'}`, usuario:null });
    }
  }
  return { unidades: porUnidad.size, fotos: filas.length, bytes };
}

const SQL_FOTOS_ENTREGADAS = `SELECT a.id, a.entidad_id, a.nombre_almacenado, a.miniatura, s.fecha_entrega_real
  FROM archivos a JOIN siniestros s ON s.id = a.entidad_id
  WHERE a.entidad_tipo='siniestro' AND a.mime LIKE 'image/%' AND a.purgado_en IS NULL
    AND s.fecha_entrega_real IS NOT NULL AND s.fecha_entrega_real != ''`;

// 1) Antigüedad: fotos de unidades entregadas hace más de `meses` meses.
// 2) Espacio: si el disco pasa de `alto` (85%), se borran las de las entregadas más antiguas, unidad por
//    unidad, hasta bajar de `bajo` (70%). Nunca toca unidades sin entrega registrada, ni la base, ni respaldos.
function limpiezaFotos(db, { meses = 12, alto = 0.85, bajo = 0.70, medir = usoDisco, registrarAuditoria = null } = {}){
  asegurarEsquemaFotos(db);
  const res = { antiguedad: null, espacio: null };
  const viejas = db.prepare(`${SQL_FOTOS_ENTREGADAS} AND date(s.fecha_entrega_real) < date('now', ?)`).all(`-${meses} months`);
  if(viejas.length){
    const u0 = medir();
    res.antiguedad = purgarFotos(db, viejas, 'antiguedad', registrarAuditoria);
    const u1 = medir();
    db.prepare(`INSERT INTO fotos_limpieza (motivo, unidades, fotos, bytes, uso_antes, uso_despues) VALUES ('antiguedad',?,?,?,?,?)`)
      .run(res.antiguedad.unidades, res.antiguedad.fotos, res.antiguedad.bytes, u0 ? u0.pct : null, u1 ? u1.pct : null);
  }
  let uso = medir();
  if(uso && uso.pct >= alto){
    const usoAntes = uso.pct;
    const unidades = db.prepare(`SELECT entidad_id, MIN(fecha_entrega_real) f FROM (${SQL_FOTOS_ENTREGADAS}) GROUP BY entidad_id ORDER BY f ASC`).all();
    const total = { unidades:0, fotos:0, bytes:0 };
    for(const u of unidades){
      const filas = db.prepare(`${SQL_FOTOS_ENTREGADAS} AND a.entidad_id = ?`).all(u.entidad_id);
      const r = purgarFotos(db, filas, 'espacio', registrarAuditoria);
      total.unidades += r.unidades; total.fotos += r.fotos; total.bytes += r.bytes;
      uso = medir();
      if(!uso || uso.pct < bajo) break;
    }
    res.espacio = { ...total, uso_antes: usoAntes, uso_despues: uso ? uso.pct : null };
    db.prepare(`INSERT INTO fotos_limpieza (motivo, unidades, fotos, bytes, uso_antes, uso_despues) VALUES ('espacio',?,?,?,?,?)`)
      .run(total.unidades, total.fotos, total.bytes, usoAntes, uso ? uso.pct : null);
  }
  return res;
}

function iniciarLimpiezaFotos(db, { intervaloMs = 6 * 60 * 60 * 1000 } = {}){
  if(process.env.TEST_DB_PATH) return null;
  const { registrarAuditoria } = require('./utils');
  const tick = () => { try{ limpiezaFotos(db, { registrarAuditoria }); }catch(e){ console.error('Limpieza de fotos:', e.message); } };
  tick();
  const t = setInterval(tick, intervaloMs);
  t.unref();
  return t;
}

// Aviso para el reporte de la mañana: disco alto, o limpieza por espacio en las últimas 24 h.
function avisoEspacio(db, medir = usoDisco){
  asegurarEsquemaFotos(db);
  const uso = medir();
  const limpieza = db.prepare(`SELECT * FROM fotos_limpieza WHERE motivo='espacio' AND fecha >= datetime('now','-1 day') ORDER BY id DESC LIMIT 1`).get();
  const lineas = [];
  if(limpieza) lineas.push(`• Se borraron ${limpieza.fotos} fotos de ${limpieza.unidades} unidades entregadas para liberar espacio.`);
  if(uso && uso.pct >= 0.75) lineas.push(`• Disco de fotos al ${Math.round(uso.pct * 100)}%. Conviene ampliarlo en Render.`);
  return lineas;
}

/* ---------- ZIP (sin comprimir: las fotos ya vienen comprimidas) ---------- */
function crearZip(entradas){
  // entradas: [{ nombre, datos: Buffer, fecha: Date }]
  const partes = [], central = [];
  let offset = 0;
  for(const e of entradas){
    const nombre = Buffer.from(e.nombre, 'utf8');
    const crc = zlib.crc32(e.datos) >>> 0;
    const d = e.fecha || new Date();
    const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(hora, 10); local.writeUInt16LE(dia, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.datos.length, 18); local.writeUInt32LE(e.datos.length, 22);
    local.writeUInt16LE(nombre.length, 26); local.writeUInt16LE(0, 28);
    partes.push(local, nombre, e.datos);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(hora, 12); c.writeUInt16LE(dia, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(e.datos.length, 20); c.writeUInt32LE(e.datos.length, 24);
    c.writeUInt16LE(nombre.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, nombre);
    offset += 30 + nombre.length + e.datos.length;
  }
  const cd = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(0, 4); fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(entradas.length, 8); fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(offset, 16); fin.writeUInt16LE(0, 20);
  return Buffer.concat([...partes, cd, fin]);
}

module.exports = { UPLOAD_DIR, ETAPAS_FOTO, ETIQUETA_ETAPA_FOTO, ETAPAS_CON_FOTO_OBLIGATORIA, asegurarEsquemaFotos,
  contarFotosEtapa, fotosFaltantesCambioEtapa, usoDisco, limpiezaFotos, iniciarLimpiezaFotos, avisoEspacio, crearZip };
