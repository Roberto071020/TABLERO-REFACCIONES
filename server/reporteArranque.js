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
  if(u.es_autosurtido) t += ' [Autosurtido]';
  return t;
}

// Panorama general del taller (5-nov-2026, Roberto): cuántas unidades hay en patio y circulando, en qué
// estado, y cómo van las fechas promesa. "Activa" = no archivada, sin entrega registrada y no cerrada.
const ETIQUETA_ETAPA = { mecanica:'Mecánica', en_laminado:'Hojalatería', preparacion:'Preparación', pintura:'Pintura',
  armado:'Armado', pulido:'Pulido', lavado:'Lavado' };
function calcularPanoramaTaller(db, hoy){
  const activas = db.prepare(`SELECT id, ubicacion, estado_autorizacion, estado_produccion, requiere_refacciones,
      aseguradora_ruta_refacciones, cita_fecha, fecha_entrega_prevista
    FROM siniestros WHERE archivado = 0 AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '')
      AND COALESCE(estatus_general,'') != 'Cerrado'`).all();
  const enTransito = u => /^tr/i.test(String(u.ubicacion || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const autorizada = u => ['autorizada','parcial'].includes(u.estado_autorizacion);
  const piezasCompletas = u => {
    if(u.requiere_refacciones === 'no') return true;
    if(u.requiere_refacciones !== 'si' || u.aseguradora_ruta_refacciones === 'autosurtido') return false;
    const f = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN z.estatus = 'Recibida físicamente' THEN 1 ELSE 0 END) rec
      FROM piezas z JOIN pedidos p ON p.id = z.pedido_id WHERE p.siniestro_id = ? AND z.estatus != 'Cancelada'`).get(u.id);
    return f.total > 0 && f.rec === f.total;
  };
  const patio = activas.filter(u => !enTransito(u));
  const circulando = activas.filter(enTransito);
  const etapas = {};
  const enReparacion = patio.filter(u => autorizada(u) && ETIQUETA_ETAPA[u.estado_produccion]);
  enReparacion.forEach(u => { etapas[u.estado_produccion] = (etapas[u.estado_produccion] || 0) + 1; });
  const conFecha = activas.filter(u => u.fecha_entrega_prevista && u.estado_produccion !== 'terminado');
  const en3 = new Date(Date.parse(hoy + 'T12:00:00Z') + 3 * 86400000).toISOString().slice(0, 10);
  const circCompletas = circulando.filter(u => !u.cita_fecha && piezasCompletas(u));
  return {
    patio: patio.length,
    por_autorizar: patio.filter(u => !autorizada(u)).length,
    sin_iniciar: patio.filter(u => autorizada(u) && (!u.estado_produccion || u.estado_produccion === 'programado')).length,
    en_reparacion: enReparacion.length,
    por_etapa: Object.keys(ETIQUETA_ETAPA).filter(e => etapas[e]).map(e => `${ETIQUETA_ETAPA[e]} ${etapas[e]}`),
    detenidas: patio.filter(u => u.estado_produccion === 'detenido').length,
    terminadas: patio.filter(u => u.estado_produccion === 'terminado').length,
    circulando: circulando.length,
    con_cita: circulando.filter(u => u.cita_fecha).length,
    piezas_completas_sin_cita: circCompletas.length,
    esperando_piezas: circulando.filter(u => !u.cita_fecha).length - circCompletas.length,
    vencidas: conFecha.filter(u => u.fecha_entrega_prevista < hoy).length,
    vencen_3_dias: conFecha.filter(u => u.fecha_entrega_prevista >= hoy && u.fecha_entrega_prevista <= en3).length
  };
}

function calcularReporteArranque(db, ahora = new Date()){
  const hoy = fechaMexico(ahora);
  const panorama = calcularPanoramaBeto(db);
  const taller = calcularPanoramaTaller(db, hoy);

  const vencidas = panorama.filter(u => u.fecha_entrega_prevista && u.fecha_entrega_prevista < hoy);
  const vencenPronto = panorama.filter(u => u.prioridad === 1 && !(u.fecha_entrega_prevista < hoy));
  const reingresos = panorama.filter(u => u.reingreso_citado);
  const rapidasSinTocar = panorama.filter(u => u.prioridad === 2);
  const listasParaIniciar = panorama.filter(u => u.prioridad === 3 || u.prioridad === 3.5);
  const transitoParaCitar = panorama.filter(u => u.en_transito && u.refacciones_completas && !u.cita_fecha);
  // Fecha de entrega obligatoria (Roberto, 5-nov-2026): solo para unidades en piso, autorizadas y con piezas
  // listas (sin refacciones, autosurtido en piso, completas o 60%+ surtidas). Circulando o esperando
  // refacciones todavía no la necesitan. La captura Beto (o Alejandra/Daniela).
  const faltaFechaEntrega = panorama.filter(u => !u.fecha_entrega_prevista && !u.en_transito && !u.reingreso_citado
    && (u.refacciones_completas || u.piezas_suficientes));
  const sinDatoRefacciones = panorama.filter(u => u.sin_dato_refacciones).length;

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
    listas_para_iniciar: listasParaIniciar, transito_para_citar: transitoParaCitar, piezas_vencidas: piezasVencidas,
    taller,
    falta_fecha_entrega: faltaFechaEntrega, sin_dato_refacciones: sinDatoRefacciones,
    aviso_espacio: (()=>{ try{ return require('./fotos').avisoEspacio(db); }catch(e){ return []; } })(),
    complementos_pendientes: complementosPendientes, pendientes_calidad: pendientesCalidad,
    // 12-nov-2026 (Roberto: premiar a quienes llegan temprano): reconocimiento en el reporte que reenvía al grupo.
    puntualidad: (()=>{ try{ const A = require('./asistencia'); return { semana: A.semanaPerfecta(db, hoy), medallas: A.medallasVigentes(db, hoy) }; }catch(e){ return null; } })()
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
  if(d.taller){
    const t = d.taller;
    const patio = [`🅿️ *En patio: ${t.patio}*`];
    if(t.por_autorizar) patio.push(`• Por autorizar: ${t.por_autorizar}`);
    if(t.sin_iniciar) patio.push(`• Autorizadas sin iniciar: ${t.sin_iniciar}`);
    if(t.en_reparacion) patio.push(`• En reparación: ${t.en_reparacion}${t.por_etapa.length ? ' (' + t.por_etapa.join(' · ') + ')' : ''}`);
    if(t.detenidas) patio.push(`• Detenidas: ${t.detenidas}`);
    if(t.terminadas) patio.push(`• Terminadas por entregar: ${t.terminadas}`);
    const circ = [`🚗 *Circulando: ${t.circulando}*`];
    if(t.esperando_piezas) circ.push(`• Esperando piezas: ${t.esperando_piezas}`);
    if(t.piezas_completas_sin_cita) circ.push(`• Piezas completas, falta citar: ${t.piezas_completas_sin_cita}`);
    if(t.con_cita) circ.push(`• Con cita de reingreso: ${t.con_cita}`);
    const fechas = `⏰ *Fechas promesa:* ${t.vencidas} vencida${t.vencidas === 1 ? '' : 's'} · ${t.vencen_3_dias} vence${t.vencen_3_dias === 1 ? '' : 'n'} en los próximos 3 días`;
    b.push(`*📊 PANORAMA DEL TALLER*\n` + patio.join('\n') + '\n\n' + circ.join('\n') + '\n\n' + fechas);
  } else {
    b.push(`Unidades autorizadas en proceso: *${d.en_proceso}*`);
  }

  if(d.puntualidad){
    const p = d.puntualidad, r = [];
    if(p.semana && p.semana.nombres.length) r.push(`🏆 *Semana perfecta* (a tiempo los ${p.semana.dias} días):\n` + p.semana.nombres.map(n => `• ${n}`).join('\n'));
    if(p.medallas && p.medallas.length) r.push(`🏅 *Rachas a tiempo:* ` + p.medallas.map(m => `${m.icono} ${m.nombre.split(' ')[0]} (${m.racha})`).join(' · '));
    if(r.length) b.push(`*👏 RECONOCIMIENTO*\n` + r.join('\n'));
  }
  if(d.vencidas.length) b.push(`*🔴 Vencidas (${d.vencidas.length})*\n` + lista(d.vencidas, u => ` – venció ${ddmm(u.fecha_entrega_prevista)}`));
  if(d.vencen_pronto.length) b.push(`*🟠 Vencen hoy o mañana (${d.vencen_pronto.length})*\n` + lista(d.vencen_pronto, u => ` – ${ddmm(u.fecha_entrega_prevista)}`));
  if(d.reingresos.length) b.push(`*🚗 Reingresos con cita (${d.reingresos.length})*\n` + lista(d.reingresos));
  if(d.listas_para_iniciar.length) b.push(`*🟢 Listas para iniciar – asignar hoy (${d.listas_para_iniciar.length})*\n` + lista(d.listas_para_iniciar));
  if(d.transito_para_citar && d.transito_para_citar.length) b.push(`*🚙 En tránsito con piezas completas – citar reingreso (${d.transito_para_citar.length})*\n` + lista(d.transito_para_citar));
  if(d.falta_fecha_entrega && d.falta_fecha_entrega.length) b.push(`*📅 Falta fecha de entrega – Beto (${d.falta_fecha_entrega.length})*\n` + lista(d.falta_fecha_entrega));
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

  // Datos que faltan capturar: sin ellos el reporte no puede avisar a tiempo (vencidas, listas para iniciar).
  const faltan = [];
  if(d.sin_dato_refacciones) faltan.push(`• Sin indicar si requiere refacciones: ${d.sin_dato_refacciones}`);
  if(faltan.length) b.push(`*📋 Falta capturar en el tablero*\n` + faltan.join('\n'));
  if(d.aviso_espacio && d.aviso_espacio.length) b.push(`*⚠️ Espacio para fotos*\n` + d.aviso_espacio.join('\n'));

  const hayAlgo = d.vencidas.length || d.vencen_pronto.length || d.reingresos.length || d.listas_para_iniciar.length
    || d.rapidas_sin_tocar.length || d.piezas_vencidas.length || otros.length || (d.transito_para_citar && d.transito_para_citar.length);
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
