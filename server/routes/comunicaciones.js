const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria } = require('../utils');
const router = express.Router();

const CC_GNP = 'cristian.hernandezortiz@gnp.com.mx, luis.ramirezalvarez@gnp.com.mx, roveytia@hotmail.com';
const CERRADAS = ['Recibida físicamente','Cancelada'];

// F-13: plantillas de correo distintas según el tipo de incidencia (antes era un único mensaje genérico de estatus).
function construirCuerpo(tipoPlantilla, { siniestroNumero, pedidoNumero, piezasPendientes, piezasIncidencia }){
  const lista = piezasPendientes.map(p=>'- '+p).join('\n');
  const listaInc = (piezasIncidencia||[]).map(p=>'- '+p).join('\n');
  const firma = '\n\nSaludos,\nDaniela Sosa\nRefacciones';
  if(tipoPlantilla === 'incidencia' && piezasIncidencia && piezasIncidencia.length){
    return `Buen día.\n\nLes escribo respecto al siniestro ${siniestroNumero}, pedido ${pedidoNumero}. Las siguientes piezas presentaron una incidencia (incorrecta, dañada o incompleta) y requieren atención:\n\n${listaInc}\n\n¿Nos podrían apoyar con el cambio, recolección o solución correspondiente, indicando fecha compromiso? Quedo atenta.${firma}`;
  }
  if(tipoPlantilla === 'retraso'){
    return `Buen día.\n\nLa fecha prometida para las siguientes piezas del siniestro ${siniestroNumero}, pedido ${pedidoNumero}, ya se cumplió sin que hayan llegado:\n\n${lista}\n\n¿Nos podrían confirmar la nueva fecha estimada de entrega? Agradezco su apoyo.${firma}`;
  }
  return `Buen día.\n\n¿Nos podrían apoyar confirmando el estatus actualizado y la fecha estimada de entrega de las siguientes piezas correspondientes al siniestro ${siniestroNumero}, pedido ${pedidoNumero}?\n\n${lista}\n\nAgradezco de antemano su apoyo. Quedo atenta a sus comentarios.${firma}`;
}

// Genera un BORRADOR (no persiste nada) agrupado por proveedor, aplicando R-03/R-04/R-05/R-06/R-08/R-13.
router.get('/generar-borrador/:pedidoId', requireAuth, (req, res)=>{
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.pedidoId);
  if(!pedido) return res.status(404).json({ error:'Pedido no encontrado.' });
  const siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(pedido.siniestro_id);
  const piezas = db.prepare('SELECT * FROM piezas WHERE pedido_id = ?').all(pedido.id);
  const pendientes = piezas.filter(z => !CERRADAS.includes(z.estatus)); // R-04: excluye recibidas/canceladas

  if(pendientes.length === 0){
    return res.json({ requiereCorreo:false, mensaje:'Todas las piezas del pedido están recibidas o canceladas (regla R-05).' });
  }

  const porProveedor = {};
  pendientes.forEach(z=>{
    const key = z.proveedor_id || 'sin';
    (porProveedor[key] = porProveedor[key] || []).push(z);
  });

  const borradores = Object.entries(porProveedor).map(([provKey, lista])=>{
    const proveedor = provKey === 'sin' ? null : db.prepare('SELECT * FROM proveedores WHERE id = ?').get(provKey);
    const incidenciasAbiertas = db.prepare(`SELECT i.* FROM incidencias i WHERE i.pieza_id IN (${lista.map(()=>'?').join(',') || 'NULL'}) AND i.estado IN ('abierta','en_proceso')`).all(...lista.map(z=>z.id));
    const tipoPlantilla = incidenciasAbiertas.length ? 'incidencia' : 'estatus';
    const cuerpo = construirCuerpo(tipoPlantilla, {
      siniestroNumero: siniestro.numero, pedidoNumero: pedido.numero,
      piezasPendientes: lista.map(z=>z.descripcion),
      piezasIncidencia: lista.filter(z=>incidenciasAbiertas.some(i=>i.pieza_id===z.id)).map(z=>z.descripcion)
    });
    return {
      proveedor_id: proveedor ? proveedor.id : null,
      proveedor_nombre: proveedor ? proveedor.razon_social : '(sin proveedor asignado)',
      destinatario: proveedor ? proveedor.correo : '',
      copia: siniestro.aseguradora === 'GNP' ? CC_GNP : '', // R-08
      asunto: `SINIESTRO ${siniestro.numero} - PEDIDO ${pedido.numero}`,
      tipo_plantilla: tipoPlantilla,
      cuerpo,
      piezas: lista.map(z=>({ id:z.id, descripcion:z.descripcion }))
    };
  });

  res.json({ requiereCorreo:true, borradores });
});

// Aprobar y registrar (F-15: guarda proveedor_id explícito, evitando el cruce entre proveedores del reporte).
router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.pedido_id) return res.status(400).json({ error:'Falta pedido_id.' });
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(b.pedido_id);
  if(!pedido) return res.status(400).json({ error:'Pedido no encontrado.' });
  if(!b.destinatarios) return res.status(400).json({ error:'El destinatario es obligatorio.' });
  const info = db.prepare(`INSERT INTO comunicaciones (pedido_id,siniestro_id,proveedor_id,canal,asunto,destinatarios,copia,cuerpo,tipo_plantilla,enviado_por)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(b.pedido_id, pedido.siniestro_id, b.proveedor_id||null, b.canal||'Correo', b.asunto||'', b.destinatarios, b.copia||'', b.cuerpo||'', b.tipo_plantilla||'estatus', req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'comunicacion', entidad_id: info.lastInsertRowid, accion:'correo_aprobado', usuario:req.session.user, valor_nuevo:`Asunto: ${b.asunto} (modo borrador/sandbox, no se envía automáticamente)` });
  res.status(201).json(db.prepare('SELECT * FROM comunicaciones WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/', requireAuth, (req, res)=>{
  const { pedido_id, siniestro_id, proveedor_id } = req.query;
  let sql = 'SELECT * FROM comunicaciones WHERE 1=1'; const params=[];
  if(pedido_id){ sql += ' AND pedido_id=?'; params.push(pedido_id); }
  if(siniestro_id){ sql += ' AND siniestro_id=?'; params.push(siniestro_id); }
  if(proveedor_id){ sql += ' AND proveedor_id=?'; params.push(proveedor_id); }
  sql += ' ORDER BY fecha_envio DESC';
  res.json(db.prepare(sql).all(...params));
});

// F-12: registrar la respuesta real del proveedor.
router.patch('/:id/respuesta', requireAuth, (req, res)=>{
  const com = db.prepare('SELECT * FROM comunicaciones WHERE id = ?').get(req.params.id);
  if(!com) return res.status(404).json({ error:'Comunicación no encontrada.' });
  const { respuesta_texto, compromiso_fecha, siguiente_seguimiento } = req.body;
  if(!respuesta_texto) return res.status(400).json({ error:'Describe la respuesta del proveedor.' });
  db.prepare(`UPDATE comunicaciones SET respuesta_texto=?, respuesta_fecha=datetime('now'), compromiso_fecha=?, siguiente_seguimiento=? WHERE id=?`)
    .run(respuesta_texto, compromiso_fecha||'', siguiente_seguimiento||'', req.params.id);
  registrarAuditoria(db, { entidad_tipo:'comunicacion', entidad_id:req.params.id, accion:'respuesta_registrada', usuario:req.session.user, valor_nuevo:respuesta_texto });
  res.json(db.prepare('SELECT * FROM comunicaciones WHERE id = ?').get(req.params.id));
});

// R-07/F-14: exclusión SOLO temporal, por pedido y envío específico, con motivo obligatorio. No bloquea al proveedor.
router.post('/exclusiones', requireAuth, (req, res)=>{
  const { pedido_id, proveedor_id, motivo } = req.body;
  if(!pedido_id || !motivo) return res.status(400).json({ error:'pedido_id y motivo son obligatorios.' });
  const info = db.prepare(`INSERT INTO exclusiones_envio (pedido_id,proveedor_id,motivo,usuario_id) VALUES (?,?,?,?)`)
    .run(pedido_id, proveedor_id||null, motivo, req.session.user.id);
  registrarAuditoria(db, { entidad_tipo:'exclusion_envio', entidad_id: info.lastInsertRowid, accion:'exclusion_temporal', usuario:req.session.user, valor_nuevo:motivo });
  res.status(201).json({ ok:true, id: info.lastInsertRowid });
});

module.exports = router;
