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
  aseguradora_regla_aplicada:'Regla aplicada', fecha_entrega_prevista:'Fecha de entrega', estado_produccion:'Etapa',
  cita_fecha:'Cita de reingreso', fecha_entrega_real:'Fecha entregada', estado_entrega:'Estado de entrega' };

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

function analizar(db, texto){
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
        // "AUTOSURTIDO GNP": tiene piezas a cambio pero NO van a Inpart (GNP con 1 a 3 piezas).
        const aseg = nuevo.aseguradora || (actual && actual.aseguradora);
        if(aseg !== 'GNP') r.errores.push(`Autosurtido solo aplica para GNP (esta unidad es ${aseg || 'sin aseguradora'}).`);
        else{
          nuevo.requiere_refacciones = 'si';
          nuevo.aseguradora_ruta_refacciones = 'autosurtido';
          nuevo.aseguradora_regla_aplicada = 'GNP marcada como autosurtido (1 a 3 piezas a cambio) en la actualización de unidades. Nunca debe figurar como pendiente de Inpart.';
        }
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
    if(f.autorizada){
      const v = siNo(f.autorizada);
      const estadoActual = actual ? actual.estado_autorizacion : null;
      if(v === 'si'){
        if(!['autorizada','parcial'].includes(estadoActual)){
          nuevo.estado_autorizacion = 'autorizada';
          if(!(actual && actual.autorizacion_fecha_respuesta)) nuevo.autorizacion_fecha_respuesta = hoy;
          if(!(actual && actual.autorizador)) nuevo.autorizador = 'Actualización masiva';
        }
      } else if(v === 'no'){
        if(['autorizada','parcial'].includes(estadoActual)) r.avisos.push('En el tablero ya está autorizada; no se cambia a "no". Corrígelo en la ficha si es un error.');
        else if(!estadoActual) nuevo.estado_autorizacion = 'en_autorizacion';
      } else r.errores.push(`"Autorizada" debe ser SI o NO (llegó "${f.autorizada}").`);
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
    if(nuevo.fecha_entrega_prevista && nuevo.fecha_entrega_prevista < hoy && !nuevo.fecha_entrega_real && !(actual && actual.fecha_entrega_real)){
      r.avisos.push('La fecha de entrega ya pasó: va a aparecer como vencida.');
    }

    if(r.errores.length){ r.accion = 'error'; return r; }
    for(const [campo, valor] of Object.entries(nuevo)){
      const antes = actual ? actual[campo] : null;
      if(String(antes == null ? '' : antes) === String(valor == null ? '' : valor)) continue;
      r.cambios.push({ campo, etiqueta: ETIQUETA_CAMPO[campo] || campo, antes: mostrar(campo, antes), despues: mostrar(campo, valor), valor });
    }
    if(r.accion === 'actualizar' && !r.cambios.length) r.accion = 'sin_cambios';
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
  return { resumen, filas: resultado, columnas: p.columnas };
}

function mostrar(campo, v){
  if(v == null || v === '') return '—';
  if(campo === 'estado_produccion') return ETIQUETA_ETAPA[v] || v;
  if(campo === 'requiere_refacciones') return v === 'si' ? 'Sí' : v === 'no' ? 'No' : 'Sin definir';
  if(campo === 'aseguradora_ruta_refacciones') return ({ autosurtido:'Autosurtido GNP', inpart:'Inpart', pago_danos:'Pago de daños', pendiente_confirmar:'Por confirmar' })[v] || v;
  return String(v);
}

function aplicar(db, texto, usuario){
  const a = analizar(db, texto);
  if(a.error) return a;
  const aplicables = a.filas.filter(r => r.accion === 'crear' || r.accion === 'actualizar');
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
      }
    }
    db.exec('COMMIT');
  }catch(e){
    db.exec('ROLLBACK');
    throw e;
  }
  return { ...a, aplicadas: aplicables.length };
}

function limpiarSalida(a){
  if(!a || a.error) return a;
  return { ...a, filas: a.filas.map(({ _actualId, ...r }) => ({ ...r, cambios: r.cambios.map(({ valor, ...c }) => c) })) };
}

module.exports = { analizar, aplicar, parsearTabla, limpiarSalida };
