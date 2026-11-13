// ===================== Aviso de los reportes desde SC Control (13-nov-2026) =====================
// Roberto: "Porque no tengo el reporte de hoy?" ... "Necesito que esto no pase y que sea automático tal como se
// pidió" ... "Todo eso ya lo hice y no cambio nada". El aviso del reporte de arranque y del corte de las 3 llegaba
// solo por la app de Claude (tarea programada); ahora SC Control también se lo manda directo a Roberto por el
// mismo canal de avisos push que ya usa el equipo. Al tocarlo se abre la página del reporte con el botón
// "Compartir por WhatsApp".
//   - Reporte de arranque: desde las 7:20 (lunes a sábado), hasta las 12:00 si por algo no se pudo antes.
//   - Corte de las 3: desde las 14:55 (lunes a sábado), hasta las 18:00.
//   - Una sola vez al día por reporte y por persona (queda en push_avisados).
//   - Se revisa cada 2 minutos y también cada vez que la tarea de Claude consulta el reporte (así, aunque el
//     servidor estuviera dormido, el aviso sale en cuanto la tarea lo despierta).
// Solo para el propietario (admin/jefe) que activó "🔔 Activar avisos" en su celular.
const REPORTES = [
  { clave:'arranque', desde:[7, 20], hasta:[12, 0], url:'/reporte-dia.html',
    armar(db){
      const r = require('./reporteArranque').calcularReporteArranque(db);
      const piezas = r.piezas_vencidas.reduce((a, p) => a + p.piezas, 0);
      const partes = [`${r.vencidas.length} vencida${r.vencidas.length === 1 ? '' : 's'}`, `${r.vencen_pronto.length} vencen hoy o mañana`,
        `${r.listas_para_iniciar.length} listas para iniciar`, `${piezas} piezas vencidas`];
      return { titulo:'🔧 Reporte de arranque listo', cuerpo: partes.join(', ') + '. Tócalo para compartirlo al grupo.' };
    } },
  { clave:'corte', desde:[14, 55], hasta:[18, 0], url:'/reporte-dia.html?tipo=corte',
    armar(db){
      const r = require('./corteTarde').calcularCorteTarde(db);
      const con = r.personas.filter(p => p.renglones.length).map(p => `${p.nombre} ${p.renglones.length}`);
      const al = r.personas.filter(p => !p.renglones.length).map(p => p.nombre);
      return { titulo:'⏱️ Corte de las 3 listo', cuerpo: (con.length ? 'Pendientes: ' + con.join(', ') : 'Todos al corriente') + (con.length && al.length ? '; al corriente: ' + al.join(', ') : '') + '. Tócalo para compartirlo.' };
    } },
];

function ahoraMX(fecha = new Date()){
  const mx = new Date(fecha.getTime() - 6 * 3600000); // Veracruz, UTC-6 todo el año
  return { fecha: mx.toISOString().slice(0, 10), dia: mx.getUTCDay(), min: mx.getUTCHours() * 60 + mx.getUTCMinutes() };
}

let corriendo = false;
async function enviarAvisoReportes(db, { ahora = new Date(), enviar } = {}){
  const push = require('./push');
  if(!enviar){ if(!push.configurado()) return { enviados: 0 }; enviar = push.enviarReal; }
  if(corriendo) return { omitido: true };
  corriendo = true;
  const res = { enviados: 0 };
  try{
    push.asegurarTablas(db);
    const t = ahoraMX(ahora);
    if(t.dia === 0) return res; // domingo cerrado
    const duenos = db.prepare(`SELECT DISTINCT u.id FROM usuarios u JOIN push_suscripciones p ON p.usuario_id = u.id WHERE u.activo = 1 AND u.rol IN ('admin','jefe')`).all();
    if(!duenos.length) return res;
    for(const rep of REPORTES){
      if(t.min < rep.desde[0] * 60 + rep.desde[1] || t.min >= rep.hasta[0] * 60 + rep.hasta[1]) continue;
      const clave = `rep-${rep.clave}-${t.fecha}`;
      const faltan = duenos.filter(u => !db.prepare('SELECT 1 FROM push_avisados WHERE usuario_id = ? AND clave = ?').get(u.id, clave));
      if(!faltan.length) continue;
      let aviso;
      try{ aviso = { ...rep.armar(db), tag: 'rep-' + rep.clave, url: rep.url }; }catch(e){ console.error('[aviso-reportes]', rep.clave, e && e.message); continue; }
      for(const u of faltan){
        db.prepare('INSERT OR IGNORE INTO push_avisados (usuario_id, clave) VALUES (?, ?)').run(u.id, clave);
        res.enviados += (await push.enviarAUsuario(db, u.id, aviso, enviar)) ? 1 : 0;
      }
    }
  }catch(e){
    console.error('[aviso-reportes] falló:', e && e.message);
  }finally{
    corriendo = false;
  }
  return res;
}

function iniciarAvisoReportes(db){
  if(process.env.TEST_DB_PATH) return null;
  setTimeout(() => enviarAvisoReportes(db), 45 * 1000);
  return setInterval(() => enviarAvisoReportes(db), 2 * 60 * 1000);
}

module.exports = { enviarAvisoReportes, iniciarAvisoReportes, REPORTES };
