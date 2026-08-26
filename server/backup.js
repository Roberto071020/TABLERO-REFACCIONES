const path = require('path');
const fs = require('fs');

// Item 11 del triage de Daniela: política y prueba de respaldo/restauración.
//
// La base de datos completa (siniestros, pedidos, piezas, proveedores, comunicaciones, auditoría,
// mapeo de Inpart, etc.) vive en un solo archivo SQLite. Este módulo crea copias consistentes de
// ese archivo con VACUUM INTO — una función nativa de SQLite que escribe una copia atómica y
// coherente en un solo paso, incluso con el servidor corriendo, a diferencia de copiar el archivo
// .db directamente mientras se sigue escribiendo (eso sí puede capturarlo a medio escribir).
//
// Esto es un respaldo A NIVEL DE APLICACIÓN, adicional al respaldo automático de la plataforma:
// Render toma una instantánea (snapshot) del disco persistente completo cada 24 horas y la conserva
// al menos 7 días (ver Politica_de_Respaldo_y_Restauracion.docx, sección 1). Ese snapshot cubre todo
// el disco (base de datos + archivos adjuntos) pero es más grueso y no distingue si capturó el
// archivo .db a medio escribir. Este respaldo de aplicación es más frecuente, siempre consistente,
// y descargable bajo demanda desde el propio tablero — ambos mecanismos se complementan.

function dirRespaldos(dataDir){
  const dir = path.join(dataDir, 'backups');
  if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });
  return dir;
}

function nombreRespaldo(fecha = new Date()){
  return 'tablero-' + fecha.toISOString().replace(/[:.]/g, '-') + '.db';
}

function crearRespaldoDB(db, dataDir){
  const dir = dirRespaldos(dataDir);
  const archivo = path.join(dir, nombreRespaldo());
  // VACUUM INTO exige una ruta literal en el SQL; se escapa la comilla simple por seguridad
  // (el nombre lo generamos nosotros con una fecha ISO, nunca viene de entrada de usuario).
  db.exec(`VACUUM INTO '${archivo.replace(/'/g, "''")}'`);
  return archivo;
}

// Conserva los últimos `retener` respaldos y borra los más viejos — rotación, no se acumulan para
// siempre (el disco de producción tiene solo 1 GB en total, compartido con la base de datos viva y
// los archivos adjuntos).
function rotarRespaldos(dataDir, retener = 14){
  const dir = dirRespaldos(dataDir);
  const archivos = fs.readdirSync(dir).filter(f => f.startsWith('tablero-') && f.endsWith('.db')).sort();
  const sobran = archivos.length - retener;
  if(sobran > 0){
    for(const f of archivos.slice(0, sobran)) fs.unlinkSync(path.join(dir, f));
  }
  return sobran > 0 ? sobran : 0;
}

function listarRespaldos(dataDir){
  const dir = dirRespaldos(dataDir);
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('tablero-') && f.endsWith('.db'))
    .map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { nombre: f, tamano_bytes: st.size, creado_en: st.mtime.toISOString() };
    })
    .sort((a, b) => b.nombre.localeCompare(a.nombre));
}

// Se llama una vez al arrancar el servidor. Crea un respaldo inmediato (Render puede reiniciar el
// proceso en cualquier redeploy, así siempre hay al menos uno reciente) y programa uno cada 24 horas.
// Se omite por completo durante las pruebas automatizadas (TEST_DB_PATH) para no ensuciar la carpeta
// de datos de prueba ni dejar temporizadores activos que compliquen el cierre del test runner.
function programarRespaldosAutomaticos(db, { intervaloMs = 24 * 60 * 60 * 1000, retener = 14 } = {}){
  if(process.env.TEST_DB_PATH) return null;
  try{
    crearRespaldoDB(db, db.DATA_DIR);
    rotarRespaldos(db.DATA_DIR, retener);
  }catch(e){
    console.error('No se pudo crear el respaldo automático al arrancar:', e.message);
  }
  const intervalo = setInterval(() => {
    try{
      crearRespaldoDB(db, db.DATA_DIR);
      rotarRespaldos(db.DATA_DIR, retener);
    }catch(e){
      console.error('No se pudo crear el respaldo automático programado:', e.message);
    }
  }, intervaloMs);
  intervalo.unref(); // no debe mantener vivo el proceso por sí solo
  return intervalo;
}

module.exports = { dirRespaldos, crearRespaldoDB, rotarRespaldos, listarRespaldos, nombreRespaldo, programarRespaldosAutomaticos };
