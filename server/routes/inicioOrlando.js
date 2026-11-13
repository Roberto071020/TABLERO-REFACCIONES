// Inicio de Orlando (6-nov-2026) -- ver server/inicioOrlando.js. También aquí la lista de calidad pendiente
// que usan los inicios de Beto (todas) y de los demás (solo las de 1 día o más), ver server/calidadPendiente.js.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { calcularInicioOrlando } = require('../inicioOrlando');
const { unidadesPorRevisarCalidad, HORAS_APOYO } = require('../calidadPendiente');
const router = express.Router();

router.get('/', requireAuth, requireRole('orlando', 'vanessa', 'admin', 'jefe'), (req, res)=>{
  res.json(calcularInicioOrlando(db));
});

// ?apoyo=1 -> solo las que llevan 1 día o más terminadas sin revisar (para Alejandra, Daniela y Orlando).
router.get('/calidad-pendiente', requireAuth, (req, res)=>{
  res.json(unidadesPorRevisarCalidad(db, { minHoras: req.query.apoyo === '1' ? HORAS_APOYO : 0 }));
});

// 13-nov-2026 (Orlando, aprobado por Roberto): "que el panel de Apoyo: revisar calidad también pueda ser editable...
// hay carros marcados como terminados que aún no lo están". Quien revisa calidad la regresa a Beto como DETENIDA con
// el motivo; la etapa la sigue moviendo Beto. Cualquiera que pueda revisar calidad puede hacerlo.
router.post('/calidad-pendiente/:id/no-terminada', requireAuth, requireRole('beto','orlando','atencion_cliente','operativo','vanessa','admin','jefe'), (req, res)=>{
  const { registrarAuditoria } = require('../utils');
  const s = db.prepare('SELECT id, estado_produccion FROM siniestros WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ error:'Unidad no encontrada.' });
  if(s.estado_produccion !== 'terminado') return res.status(400).json({ error:'Esta unidad ya no aparece como terminada.' });
  const nota = String((req.body && req.body.nota) || '').trim().slice(0, 200);
  if(!nota) return res.status(400).json({ error:'Escribe qué le falta.' });
  const quien = String(req.session.user.nombre || '').split(' ')[0];
  const texto = `${nota} (reporta ${quien})`;
  db.prepare(`UPDATE siniestros SET estado_produccion = 'detenido', detenido_motivo = 'no_terminada', detenido_nota = ?, detenido_desde = datetime('now'), actualizado_en = datetime('now') WHERE id = ?`).run(texto, s.id);
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'actualizacion', campo:'estado_produccion', valor_anterior:'terminado', valor_nuevo:'detenido', usuario:req.session.user });
  registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'detenida', campo:'detenido_motivo', valor_anterior:null, valor_nuevo:'no_terminada — ' + texto, usuario:req.session.user });
  res.json({ ok: true });
});

module.exports = router;
