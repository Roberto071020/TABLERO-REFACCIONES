// Módulo Alejandra (Fase 3): catálogo de hitos obligatorios aplicado a cada expediente.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { registrarAuditoria } = require('../utils');
const router = express.Router();

const ESTADOS = ['pendiente','generado','revisado','enviado','no_aplica'];

// Aprovisiona (una sola vez) las filas de siniestro_hitos para un expediente, a partir del catálogo activo.
// Así, expedientes creados antes de esta fase quedan cubiertos automáticamente la primera vez que se consultan.
function asegurarHitos(siniestroId){
  const existentes = db.prepare('SELECT COUNT(*) c FROM siniestro_hitos WHERE siniestro_id=?').get(siniestroId).c;
  if(existentes > 0) return;
  const catalogo = db.prepare('SELECT id FROM catalogo_hitos WHERE activo=1 ORDER BY orden').all();
  const ins = db.prepare(`INSERT INTO siniestro_hitos (siniestro_id,hito_id,estado) VALUES (?,?,'pendiente')`);
  catalogo.forEach(h => ins.run(siniestroId, h.id));
}

router.get('/catalogo', requireAuth, (req, res)=>{
  res.json(db.prepare('SELECT * FROM catalogo_hitos WHERE activo=1 ORDER BY orden').all());
});

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  if(!siniestro_id) return res.status(400).json({ error:'Falta siniestro_id.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id=?').get(siniestro_id);
  if(!siniestro) return res.status(404).json({ error:'Expediente no encontrado.' });
  asegurarHitos(siniestro_id);
  const filas = db.prepare(`
    SELECT sh.*, ch.orden, ch.clave, ch.titulo, ch.descripcion as hito_descripcion, ch.condicional, u.nombre as responsable_nombre
    FROM siniestro_hitos sh
    JOIN catalogo_hitos ch ON ch.id = sh.hito_id
    LEFT JOIN usuarios u ON u.id = sh.responsable_id
    WHERE sh.siniestro_id = ?
    ORDER BY ch.orden`).all(siniestro_id);
  res.json(filas);
});

router.get('/:id', requireAuth, (req, res)=>{
  const fila = db.prepare(`
    SELECT sh.*, ch.orden, ch.clave, ch.titulo, ch.descripcion as hito_descripcion, ch.condicional, u.nombre as responsable_nombre
    FROM siniestro_hitos sh JOIN catalogo_hitos ch ON ch.id=sh.hito_id LEFT JOIN usuarios u ON u.id=sh.responsable_id
    WHERE sh.id=?`).get(req.params.id);
  if(!fila) return res.status(404).json({ error:'Hito no encontrado.' });
  res.json(fila);
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM siniestro_hitos WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Hito no encontrado.' });
  const { estado, motivo_no_aplica, mensaje } = req.body;
  if(!estado || !ESTADOS.includes(estado)) return res.status(400).json({ error:'Estado de hito inválido.' });
  if(estado === 'no_aplica' && (!motivo_no_aplica || !String(motivo_no_aplica).trim())){
    return res.status(400).json({ error:'Para marcar un hito como "no aplica" debes indicar el motivo.' });
  }
  if(estado === 'enviado' && (!mensaje || !String(mensaje).trim())){
    return res.status(400).json({ error:'Para marcar un hito como "enviado" debes registrar el mensaje que se envió al cliente (queda en la bitácora).' });
  }

  let eventoClienteId = anterior.evento_cliente_id;
  if(estado === 'enviado'){
    const catalogo = db.prepare('SELECT titulo FROM catalogo_hitos WHERE id=?').get(anterior.hito_id);
    const evento = db.prepare(`INSERT INTO eventos_cliente (siniestro_id,direccion,canal,tipo_evento,autor_id,mensaje)
      VALUES (?,?,?,?,?,?)`)
      .run(anterior.siniestro_id, 'saliente', 'WhatsApp', 'hito: ' + (catalogo ? catalogo.titulo : ''), req.session.user.id, String(mensaje).trim());
    eventoClienteId = evento.lastInsertRowid;
  }

  db.prepare(`UPDATE siniestro_hitos SET estado=?, motivo_no_aplica=?, fecha_estado=datetime('now'), responsable_id=?, evento_cliente_id=?, actualizado_en=datetime('now') WHERE id=?`)
    .run(estado, estado==='no_aplica' ? String(motivo_no_aplica).trim() : null, req.session.user.id, eventoClienteId, req.params.id);

  registrarAuditoria(db, { entidad_tipo:'siniestro_hito', entidad_id: req.params.id, accion:'edicion', campo:'estado',
    valor_anterior: anterior.estado, valor_nuevo: estado, usuario: req.session.user });

  // Módulo Alejandra (Fase 5): al confirmar el hito de "Entrega" como enviado, programar la postventa automáticamente (2-3 días después).
  if(estado === 'enviado' && anterior.estado !== 'enviado'){
    const claveHito = db.prepare('SELECT clave FROM catalogo_hitos WHERE id=?').get(anterior.hito_id);
    if(claveHito && claveHito.clave === 'entrega'){
      const fechaPostventa = new Date(Date.now() + 3*86400000).toISOString().slice(0,10);
      db.prepare("UPDATE siniestros SET postventa_programada=?, actualizado_en=datetime('now') WHERE id=?").run(fechaPostventa, anterior.siniestro_id);
      const yaExiste = db.prepare(`SELECT id FROM tareas WHERE siniestro_id=? AND disparador='entrega_confirmada' AND estado IN ('pendiente','en_proceso')`).get(anterior.siniestro_id);
      if(!yaExiste){
        db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,responsable_id,fecha_limite,estado,origen,disparador,creado_por)
          VALUES (?,?,?,?,?,'pendiente','automatica','entrega_confirmada',?)`)
          .run(anterior.siniestro_id, 'mensaje', 'Seguimiento postventa: confirmar con el cliente que todo esté bien.',
               req.session.user.id, fechaPostventa, req.session.user.id);
      }
    }
  }

  res.json(db.prepare(`
    SELECT sh.*, ch.orden, ch.clave, ch.titulo, ch.descripcion as hito_descripcion, ch.condicional, u.nombre as responsable_nombre
    FROM siniestro_hitos sh JOIN catalogo_hitos ch ON ch.id=sh.hito_id LEFT JOIN usuarios u ON u.id=sh.responsable_id
    WHERE sh.id=?`).get(req.params.id));
});

module.exports = router;
