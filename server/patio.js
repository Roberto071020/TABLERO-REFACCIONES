// ===================== Trabajo del personal de patio (12-nov-2026) =====================
// Roberto: "Quiero avanzar con las opciones del personal de patio en SC Control" ... "necesito que para el
// personal en patio sea muy sencillo de utilizar". Proceso acordado ese día:
//   - Beto asigna hojalatero, pintor y/o mecánico a cada unidad (puede reasignar; queda registrado quién la tenía).
//     El hojalatero también hace el armado y el pintor la preparación y el pulido.
//   - El técnico ve "Mis trabajos" (vehículo, placas, fecha de entrega y su OT) y usa tres botones:
//       ▶ Empecé  ·  ✅ Terminé (con foto; Beto confirma pasando la unidad a la siguiente etapa)  ·  ⏸ Me detuve.
//   - Puede tener varias unidades en curso a la vez. Los tiempos son solo para control (no para pago).
//   - "Me detuve": falta pieza (avisa a Daniela), pieza mal surtida (foto obligatoria, avisa a Daniela), daño oculto
//     (foto obligatoria, avisa a Orlando), falta material (avisa a Beto), Beto me movió (sin aviso).
//     Roberto: "Cuando el problema sea pieza mal surtida o daño oculto necesito que pueda tomar fotos para que
//     aparte del aviso le llegue la evidencia a la persona indicada".
//   - Beto ve quién llegó hoy de su personal (solo el día; el historial de retardos sigue siendo de Roberto).

const AREAS = {
  hojalateria: { etiqueta:'Hojalatería', puesto:'Hojalatero', etapas:['en_laminado','armado'], primera:'en_laminado' },
  pintura:     { etiqueta:'Pintura',     puesto:'Pintor',     etapas:['preparacion','pintura','pulido'], primera:'preparacion' },
  mecanica:    { etiqueta:'Mecánica',    puesto:'Mecánico',   etapas:['mecanica'], primera:'mecanica' },
};
const PUESTO_AREA = Object.fromEntries(Object.entries(AREAS).map(([k, a]) => [a.puesto, k]));
const SECUENCIA = ['programado','mecanica','en_laminado','preparacion','pintura','armado','pulido','lavado','terminado'];
const ETIQUETA_ETAPA = { programado:'Sin iniciar', mecanica:'Mecánica', en_laminado:'Hojalatería', preparacion:'Preparación', pintura:'Pintura',
  armado:'Armado', pulido:'Pulido', lavado:'Lavado', detenido:'Detenida', terminado:'Terminada' };

// detiene = motivo de "Detenido" de server/detenidas.js (la unidad queda detenida y le aparece a quien la destraba).
const MOTIVOS_PARO = {
  falta_pieza:    { etiqueta:'Falta pieza',        icono:'📦', detiene:'falta_pieza', foto:false, avisa:'Daniela' },
  pieza_mal:      { etiqueta:'Pieza mal surtida',  icono:'⚠️', detiene:'pieza_mal',   foto:true,  avisa:'Daniela' },
  dano_oculto:    { etiqueta:'Daño oculto',        icono:'🔍', detiene:'dano_oculto', foto:true,  avisa:'Orlando' },
  falta_material: { etiqueta:'Falta material',     icono:'🧴', detiene:null,          foto:false, avisa:'Beto' },
  me_movieron:    { etiqueta:'Beto me movió a otra unidad', icono:'🔀', detiene:null, foto:false, avisa:null },
};

function asegurarTablasPatio(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS patio_asignaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      siniestro_id INTEGER NOT NULL,
      area TEXT NOT NULL,
      usuario_id INTEGER NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      asignado_por TEXT,
      asignado_en TEXT NOT NULL DEFAULT (datetime('now')),
      quitado_en TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_patio_asig_sin ON patio_asignaciones(siniestro_id, activo);
    CREATE INDEX IF NOT EXISTS idx_patio_asig_usr ON patio_asignaciones(usuario_id, activo);
    CREATE TABLE IF NOT EXISTS patio_trabajos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asignacion_id INTEGER NOT NULL,
      siniestro_id INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      etapa TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'en_curso',   -- en_curso | pausado | terminado (espera a Beto) | cerrado
      iniciado_en TEXT NOT NULL DEFAULT (datetime('now')),
      pausado_en TEXT, motivo_paro TEXT, nota_paro TEXT,
      terminado_en TEXT, cerrado_en TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_patio_trab_sin ON patio_trabajos(siniestro_id, estado);
    CREATE TABLE IF NOT EXISTS patio_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      siniestro_id INTEGER NOT NULL,
      trabajo_id INTEGER,
      usuario_id INTEGER,
      usuario_nombre TEXT,
      tipo TEXT NOT NULL,                        -- asignacion | quitar | inicio | termino | pausa | reanuda
      area TEXT, etapa TEXT, motivo TEXT, nota TEXT,
      fotos TEXT,                                -- ids de archivos (JSON)
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_patio_ev_sin ON patio_eventos(siniestro_id);
  `);
}

function hoyMX(){ return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10); }
function areaDeEtapa(etapa){ return Object.keys(AREAS).find(k => AREAS[k].etapas.includes(etapa)) || null; }
const sinIniciar = e => !e || e === 'programado';
function nombreCorto(n){ const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[1][0]}.` : p[0] || ''; }

function evento(db, d){
  return db.prepare(`INSERT INTO patio_eventos (siniestro_id, trabajo_id, usuario_id, usuario_nombre, tipo, area, etapa, motivo, nota, fotos)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(d.siniestro_id, d.trabajo_id || null, d.usuario ? d.usuario.id : null, d.usuario ? d.usuario.nombre : 'sistema',
    d.tipo, d.area || null, d.etapa || null, d.motivo || null, d.nota || null, d.fotos && d.fotos.length ? JSON.stringify(d.fotos) : null).lastInsertRowid;
}

// Técnicos que se pueden asignar (Hojalatero, Pintor, Mecánico) con su asistencia de hoy.
function personalPatio(db){
  const hoy = hoyMX();
  const filas = db.prepare(`SELECT u.id, u.nombre, u.puesto, a.hora_local AS hora FROM usuarios u
    LEFT JOIN asistencia a ON a.usuario_id = u.id AND a.fecha = ?
    WHERE u.rol = 'tecnico' AND u.activo = 1 ORDER BY u.nombre`).all(hoy);
  return filas.map(f => ({ id: f.id, nombre: f.nombre, puesto: f.puesto || null, area: PUESTO_AREA[f.puesto] || null, llego: !!f.hora, hora: f.hora || null }));
}

// Lo que Beto ve: asistencia de hoy del personal de patio y, por unidad, quién la tiene y cómo va.
function vistaBeto(db){
  const personal = personalPatio(db);
  const asign = db.prepare(`SELECT a.id, a.siniestro_id, a.area, a.usuario_id, u.nombre FROM patio_asignaciones a JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.activo = 1`).all();
  const trabajos = db.prepare(`SELECT * FROM patio_trabajos WHERE estado != 'cerrado' ORDER BY id DESC`).all();
  const porSiniestro = {};
  for(const a of asign){
    const t = trabajos.find(x => x.asignacion_id === a.id);
    (porSiniestro[a.siniestro_id] = porSiniestro[a.siniestro_id] || []).push({
      area: a.area, area_etiqueta: AREAS[a.area] ? AREAS[a.area].etiqueta : a.area, usuario_id: a.usuario_id, nombre: a.nombre, corto: nombreCorto(a.nombre),
      trabajo: t ? { estado: t.estado, etapa: t.etapa, etapa_etiqueta: ETIQUETA_ETAPA[t.etapa] || t.etapa, desde: t.estado === 'pausado' ? t.pausado_en : t.estado === 'terminado' ? t.terminado_en : t.iniciado_en,
        motivo: t.motivo_paro, motivo_etiqueta: t.motivo_paro && MOTIVOS_PARO[t.motivo_paro] ? MOTIVOS_PARO[t.motivo_paro].etiqueta : null, nota: t.nota_paro } : null
    });
  }
  return { personal, llegaron: personal.filter(p => p.llego).length, total: personal.length, por_siniestro: porSiniestro };
}

// Asignar (usuarioId) o quitar (null) a la persona de un área en una unidad.
function asignar(db, { siniestroId, area, usuarioId, usuario }){
  if(!AREAS[area]) throw Object.assign(new Error('Área no válida.'), { status: 400 });
  const s = db.prepare('SELECT id FROM siniestros WHERE id = ?').get(siniestroId);
  if(!s) throw Object.assign(new Error('Unidad no encontrada.'), { status: 404 });
  if(usuarioId){
    const t = db.prepare(`SELECT id, puesto FROM usuarios WHERE id = ? AND rol = 'tecnico' AND activo = 1`).get(usuarioId);
    if(!t || PUESTO_AREA[t.puesto] !== area) throw Object.assign(new Error(`Elige a un ${AREAS[area].puesto.toLowerCase()}.`), { status: 400 });
  }
  const actual = db.prepare(`SELECT * FROM patio_asignaciones WHERE siniestro_id = ? AND area = ? AND activo = 1`).get(siniestroId, area);
  if(actual && actual.usuario_id === Number(usuarioId)) return { sin_cambio: true };
  if(actual){
    db.prepare(`UPDATE patio_asignaciones SET activo = 0, quitado_en = datetime('now') WHERE id = ?`).run(actual.id);
    // Lo que tenía abierto la persona anterior se cierra (queda en el historial).
    db.prepare(`UPDATE patio_trabajos SET estado = 'cerrado', cerrado_en = datetime('now') WHERE asignacion_id = ? AND estado != 'cerrado'`).run(actual.id);
    evento(db, { siniestro_id: siniestroId, usuario, tipo:'quitar', area, nota: `Tenía: ${(db.prepare('SELECT nombre FROM usuarios WHERE id=?').get(actual.usuario_id) || {}).nombre || ''}` });
  }
  if(usuarioId){
    db.prepare(`INSERT INTO patio_asignaciones (siniestro_id, area, usuario_id, asignado_por) VALUES (?,?,?,?)`).run(siniestroId, area, usuarioId, usuario ? usuario.nombre : null);
    evento(db, { siniestro_id: siniestroId, usuario, tipo:'asignacion', area, nota: (db.prepare('SELECT nombre FROM usuarios WHERE id=?').get(usuarioId) || {}).nombre });
  }
  return { ok: true };
}

// Estado de UNA tarjeta del técnico: qué ve y qué botón tiene.
function estadoTarjeta(s, area, trabajo){
  const etapa = s.estado_produccion || null;
  const A = AREAS[area];
  if(trabajo && trabajo.estado === 'terminado') return { accion:'espera_beto', texto:`Terminaste ${ETIQUETA_ETAPA[trabajo.etapa] || ''}. Beto la revisa.` };
  if(trabajo && trabajo.estado === 'pausado'){
    if(etapa === 'detenido') return { accion:'detenida', texto:`Detenida: ${(MOTIVOS_PARO[trabajo.motivo_paro] || {}).etiqueta || 'espera'}${(MOTIVOS_PARO[trabajo.motivo_paro] || {}).avisa ? ' · ya se le avisó a ' + MOTIVOS_PARO[trabajo.motivo_paro].avisa : ''}` };
    return { accion:'seguir', texto:`Detenida: ${(MOTIVOS_PARO[trabajo.motivo_paro] || {}).etiqueta || ''}` };
  }
  if(trabajo && trabajo.estado === 'en_curso') return { accion:'trabajando', texto:'Trabajando' };
  if(etapa === 'detenido') return { accion:'detenida', texto:'Detenida' };
  if(sinIniciar(etapa) || A.etapas.includes(etapa)) return { accion:'empezar', texto: sinIniciar(etapa) ? 'Lista para empezar' : `Te toca: ${ETIQUETA_ETAPA[etapa]}` };
  return { accion:'no_toca', texto:`Todavía no te toca · está en ${ETIQUETA_ETAPA[etapa] || etapa}` };
}

// "Mis trabajos": unidades asignadas a este técnico que todavía tienen algo para él.
function misTrabajos(db, usuarioId){
  const hoy = hoyMX();
  const filas = db.prepare(`SELECT a.id AS asignacion_id, a.area, s.id, s.numero, s.vehiculo, s.placas, s.estado_produccion, s.fecha_entrega_prevista,
      (SELECT id FROM archivos f WHERE f.entidad_tipo='siniestro' AND f.entidad_id=s.id AND f.tipo='Orden de trabajo' AND f.eliminado=0 ORDER BY f.id DESC LIMIT 1) AS ot_archivo_id
    FROM patio_asignaciones a JOIN siniestros s ON s.id = a.siniestro_id
    WHERE a.usuario_id = ? AND a.activo = 1 AND s.archivado = 0 AND (s.fecha_entrega_real IS NULL OR s.fecha_entrega_real = '')
      AND COALESCE(s.estado_produccion, '') != 'terminado'`).all(usuarioId);
  const lista = [];
  for(const f of filas){
    const t = db.prepare(`SELECT * FROM patio_trabajos WHERE asignacion_id = ? AND estado != 'cerrado' ORDER BY id DESC LIMIT 1`).get(f.asignacion_id);
    const e = estadoTarjeta(f, f.area, t);
    // Ya pasó su parte (p. ej. el hojalatero cuando la unidad va en lavado): ya no se le muestra.
    if(e.accion === 'no_toca'){
      const ultima = Math.max(...AREAS[f.area].etapas.map(x => SECUENCIA.indexOf(x)));
      if(SECUENCIA.indexOf(f.estado_produccion) > ultima) continue;
    }
    lista.push({ siniestro_id: f.id, vehiculo: f.vehiculo || f.numero, placas: f.placas || '', numero: f.numero, area: f.area, area_etiqueta: AREAS[f.area].etiqueta,
      etapa: f.estado_produccion || null, etapa_etiqueta: ETIQUETA_ETAPA[f.estado_produccion || 'programado'], fecha_entrega: f.fecha_entrega_prevista || null,
      vencida: !!(f.fecha_entrega_prevista && f.fecha_entrega_prevista < hoy), tiene_ot: !!f.ot_archivo_id,
      trabajo_id: t ? t.id : null, desde: t ? (t.estado === 'pausado' ? t.pausado_en : t.iniciado_en) : null, ...e });
  }
  const peso = { trabajando:0, seguir:1, empezar:2, detenida:3, espera_beto:4, no_toca:5 };
  return lista.sort((a, b) => (a.fecha_entrega ? 0 : 1) - (b.fecha_entrega ? 0 : 1) || String(a.fecha_entrega || '').localeCompare(String(b.fecha_entrega || ''))
    || peso[a.accion] - peso[b.accion]);
}

function error(msg, status = 400){ return Object.assign(new Error(msg), { status }); }
function cargar(db, siniestroId, usuarioId){
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(siniestroId);
  if(!s) throw error('Unidad no encontrada.', 404);
  const a = db.prepare(`SELECT * FROM patio_asignaciones WHERE siniestro_id = ? AND usuario_id = ? AND activo = 1 ORDER BY id DESC LIMIT 1`).get(siniestroId, usuarioId);
  if(!a) throw error('Esta unidad ya no está asignada a ti. Pregúntale a Beto.', 403);
  const t = db.prepare(`SELECT * FROM patio_trabajos WHERE asignacion_id = ? AND estado != 'cerrado' ORDER BY id DESC LIMIT 1`).get(a.id);
  return { s, a, t };
}

// ▶ Empecé. Si la unidad no se había iniciado, pasa a la primera etapa de su área (hojalatería, preparación o mecánica).
function empezar(db, { siniestroId, usuario, registrarAuditoria, marcarHito }){
  const { s, a, t } = cargar(db, siniestroId, usuario.id);
  if(t) throw error(t.estado === 'pausado' ? 'Usa "Seguir" para continuar.' : 'Ya la tienes iniciada.');
  let etapa = s.estado_produccion;
  if(etapa === 'detenido') throw error('La unidad está detenida. Pregúntale a Beto.');
  if(sinIniciar(etapa)){
    etapa = AREAS[a.area].primera;
    db.prepare(`UPDATE siniestros SET estado_produccion = ?, actualizado_en = datetime('now') WHERE id = ?`).run(etapa, s.id);
    if(registrarAuditoria) registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'edicion', campo:'estado_produccion', valor_anterior: s.estado_produccion, valor_nuevo: etapa, usuario });
    if(marcarHito && etapa === 'en_laminado') marcarHito(db, s.id, 'hojalateria');
  } else if(!AREAS[a.area].etapas.includes(etapa)){
    throw error(`Todavía no te toca: la unidad está en ${ETIQUETA_ETAPA[etapa] || etapa}.`);
  }
  const id = db.prepare(`INSERT INTO patio_trabajos (asignacion_id, siniestro_id, usuario_id, etapa) VALUES (?,?,?,?)`).run(a.id, s.id, usuario.id, etapa).lastInsertRowid;
  evento(db, { siniestro_id: s.id, trabajo_id: id, usuario, tipo:'inicio', area: a.area, etapa });
  return { ok: true, etapa };
}

// Fotos subidas por el técnico a esta unidad (para validar que las que manda son suyas y de esta unidad).
function fotosValidas(db, siniestroId, usuarioId, ids, etapa){
  const lista = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  if(!lista.length) return [];
  return db.prepare(`SELECT id FROM archivos WHERE id IN (${lista.map(() => '?').join(',')}) AND entidad_tipo='siniestro' AND entidad_id = ?
    AND tipo='foto' AND subido_por = ? AND eliminado = 0${etapa ? ' AND etapa = ?' : ''}`).all(...lista, siniestroId, usuarioId, ...(etapa ? [etapa] : [])).map(r => r.id);
}

// ✅ Terminé (con al menos una foto del trabajo). Beto confirma pasando la unidad a la siguiente etapa.
function terminar(db, { siniestroId, usuario, fotos }){
  const { s, a, t } = cargar(db, siniestroId, usuario.id);
  if(!t || t.estado !== 'en_curso') throw error('Primero toca "Empecé".');
  const ok = fotosValidas(db, s.id, usuario.id, fotos, t.etapa);
  if(!ok.length) throw error('Toma al menos una foto del trabajo terminado.');
  db.prepare(`UPDATE patio_trabajos SET estado = 'terminado', terminado_en = datetime('now') WHERE id = ?`).run(t.id);
  evento(db, { siniestro_id: s.id, trabajo_id: t.id, usuario, tipo:'termino', area: a.area, etapa: t.etapa, fotos: ok });
  return { ok: true };
}

// ⏸ Me detuve. Pieza / daño oculto: la unidad queda Detenida y le aparece (con las fotos) a Daniela u Orlando.
function detener(db, { siniestroId, usuario, motivo, nota, fotos, registrarAuditoria }){
  const { s, a, t } = cargar(db, siniestroId, usuario.id);
  const m = MOTIVOS_PARO[motivo];
  if(!m) throw error('Elige por qué te detuviste.');
  if(!t || t.estado !== 'en_curso') throw error('Esta unidad no está en curso.');
  nota = String(nota || '').trim().slice(0, 160) || null;
  const ok = fotosValidas(db, s.id, usuario.id, fotos, 'paro');
  if(m.foto && !ok.length) throw error('Toma al menos una foto para que vean el problema.');
  db.prepare(`UPDATE patio_trabajos SET estado = 'pausado', pausado_en = datetime('now'), motivo_paro = ?, nota_paro = ? WHERE id = ?`).run(motivo, nota, t.id);
  evento(db, { siniestro_id: s.id, trabajo_id: t.id, usuario, tipo:'pausa', area: a.area, etapa: t.etapa, motivo, nota, fotos: ok });
  if(m.detiene && s.estado_produccion !== 'detenido'){
    const notaDet = `Reporta ${nombreCorto(usuario.nombre)}${nota ? ': ' + nota : ''}`.slice(0, 200);
    db.prepare(`UPDATE siniestros SET estado_produccion = 'detenido', detenido_motivo = ?, detenido_nota = ?, detenido_desde = datetime('now'), actualizado_en = datetime('now') WHERE id = ?`)
      .run(m.detiene, notaDet, s.id);
    if(registrarAuditoria){
      registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'edicion', campo:'estado_produccion', valor_anterior: s.estado_produccion, valor_nuevo:'detenido', usuario });
      registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'detenida', campo:'detenido_motivo', valor_anterior: s.detenido_motivo || null, valor_nuevo: m.detiene + ' — ' + notaDet, usuario });
    }
  }
  return { ok: true, avisa: m.avisa };
}

// ▶ Seguir, después de una pausa (cuando ya se resolvió).
function seguir(db, { siniestroId, usuario }){
  const { s, a, t } = cargar(db, siniestroId, usuario.id);
  if(!t || t.estado !== 'pausado') throw error('Esta unidad no está detenida.');
  if(s.estado_produccion === 'detenido') throw error('La unidad sigue detenida. Cuando se resuelva, Beto la reanuda.');
  let etapa = t.etapa;
  if(s.estado_produccion !== t.etapa){
    if(!AREAS[a.area].etapas.includes(s.estado_produccion)) throw error(`La unidad ya está en ${ETIQUETA_ETAPA[s.estado_produccion] || s.estado_produccion}.`);
    etapa = s.estado_produccion;
  }
  db.prepare(`UPDATE patio_trabajos SET estado = 'en_curso', etapa = ?, pausado_en = NULL, motivo_paro = NULL, nota_paro = NULL WHERE id = ?`).run(etapa, t.id);
  evento(db, { siniestro_id: s.id, trabajo_id: t.id, usuario, tipo:'reanuda', area: a.area, etapa });
  return { ok: true };
}

// Cuando Beto (o Roberto) cambia la etapa de la unidad: lo que se trabajaba en la etapa anterior queda cerrado
// (Beto confirmó el "Terminé"). Si la unidad sale de "Detenido", la pausa del técnico sigue abierta para que toque "Seguir".
function alCambiarEtapa(db, anterior, nuevo){
  const antes = anterior.estado_produccion || null, ahora = nuevo.estado_produccion || null;
  if(antes === ahora || ahora === 'detenido') return;
  const abiertos = db.prepare(`SELECT t.*, a.area FROM patio_trabajos t JOIN patio_asignaciones a ON a.id = t.asignacion_id
    WHERE t.siniestro_id = ? AND t.estado != 'cerrado'`).all(anterior.id);
  for(const t of abiertos){
    if(t.etapa === ahora) continue;
    if(antes === 'detenido' && t.estado === 'pausado' && AREAS[t.area] && AREAS[t.area].etapas.includes(ahora)){
      db.prepare(`UPDATE patio_trabajos SET etapa = ? WHERE id = ?`).run(ahora, t.id);
      continue;
    }
    db.prepare(`UPDATE patio_trabajos SET estado = 'cerrado', cerrado_en = datetime('now') WHERE id = ?`).run(t.id);
  }
}

// Fotos de evidencia del último paro de la unidad (para Daniela / Orlando en "Unidades detenidas").
function evidenciaParo(db, siniestroId){
  const e = db.prepare(`SELECT usuario_nombre, motivo, nota, fotos, creado_en FROM patio_eventos WHERE siniestro_id = ? AND tipo = 'pausa' ORDER BY id DESC LIMIT 1`).get(siniestroId);
  if(!e) return null;
  let fotos = []; try{ fotos = JSON.parse(e.fotos || '[]'); }catch(x){}
  return { reporta: e.usuario_nombre, motivo: e.motivo, nota: e.nota, fotos, creado_en: e.creado_en };
}

// ---- Avisos push (server/push.js) ----
const RECIENTE = "datetime('now','-3 days')";
function unidadTxt(x){ return [x.vehiculo, x.placas, x.numero].filter(Boolean).join(' · '); }
function avisosParo(db, motivos, titulo){
  const ph = motivos.map(() => '?').join(',');
  return db.prepare(`SELECT e.id, e.motivo, e.nota, e.usuario_nombre, s.vehiculo, s.placas, s.numero FROM patio_eventos e JOIN siniestros s ON s.id = e.siniestro_id
    WHERE e.tipo = 'pausa' AND e.motivo IN (${ph}) AND e.creado_en >= ${RECIENTE}`).all(...motivos)
    .map(e => ({ clave:`patio-${e.id}`, titulo, cuerpo:`${unidadTxt(e)}: ${MOTIVOS_PARO[e.motivo].etiqueta}${e.nota ? ' (' + e.nota + ')' : ''}. Reporta ${nombreCorto(e.usuario_nombre)}.` }));
}
const pushDaniela = db => avisosParo(db, ['falta_pieza', 'pieza_mal'], '⛔ Detenida en patio: pieza');
const pushOrlando = db => avisosParo(db, ['dano_oculto'], '⛔ Daño oculto en patio');
function pushBeto(db){
  const terminados = db.prepare(`SELECT e.id, e.etapa, e.usuario_nombre, s.vehiculo, s.placas, s.numero FROM patio_eventos e JOIN siniestros s ON s.id = e.siniestro_id
    WHERE e.tipo = 'termino' AND e.creado_en >= ${RECIENTE}`).all()
    .map(e => ({ clave:`patio-${e.id}`, titulo:`✅ ${nombreCorto(e.usuario_nombre)} terminó ${ETIQUETA_ETAPA[e.etapa] || ''}`, cuerpo:`${unidadTxt(e)}: revísala y pásala a la siguiente etapa.` }));
  return terminados.concat(avisosParo(db, ['falta_material'], '🧴 Falta material en patio'));
}
function pushTecnico(db, usuario){
  return db.prepare(`SELECT a.id, a.area, s.vehiculo, s.placas, s.numero FROM patio_asignaciones a JOIN siniestros s ON s.id = a.siniestro_id
    WHERE a.usuario_id = ? AND a.activo = 1 AND a.asignado_en >= ${RECIENTE}`).all(usuario.id)
    .map(a => ({ clave:`asig-${a.id}`, titulo:'🔧 Beto te asignó una unidad', cuerpo:`${[a.vehiculo, a.placas].filter(Boolean).join(' · ')}: ${AREAS[a.area].etiqueta}` }));
}

module.exports = { AREAS, MOTIVOS_PARO, ETIQUETA_ETAPA, asegurarTablasPatio, personalPatio, vistaBeto, asignar, misTrabajos, empezar, terminar, detener, seguir,
  alCambiarEtapa, evidenciaParo, pushDaniela, pushOrlando, pushBeto, pushTecnico, nombreCorto };
