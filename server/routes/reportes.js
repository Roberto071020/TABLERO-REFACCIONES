const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { csvCell, csvTextForced, toLocal } = require('../utils');
const router = express.Router();

const CERRADAS = ['Recibida físicamente','Cancelada'];

// F-05: la lista maestra parte de PEDIDOS (no de piezas), así un pedido sin piezas capturadas sigue siendo visible.
function obtenerFilasListaMaestra({ aseguradora, estatus, proveedor_id, q }){
  let sql = `SELECT p.id as pedido_id, p.numero as pedido_numero, p.estatus_operativo, p.fecha_prevista as pedido_fecha_prevista,
                    s.id as siniestro_id, s.numero as siniestro_numero, s.aseguradora, s.vehiculo, s.placas,
                    z.id as pieza_id, z.descripcion, z.estatus as pieza_estatus, z.fecha_prometida, z.proveedor_id,
                    pv.razon_social as proveedor_nombre
             FROM pedidos p
             JOIN siniestros s ON s.id = p.siniestro_id
             LEFT JOIN piezas z ON z.pedido_id = p.id
             LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
             WHERE 1=1`;
  const params = [];
  if(aseguradora){ sql += ' AND s.aseguradora = ?'; params.push(aseguradora); }
  if(proveedor_id){ sql += ' AND z.proveedor_id = ?'; params.push(proveedor_id); }
  if(estatus){ sql += ' AND z.estatus = ?'; params.push(estatus); }
  if(q){
    sql += ' AND (s.numero LIKE ? OR p.numero LIKE ? OR z.descripcion LIKE ? OR s.placas LIKE ? OR s.vehiculo LIKE ?)';
    const like = `%${q}%`; params.push(like,like,like,like,like);
  }
  sql += ' ORDER BY z.fecha_prometida IS NULL, z.fecha_prometida ASC';
  return db.prepare(sql).all(...params);
}

router.get('/lista-maestra', requireAuth, (req, res)=>{
  res.json(obtenerFilasListaMaestra(req.query));
});

// F-16 + F-17: exporta EXACTAMENTE lo que se ve filtrado (incluida la búsqueda de texto) y neutraliza fórmulas/inyección CSV.
router.get('/lista-maestra.csv', requireAuth, (req, res)=>{
  const filas = obtenerFilasListaMaestra(req.query);
  const header = ['Siniestro','Aseguradora','Pedido','Proveedor','Pieza','Estatus','Fecha prometida'];
  const lines = [header.map(csvCell).join(',')];
  filas.forEach(f=>{
    lines.push([
      csvTextForced(f.siniestro_numero),
      csvCell(f.aseguradora),
      csvTextForced(f.pedido_numero),
      csvCell(f.proveedor_nombre || ''),
      csvCell(f.descripcion || 'Pendiente de capturar piezas'),
      csvCell(f.pieza_estatus || 'Sin piezas'),
      csvCell(f.fecha_prometida || '')
    ].join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lista_maestra_refacciones.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

router.get('/resumen', requireAuth, (req, res)=>{
  const hoy = new Date().toISOString().slice(0,10);
  const pedidosNuevos = db.prepare(`SELECT COUNT(*) n FROM pedidos WHERE estatus_operativo='Nuevo'`).get().n;
  const piezasVencidas = db.prepare(`SELECT COUNT(*) n FROM piezas WHERE estatus NOT IN ('Recibida físicamente','Cancelada') AND fecha_prometida != '' AND fecha_prometida < ?`).get(hoy).n;
  const sinProveedor = db.prepare(`SELECT COUNT(*) n FROM piezas WHERE estatus='Sin proveedor'`).get().n;
  const recibidosParciales = db.prepare(`SELECT COUNT(*) n FROM pedidos WHERE estatus_operativo='Recibido parcial'`).get().n;
  const correosPendientes = db.prepare(`SELECT COUNT(*) n FROM comunicaciones WHERE respuesta_texto IS NULL`).get().n;
  const cierresHoy = db.prepare(`SELECT COUNT(*) n FROM piezas WHERE fecha_recepcion LIKE ?`).get(hoy+'%').n;
  const incidenciasAbiertas = db.prepare(`SELECT COUNT(*) n FROM incidencias WHERE estado IN ('abierta','en_proceso')`).get().n;
  const pendientesCompletar = db.prepare(`SELECT COUNT(*) n FROM siniestros WHERE completo = 0`).get().n;
  const porAseguradora = db.prepare(`SELECT s.aseguradora, COUNT(DISTINCT p.id) abiertos FROM pedidos p JOIN siniestros s ON s.id=p.siniestro_id WHERE p.estatus_operativo NOT IN ('Cerrado') GROUP BY s.aseguradora`).all();
  res.json({ pedidosNuevos, piezasVencidas, sinProveedor, recibidosParciales, correosPendientes, cierresHoy, incidenciasAbiertas, pendientesCompletar, porAseguradora });
});

// F-20: la búsqueda global regresa una LISTA de coincidencias agrupadas, no abre automáticamente la primera.
router.get('/buscar', requireAuth, (req, res)=>{
  const q = String(req.query.q||'').trim();
  if(!q) return res.json({ siniestros:[], pedidos:[], proveedores:[] });
  const like = `%${q}%`;
  const siniestros = db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas FROM siniestros WHERE numero LIKE ? OR placas LIKE ? OR vehiculo LIKE ? LIMIT 20`).all(like,like,like);
  const pedidos = db.prepare(`SELECT p.id, p.numero, s.numero as siniestro_numero, s.id as siniestro_id FROM pedidos p JOIN siniestros s ON s.id=p.siniestro_id WHERE p.numero LIKE ? LIMIT 20`).all(like);
  const proveedores = db.prepare(`SELECT id, razon_social, correo FROM proveedores WHERE razon_social LIKE ? LIMIT 20`).all(like);
  res.json({ siniestros, pedidos, proveedores, tipoDetectado: /^018.*A$/i.test(q) ? 'siniestro (regla R-02)' : 'pedido/otro' });
});


// Vista enriquecida para el Kanban: todos los pedidos (F-03: ningún estatus se excluye) con resumen de piezas.
router.get('/kanban', requireAuth, (req, res)=>{
  const pedidos = db.prepare(`SELECT p.*, s.numero as siniestro_numero, s.aseguradora, s.vehiculo, s.id as siniestro_id
                               FROM pedidos p JOIN siniestros s ON s.id = p.siniestro_id ORDER BY p.creado_en DESC`).all();
  const hoy = new Date().toISOString().slice(0,10);
  const out = pedidos.map(p=>{
    const piezas = db.prepare('SELECT z.*, pv.razon_social as proveedor_nombre FROM piezas z LEFT JOIN proveedores pv ON pv.id = z.proveedor_id WHERE z.pedido_id = ?').all(p.id);
    const pendientes = piezas.filter(z => !CERRADAS.includes(z.estatus));
    const vencidas = pendientes.filter(z => z.fecha_prometida && z.fecha_prometida < hoy);
    const proveedores = [...new Set(piezas.map(z=>z.proveedor_nombre).filter(Boolean))];
    const incidenciasAbiertas = db.prepare(`SELECT COUNT(*) n FROM incidencias i JOIN piezas z ON z.id=i.pieza_id WHERE z.pedido_id=? AND i.estado IN ('abierta','en_proceso')`).get(p.id).n;
    return { ...p, totalPiezas: piezas.length, pendientes: pendientes.length, vencidas: vencidas.length, proveedores, incidenciasAbiertas };
  });
  res.json(out);
});

module.exports = router;
