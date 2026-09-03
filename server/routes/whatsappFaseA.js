// Endpoint de solo lectura / revisión explícita, exclusivo para admin, para verificar el modo "solo
// registro" de WhatsApp Fase A (autorizado por Roberto, 3-sep-2026, ampliado en la quinta revisión el
// mismo día). No está enlazado desde ninguna pantalla del frontend -- es una herramienta de
// verificación/revisión, no un componente nuevo expuesto a ningún rol operativo. La acción de revisión
// (PATCH) NUNCA envía nada real: solo mueve un evento de "pendiente_revision" (o, para una alerta interna,
// "registrado") a "descartado" o "liberado_para_programacion", con justificación obligatoria.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const whatsappFaseA = require('../whatsappFaseA');
const whatsappScheduler = require('../whatsappScheduler');
const router = express.Router();

// LEFT JOIN (no INNER): un evento puede ser una alerta de SISTEMA (punto 1/2, quinta revisión) sin
// siniestro_id -- con INNER JOIN esas filas desaparecerían silenciosamente de este listado.
router.get('/eventos', requireAuth, requireRole('admin'), (req, res)=>{
  const { siniestro_id, plantilla_codigo, estado, limit } = req.query;
  let sql = `SELECT e.*, s.numero AS siniestro_numero FROM whatsapp_eventos_registrados e
             LEFT JOIN siniestros s ON s.id = e.siniestro_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND e.siniestro_id = ?'; params.push(siniestro_id); }
  if(plantilla_codigo){ sql += ' AND e.plantilla_codigo = ?'; params.push(plantilla_codigo); }
  if(estado){ sql += ' AND e.estado = ?'; params.push(estado); }
  sql += ' ORDER BY e.creado_en DESC LIMIT ?';
  params.push(Math.min(Number(limit)||200, 1000));
  const filas = db.prepare(sql).all(...params);
  // Enriquecer las alertas internas con su catálogo (punto 2, quinta revisión): nombre legible, prioridad
  // ya guardada en la fila, responsable sugerido y regla de cierre -- estas dos últimas no se guardan por
  // fila (son propiedades del TIPO de alerta, no de cada instancia), se calculan aquí para la lectura.
  const enriquecidas = filas.map(f => {
    if(f.es_plantilla_meta === 0 && whatsappFaseA.EVENTOS_INTERNOS[f.plantilla_codigo]){
      const cat = whatsappFaseA.EVENTOS_INTERNOS[f.plantilla_codigo];
      return { ...f, alerta_nombre: cat.nombre, alerta_responsable_sugerido: cat.responsableSugerido, alerta_regla_cierre: cat.reglaCierre };
    }
    return f;
  });
  res.json(enriquecidas);
});

router.get('/errores', requireAuth, requireRole('admin'), (req, res)=>{
  const { resuelto, limit } = req.query;
  let sql = `SELECT er.*, s.numero AS siniestro_numero FROM whatsapp_errores er
             LEFT JOIN siniestros s ON s.id = er.siniestro_id WHERE 1=1`;
  const params = [];
  // Ojo: "resuelto=0" en query string es un string NO vacío ("0"), por lo tanto truthy en JS -- no se
  // puede usar `resuelto ? 1 : 0` (convertiría "0" en 1). Se compara explícitamente contra el string '0'.
  if(resuelto !== undefined){ sql += ' AND er.resuelto = ?'; params.push(resuelto === '0' || resuelto === 0 || resuelto === false ? 0 : 1); }
  sql += ' ORDER BY er.ultimo_intento_en DESC LIMIT ?';
  params.push(Math.min(Number(limit)||200, 1000));
  res.json(db.prepare(sql).all(...params));
});

// Punto 1 (quinta revisión): estado consultable del barrido programado -- última ejecución, hace cuánto
// corrió, y si está atrasado. Solo lectura, admin, sin pantalla.
router.get('/scheduler', requireAuth, requireRole('admin'), (req, res)=>{
  const { limit } = req.query;
  const estado = whatsappScheduler.estadoScheduler(db);
  const historial = db.prepare('SELECT * FROM whatsapp_scheduler_ejecuciones ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit)||20, 200));
  res.json({ ...estado, historial });
});

// Punto 3 (quinta revisión): registro de una comunicación manual informativa. Endpoint admin-only, sin
// enlazar desde ninguna pantalla todavía (punto 7 sigue sin autorizar cambios visibles para Alejandra) --
// existe para que la lógica quede probada de extremo a extremo antes de decidir cómo se captura en la
// interfaz real.
router.post('/comunicaciones-manuales', requireAuth, requireRole('admin'), (req, res)=>{
  const { siniestro_id, tipo, nota } = req.body;
  try{
    const registro = whatsappFaseA.registrarComunicacionManual(db, {
      siniestroId: siniestro_id, tipo, nota, usuarioId: req.session.user.id,
    });
    res.status(201).json(registro);
  } catch(e){
    res.status(400).json({ error: e.message });
  }
});
router.get('/comunicaciones-manuales', requireAuth, requireRole('admin'), (req, res)=>{
  const { siniestro_id, limit } = req.query;
  let sql = `SELECT c.*, s.numero AS siniestro_numero FROM whatsapp_comunicaciones_manuales c
             JOIN siniestros s ON s.id = c.siniestro_id WHERE 1=1`;
  const params = [];
  if(siniestro_id){ sql += ' AND c.siniestro_id = ?'; params.push(siniestro_id); }
  sql += ' ORDER BY c.registrado_en DESC LIMIT ?';
  params.push(Math.min(Number(limit)||200, 1000));
  res.json(db.prepare(sql).all(...params));
});

// Acción explícita de revisión humana. Requiere justificación. Nunca envía nada real. Sirve tanto para
// eventos bloqueados de cliente (pendiente_revision -> descartado/liberado_para_programacion) como para
// cerrar una alerta interna (registrado -> descartado; ver resolverPendienteRevision para el detalle).
router.patch('/eventos/:id/revision', requireAuth, requireRole('admin'), (req, res)=>{
  const { decision, justificacion } = req.body;
  try{
    const evento = whatsappFaseA.resolverPendienteRevision(db, {
      eventoId: req.params.id, decision, justificacion, usuarioId: req.session.user.id,
    });
    res.json(evento);
  } catch(e){
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
