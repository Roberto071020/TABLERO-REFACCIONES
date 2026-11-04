// Cálculo del panorama de Beto, extraído de server/routes/reportes.js (4-nov-2026) para que lo reutilice
// también el "Reporte de arranque del día" (server/reporteArranque.js) sin duplicar la lógica de prioridades.
// La ruta GET /api/reportes/panorama-beto regresa exactamente lo mismo que antes.
const { porcentajePiezasRecibidas } = require('./utils');

function calcularPanoramaBeto(db){
  const hoy = new Date().toISOString().slice(0,10);
  const manana = new Date(Date.now()+86400000).toISOString().slice(0,10);
  const siniestros = db.prepare(`SELECT * FROM siniestros WHERE archivado=0 AND estado_autorizacion IN ('autorizada','parcial')
    AND (estado_produccion IS NULL OR estado_produccion != 'terminado') ORDER BY creado_en DESC`).all();

  const out = siniestros.map(s=>{
    const ots = db.prepare(`SELECT * FROM ordenes_trabajo WHERE siniestro_id = ? ORDER BY creado_en DESC`).all(s.id);
    const otMasReciente = ots[0] || null;
    let otRapidaSinTocar = false;
    if(otMasReciente){
      const ops = db.prepare(`SELECT estado FROM ot_operaciones WHERE ot_id = ?`).all(otMasReciente.id);
      otRapidaSinTocar = ops.length > 0 && ops.length <= 2 && ops.every(o => o.estado === 'programado');
    }
    const pedidos = db.prepare(`SELECT id FROM pedidos WHERE siniestro_id = ?`).all(s.id);
    let refaccionesCompletas = s.requiere_refacciones !== 'si';
    if(!refaccionesCompletas && pedidos.length){
      refaccionesCompletas = pedidos.every(p=>{
        const piezas = db.prepare(`SELECT estatus FROM piezas WHERE pedido_id = ?`).all(p.id);
        return piezas.length > 0 && piezas.every(z => z.estatus === 'Recibida físicamente');
      });
    }
    // Modificación 1 (Modificaciones_Tablero_SC_Control.docx): aviso de "listo para iniciar" en cuanto
    // haya piezas SUFICIENTES, aunque el expediente no esté 100% completo. No existe un catálogo de qué
    // pieza es "crítica" para arrancar, así que se usa una señal objetiva: 80%+ de las piezas del
    // expediente ya recibidas físicamente (sin llegar al 100% que ya cubre refaccionesCompletas arriba).
    const pctPiezas = s.requiere_refacciones === 'si' ? porcentajePiezasRecibidas(db, s.id) : null;
    const piezasSuficientes = !refaccionesCompletas && pctPiezas !== null && pctPiezas >= 0.8;
    const enPiso = !s.estado_produccion || s.estado_produccion === 'programado';
    const vencidaOProxima = s.fecha_entrega_prevista && (s.fecha_entrega_prevista <= manana);
    // Modificación 1(a): "reingreso citado con fecha de entrega" separado de "unidad en piso" -- hoy
    // Beto no distingue entre una unidad que ya está físicamente en el taller (fecha_admision capturada)
    // y una que solo tiene cita agendada para reingresar (circulando, todavía no llega).
    const reingresoCitado = s.ingreso_tipo === 'circulando' && s.cita_fecha && !s.fecha_admision;
    const situacion = reingresoCitado ? 'reingreso_citado' : (s.fecha_admision ? 'en_piso' : (enPiso ? 'en_piso' : 'en_proceso'));
    const diasEnTaller = s.creado_en ? Math.floor((Date.now() - new Date(s.creado_en.replace(' ','T')+'Z').getTime()) / 86400000) : null;

    let prioridad = 4, motivo = 'En proceso normal, dentro de fecha.';
    if(vencidaOProxima){ prioridad = 1; motivo = s.fecha_entrega_prevista < hoy ? 'Vencida.' : 'Vence hoy o mañana.'; }
    else if(otRapidaSinTocar){ prioridad = 2; motivo = 'Reparación rápida recién asignable, sin tocar.'; }
    else if(enPiso && refaccionesCompletas){ prioridad = 3; motivo = 'Lista para iniciar: refacciones completas.'; }
    else if(enPiso && piezasSuficientes){ prioridad = 3.5; motivo = `Piezas suficientes recibidas (${Math.round(pctPiezas*100)}%), aunque no esté al 100%.`; }

    return { id:s.id, numero:s.numero, vehiculo:s.vehiculo, placas:s.placas, aseguradora:s.aseguradora,
      fecha_entrega_prevista:s.fecha_entrega_prevista, estado_produccion:s.estado_produccion,
      entrega_compromiso_gnp: !!s.entrega_compromiso_gnp,
      ot_numero: otMasReciente ? otMasReciente.numero : null, prioridad, motivo,
      situacion, reingreso_citado: !!reingresoCitado, dias_en_taller: diasEnTaller };
  });

  // Modificación 1(c): orden por antigüedad/urgencia en vez de solo el orden físico en que llegan las
  // hojas -- dentro de la misma prioridad y fecha promesa, gana el expediente más antiguo (más días en
  // taller esperando), para que no se quede debajo del montón.
  out.sort((a,b)=> a.prioridad - b.prioridad || (a.fecha_entrega_prevista||'9999').localeCompare(b.fecha_entrega_prevista||'9999') || (b.dias_en_taller||0) - (a.dias_en_taller||0));
  return out;
}

module.exports = { calcularPanoramaBeto };
