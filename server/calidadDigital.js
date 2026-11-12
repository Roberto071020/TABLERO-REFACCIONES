// ===================== Checklist de calidad digital por OT (12-nov-2026) =====================
// Roberto (12-nov-2026): "Veo que los expedientes se están atorando un poco en la revisión de calidad ... no se que
// tan complicado sería que ese checklist se tuviera de manera digital dentro de SC Control y se pudiera contestar
// ahí mismo desde el teléfono para no depender de una hoja física que se llena a mano". Sin botón de imprimir
// ("en caso de ser necesario supongo que la puedo descargar e imprimir yo").
//
// Es la misma hoja que se imprimía (checklist QA por OT), ahora en el celular:
//   1) Avisos de seguridad: piezas estructurales o de suspensión/frenos/dirección NO AUTORIZADAS (en rojo, primero).
//   2) Los 8 puntos generales, con el mismo texto de la hoja impresa.
//   3) Un punto por cada pieza autorizada de la OT, con lo que hay que verificar según la operación.
// Las piezas llegan cuando Claude carga la OT (POST /api/externo/ot-piezas). Sin piezas: solo los generales.
// Cada punto: Cumple / No cumple / No aplica. "No cumple" exige escribir qué corregir.

const GENERALES = [
  'Estado general exterior e interior visible; ausencia de daños nuevos evidentes.',
  'Piezas, molduras, emblemas, grapas y tornillería presentes y correctamente sujetos en zonas intervenidas o manipuladas.',
  'Apertura, cierre, alineación y seguros visibles de puertas, cofre, cajuela/tapa y elementos manipulados.',
  'Luces y funciones visibles: encendido y operación de faros, cuartos, direccionales, freno, reversa; focos, conectores y tapas.',
  'Cristales, espejos, limpiaparabrisas, elevadores, manijas, sensores/cámara u otras funciones visibles.',
  'Tablero sin testigos nuevos atribuibles al proceso; registrar testigos existentes o pendientes.',
  'Limpieza final: sin polvo de lijado, residuos, manchas, cinta, compuesto, sobrepulverización o piezas sueltas.',
  'Revisión visual final de ajuste, uniformidad y presentación general; observaciones documentadas antes de liberar.',
];
const RESULTADOS = ['cumple', 'no_cumple', 'no_aplica'];

// Partes cuya falta de autorización es un riesgo (estructura, suspensión, dirección, frenos). Lo demás NO AUTORIZADO
// (molduras, grapas, faros, etc.) no genera aviso, igual que en la hoja impresa.
const SEGURIDAD = /LARGUERO|POSTE|PILAR|MARCO|ALMA|SOPORTE|BRACKET|PISO DE CAJUELA|ESQUINERO|BASE DE CALAVERA|PARED DE FUEGO|AMORTIGUADOR|BALERO|MANGO|SENSOR ABS|\bABS\b|FRENO|DIRECCION|SUSPENSION|HORQUILLA|BRAZO|ROTULA|TIJERA|BIELETA|TERMINAL|BARRA ESTABILIZADORA|\bRIN\b/;

const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

function laminacion(t){
  const x = norm(t);
  if(/NO AUTORIZ|NO SE AUTORIZA|NO AMPARAD/.test(x)) return 'no_autorizado';
  if(/CAMBIO|SUSTITU/.test(x)) return 'cambio';
  if(/REPARA/.test(x)) return 'reparar';
  if(/AJUST|ALINE|CHECAR|REVISAR/.test(x)) return 'ajuste';
  if(/AUTORIZADO/.test(x)) return 'autorizado';
  return '';
}
function pintura(t){
  const x = norm(t);
  if(/COMPLET/.test(x)) return 'completa';
  if(/RESANE/.test(x)) return 'resane';
  if(/PULI|HIDRAT/.test(x)) return 'pulir';
  return '';
}
const LAM = {
  cambio: ['cambio', 'pieza nueva bien instalada, ajustada y alineada; si tiene función, funciona'],
  reparar: ['reparación', 'forma y línea recuperadas, sin ondulaciones ni golpes'],
  ajuste: ['ajuste/revisión', 'ajuste y alineación correctos'],
  autorizado: ['operación autorizada', 'realizada correctamente'],
};
const PIN = {
  completa: ['pintura completa', 'tono, brillo y cobertura uniformes, sin escurridos ni polvo'],
  resane: ['resane', 'empate invisible con el resto de la pieza'],
  pulir: ['pulido', 'acabado uniforme, sin rayas ni marcas'],
};

function puntosCalidad(piezas){
  const puntos = [];
  const usadas = new Set();
  const clave = base => { let k = base, i = 2; while(usadas.has(k)) k = base + '#' + (i++); usadas.add(k); return k; };
  const lista = piezas || [];
  for(const p of lista){
    const pieza = String(p.pieza || '').trim();
    if(pieza && laminacion(p.laminacion) === 'no_autorizado' && SEGURIDAD.test(norm(pieza))){
      puntos.push({ clave: clave('s:' + norm(pieza)), seccion: 'Avisos de seguridad', critico: true,
        texto: `${pieza} (NO AUTORIZADO): inspeccionar antes de liberar; documentar su estado y avisar a la aseguradora.` });
    }
  }
  GENERALES.forEach((t, i) => puntos.push({ clave: 'g' + (i + 1), seccion: 'General', critico: false, texto: t }));
  for(const p of lista){
    const pieza = String(p.pieza || '').trim();
    const l = laminacion(p.laminacion), q = pintura(p.pintura);
    if(!pieza || l === 'no_autorizado' || (!LAM[l] && !PIN[q])) continue;
    const que = [LAM[l] && LAM[l][0], PIN[q] && PIN[q][0]].filter(Boolean).join(' + ');
    const verificar = [LAM[l] && LAM[l][1], PIN[q] && PIN[q][1]].filter(Boolean).join('; ');
    const t = que.charAt(0).toUpperCase() + que.slice(1);
    puntos.push({ clave: clave('p:' + norm(pieza)), seccion: 'Trabajos de la OT', critico: false, texto: `${pieza} — ${t}: ${verificar}.` });
  }
  return puntos;
}

function asegurarTablas(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS ot_piezas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
      orden INTEGER NOT NULL,
      pieza TEXT NOT NULL,
      laminacion TEXT,
      pintura TEXT,
      proveedor TEXT,
      archivo_id INTEGER,
      cargado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ot_piezas_siniestro ON ot_piezas(siniestro_id);
    CREATE TABLE IF NOT EXISTS calidad_respuestas (
      siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
      clave TEXT NOT NULL,
      seccion TEXT,
      texto TEXT NOT NULL,
      resultado TEXT NOT NULL CHECK(resultado IN ('cumple','no_cumple','no_aplica')),
      observacion TEXT,
      inspector_id INTEGER,
      inspector_nombre TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (siniestro_id, clave)
    );
  `);
}

function piezasDe(db, siniestroId){
  return db.prepare('SELECT pieza, laminacion, pintura, proveedor FROM ot_piezas WHERE siniestro_id = ? ORDER BY orden').all(siniestroId);
}

// La OT más reciente reemplaza la lista anterior.
function guardarPiezas(db, siniestroId, piezas, archivoId){
  const limpias = (Array.isArray(piezas) ? piezas : []).map(p => ({
    pieza: String((p && p.pieza) || '').trim().slice(0, 200), laminacion: String((p && p.laminacion) || '').trim().slice(0, 120),
    pintura: String((p && p.pintura) || '').trim().slice(0, 120), proveedor: String((p && p.proveedor) || '').trim().slice(0, 200),
  })).filter(p => p.pieza);
  if(!limpias.length) throw new Error('No llegó ninguna pieza.');
  db.prepare('DELETE FROM ot_piezas WHERE siniestro_id = ?').run(siniestroId);
  const st = db.prepare('INSERT INTO ot_piezas (siniestro_id, orden, pieza, laminacion, pintura, proveedor, archivo_id) VALUES (?,?,?,?,?,?,?)');
  limpias.forEach((p, i) => st.run(siniestroId, i + 1, p.pieza, p.laminacion, p.pintura, p.proveedor, archivoId || null));
  return limpias.length;
}

function revisionDe(db, siniestroId){
  const piezas = piezasDe(db, siniestroId);
  const resp = {};
  db.prepare('SELECT * FROM calidad_respuestas WHERE siniestro_id = ?').all(siniestroId).forEach(r => { resp[r.clave] = r; });
  const puntos = puntosCalidad(piezas).map(p => {
    const r = resp[p.clave];
    return { ...p, resultado: r ? r.resultado : null, observacion: r ? r.observacion : '', inspector_nombre: r ? r.inspector_nombre : null, fecha: r ? r.fecha : null };
  });
  return { tiene_ot: piezas.length > 0, puntos };
}

// Guarda la revisión completa. Regresa { todo_bien, no_cumple: [...] }.
function guardarRevision(db, siniestroId, respuestas, usuario){
  const { puntos } = revisionDe(db, siniestroId);
  const porClave = {};
  (Array.isArray(respuestas) ? respuestas : []).forEach(r => { if(r && r.clave) porClave[r.clave] = r; });
  const faltan = puntos.filter(p => !RESULTADOS.includes(porClave[p.clave] && porClave[p.clave].resultado));
  if(faltan.length) throw Object.assign(new Error(`Faltan ${faltan.length} punto(s) por revisar.`), { status: 400 });
  const sinTexto = puntos.filter(p => porClave[p.clave].resultado === 'no_cumple' && !String(porClave[p.clave].observacion || '').trim());
  if(sinTexto.length) throw Object.assign(new Error('Escribe qué hay que corregir en cada punto que no cumple.'), { status: 400 });

  db.prepare('DELETE FROM calidad_respuestas WHERE siniestro_id = ?').run(siniestroId);
  const st = db.prepare(`INSERT INTO calidad_respuestas (siniestro_id, clave, seccion, texto, resultado, observacion, inspector_id, inspector_nombre) VALUES (?,?,?,?,?,?,?,?)`);
  for(const p of puntos){
    const r = porClave[p.clave];
    st.run(siniestroId, p.clave, p.seccion, p.texto, r.resultado, String(r.observacion || '').trim().slice(0, 1000), usuario && usuario.id || null, usuario && usuario.nombre || null);
  }
  const noCumple = puntos.filter(p => porClave[p.clave].resultado === 'no_cumple').map(p => ({ texto: p.texto, observacion: String(porClave[p.clave].observacion).trim() }));
  // Compatibilidad con el checklist anterior (7 dimensiones): si todo cumple, sus rechazos viejos quedan corregidos,
  // para que no bloqueen la liberación (PATCH /api/siniestros, regla de la tabla 16).
  if(!noCumple.length){
    db.prepare(`UPDATE checklist_calidad SET resultado='aprobado', correccion=COALESCE(NULLIF(correccion,''),'Corregido (revisión digital por OT)'), actualizado_en=datetime('now')
      WHERE siniestro_id = ? AND resultado = 'rechazado'`).run(siniestroId);
  }
  return { todo_bien: !noCumple.length, no_cumple: noCumple };
}

// Lo que falta corregir según la última revisión digital (para las pantallas de calidad pendiente).
function pendientesDeCorregir(db, siniestroId){
  return db.prepare(`SELECT texto, observacion FROM calidad_respuestas WHERE siniestro_id = ? AND resultado = 'no_cumple'`).all(siniestroId);
}

module.exports = { GENERALES, puntosCalidad, asegurarTablas, guardarPiezas, piezasDe, revisionDe, guardarRevision, pendientesDeCorregir };
