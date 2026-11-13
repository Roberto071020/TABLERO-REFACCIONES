// Complementos por daño oculto (Documento Maestro, tabla 15). Responsable principal: Orlando; Beto
// también puede registrar hallazgos que surgen durante producción (sección 5.11 / 9).
// Proceso_Completo_Servicio_Cristian.docx (sección 7): además existe el complemento por PIEZAS NO
// AUTORIZADAS en la evaluación inicial (tipo='no_autorizado_inicial') -- lo detecta Roberto al revisar
// la evaluación autorizada, antes de que exista una OT, y tiene un plazo corto (~24h) para reautorizar
// con fotos editadas antes de soltar el expediente al equipo.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, auditarCambios } = require('../utils');
const router = express.Router();

const ROLES_EDICION = ['orlando','beto','admin','jefe'];
const DECISIONES = ['pendiente','autorizado','rechazado','parcial'];
const ESTADOS = ['detectado','documentando','enviado','en_autorizacion','autorizado','rechazado','incorporado_a_ot'];
const TIPOS = ['dano_oculto','no_autorizado_inicial'];
const HORAS_PLAZO_REAUTORIZACION = 24;
// 13-nov-2026 (Roberto: "como es una reincidencia te pediría que tenga 12 horas").
const HORAS_PLAZO_REINCIDENCIA = 12;

function marcarVencido(c){
  const vencido = c.tipo === 'no_autorizado_inicial' && c.decision === 'pendiente' && c.fecha_limite && c.fecha_limite < new Date().toISOString();
  return { ...c, vencido };
}

router.get('/', requireAuth, (req, res)=>{
  const { siniestro_id, tipo, pendientes } = req.query;
  // 6-nov-2026: también trae número, vehículo y placas del expediente, para listar las reautorizaciones en
  // curso en la pantalla de Valuación sin abrir cada expediente.
  let sql = `SELECT c.*, u.nombre as autor_nombre, s.numero as siniestro_numero, s.vehiculo, s.placas
    FROM complementos c LEFT JOIN usuarios u ON u.id = c.autor_id LEFT JOIN siniestros s ON s.id = c.siniestro_id WHERE 1=1`;
  const params = [];
  if(pendientes === '1'){ sql += " AND c.decision = 'pendiente'"; }
  if(siniestro_id){ sql += ' AND c.siniestro_id = ?'; params.push(siniestro_id); }
  if(tipo){ sql += ' AND c.tipo = ?'; params.push(tipo); }
  sql += ' ORDER BY c.creado_en DESC';
  res.json(db.prepare(sql).all(...params).map(marcarVencido));
});

router.post('/', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const b = req.body;
  if(!b.siniestro_id) return res.status(400).json({ error:'El complemento debe ligarse a un expediente.' });
  const siniestro = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(b.siniestro_id);
  if(!siniestro) return res.status(400).json({ error:'El expediente indicado no existe.' });
  if(!b.causa || !String(b.causa).trim()) return res.status(400).json({ error:'Describe la causa del complemento (hallazgo de daño oculto).' });
  if(b.ot_id){
    const ot = db.prepare('SELECT id FROM ordenes_trabajo WHERE id = ?').get(b.ot_id);
    if(!ot) return res.status(400).json({ error:'La OT indicada no existe.' });
  }
  if(b.archivo_id){
    const archivo = db.prepare('SELECT id FROM archivos WHERE id = ?').get(b.archivo_id);
    if(!archivo) return res.status(400).json({ error:'El archivo/evidencia indicado no existe.' });
  }
  const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'dano_oculto';
  // Solo Roberto (admin/jefe) detecta piezas no autorizadas al revisar la evaluación -- Orlando/Beto
  // siguen pudiendo registrar complementos por daño oculto como siempre.
  if(tipo === 'no_autorizado_inicial' && !['admin','jefe'].includes(req.session.user.rol)){
    return res.status(403).json({ error:'Solo el propietario/gerente puede registrar una solicitud de reautorización por piezas no autorizadas.' });
  }
  if(tipo === 'no_autorizado_inicial' && (!b.pieza_operacion || !String(b.pieza_operacion).trim())){
    return res.status(400).json({ error:'Indica qué pieza(s) no fueron autorizadas.' });
  }
  const fechaLimite = tipo === 'no_autorizado_inicial'
    ? new Date(Date.now() + HORAS_PLAZO_REAUTORIZACION*3600*1000).toISOString()
    : null;

  const info = db.prepare(`INSERT INTO complementos (siniestro_id,ot_id,causa,fecha,pieza_operacion,archivo_id,importe,folio,decision,impacto_dias,estado,autor_id,tipo,fecha_limite)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.siniestro_id, b.ot_id||null, String(b.causa).trim(), b.fecha||new Date().toISOString().slice(0,10), b.pieza_operacion||'',
         b.archivo_id||null, b.importe!=null&&b.importe!==''?Number(b.importe):null, b.folio||'', 'pendiente', b.impacto_dias||null, 'detectado', req.session.user.id,
         tipo, fechaLimite);
  registrarAuditoria(db, { entidad_tipo:'complemento', entidad_id: info.lastInsertRowid, accion:'alta', usuario:req.session.user, valor_nuevo:b.causa });

  // Aviso automático a Orlando (mismo patrón que "ot_lista_beto"): visible en la bitácora del expediente
  // en cuanto lo abra, con el plazo de 24h explícito en la descripción.
  if(tipo === 'no_autorizado_inicial'){
    db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
      VALUES (?,?,?,?,'pendiente','automatica','reautorizacion_solicitada',?)`)
      .run(b.siniestro_id, 'aviso',
        `Piezas no autorizadas por la aseguradora: ${String(b.pieza_operacion).trim()}. Se necesitan fotos editadas señalando el daño antes de ${fechaLimite.slice(0,16).replace('T',' ')} para reautorizar (plazo de ${HORAS_PLAZO_REAUTORIZACION}h).`,
        fechaLimite.slice(0,10), req.session.user.id);
  }

  res.status(201).json(marcarVencido(db.prepare(`SELECT c.*, u.nombre as autor_nombre FROM complementos c LEFT JOIN usuarios u ON u.id=c.autor_id WHERE c.id=?`).get(info.lastInsertRowid)));
});

router.patch('/:id', requireAuth, requireRole(...ROLES_EDICION), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM complementos WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Complemento no encontrado.' });
  const campos = ['causa','fecha','pieza_operacion','archivo_id','importe','folio','decision','impacto_dias','estado','ot_id'];
  const nuevo = { ...anterior };
  campos.forEach(c=>{ if(req.body[c] !== undefined) nuevo[c] = req.body[c]; });
  if(nuevo.decision && !DECISIONES.includes(nuevo.decision)) return res.status(400).json({ error:'Decisión inválida.' });
  if(nuevo.estado && !ESTADOS.includes(nuevo.estado)) return res.status(400).json({ error:'Estado inválido.' });
  // Alerta del documento (tabla 4/15): "daño trabajado sin autorización" — no se puede marcar incorporado
  // a OT si la decisión sigue pendiente o fue rechazada.
  if(nuevo.estado === 'incorporado_a_ot' && nuevo.decision !== 'autorizado' && nuevo.decision !== 'parcial'){
    return res.status(400).json({ error:'No se puede incorporar a la OT un complemento sin autorización (total o parcial).' });
  }
  // Límite de compra confirmado por Roberto (24-ago-2026): complementos superiores a $1,000 MXN no pueden
  // autorizarse desde el rol de Orlando/Beto; requieren admin o jefe (propietario/gerente, tabla 2).
  const LIMITE_AUTORIZACION_SIN_PROPIETARIO = 1000;
  const decisionCambiaAAutorizada = ['autorizado','parcial'].includes(nuevo.decision) && anterior.decision !== nuevo.decision;
  if(decisionCambiaAAutorizada && Number(nuevo.importe) > LIMITE_AUTORIZACION_SIN_PROPIETARIO && !['admin','jefe'].includes(req.session.user.rol)){
    return res.status(403).json({ error:`Complementos por más de $${LIMITE_AUTORIZACION_SIN_PROPIETARIO} MXN requieren autorización del propietario/gerente (admin o jefe).` });
  }

  // Para medir "cuánto tardó Orlando en resolver el complemento" (Roberto, 28-ago-2026): se sella sola
  // la primera vez que la decisión deja de ser 'pendiente'.
  const decisionEn = (anterior.decision === 'pendiente' && nuevo.decision !== 'pendiente' && !anterior.decision_en)
    ? new Date().toISOString() : anterior.decision_en;

  db.prepare(`UPDATE complementos SET causa=?,fecha=?,pieza_operacion=?,archivo_id=?,importe=?,folio=?,decision=?,impacto_dias=?,estado=?,ot_id=?,decision_en=?,actualizado_en=datetime('now') WHERE id=?`)
    .run(nuevo.causa, nuevo.fecha, nuevo.pieza_operacion, nuevo.archivo_id||null, nuevo.importe, nuevo.folio, nuevo.decision, nuevo.impacto_dias, nuevo.estado, nuevo.ot_id||null, decisionEn, req.params.id);
  auditarCambios(db, { entidad_tipo:'complemento', entidad_id:req.params.id, anterior, nuevo, usuario:req.session.user });
  res.json(marcarVencido(db.prepare(`SELECT c.*, u.nombre as autor_nombre FROM complementos c LEFT JOIN usuarios u ON u.id=c.autor_id WHERE c.id=?`).get(req.params.id)));
});

// 13-nov-2026 (Roberto: "actívale ese pendiente de nuevo a Orlando" / "como es una reincidencia te pediría
// que tenga 12 horas"): reactiva una reautorización (piezas no autorizadas) que sigue sin resolverse. Regresa
// a la lista de Orlando marcada como REINCIDENCIA, con un plazo nuevo de 12 h contado desde ahora. Solo
// Roberto (admin/jefe) puede hacerlo. Opcional: "nota" se agrega a la causa para que Orlando vea qué falta.
router.post('/:id/reincidencia', requireAuth, requireRole('admin','jefe'), (req, res)=>{
  const anterior = db.prepare('SELECT * FROM complementos WHERE id = ?').get(req.params.id);
  if(!anterior) return res.status(404).json({ error:'Complemento no encontrado.' });
  if(anterior.tipo !== 'no_autorizado_inicial') return res.status(400).json({ error:'Solo aplica a reautorizaciones por piezas no autorizadas.' });
  if(anterior.decision !== 'pendiente') return res.status(400).json({ error:'Esta reautorización ya tiene respuesta de la aseguradora.' });
  const limite = new Date(Date.now() + HORAS_PLAZO_REINCIDENCIA*3600*1000).toISOString();
  const nota = req.body && req.body.nota ? String(req.body.nota).trim() : '';
  const causa = nota ? `${anterior.causa || ''}${anterior.causa ? ' · ' : ''}${nota}` : anterior.causa;
  db.prepare(`UPDATE complementos SET estado='documentando', reincidencia=1, fecha_limite=?, causa=?, actualizado_en=datetime('now') WHERE id=?`)
    .run(limite, causa, anterior.id);
  const nuevo = db.prepare('SELECT * FROM complementos WHERE id = ?').get(anterior.id);
  auditarCambios(db, { entidad_tipo:'complemento', entidad_id:anterior.id, anterior, nuevo, usuario:req.session.user });
  db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
    VALUES (?,?,?,?,'pendiente','automatica','reautorizacion_reincidencia',?)`)
    .run(anterior.siniestro_id, 'aviso',
      `REINCIDENCIA: la reautorización de ${anterior.pieza_operacion} sigue sin resolverse. Plazo de ${HORAS_PLAZO_REINCIDENCIA}h, antes de ${limite.slice(0,16).replace('T',' ')}.${nota ? ' ' + nota : ''}`,
      limite.slice(0,10), req.session.user.id);
  res.json(marcarVencido(db.prepare(`SELECT c.*, u.nombre as autor_nombre FROM complementos c LEFT JOIN usuarios u ON u.id=c.autor_id WHERE c.id=?`).get(anterior.id)));
});

module.exports = router;
