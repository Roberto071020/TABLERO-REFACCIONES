// ===================== Actualización rápida de unidades (4-nov-2026) =====================
// Roberto: antes del arranque del lunes se va a poner al día TODO el tablero. El equipo llena una tabla
// sencilla (Excel o WhatsApp) y se pega aquí. Solo toca los campos de la plantilla; una celda vacía
// significa "no cambiar". Funciona en dos pasos, igual que la carga masiva de Daniela:
//   1) validar  -> muestra qué va a cambiar en cada unidad, sin guardar nada.
//   2) confirmar -> aplica todo en una sola transacción y deja cada cambio en la auditoría.
const { registrarAuditoria, normalizarFechaISO, normalizarAseguradora, calcularRutaAseguradora } = require('./utils');

// Encabezados aceptados (sin acentos, minúsculas, sin espacios extra) -> campo interno.
const ENCABEZADOS = {
  'siniestro':'siniestro', 'numero de siniestro':'siniestro', 'no. siniestro':'siniestro', 'no siniestro':'siniestro', 'numero':'siniestro',
  'aseguradora':'aseguradora',
  'vehiculo':'vehiculo',
  'placas':'placas', 'placa':'placas',
  'ubicacion':'ubicacion', 'piso/transito':'ubicacion', 'p/t':'ubicacion',
  'autorizada':'autorizada', 'autorizado':'autorizada',
  'requiere refacciones':'requiere_refacciones', 'refacciones':'requiere_refacciones', 'requiere piezas':'requiere_refacciones',
  'piezas a cambio':'piezas', 'piezas autorizadas a cambio':'piezas', 'no. piezas':'piezas', 'piezas':'piezas',
  'fecha entrega':'fecha_entrega', 'fecha de entrega':'fecha_entrega', 'fecha promesa':'fecha_entrega', 'fecha promesa de entrega':'fecha_entrega',
  'etapa':'etapa', 'etapa actual':'etapa',
  'archivar':'archivar', 'archivada':'archivar', 'archivado':'archivar',
  'no autorizadas':'no_autorizadas', 'piezas no autorizadas':'no_autorizadas', 'componentes no autorizados':'no_autorizadas', 'no autorizado':'no_autorizadas', // 11-nov-2026
  'expediente':'expediente', 'expediente enviado':'expediente', 'expediente completo':'expediente', 'expediente completo enviado':'expediente', // 11-nov-2026 // 11-nov-2026: SI = archivar (p. ej. pérdida total)
  'revision':'revision', 'estado revision':'revision', 'pendiente':'revision',
  'cita reingreso':'cita', 'fecha cita reingreso':'cita', 'cita':'cita', 'fecha cita':'cita',
  'entregada':'entregada', 'fecha entregada':'entregada', 'fecha entregado':'entregada', 'entregado':'entregada'
};

const ETAPAS = {
  'sin iniciar':'programado', 'programado':'programado', 'en espera':'programado',
  'mecanica':'mecanica',
  'hojalateria':'en_laminado', 'laminado':'en_laminado', 'laminacion':'en_laminado',
  'preparacion':'preparacion',
  'pintura':'pintura',
  'armado':'armado',
  'pulido':'pulido', 'detallado':'pulido',
  'lavado':'lavado',
  'detenido':'detenido',
  'terminado':'terminado'
};
const ETIQUETA_ETAPA = { programado:'Sin iniciar', mecanica:'Mecánica', en_laminado:'Hojalatería', preparacion:'Preparación',
  pintura:'Pintura', armado:'Armado', pulido:'Pulido', lavado:'Lavado', detenido:'Detenido', terminado:'Terminado' };

const ETIQUETA_CAMPO = { aseguradora:'Aseguradora', vehiculo:'Vehículo', placas:'Placas', ubicacion:'Ubicación',
  estado_autorizacion:'Autorización', autorizacion_fecha_respuesta:'Fecha de autorización', autorizador:'Autorizó',
  requiere_refacciones:'Requiere refacciones', piezas_autorizadas_cambio:'Piezas a cambio', aseguradora_ruta_refacciones:'Esquema de surtido',
  aseguradora_regla_aplicada:'Regla aplicada', archivado:'Archivada', archivado_en:'Archivada el', fecha_entrega_prevista:'Fecha de entrega', estado_produccion:'Etapa',
  fecha_hora_disponible_revision:'Disponible para revisión', estado_revision_tecnica:'Revisión técnica', excel_capturado:'Capturado en Excel',
  fotos_completas:'Fotos completas', enviado_propietario:'Enviado a Roberto', estado_expediente:'Expediente',
  cita_fecha:'Cita de reingreso', reingreso_recibido_en:'Llegó a su cita', fecha_entrega_real:'Fecha entregada', estado_entrega:'Estado de entrega' };

function limpiar(t){
  return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function siNo(v){
  const t = limpiar(v);
  if(['si','s','yes','x','1'].includes(t)) return 'si';
  if(['no','n','0'].includes(t)) return 'no';
  return null;
}
function hoyMexico(){
  return new Intl.DateTimeFormat('en-CA', { timeZone:'America/Mexico_City', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}
function fecha(v){
  const t = String(v || '').trim().replace(/\./g, '/');
  if(!t) return { ok:true, valor:null };
  let iso = normalizarFechaISO(t.replace(/^(\d{1,2})-(\d{1,2})-(\d{4})$/, '$1/$2/$3'));
  // Año de 2 dígitos (04/11/26)
  const corto = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if(corto) iso = `20${corto[3]}-${corto[2].padStart(2,'0')}-${corto[1].padStart(2,'0')}`;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { ok:false };
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if(dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { ok:false };
  return { ok:true, valor:iso };
}

// Acepta lo que sale al copiar celdas de Excel (separado por tabuladores) o un CSV con comas.
function parsearTabla(texto){
  const lineas = String(texto || '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim() !== '');
  if(!lineas.length) return { error:'No pegaste ninguna información.' };
  const sep = lineas[0].includes('\t') ? '\t' : (lineas[0].includes(';') && !lineas[0].includes(',') ? ';' : ',');
  const partir = l => {
    if(sep !== ',') return l.split(sep).map(x => x.trim());
    const out = []; let campo = '', comillas = false;
    for(let i = 0; i < l.length; i++){
      const c = l[i];
      if(comillas){ if(c === '"'){ if(l[i+1] === '"'){ campo += '"'; i++; } else comillas = false; } else campo += c; }
      else if(c === '"') comillas = true;
      else if(c === ','){ out.push(campo.trim()); campo = ''; }
      else campo += c;
    }
    out.push(campo.trim());
    return out;
  };
  const encabezado = partir(lineas[0]).map(h => ENCABEZADOS[limpiar(h)] || null);
  if(!encabezado.includes('siniestro')){
    return { error:'La primera fila debe traer los títulos de la plantilla, empezando por SINIESTRO.' };
  }
  const filas = lineas.slice(1).map((l, i) => {
    const celdas = partir(l);
    const f = { _fila: i + 2 };
    encabezado.forEach((campo, j) => { if(campo) f[campo] = (celdas[j] || '').trim(); });
    return f;
  }).filter(f => Object.keys(f).some(k => k !== '_fila' && f[k]));
  return { filas, columnas: encabezado.filter(Boolean) };
}

function analizar(db, texto, { archivarFaltantes = false } = {}){
  const p = parsearTabla(texto);
  if(p.error) return { error: p.error };
  const hoy = hoyMexico();
  const vistos = new Map();
  const resultado = p.filas.map(f => {
    const r = { fila: f._fila, siniestro: f.siniestro || '', accion:'actualizar', cambios:[], errores:[], avisos:[] };
    if(!f.siniestro){ r.errores.push('Falta el número de siniestro.'); r.accion = 'error'; return r; }
    if(/e\+\d+$/i.test(f.siniestro)){
      r.errores.push('El número de siniestro llegó cortado por Excel (formato 4.26E+15). Pon la columna como Texto y vuelve a copiarla.');
      r.accion = 'error'; return r;
    }
    if(vistos.has(f.siniestro)) r.avisos.push(`Repetido en la fila ${vistos.get(f.siniestro)}; se aplica el último.`);
    vistos.set(f.siniestro, f._fila);

    const actual = db.prepare(`SELECT * FROM siniestros WHERE numero = ?`).get(f.siniestro);
    const nuevo = {};
    if(!actual){
      if(!f.aseguradora){ r.errores.push('No existe en el tablero. Para crearlo hace falta la aseguradora.'); r.accion = 'error'; return r; }
      r.accion = 'crear';
    }
    if(f.aseguradora) nuevo.aseguradora = normalizarAseguradora(f.aseguradora);
    if(f.vehiculo) nuevo.vehiculo = f.vehiculo;
    if(f.placas) nuevo.placas = f.placas.toUpperCase();

    if(f.ubicacion){
      const u = limpiar(f.ubicacion);
      if(u.startsWith('p')) nuevo.ubicacion = 'Piso';
      else if(u.startsWith('t')) nuevo.ubicacion = 'Tránsito';
      else r.errores.push(`Ubicación "${f.ubicacion}" no válida: usa PISO o TRANSITO.`);
    }
    if(f.requiere_refacciones){
      const v = siNo(f.requiere_refacciones);
      if(v) nuevo.requiere_refacciones = v;
      else if(limpiar(f.requiere_refacciones).startsWith('auto')){
        // "AUTOSURTIDO": tiene piezas a cambio pero NO van a Inpart. 7-nov-2026 (Roberto): cualquier
        // aseguradora puede solicitarlo para agilizar una entrega; solo GNP con 1 a 3 piezas es regla fija.
        const aseg = nuevo.aseguradora || (actual && actual.aseguradora);
        nuevo.requiere_refacciones = 'si';
        nuevo.aseguradora_ruta_refacciones = 'autosurtido';
        nuevo.aseguradora_regla_aplicada = aseg === 'GNP'
          ? 'GNP marcada como autosurtido (1 a 3 piezas a cambio) en la actualización de unidades. Nunca debe figurar como pendiente de Inpart.'
          : `${aseg || 'Aseguradora'}: autosurtido a solicitud de la aseguradora (actualización de unidades). No va a Inpart.`;
      }
      else r.errores.push(`"Requiere refacciones" debe ser SI, NO o AUTOSURTIDO GNP (llegó "${f.requiere_refacciones}").`);
    }
    if(f.piezas){
      const n = Number(String(f.piezas).trim());
      if(!Number.isInteger(n) || n < 0 || n > 99) r.errores.push(`"Piezas a cambio" debe ser un número entero (llegó "${f.piezas}").`);
      else{
        nuevo.piezas_autorizadas_cambio = n;
        // Mismo motor de reglas que usa la ficha: GNP 1-3 piezas -> autosurtido; 4+ -> Inpart.
        const aseg = nuevo.aseguradora || (actual && actual.aseguradora);
        const ruta = calcularRutaAseguradora(aseg, n);
        nuevo.aseguradora_ruta_refacciones = ruta.ruta;
        nuevo.aseguradora_regla_aplicada = ruta.regla;
        if(!nuevo.requiere_refacciones) nuevo.requiere_refacciones = n > 0 ? 'si' : 'no';
        else if(n > 0 && nuevo.requiere_refacciones === 'no') r.avisos.push('Dice que NO requiere refacciones pero tiene piezas a cambio; revisa cuál es correcto.');
      }
    }
    // 7-nov-2026 (Roberto): unidades que todavía no se valúan. REVISION = "PENDIENTE" -> a la pantalla de Orlando
    // (Revisar unidades nuevas); "POR VALUAR" -> ya revisada y con expediente enviado, a la lista de Valuación de
    // Roberto. En ambos casos queda SIN autorización (no "en autorización", que significa enviada a la aseguradora).
    let revision = null;
    if(f.revision){
      const t = limpiar(f.revision);
      if(t.startsWith('pend') || t.startsWith('revis')) revision = 'pendiente';
      else if(t.includes('valu')) revision = 'por_valuar';
      else r.errores.push(`"Revisión" debe ser PENDIENTE o POR VALUAR (llegó "${f.revision}").`);
    }
    if(revision){
      if(actual && ['autorizada','parcial'].includes(actual.estado_autorizacion)){
        r.avisos.push('Ya está autorizada en el tablero; no se regresa a revisión.'); revision = null;
      } else {
        nuevo.estado_autorizacion = null;
        if(revision === 'pendiente'){
          if(!(actual && actual.fecha_hora_disponible_revision)) nuevo.fecha_hora_disponible_revision = new Date().toISOString().replace('T', ' ').slice(0, 19);
          if(actual && actual.estado_revision_tecnica === 'revision_terminada') r.avisos.push('En el tablero ya tenía la revisión terminada; se deja así.');
        } else {
          if(!(actual && actual.fecha_hora_disponible_revision)) nuevo.fecha_hora_disponible_revision = new Date().toISOString().replace('T', ' ').slice(0, 19);
          nuevo.estado_revision_tecnica = 'revision_terminada';
          nuevo.excel_capturado = 1; nuevo.fotos_completas = 1; nuevo.enviado_propietario = 1;
          nuevo.estado_expediente = 'listo_para_valuacion';
        }
      }
    }
    if(f.autorizada && !revision){
      const v = siNo(f.autorizada);
      const estadoActual = actual ? actual.estado_autorizacion : null;
      if(v === 'si'){
        if(!['autorizada','parcial'].includes(estadoActual)){
          nuevo.estado_autorizacion = 'autorizada';
          if(!(actual && actual.autorizacion_fecha_respuesta)) nuevo.autorizacion_fecha_respuesta = hoy;
          if(!(actual && actual.autorizador)) nuevo.autorizador = 'Actualización masiva';
        }
      } else if(/^parc/i.test(limpiar(f.autorizada))){
        // 11-nov-2026: autorización PARCIAL (la aseguradora no autorizó algunas piezas).
        if(estadoActual !== 'parcial'){
          nuevo.estado_autorizacion = 'parcial';
          if(!(actual && actual.autorizacion_fecha_respuesta)) nuevo.autorizacion_fecha_respuesta = hoy;
          if(!(actual && actual.autorizador)) nuevo.autorizador = 'Actualización masiva';
        }
      } else if(v === 'no'){
        if(['autorizada','parcial'].includes(estadoActual)) r.avisos.push('En el tablero ya está autorizada; no se cambia a "no". Corrígelo en la ficha si es un error.');
        else if(!estadoActual) nuevo.estado_autorizacion = 'en_autorizacion';
      } else r.errores.push(`"Autorizada" debe ser SI, NO o PARCIAL (llegó "${f.autorizada}").`);
    }
    for(const [col, campo, etiqueta] of [['fecha_entrega','fecha_entrega_prevista','Fecha de entrega'], ['cita','cita_fecha','Cita de reingreso'], ['entregada','fecha_entrega_real','Fecha entregada']]){
      if(!f[col]) continue;
      const fx = fecha(f[col]);
      if(!fx.ok) r.errores.push(`${etiqueta} "${f[col]}" no es una fecha válida (usa DD/MM/AAAA).`);
      else nuevo[campo] = fx.valor;
    }
    if(f.etapa){
      const e = ETAPAS[limpiar(f.etapa)];
      if(e) nuevo.estado_produccion = e;
      else r.errores.push(`Etapa "${f.etapa}" no válida. Usa: ${Object.values(ETIQUETA_ETAPA).join(', ')}.`);
    }
    // Una unidad entregada sale de las listas de producción.
    if(nuevo.fecha_entrega_real){
      nuevo.estado_entrega = 'entregado';
      if(!nuevo.estado_produccion) nuevo.estado_produccion = 'terminado';
      else if(nuevo.estado_produccion !== 'terminado'){ r.avisos.push('Tiene fecha de entregada; la etapa se registra como Terminado.'); nuevo.estado_produccion = 'terminado'; }
    }
    // 7-nov-2026: si la unidad está en PISO y su cita ya pasó (o es hoy), ya llegó aunque nadie lo haya
    // registrado: se marca la llegada para que no le salga a Alejandra como "no ha llegado" ni a Beto como
    // "reingreso por llegar".
    {
      const ubic = nuevo.ubicacion || (actual && actual.ubicacion) || '';
      const cita = nuevo.cita_fecha || (actual && actual.cita_fecha) || '';
      const yaRegistrada = actual && ((actual.fecha_admision && String(actual.fecha_admision).slice(0,10) >= String(cita).slice(0,10))
        || (actual.reingreso_recibido_en && String(actual.reingreso_recibido_en).slice(0,10) >= String(cita).slice(0,10)));
      if(/^piso/i.test(ubic) && cita && String(cita).slice(0,10) <= hoy && !yaRegistrada && !nuevo.fecha_entrega_real){
        nuevo.reingreso_recibido_en = String(cita).slice(0,10);
        r.avisos.push('Está en PISO y su cita ya pasó: se registra que ya llegó.');
      }
    }
    // 9-nov-2026 (Roberto): "no puede tener fecha de entrega si no está en piso". Si la unidad está (o queda) en
    // TRÁNSITO, la fecha de la plantilla no se toma y la que tuviera en el tablero se quita.
    if(/^tr/i.test(nuevo.ubicacion || (actual && actual.ubicacion) || '') && !nuevo.fecha_entrega_real && !(actual && actual.fecha_entrega_real)){
      if(nuevo.fecha_entrega_prevista){ delete nuevo.fecha_entrega_prevista; r.avisos.push('Está circulando (TRÁNSITO): no puede tener fecha de entrega; no se toma.'); }
      if(actual && actual.fecha_entrega_prevista){ nuevo.fecha_entrega_prevista = null; r.avisos.push('Está circulando (TRÁNSITO): se quita su fecha de entrega.'); }
    }
    if(nuevo.fecha_entrega_prevista && nuevo.fecha_entrega_prevista < hoy && !nuevo.fecha_entrega_real && !(actual && actual.fecha_entrega_real)){
      r.avisos.push('La fecha de entrega ya pasó: va a aparecer como vencida.');
    }

    // Si la unidad viene en la lista pero estaba archivada, se reactiva (sigue en proceso).
    // 11-nov-2026 (Roberto: "lo de enviar expediente completo, ¿lo puedes hacer tú?"): EXPEDIENTE = SI registra el envío
    // del expediente completo (mismo efecto que el botón "Enviar expediente completo": avisa a Alejandra y Daniela).
    if(f.expediente && /^s/i.test(limpiar(f.expediente))){
      const est = nuevo.estado_autorizacion || (actual && actual.estado_autorizacion);
      if(!['autorizada','parcial'].includes(est)) r.errores.push('Para registrar el expediente completo, la unidad debe estar autorizada.');
      else if(!(actual && actual.expediente_completo_enviado_en)){
        nuevo.expediente_completo_enviado_en = new Date().toISOString();
        r.avisos.push('Expediente completo enviado: se avisa a Alejandra y Daniela.');
      }
    }
    // 11-nov-2026 (Roberto: "archívalo"): ARCHIVAR = SI saca la unidad de las listas (pérdida total, cancelada…). Se puede reactivar.
    const archivarla = f.archivar && /^s/i.test(limpiar(f.archivar));
    if(archivarla){
      if(!actual) r.errores.push('No se puede archivar una unidad que no existe en el tablero.');
      else if(!actual.archivado){ nuevo.archivado = 1; nuevo.archivado_en = new Date().toISOString().replace('T', ' ').slice(0, 19); r.avisos.push('Se archiva.'); }
    } else if(actual && actual.archivado){ nuevo.archivado = 0; nuevo.archivado_en = null; r.avisos.push('Estaba archivada: se reactiva.'); }
    if(r.errores.length){ r.accion = 'error'; return r; }
    for(const [campo, valor] of Object.entries(nuevo)){
      const antes = actual ? actual[campo] : null;
      if(String(antes == null ? '' : antes) === String(valor == null ? '' : valor)) continue;
      r.cambios.push({ campo, etiqueta: ETIQUETA_CAMPO[campo] || campo, antes: mostrar(campo, antes), despues: mostrar(campo, valor), valor });
    }
    // 11-nov-2026 (Roberto, "componentes no autorizados"): NO AUTORIZADAS = lista de piezas que la aseguradora no autorizó.
    // Deja la autorización como PARCIAL y abre la solicitud de reautorización: Orlando tiene 24 h para las fotos editadas.
    if(f.no_autorizadas && String(f.no_autorizadas).trim() && actual){
      const lista = String(f.no_autorizadas).trim();
      const est = nuevo.estado_autorizacion || actual.estado_autorizacion;
      if(est !== 'parcial' && est !== 'autorizada'){
        nuevo.estado_autorizacion = 'parcial';
        if(!actual.autorizacion_fecha_respuesta) nuevo.autorizacion_fecha_respuesta = hoy;
        if(!actual.autorizador) nuevo.autorizador = 'Actualización masiva';
        for(const campo of ['estado_autorizacion', 'autorizacion_fecha_respuesta', 'autorizador']) if(nuevo[campo] !== undefined && !r.cambios.some(c => c.campo === campo))
          r.cambios.push({ campo, etiqueta: ETIQUETA_CAMPO[campo] || campo, antes: mostrar(campo, actual[campo]), despues: mostrar(campo, nuevo[campo]), valor: nuevo[campo] });
      }
      const ya = db.prepare(`SELECT 1 FROM complementos WHERE siniestro_id=? AND tipo='no_autorizado_inicial' AND decision='pendiente' AND pieza_operacion=?`).get(actual.id, lista);
      if(ya) r.avisos.push('La solicitud de reautorización de esas piezas ya existe.');
      else { r._reautorizar = lista; if(r.accion === 'sin_cambios' || !r.cambios.length) r.accion = 'actualizar';
        r.avisos.push(`Reautorización: Orlando tiene 24 h para mandar fotos editadas de: ${lista}.`); }
    } else if(f.no_autorizadas && String(f.no_autorizadas).trim() && !actual) r.errores.push('La unidad no existe en el tablero.');
    if(r.accion === 'actualizar' && !r.cambios.length && !r._reautorizar) r.accion = 'sin_cambios';
    r._actualId = actual ? actual.id : null;
    return r;
  });

  const resumen = {
    total: resultado.length,
    crear: resultado.filter(r => r.accion === 'crear').length,
    actualizar: resultado.filter(r => r.accion === 'actualizar').length,
    sin_cambios: resultado.filter(r => r.accion === 'sin_cambios').length,
    errores: resultado.filter(r => r.accion === 'error').length
  };
  // "Esta lista es TODO lo que está en proceso" (Roberto, 5-nov-2026): las unidades activas del tablero que
  // NO vienen en la lista se archivan (no se borran; se pueden reactivar con "Deshacer" o desde la ficha).
  let archivar = [];
  if(archivarFaltantes){
    const enLista = new Set(resultado.filter(r => r.siniestro).map(r => r.siniestro));
    archivar = db.prepare(`SELECT id, numero, aseguradora, vehiculo, placas, ubicacion, estado_produccion FROM siniestros
      WHERE archivado = 0 AND (fecha_entrega_real IS NULL OR fecha_entrega_real = '') AND COALESCE(estatus_general,'') != 'Cerrado'
      ORDER BY numero`).all().filter(s => !enLista.has(s.numero));
    resumen.archivar = archivar.length;
    const validas = resumen.crear + resumen.actualizar + resumen.sin_cambios;
    if(validas < 5){
      return { error: 'La lista tiene menos de 5 unidades válidas. Para archivar el resto, pega la lista COMPLETA de unidades en proceso.' };
    }
  }
  return { resumen, filas: resultado, columnas: p.columnas, archivar };
}

function mostrar(campo, v){
  if(v == null || v === '') return '—';
  if(campo === 'estado_produccion') return ETIQUETA_ETAPA[v] || v;
  if(campo === 'archivado') return Number(v) ? 'Sí' : 'No (activa)';
  if(campo === 'expediente_completo_enviado_en') return 'Enviado ' + String(v).slice(0, 10);
  if(campo === 'requiere_refacciones') return v === 'si' ? 'Sí' : v === 'no' ? 'No' : 'Sin definir';
  if(campo === 'aseguradora_ruta_refacciones') return ({ autosurtido:'Autosurtido', inpart:'Inpart', pago_danos:'Pago de daños', pendiente_confirmar:'Por confirmar' })[v] || v;
  return String(v);
}

function aplicar(db, texto, usuario, { archivarFaltantes = false } = {}){
  const a = analizar(db, texto, { archivarFaltantes });
  if(a.error) return a;
  const aplicables = a.filas.filter(r => r.accion === 'crear' || r.accion === 'actualizar');
  let lote = null;
  db.exec('BEGIN');
  try{
    for(const r of aplicables){
      let id = r._actualId;
      if(r.accion === 'crear'){
        const ase = r.cambios.find(c => c.campo === 'aseguradora').valor;
        id = Number(db.prepare(`INSERT INTO siniestros (numero, aseguradora, fecha_ingreso, ubicacion, responsable, creado_por)
          VALUES (?, ?, ?, 'Piso', ?, ?)`).run(r.siniestro, ase, hoyMexico(), usuario ? usuario.nombre : null, usuario ? usuario.id : null).lastInsertRowid);
        registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:id, accion:'crear_actualizacion_masiva', usuario });
      }
      const cambios = r.cambios.filter(c => !(r.accion === 'crear' && c.campo === 'aseguradora'));
      if(cambios.length){
        const sets = cambios.map(c => `${c.campo} = ?`).join(', ');
        db.prepare(`UPDATE siniestros SET ${sets}, actualizado_en = datetime('now') WHERE id = ?`).run(...cambios.map(c => c.valor), id);
        for(const c of cambios){
          registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:id, accion:'actualizacion_masiva', campo:c.campo,
            valor_anterior: c.antes === '—' ? null : c.antes, valor_nuevo: c.valor, usuario });
        }
        if(r._reautorizar) crearReautorizacion(db, id, r._reautorizar, usuario);
        if(cambios.some(c => c.campo === 'expediente_completo_enviado_en')){
          registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:id, accion:'expediente_completo_enviado', usuario });
          db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
            VALUES (?,?,?,?,'pendiente','automatica','expediente_completo_enviado',?)`)
            .run(id, 'mensaje', 'Expediente completo: evaluación autorizada, orden de trabajo y proveedores ya asignados. Alejandra: informar al cliente y coordinar entrada a producción. Daniela: dar seguimiento a los pedidos en Impart.',
              new Date().toISOString().slice(0, 10), usuario && usuario.id ? usuario.id : null);
        }
      }
    }
    if(archivarFaltantes && a.archivar.length){
      lote = 'L' + Date.now().toString(36).toUpperCase();
      asegurarTablaArchivado(db);
      for(const s of a.archivar){
        db.prepare(`UPDATE siniestros SET archivado = 1, archivado_en = datetime('now') WHERE id = ?`).run(s.id);
        db.prepare(`INSERT INTO archivado_masivo (lote, siniestro_id) VALUES (?, ?)`).run(lote, s.id);
        registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:s.id, accion:'archivado_por_actualizacion',
          valor_nuevo:`No venía en la lista de unidades en proceso (lote ${lote})`, usuario });
      }
    }
    db.exec('COMMIT');
  }catch(e){
    db.exec('ROLLBACK');
    throw e;
  }
  return { ...a, aplicadas: aplicables.length, archivadas: lote ? a.archivar.length : 0, lote };
}

// Misma solicitud que crea Roberto desde "Llegó la respuesta → Parcial" (server/routes/complementos.js): plazo de 24 h.
function crearReautorizacion(db, siniestroId, piezas, usuario){
  const limite = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const info = db.prepare(`INSERT INTO complementos (siniestro_id, causa, fecha, pieza_operacion, decision, estado, autor_id, tipo, fecha_limite)
    VALUES (?, ?, ?, ?, 'pendiente', 'detectado', ?, 'no_autorizado_inicial', ?)`)
    .run(siniestroId, 'Piezas no autorizadas por la aseguradora', new Date().toISOString().slice(0, 10), piezas, usuario && usuario.id ? usuario.id : null, limite);
  registrarAuditoria(db, { entidad_tipo:'complemento', entidad_id: info.lastInsertRowid, accion:'alta', usuario, valor_nuevo:'Reautorización: ' + piezas });
  db.prepare(`INSERT INTO tareas (siniestro_id,tipo,descripcion,fecha_limite,estado,origen,disparador,creado_por)
    VALUES (?,?,?,?,'pendiente','automatica','reautorizacion_solicitada',?)`)
    .run(siniestroId, 'aviso', `Piezas no autorizadas por la aseguradora: ${piezas}. Se necesitan fotos editadas señalando el daño antes de ${limite.slice(0,16).replace('T',' ')} para reautorizar (plazo de 24h).`,
      limite.slice(0, 10), usuario && usuario.id ? usuario.id : null);
}

function asegurarTablaArchivado(db){
  db.exec(`CREATE TABLE IF NOT EXISTS archivado_masivo (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lote TEXT NOT NULL, siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
    creado_en TEXT NOT NULL DEFAULT (datetime('now')), revertido_en TEXT);`);
}

// Deshace un archivado masivo: reactiva las unidades de ese lote que sigan archivadas.
function revertirArchivado(db, lote, usuario){
  asegurarTablaArchivado(db);
  const filas = db.prepare(`SELECT a.id, a.siniestro_id FROM archivado_masivo a JOIN siniestros s ON s.id = a.siniestro_id
    WHERE a.lote = ? AND a.revertido_en IS NULL AND s.archivado = 1`).all(lote);
  db.exec('BEGIN');
  try{
    for(const f of filas){
      db.prepare(`UPDATE siniestros SET archivado = 0, archivado_en = NULL WHERE id = ?`).run(f.siniestro_id);
      db.prepare(`UPDATE archivado_masivo SET revertido_en = datetime('now') WHERE id = ?`).run(f.id);
      registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id:f.siniestro_id, accion:'archivado_revertido', valor_nuevo:`Lote ${lote}`, usuario });
    }
    db.exec('COMMIT');
  }catch(e){ db.exec('ROLLBACK'); throw e; }
  return { reactivadas: filas.length };
}

function limpiarSalida(a){
  if(!a || a.error) return a;
  return { ...a, filas: a.filas.map(({ _actualId, ...r }) => ({ ...r, cambios: r.cambios.map(({ valor, ...c }) => c) })) };
}

module.exports = { analizar, aplicar, parsearTabla, limpiarSalida, revertirArchivado };
