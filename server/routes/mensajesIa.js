// Módulo Alejandra (Fase 4): IA como copiloto. No se conecta ninguna API de IA todavía —
// el sistema arma un contexto verificado con los datos vigentes del expediente para que Alejandra
// lo copie a su ChatGPT actual, y guarda el borrador que ella pegue de vuelta. El envío es siempre manual.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const router = express.Router();

function construirContexto(siniestroId, hitoId){
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(siniestroId);
  if(!s) return null;

  const hitos = db.prepare(`
    SELECT sh.*, ch.orden, ch.titulo FROM siniestro_hitos sh JOIN catalogo_hitos ch ON ch.id=sh.hito_id
    WHERE sh.siniestro_id=? ORDER BY ch.orden`).all(siniestroId);
  const hitoObjetivo = hitoId ? hitos.find(h => h.hito_id == hitoId) : null;
  const ultimosEnviados = hitos.filter(h => h.estado === 'enviado').slice(-3);
  const pendientes = hitos.filter(h => !['enviado','no_aplica'].includes(h.estado)).slice(0,5);

  const comunicaciones = db.prepare('SELECT * FROM eventos_cliente WHERE siniestro_id=? ORDER BY creado_en DESC LIMIT 5').all(siniestroId);
  const tareas = db.prepare("SELECT * FROM tareas WHERE siniestro_id=? AND estado IN ('pendiente','en_proceso') ORDER BY fecha_limite ASC").all(siniestroId);

  const lineas = [];
  lineas.push('=== DATOS DEL EXPEDIENTE (usa SOLO esta información, no inventes nada más) ===');
  lineas.push(`Cliente: ${s.cliente_nombre || '(sin registrar)'}`);
  lineas.push(`Teléfono: ${s.cliente_telefono || '(sin registrar)'}`);
  lineas.push(`Siniestro: ${s.numero} · Aseguradora: ${s.aseguradora}`);
  lineas.push(`Vehículo: ${s.vehiculo || '(sin registrar)'} ${s.placas ? '· Placas ' + s.placas : ''}`);
  lineas.push(`Orden de admisión: ${s.orden_admision || '(sin registrar)'}`);
  lineas.push(`Etapa actual: ${s.etapa_actual || '(sin registrar)'}`);
  lineas.push(`¿Requiere refacciones?: ${ {si:'Sí', no:'No', por_definir:'Aún por definir'}[s.requiere_refacciones] || s.requiere_refacciones }`);
  if(s.fecha_entrega_prevista) lineas.push(`Fecha de entrega prevista: ${s.fecha_entrega_prevista}`);

  if(hitoObjetivo){
    lineas.push('');
    lineas.push(`=== HITO A COMUNICAR: ${hitoObjetivo.titulo} ===`);
  }
  if(ultimosEnviados.length){
    lineas.push('');
    lineas.push('=== ÚLTIMOS HITOS YA COMUNICADOS AL CLIENTE ===');
    ultimosEnviados.forEach(h => lineas.push(`- ${h.titulo} (${h.fecha_estado || ''})`));
  }
  if(pendientes.length){
    lineas.push('');
    lineas.push('=== HITOS TODAVÍA PENDIENTES (no afirmes que ya pasaron) ===');
    pendientes.forEach(h => lineas.push(`- ${h.titulo} [${h.estado}]`));
  }
  if(comunicaciones.length){
    lineas.push('');
    lineas.push('=== ÚLTIMAS COMUNICACIONES CON EL CLIENTE ===');
    comunicaciones.forEach(c => lineas.push(`- (${c.creado_en}, ${c.direccion}) ${c.mensaje}`));
  }
  if(tareas.length){
    lineas.push('');
    lineas.push('=== TAREAS PENDIENTES DEL EQUIPO ===');
    tareas.forEach(t => lineas.push(`- ${t.descripcion}${t.fecha_limite ? ' (límite ' + t.fecha_limite + ')' : ''}`));
  }
  lineas.push('');
  lineas.push('=== INSTRUCCIONES PARA LA IA ===');
  lineas.push('Redacta un mensaje breve y amable de WhatsApp para el cliente, usando ÚNICAMENTE los datos de arriba.');
  lineas.push('No inventes fechas, autorizaciones, precios ni promesas que no aparezcan en esta información.');
  lineas.push('Si falta algún dato importante para redactar el mensaje, dilo explícitamente en vez de suponerlo.');

  return lineas.join('\n');
}

router.get('/contexto', requireAuth, (req, res)=>{
  const { siniestro_id, hito_id } = req.query;
  if(!siniestro_id) return res.status(400).json({ error:'Falta siniestro_id.' });
  const texto = construirContexto(siniestro_id, hito_id);
  if(texto === null) return res.status(404).json({ error:'Expediente no encontrado.' });
  res.json({ texto });
});

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id } = req.query;
  if(!siniestro_id) return res.status(400).json({ error:'Falta siniestro_id.' });
  const filas = db.prepare(`
    SELECT m.*, ch.titulo as hito_titulo, u1.nombre as generado_por_nombre, u2.nombre as aprobado_por_nombre
    FROM mensajes_ia m
    LEFT JOIN catalogo_hitos ch ON ch.id = m.hito_id
    LEFT JOIN usuarios u1 ON u1.id = m.generado_por
    LEFT JOIN usuarios u2 ON u2.id = m.aprobado_por
    WHERE m.siniestro_id = ? ORDER BY m.generado_en DESC`).all(siniestro_id);
  res.json(filas);
});

router.post('/', requireAuth, (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'Falta siniestro_id.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id=?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });

  const info = db.prepare(`INSERT INTO mensajes_ia (siniestro_id,hito_id,contexto_usado,borrador,estado,generado_por)
    VALUES (?,?,?,?,'generado',?)`)
    .run(b.siniestro_id, b.hito_id || null, b.contexto_usado || '', b.borrador || '', req.session.user.id);
  res.status(201).json(db.prepare('SELECT * FROM mensajes_ia WHERE id=?').get(info.lastInsertRowid));
});

router.patch('/:id', requireAuth, (req, res)=>{
  const anterior = db.prepare('SELECT * FROM mensajes_ia WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Mensaje no encontrado.' });
  const { borrador, estado } = req.body;
  const nuevoEstado = estado || anterior.estado;
  if(!['generado','aprobado','enviado'].includes(nuevoEstado)) return res.status(400).json({ error:'Estado inválido.' });
  const nuevoBorrador = borrador !== undefined ? borrador : anterior.borrador;

  if(nuevoEstado === 'enviado' && (!nuevoBorrador || !String(nuevoBorrador).trim())){
    return res.status(400).json({ error:'No puedes marcar como enviado un mensaje sin borrador.' });
  }

  let eventoClienteId = anterior.evento_cliente_id;
  let aprobadoPor = anterior.aprobado_por, aprobadoEn = anterior.aprobado_en;
  if(nuevoEstado === 'aprobado' && anterior.estado !== 'aprobado'){ aprobadoPor = req.session.user.id; aprobadoEn = new Date().toISOString(); }
  if(nuevoEstado === 'enviado' && anterior.estado !== 'enviado'){
    if(!aprobadoPor){ aprobadoPor = req.session.user.id; aprobadoEn = new Date().toISOString(); }
    const evento = db.prepare(`INSERT INTO eventos_cliente (siniestro_id,direccion,canal,tipo_evento,autor_id,mensaje)
      VALUES (?,?,?,?,?,?)`)
      .run(anterior.siniestro_id, 'saliente', 'WhatsApp', 'mensaje generado con IA', req.session.user.id, String(nuevoBorrador).trim());
    eventoClienteId = evento.lastInsertRowid;
  }

  db.prepare(`UPDATE mensajes_ia SET borrador=?, estado=?, aprobado_por=?, aprobado_en=?, evento_cliente_id=? WHERE id=?`)
    .run(nuevoBorrador, nuevoEstado, aprobadoPor, aprobadoEn, eventoClienteId, req.params.id);
  res.json(db.prepare('SELECT * FROM mensajes_ia WHERE id=?').get(req.params.id));
});

module.exports = router;
