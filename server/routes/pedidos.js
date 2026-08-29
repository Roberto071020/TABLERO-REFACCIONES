const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria, auditarCambios, verificarRefaccionesCompletas, crearTareaFechaPromesaModificada, prepararCorreoPedidoNuevo, sincronizarPiezasConEstatusPedido } = require('../utils');
const router = express.Router();

const ESTATUS_OPERATIVO = ['Nuevo','Por revisar','Esperando proveedor','En tránsito','Entrega vencida','Recibido parcial','Recibido completo','Con incidencia','Cancelado','Cerrado'];

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id, estatus_operativo, aseguradora } = req.query;
  let sql = 'SELECT * FROM pedidos WHERE 1=1';
  const params = [];
  if(siniestro_id){ sql += ' AND siniestro_id = ?'; params.push(siniestro_id); }
  if(estatus_operativo){ sql += ' AND estatus_operativo = ?'; params.push(estatus_operativo); }
  if(aseguradora){ sql += ' AND aseguradora = ?'; params.push(aseguradora); }
  sql += ' ORDER BY creado_en DESC';
  // F-03: este endpoint NUNCA excluye estatus por defecto — el Kanban debe pintar TODOS los estatus, incluidos
  // 'Con incidencia', 'Entrega vencida' y 'Cancelado', para que un pedido jamás desaparezca de la vista.
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requireAuth, (req, res)=>{
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if(!p) return res.status(404).json({ error:'Pedido no encontrado.' });
  res.json(p);
});

router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.numero || !String(b.numero).trim()) return res.status(400).json({ error:'El número de pedido es obligatorio.' });
  if(!b.siniestro_id) return res.status(400).json({ error:'El pedido debe ligarse a un siniestro.' });
  if(!b.fecha_prevista || !String(b.fecha_prevista).trim()) return res.status(400).json({ error:'La fecha promesa (Inpart) es obligatoria en todo pedido.' });
  const siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El siniestro indicado no existe.' });
  const existente = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(String(b.numero).trim());
  if(existente) return res.status(409).json({ error:'Ya existe un pedido con ese número (no se crean duplicados).', duplicado: existente });

  const fechaCreacion = b.fecha_creacion || new Date().toISOString().slice(0,10);
  const hoy = new Date().toISOString().slice(0,10);
  const advertencias = [];
  // Hallazgo A-05: una fecha prevista de hoy o anterior casi siempre es un error de captura (Inpart la reporta
  // a futuro). Se bloquea y se pide confirmación explícita en vez de dejarla pasar silenciosamente.
  if(b.fecha_prevista && b.fecha_prevista <= hoy && !b.confirmar_fecha_prevista){
    return res.status(409).json({ error:'FECHA_PREVISTA_INVALIDA', mensaje:`La fecha prevista (${b.fecha_prevista}) es hoy o anterior. Confírmala si es correcta.` });
  }
  if(b.fecha_prevista && b.fecha_prevista <= fechaCreacion) advertencias.push('La fecha prevista es igual o anterior a la fecha de alta; verifícala.');
  const confirmadaPor = (b.fecha_prevista && b.fecha_prevista <= hoy && b.confirmar_fecha_prevista) ? req.session.user.nombre : null;

  const info = db.prepare(`INSERT INTO pedidos (numero,cotizacion,siniestro_id,aseguradora,fecha_creacion,fecha_prevista,estatus_inpart,total,tipo_evaluacion,estatus_operativo,creado_por,fecha_prevista_confirmada_por,estatus_inpart_actualizado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(b.numero).trim(), b.cotizacion||'', b.siniestro_id, b.aseguradora||siniestro.aseguradora, fechaCreacion, b.fecha_prevista||'',
         b.estatus_inpart||'Aguardando confirmación', b.total||0, b.tipo_evaluacion||'Inicial', 'Nuevo', req.session.user.id, confirmadaPor, new Date().toISOString().replace('T',' ').slice(0,19));
  registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:`Pedido ${b.numero} (siniestro ${siniestro.numero})` });

  // Módulo Alejandra (Fase 1): si el expediente maestro todavía no tenía definido si requiere refacciones,
  // el primer pedido que Daniela crea sobre él lo confirma automáticamente. Queda auditado como cualquier otro cambio.
  if(siniestro.requiere_refacciones === 'por_definir'){
    db.prepare("UPDATE siniestros SET requiere_refacciones='si', actualizado_en=datetime('now') WHERE id=?").run(siniestro.id);
    registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: siniestro.id, accion:'automatico', campo:'requiere_refacciones',
      valor_anterior:'por_definir', valor_nuevo:'si', usuario:req.session.user });
  }

  // Requerimiento de Daniela: preparar correo en cuanto se detecta un pedido nuevo (aunque no llegue notificación de Inpart).
  prepararCorreoPedidoNuevo(db, { pedido: db.prepare('SELECT * FROM pedidos WHERE id = ?').get(info.lastInsertRowid), siniestro });

  const creado = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...creado, advertencias });
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Pedido no encontrado.' });
  if(req.body.estatus_operativo && !ESTATUS_OPERATIVO.includes(req.body.estatus_operativo)){
    return res.status(400).json({ error:'Estatus operativo inválido.' });
  }
  const campos = ['cotizacion','aseguradora','fecha_creacion','fecha_prevista','estatus_inpart','total','tipo_evaluacion','estatus_operativo','motivo_cancelacion'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  // Requerimiento de Daniela: los pedidos cancelados deben conservar su motivo.
  if(nuevo.estatus_operativo === 'Cancelado' && (!nuevo.motivo_cancelacion || !String(nuevo.motivo_cancelacion).trim())){
    return res.status(400).json({ error:'Para cancelar un pedido debes indicar el motivo (reasignación de proveedor, pérdida total, unidad que no repara u otro).' });
  }
  // Hallazgo A-05: si cambian la fecha prevista a hoy o antes, exigir confirmación explícita.
  const hoyPatch = new Date().toISOString().slice(0,10);
  let confirmadaPorPatch = anterior.fecha_prevista_confirmada_por;
  if(nuevo.fecha_prevista && nuevo.fecha_prevista !== anterior.fecha_prevista && nuevo.fecha_prevista <= hoyPatch){
    if(!req.body.confirmar_fecha_prevista){
      return res.status(409).json({ error:'FECHA_PREVISTA_INVALIDA', mensaje:`La fecha prevista (${nuevo.fecha_prevista}) es hoy o anterior. Confírmala si es correcta.` });
    }
    confirmadaPorPatch = req.session.user.nombre;
  } else if(nuevo.fecha_prevista && nuevo.fecha_prevista !== anterior.fecha_prevista){
    confirmadaPorPatch = null;
  }
  // C-04 (parcial): estatus_inpart_actualizado_en solo se toca cuando estatus_inpart específicamente cambió.
  const estatusInpartActualizadoEn = (nuevo.estatus_inpart !== anterior.estatus_inpart) ? new Date().toISOString().replace('T',' ').slice(0,19) : anterior.estatus_inpart_actualizado_en;
  db.prepare(`UPDATE pedidos SET cotizacion=?,aseguradora=?,fecha_creacion=?,fecha_prevista=?,estatus_inpart=?,total=?,tipo_evaluacion=?,estatus_operativo=?,motivo_cancelacion=?,fecha_prevista_confirmada_por=?,estatus_inpart_actualizado_en=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.cotizacion, nuevo.aseguradora, nuevo.fecha_creacion, nuevo.fecha_prevista, nuevo.estatus_inpart, nuevo.total, nuevo.tipo_evaluacion, nuevo.estatus_operativo, nuevo.motivo_cancelacion, confirmadaPorPatch, estatusInpartActualizadoEn, req.params.id);
  auditarCambios(db, { entidad_tipo:'pedido', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });

  // Hallazgo A-07 (Informe Daniela): si el estatus cambió y vino con un motivo explícito, se registra
  // como su propia entrada de auditoría (queda visible en la línea de tiempo del expediente).
  if(nuevo.estatus_operativo !== anterior.estatus_operativo && req.body.motivo_estatus && String(req.body.motivo_estatus).trim()){
    registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id:req.params.id, accion:'cambio_estatus_motivo', campo:'motivo_estatus',
      valor_anterior: anterior.estatus_operativo, valor_nuevo: `${anterior.estatus_operativo} -> ${nuevo.estatus_operativo}: ${String(req.body.motivo_estatus).trim()}`,
      usuario: req.session.user });
  }

  // Módulo Alejandra (Fase 5): automatizaciones cruzadas.
  if(nuevo.fecha_prevista && nuevo.fecha_prevista !== anterior.fecha_prevista){
    crearTareaFechaPromesaModificada(db, { siniestroId: anterior.siniestro_id, pedidoNumero: anterior.numero,
      fechaAnterior: anterior.fecha_prevista, fechaNueva: nuevo.fecha_prevista, usuario: req.session.user });
  }
  if(nuevo.estatus_operativo !== anterior.estatus_operativo){
    verificarRefaccionesCompletas(db, anterior.siniestro_id, req.session.user);
    // Roberto (29-ago-2026): si el pedido quedó Recibido completo/Cancelado por edición manual, sus
    // piezas todavía abiertas se sincronizan al instante (el barrido de /resumen es el respaldo, pero
    // no hay que esperar a la próxima carga del tablero para que se refleje).
    sincronizarPiezasConEstatusPedido(db, req.params.id, req.session.user);
  }

  res.json(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id));
});

module.exports = router;
