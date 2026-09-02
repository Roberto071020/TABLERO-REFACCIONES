// Operaciones de la OT / etapas de producción (Documento Maestro, tablas 12 y 14 combinadas: mismos
// campos por operación — técnico/área, secuencia, horas, fechas, avance, bloqueo — así que es una sola
// entidad en vez de dos tablas paralelas para lo mismo).
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['beto','orlando','admin','jefe'];
const ESTADOS = ['programado','en_proceso','detenido','terminado'];
const CAUSAS_BLOQUEO = ['pieza_faltante','complemento_pendiente','capacidad','falla_equipo','ausencia','retrabajo'];

router.get('/', requireAuth, (req, res)=>{
  const { ot_id } = req.query;
  let sql = 'SELECT * FROM ot_operaciones WHERE 1=1';
  const params = [];
  if(ot_id){ sql += ' AND ot_id = ?'; params.push(ot_id); }
  sql += ' ORDER BY secuencia, id';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.ot_id) return res.status(400).json({ error:'La operación debe ligarse a una OT.' });
  const ot = db.prepare('SELECT id FROM ordenes_trabajo WHERE id = ?').get(b.ot_id);
  if(!ot) return res.status(400).json({ error:'La OT indicada no existe.' });
  if(!b.descripcion || !String(b.descripcion).trim()) return res.status(400).json({ error:'Describe la operación.' });
  if(b.causa_bloqueo && !CAUSAS_BLOQUEO.includes(b.causa_bloqueo)) return res.status(400).json({ error:'Causa de bloqueo inválida.' });

  const info = db.prepare(`INSERT INTO ot_operaciones (ot_id,descripcion,pieza,area,tecnico,secuencia,horas_estimadas,estado,fecha_inicio,fecha_fin_prevista,causa_bloqueo,siguiente_accion)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.ot_id, String(b.descripcion).trim(), b.pieza||'', b.area||'', b.tecnico||'', b.secuencia||null, b.horas_estimadas||null,
         ESTADOS.includes(b.estado)?b.estado:'programado', b.fecha_inicio||'', b.fecha_fin_prevista||'', b.causa_bloqueo||null, b.siguiente_accion||'');
  registrarAuditoria(db, { entidad_tipo:'ot_operacion', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:b.descripcion });
  res.status(201).json(db.prepare('SELECT * FROM ot_operaciones WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM ot_operaciones WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Operación no encontrada.' });
  const campos = ['descripcion','pieza','area','tecnico','secuencia','horas_estimadas','estado','fecha_inicio','fecha_fin_prevista','fecha_fin_real','avance','causa_bloqueo','siguiente_accion'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.estado && !ESTADOS.includes(nuevo.estado)) return res.status(400).json({ error:'Estado de operación inválido.' });
  if(nuevo.causa_bloqueo && !CAUSAS_BLOQUEO.includes(nuevo.causa_bloqueo)) return res.status(400).json({ error:'Causa de bloqueo inválida.' });
  // Sección 9: "no marcar como avance una mera reasignación o espera" — al menos exige que, si se marca
  // 'detenido', quede la causa; y si se marca 'terminado', el avance quede en 100.
  if(nuevo.estado === 'detenido' && !nuevo.causa_bloqueo){
    return res.status(400).json({ error:'Indica la causa de bloqueo al detener una operación.' });
  }
  // Fotos obligatorias por etapa (2-sep-2026, pedido de Roberto): las aseguradoras piden evidencia
  // fotográfica del proceso para pagar la factura, y cuando falta el taller termina reconstruyéndola al
  // final -- eso retrasa el cobro. Bloqueo duro: no se puede cerrar una operación sin al menos una foto
  // real ligada a ella (archivos.ot_operacion_id), subida en cualquier momento mientras estuvo abierta.
  if(nuevo.estado === 'terminado' && anterior.estado !== 'terminado'){
    const fotos = db.prepare('SELECT COUNT(*) n FROM archivos WHERE ot_operacion_id = ? AND eliminado = 0').get(req.params.id).n;
    if(fotos === 0){
      return res.status(409).json({ error:'Sube al menos una foto real de esta etapa antes de marcarla como terminada (la piden las aseguradoras para pagar la factura).' });
    }
  }
  if(nuevo.estado === 'terminado'){ nuevo.avance = 100; if(!nuevo.fecha_fin_real) nuevo.fecha_fin_real = new Date().toISOString().slice(0,10); }
  if(nuevo.avance !== undefined) nuevo.avance = Math.max(0, Math.min(100, Number(nuevo.avance)||0));

  db.prepare(`UPDATE ot_operaciones SET descripcion=?,pieza=?,area=?,tecnico=?,secuencia=?,horas_estimadas=?,estado=?,fecha_inicio=?,fecha_fin_prevista=?,fecha_fin_real=?,avance=?,causa_bloqueo=?,siguiente_accion=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.descripcion, nuevo.pieza, nuevo.area, nuevo.tecnico, nuevo.secuencia, nuevo.horas_estimadas, nuevo.estado, nuevo.fecha_inicio, nuevo.fecha_fin_prevista, nuevo.fecha_fin_real, nuevo.avance, nuevo.causa_bloqueo, nuevo.siguiente_accion, req.params.id);
  auditarCambios(db, { entidad_tipo:'ot_operacion', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(db.prepare('SELECT * FROM ot_operaciones WHERE id = ?').get(req.params.id));
});

module.exports = router;
