// ===================== Reporte de arranque del día (4-nov-2026) =====================
// Roberto: "que el sistema vaya hacia la gente, en vez de esperar a que entren a buscar la información".
// Cada mañana se arma un resumen corto, ya escrito en formato WhatsApp, para leerlo en la junta de las 8:00
// y reenviarlo al grupo del equipo con un solo toque (página /reporte-dia.html, botón "Compartir").
//
// Solo LEE datos que ya existen -- no captura nada nuevo ni cambia ningún expediente. Reutiliza la misma
// lógica de prioridades del panorama de Beto (server/panoramaBeto.js) para que el reporte y la pantalla de
// Beto nunca digan cosas distintas.
//
// Envío automático por correo: opcional, solo si están configuradas GMAIL_USER / GMAIL_APP_PASSWORD (ya
// usadas por correoSaliente.js) y REPORTE_ARRANQUE_CORREO (destinatario). Sin esas variables el módulo
// queda inerte y la página sigue funcionando igual.
const { calcularPanoramaBeto } = require('./panoramaBeto');

const ZONA = 'America/Mexico_City';
const MAX_POR_SECCION = 10;

// Fecha de "hoy" en Ciudad de México (AAAA-MM-DD), sin depender de la zona horaria del servidor (UTC en Render).
function fechaMexico(fecha = new Date()){
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year:'numeric', month:'2-digit', day:'2-digit' }).format(fecha);
}
function horaMexico(fecha = new Date()){
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(fecha);
  const h = Number(p.find(x=>x.type==='hour').value) % 24;
  const m = Number(p.find(x=>x.type==='minute').value);
  return h * 60 + m; // minutos desde medianoche
}
function fechaLarga(fecha = new Date()){
  const t = new Intl.DateTimeFormat('es-MX', { timeZone: ZONA, weekday:'long', day:'numeric', month:'short' }).format(fecha);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function ddmm(iso){
  if(!iso) return '';
  const [, m, d] = String(iso).slice(0,10).split('-');
  return d && m ? `${d}/${m}` : String(iso);
}

function etiquetaUnidad(u){
  const partes = [u.vehiculo || 'Sin vehículo', u.placas, u.aseguradora].filter(Boolean);
  let t = partes.join(' · ');
  if(u.ot_numero) t += ` (OT ${u.ot_numero})`;
  else if(u.numero) t += ` (${u.numero})`;
  return t;
}

function calcularReporteArranque(db, ahora = new Date()){
  const hoy = fechaMexico(ahora);
  const panorama = calcularPanoramaBeto(db);

  const vencidas = panorama.filter(u => u.fecha_entrega_prevista && u.fecha_entrega_prevista < hoy);
  const vencenPronto = panorama.filter(u => u.prioridad === 1 && !(u.fecha_entrega_prevista < hoy));
  const reingresos = panorama.filter(u => u.reingreso_citado);
  const rapidasSinTocar = panorama.filter(u => u.prioridad === 2);
  const listasParaIniciar = panorama.filter(u => u.prioridad === 3 || u.prioridad === 3.5);

  // Piezas vencidas: mismo criterio que el contador "Piezas vencidas" del resumen diario de Daniela.
  const piezasVencidas = db.prepare(`
    SELECT COALESCE(pv.razon_social, 'Sin proveedor') proveedor, COUNT(*) piezas, COUNT(DISTINCT s.id) unidades,
           MIN(z.fecha_prometida) mas_antigua
    FROM piezas z
    JOIN pedidos p ON p.id = z.pedido_id
    JOIN siniestros s ON s.id = p.siniestro_id
    LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
    WHERE z.estatus NOT IN ('Recibida físicamente','Cancelada')
      AND p.estatus_operativo NOT IN ('Cancelado','Cerrado','Recibido completo')
      AND s.archivado = 0
      AND z.fecha_prometida IS NOT NULL AND z.fecha_prometida != '' AND z.fecha_prometida < ?
    GROUP BY proveedor ORDER BY piezas DESC, mas_antigua ASC`).all(hoy);

  const complementosPendientes = db.prepare(`
    SELECT COUNT(*) n FROM complementos c JOIN siniestros s ON s.id = c.siniestro_id
    WHERE c.decision = 'pendiente' AND s.archivado = 0`).get().n;
  const pendientesCalidad = db.prepare(`
    SELECT COUNT(*) n FROM siniestros WHERE archivado = 0 AND estado_produccion = 'terminado'
      AND (estado_calidad IS NULL OR estado_calidad != 'liberado')
      AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '')`).get().n;

  const datos = {
    fecha: hoy,
    fecha_texto: fechaLarga(ahora),
    en_proceso: panorama.length,
    vencidas, vencen_pronto: vencenPronto, reingresos, rapidas_sin_tocar: rapidasSinTocar,
    listas_para_iniciar: listasParaIniciar, piezas_vencidas: piezasVencidas,
    complementos_pendientes: complementosPendientes, pendientes_calidad: pendientesCalidad
  };
  datos.texto = textoWhatsApp(datos);
  return datos;
}

function lista(unidades, detalle){
  const lineas = unidades.slice(0, MAX_POR_SECCION).map(u => `• ${etiquetaUnidad(u)}${detalle ? detalle(u) : ''}`);
  if(unidades.length > MAX_POR_SECCION) lineas.push(`  …y ${unidades.length - MAX_POR_SECCION} más en el tablero`);
  return lineas.join('\n');
}

// Formato WhatsApp: *negritas*, renglones cortos, sin tablas (se descuadran en el celular).
function textoWhatsApp(d){
  const b = [];
  b.push(`*🔧 ARRANQUE DEL DÍA – ${d.fecha_texto}*`);
  b.push(`Unidades autorizadas en proceso: *${d.en_proceso}*`);

  if(d.vencidas.length) b.push(`*🔴 Vencidas (${d.vencidas.length})*\n` + lista(d.vencidas, u => ` – venció ${ddmm(u.fecha_entrega_prevista)}`));
  if(d.vencen_pronto.length) b.push(`*🟠 Vencen hoy o mañana (${d.vencen_pronto.length})*\n` + lista(d.vencen_pronto, u => ` – ${ddmm(u.fecha_entrega_prevista)}`));
  if(d.reingresos.length) b.push(`*🚗 Reingresos con cita (${d.reingresos.length})*\n` + lista(d.reingresos));
  if(d.listas_para_iniciar.length) b.push(`*🟢 Listas para iniciar – asignar hoy (${d.listas_para_iniciar.length})*\n` + lista(d.listas_para_iniciar));
  if(d.rapidas_sin_tocar.length) b.push(`*⚡ Reparaciones rápidas sin tocar (${d.rapidas_sin_tocar.length})*\n` + lista(d.rapidas_sin_tocar));

  if(d.piezas_vencidas.length){
    const total = d.piezas_vencidas.reduce((a, p) => a + p.piezas, 0);
    const lineas = d.piezas_vencidas.slice(0, MAX_POR_SECCION)
      .map(p => `• ${p.proveedor}: ${p.piezas} pieza${p.piezas === 1 ? '' : 's'} (${p.unidades} unidad${p.unidades === 1 ? '' : 'es'})`);
    if(d.piezas_vencidas.length > MAX_POR_SECCION) lineas.push(`  …y ${d.piezas_vencidas.length - MAX_POR_SECCION} proveedores más`);
    b.push(`*📦 Piezas vencidas (${total})*\n` + lineas.join('\n'));
  }

  const otros = [];
  if(d.complementos_pendientes) otros.push(`• Complementos sin respuesta: ${d.complementos_pendientes}`);
  if(d.pendientes_calidad) otros.push(`• Terminadas esperando revisión de calidad: ${d.pendientes_calidad}`);
  if(otros.length) b.push(`*📝 Otros pendientes*\n` + otros.join('\n'));

  const hayAlgo = d.vencidas.length || d.vencen_pronto.length || d.reingresos.length || d.listas_para_iniciar.length
    || d.rapidas_sin_tocar.length || d.piezas_vencidas.length || otros.length;
  if(!hayAlgo) b.push('✅ Sin vencidos ni bloqueos registrados hoy.');

  b.push('_Generado por SC Control_');
  return b.join('\n\n');
}

/* ---------- Envío automático diario por correo (opcional) ---------- */

function asegurarTablaEnvios(db){
  db.exec(`CREATE TABLE IF NOT EXISTS reporte_arranque_envios (
    fecha TEXT PRIMARY KEY,
    destinatario TEXT,
    enviado_en TEXT,
    error TEXT
  );`);
}

const HORA_ENVIO = 7 * 60 + 30;   // 7:30 a.m. (Ciudad de México)
const HORA_LIMITE = 12 * 60;      // si el servidor estuvo caído, ya no se manda después del mediodía

async function intentarEnvioDiario(db, { ahora = new Date(), enviar } = {}){
  const destinatario = process.env.REPORTE_ARRANQUE_CORREO;
  if(!destinatario) return { enviado:false, motivo:'sin_destinatario' };
  const correo = require('./correoSaliente');
  if(!enviar && !correo.configurado()) return { enviado:false, motivo:'gmail_no_configurado' };

  const minutos = horaMexico(ahora);
  if(minutos < HORA_ENVIO || minutos >= HORA_LIMITE) return { enviado:false, motivo:'fuera_de_horario' };

  asegurarTablaEnvios(db);
  const hoy = fechaMexico(ahora);
  const previo = db.prepare(`SELECT enviado_en FROM reporte_arranque_envios WHERE fecha = ?`).get(hoy);
  if(previo && previo.enviado_en) return { enviado:false, motivo:'ya_enviado' };

  const reporte = calcularReporteArranque(db, ahora);
  const base = (process.env.APP_URL || 'https://tablero-refacciones.onrender.com').replace(/\/$/, '');
  const text = `${reporte.texto}\n\n— — —\nPara reenviarlo al grupo de WhatsApp con un toque, abre:\n${base}/reporte-dia.html`;
  try{
    await (enviar || correo.enviarCorreo)({ to: destinatario, subject: `Arranque del día – ${reporte.fecha_texto}`, text });
    db.prepare(`INSERT INTO reporte_arranque_envios (fecha, destinatario, enviado_en, error) VALUES (?, ?, datetime('now'), NULL)
      ON CONFLICT(fecha) DO UPDATE SET destinatario = excluded.destinatario, enviado_en = excluded.enviado_en, error = NULL`).run(hoy, destinatario);
    return { enviado:true };
  }catch(e){
    db.prepare(`INSERT INTO reporte_arranque_envios (fecha, destinatario, enviado_en, error) VALUES (?, ?, NULL, ?)
      ON CONFLICT(fecha) DO UPDATE SET error = excluded.error`).run(hoy, destinatario, String(e.message || e));
    console.error('Reporte de arranque: no se pudo enviar el correo:', e.message);
    return { enviado:false, motivo:'error', error: e.message };
  }
}

// Revisa cada 5 minutos si ya toca mandar el reporte de hoy (mismo patrón que backup.js y whatsappScheduler.js:
// el plan starter de Render no duerme el proceso). No-op durante las pruebas automatizadas.
function iniciarReporteArranque(db, { intervaloMs = 5 * 60 * 1000 } = {}){
  if(process.env.TEST_DB_PATH) return null;
  const tick = () => { intentarEnvioDiario(db).catch(e => console.error('Reporte de arranque:', e.message)); };
  tick();
  const t = setInterval(tick, intervaloMs);
  t.unref();
  return t;
}

module.exports = { calcularReporteArranque, textoWhatsApp, intentarEnvioDiario, iniciarReporteArranque, fechaMexico, horaMexico };
