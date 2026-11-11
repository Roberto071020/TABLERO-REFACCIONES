// ===================== Inicio de Roberto (7-nov-2026) =====================
// Mismo criterio que Beto, Alejandra, Daniela y Orlando (Roberto: "hazlo usando el mismo criterio"): una sola
// pantalla con lo que le TOCA hacer, en orden y con botón, y aparte solo lo que está ATORADO en el equipo.
//   1) Reautorizaciones por vencer -> Orlando tiene <= 6 h (o ya venció) para mandar las fotos editadas.
//   2) Por valuar                  -> expediente listo; botón "Valué y envié".
//   3) Esperando a la aseguradora  -> botón "Llegó la respuesta"; en rojo las de más de 3 días hábiles.
//   4) Por arrancar                -> autorizadas; botón "Enviar expediente completo" (avisa a Alejandra y Daniela).
//   5) Complementos que requieren su decisión -> daño oculto de más de $1,000 (solo el propietario lo autoriza).
//   Alertas del taller -> entregas vencidas, listas sin iniciar, calidad sin revisar (+1 día), clientes sin aviso
//   (+3 días) y piezas vencidas. Solo se muestran las que tienen algo.
// Línea base (lunes 9-nov-2026): "Por arrancar" solo muestra autorizaciones registradas desde ese día; todo lo
// que ya estaba autorizado (incluida la carga masiva del 7-nov) se da por arrancado, sin escribir nada.
const { sumarDiasHabiles } = require('./utils');
const { calcularPanoramaBeto } = require('./panoramaBeto');
const { unidadesPorRevisarCalidad, HORAS_APOYO } = require('./calidadPendiente');

const LINEA_BASE_DESDE = process.env.LINEA_BASE_ROBERTO || '2026-11-09';
const LIMITE_COMPLEMENTO = 1000; // mismo límite que server/routes/complementos.js (LIMITE_AUTORIZACION_SIN_PROPIETARIO)
const HORAS_ALERTA_REAUTORIZACION = 6;
const DIAS_INCONFORMES = 15; // 11-nov-2026: ver alerta 'inconformes'

function hoyMX(){ return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10); }
function aMs(v){ if(!v) return NaN; const t = String(v); return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); }
const vacio = v => v === null || v === undefined || String(v).trim() === '';
// Medianoche de Veracruz (UTC-6) del día de la línea base, en el formato de la auditoría (UTC).
const baseUTC = () => LINEA_BASE_DESDE + ' 06:00:00';

function calcularInicioRoberto(db, { alertas: conAlertas = true } = {}){
  const hoy = hoyMX();
  const ahora = Date.now();
  const base = 's.id, s.numero, s.vehiculo, s.placas, s.aseguradora, s.cliente_nombre';

  const reautorizaciones = db.prepare(`SELECT c.id AS complemento_id, c.pieza_operacion, c.fecha_limite, c.estado, ${base}
    FROM complementos c JOIN siniestros s ON s.id = c.siniestro_id
    WHERE c.tipo='no_autorizado_inicial' AND c.decision='pendiente' AND c.estado IN ('detectado','documentando') AND s.archivado = 0`).all()
    .map(c => ({ ...c, horas_restantes: c.fecha_limite ? Math.round((aMs(c.fecha_limite) - ahora) / 3600000) : null }))
    .filter(c => c.horas_restantes !== null && c.horas_restantes <= HORAS_ALERTA_REAUTORIZACION)
    .sort((a, b) => a.horas_restantes - b.horas_restantes);

  const porValuar = db.prepare(`SELECT ${base}, s.expediente_listo_fecha, s.actualizado_en FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado' AND s.estado_expediente = 'listo_para_valuacion'
      AND (s.valuacion_fecha_envio IS NULL OR s.valuacion_fecha_envio = '')
      AND (s.estado_autorizacion IS NULL OR s.estado_autorizacion = '')
    ORDER BY COALESCE(s.expediente_listo_fecha, s.actualizado_en) ASC`).all();

  const esperando = db.prepare(`SELECT ${base}, s.valuacion_fecha_envio, s.autorizacion_fecha_envio, s.estado_autorizacion FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado'
      AND (s.estado_autorizacion IN ('en_autorizacion','por_aclarar')
        OR ((s.estado_autorizacion IS NULL OR s.estado_autorizacion = '') AND s.valuacion_fecha_envio IS NOT NULL AND s.valuacion_fecha_envio != ''))`).all()
    .map(s => {
      const enviada = String(s.autorizacion_fecha_envio || s.valuacion_fecha_envio || '').slice(0, 10);
      const vencida = !!enviada && hoy > sumarDiasHabiles(enviada, 3);
      return { ...s, enviada, vencida, por_aclarar: s.estado_autorizacion === 'por_aclarar' };
    })
    .sort((a, b) => (b.vencida - a.vencida) || String(a.enviada || '9999').localeCompare(String(b.enviada || '9999')));

  const porArrancar = db.prepare(`SELECT ${base}, s.estado_autorizacion, s.autorizacion_fecha_respuesta FROM siniestros s
    WHERE s.archivado = 0 AND s.estatus_general != 'Cerrado' AND s.estado_autorizacion IN ('autorizada','parcial')
      AND (s.expediente_completo_enviado_en IS NULL OR s.expediente_completo_enviado_en = '')
      AND (s.fecha_entrega_real IS NULL OR s.fecha_entrega_real = '')
      AND EXISTS (SELECT 1 FROM auditoria a WHERE a.entidad_tipo='siniestro' AND a.entidad_id = s.id AND a.campo='estado_autorizacion'
                  AND a.valor_nuevo IN ('autorizada','parcial') AND a.fecha >= ?)
    ORDER BY s.autorizacion_fecha_respuesta ASC`).all(baseUTC())
    .map(s => {
      const ot = db.prepare(`SELECT 1 FROM archivos WHERE entidad_tipo='siniestro' AND entidad_id=? AND tipo='Orden de trabajo' AND eliminado=0 LIMIT 1`).get(s.id)
        || db.prepare(`SELECT 1 FROM ordenes_trabajo WHERE siniestro_id=? LIMIT 1`).get(s.id);
      const sinProveedor = db.prepare(`SELECT COUNT(*) n FROM piezas z JOIN pedidos p ON p.id=z.pedido_id WHERE p.siniestro_id=? AND z.estatus='Sin proveedor'`).get(s.id).n;
      const faltan = [];
      if(!ot) faltan.push('la orden de trabajo');
      if(sinProveedor) faltan.push(`proveedor para ${sinProveedor} pieza(s)`);
      return { ...s, faltan };
    });

  const complementos = db.prepare(`SELECT c.id AS complemento_id, c.causa, c.pieza_operacion, c.importe, c.estado, ${base}
    FROM complementos c JOIN siniestros s ON s.id = c.siniestro_id
    WHERE c.tipo='dano_oculto' AND c.decision='pendiente' AND COALESCE(c.importe, 0) > ? AND s.archivado = 0
    ORDER BY c.creado_en ASC`).all(LIMITE_COMPLEMENTO);

  let alertas = [];
  if(conAlertas){
    const unidad = s => ({ id: s.id, numero: s.numero, detalle: [s.vehiculo, s.placas].filter(Boolean).join(' · ') });
    const vencidas = db.prepare(`SELECT id, numero, vehiculo, placas, fecha_entrega_prevista FROM siniestros
      WHERE archivado = 0 AND fecha_entrega_prevista IS NOT NULL AND fecha_entrega_prevista != '' AND fecha_entrega_prevista < ?
        AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '') ORDER BY fecha_entrega_prevista ASC`).all(hoy)
      .map(s => ({ ...unidad(s), detalle: unidad(s).detalle + ' · prometida ' + s.fecha_entrega_prevista }));
    let listas = [];
    try{ listas = calcularPanoramaBeto(db).filter(x => (x.prioridad === 3 || x.prioridad === 3.5) && !x.estado_produccion).map(unidad); }catch(e){}
    const calidad = unidadesPorRevisarCalidad(db, { minHoras: HORAS_APOYO }).map(s => ({ ...unidad(s), detalle: unidad(s).detalle + ` · terminada hace ${Math.floor(s.horas_terminada / 24)} día(s)` }));
    let sinAviso = [];
    try{ sinAviso = require('./inicioAlejandra').calcularInicioAlejandra(db).tarjetas.filter(t => t.tipo === 'seguimiento' || t.tipo === 'aviso')
      .map(t => ({ id: t.id, numero: t.numero, detalle: [t.vehiculo, t.motivo].filter(Boolean).join(' · ') })); }catch(e){}
    let piezas = [];
    try{ piezas = require('./inicioDaniela').calcularInicioDaniela(db).vencidas
      .flatMap(g => g.piezas.map(z => ({ id: z.siniestro_id, numero: z.siniestro_numero, detalle: `${z.descripcion} · ${g.proveedor} · vencida hace ${z.dias_vencida} día(s)` }))); }catch(e){}
    let detenidas = [];
    try{ const D = require('./detenidas'); detenidas = D.listarDetenidas(db).map(d => ({ id: d.id, numero: d.numero, detalle: [d.vehiculo, D.textoDetalle(d)].filter(Boolean).join(' · ') })); }catch(e){}
    // 11-nov-2026: clientes GNP que se fueron inconformes (Roberto: "es mejor sin respuesta a una mala calificación").
    // Se muestran 15 días después de la entrega para que Roberto los atienda antes de que GNP los encueste.
    const desde = new Date(Date.parse(hoy) - DIAS_INCONFORMES * 86400000).toISOString().slice(0, 10);
    const inconformes = db.prepare(`SELECT id, numero, vehiculo, placas, cliente_nombre, cliente_telefono, encuesta_comentarios, fecha_entrega_real FROM siniestros
      WHERE encuesta_estado = 'no_solicitar' AND fecha_entrega_real >= ? ORDER BY fecha_entrega_real DESC`).all(desde)
      .map(s => ({ id: s.id, numero: s.numero, detalle: [s.vehiculo, s.cliente_nombre, s.cliente_telefono, 'entregada ' + s.fecha_entrega_real, s.encuesta_comentarios ? 'Motivo: ' + s.encuesta_comentarios : ''].filter(Boolean).join(' · ') }));
    alertas = [
      { clave:'inconformes', titulo:'Clientes GNP inconformes en la entrega (no se les pidió la encuesta)', quien:'ti', items: inconformes },
      { clave:'detenidas', titulo:'Unidades detenidas', quien:'quien indica el motivo', items: detenidas },
      { clave:'vencidas', titulo:'Entregas vencidas', quien:'Beto y Alejandra', items: vencidas },
      { clave:'listas', titulo:'Listas para iniciar y sin tocar', quien:'Beto', items: listas },
      { clave:'calidad', titulo:'Terminadas sin revisión de calidad (+1 día)', quien:'Beto', items: calidad },
      { clave:'avisos', titulo:'Clientes por avisar o sin aviso (+3 días)', quien:'Alejandra', items: sinAviso },
      { clave:'piezas', titulo:'Piezas vencidas', quien:'Daniela', items: piezas },
    ].filter(a => a.items.length);
  }

  const numeros = {
    por_valuar: porValuar.length,
    esperando: esperando.length,
    por_arrancar: porArrancar.length,
    alertas: alertas.reduce((n, a) => n + a.items.length, 0),
  };
  return { hoy, numeros, reautorizaciones, por_valuar: porValuar, esperando, por_arrancar: porArrancar, complementos, alertas,
    limite_complemento: LIMITE_COMPLEMENTO };
}

module.exports = { calcularInicioRoberto, LIMITE_COMPLEMENTO };
