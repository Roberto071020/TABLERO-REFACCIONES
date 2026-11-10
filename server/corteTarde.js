// ===================== Corte de las 3 de la tarde (9-nov-2026) =====================
// Roberto: "un reporte corto diario a las 3 pm recordando lo que no se está haciendo". Le llega a SU celular
// (tarea programada, igual que el arranque de la mañana) y él lo comparte al grupo del equipo.
// Por persona, solo lo que a esa hora sigue sin hacerse (máximo 4 renglones); quien está al día sale con ✅.
// Solo LEE: usa los mismos cálculos que la pantalla de inicio de cada quien, para que nunca digan cosas distintas.
const { calcularPanoramaBeto } = require('./panoramaBeto');
const { unidadesPorRevisarCalidad } = require('./calidadPendiente');

const ZONA = 'America/Mexico_City';
const MAX_NOMBRES = 3;
const HORAS_CALIDAD = 4;        // terminada hace 4 h o más sin revisión de calidad
const HORAS_REAUTORIZACION = 6; // mismo umbral que el inicio de Roberto

function fechaMexico(f = new Date()){ return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year:'numeric', month:'2-digit', day:'2-digit' }).format(f); }
function fechaLarga(f = new Date()){
  const t = new Intl.DateTimeFormat('es-MX', { timeZone: ZONA, weekday:'long', day:'numeric', month:'short' }).format(f);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
// Inicio del día de hoy (Veracruz, UTC-6) en el formato de la auditoría (UTC).
function inicioDiaUTC(hoy){ return hoy + ' 06:00:00'; }

// "Kwid, Taos, Beat y 2 más"
function nombres(lista, campo = 'vehiculo'){
  const n = lista.map(x => String(x[campo] || x.numero || x.siniestro_numero || '').split(' ').slice(0, 2).join(' ')).filter(Boolean);
  const vis = n.slice(0, MAX_NOMBRES).join(', ');
  return n.length > MAX_NOMBRES ? `${vis} y ${n.length - MAX_NOMBRES} más` : vis;
}
const renglon = (cant, texto, lista, campo) => cant ? `${cant} ${texto}${lista && lista.length ? ' (' + nombres(lista, campo) + ')' : ''}` : null;

function seguro(fn, def){ try{ return fn(); }catch(e){ return def; } }

function calcularCorteTarde(db, ahora = new Date()){
  const hoy = fechaMexico(ahora);
  const desde = inicioDiaUTC(hoy);
  const personas = [];

  const detenidas = seguro(() => require('./detenidas').listarDetenidas(db), []);
  const det = para => detenidas.filter(d => d.para === para);
  const renglonDet = (para, texto) => { const l = det(para); return l.length ? `${l.length} ${l.length === 1 ? 'detenida' : 'detenidas'} ${texto} (${l.map(d => String(d.vehiculo || d.numero).split(' ').slice(0, 2).join(' ') + ' ' + (d.dias === 1 ? '1 día' : d.dias + ' días')).slice(0, MAX_NOMBRES).join('; ')}${l.length > MAX_NOMBRES ? '…' : ''})` : null; };

  // ---- Beto (producción y calidad) ----
  {
    const panorama = seguro(() => calcularPanoramaBeto(db), []);
    const movidaHoy = id => !!db.prepare(`SELECT 1 FROM auditoria WHERE entidad_tipo='siniestro' AND entidad_id=? AND campo='estado_produccion' AND fecha >= ? LIMIT 1`).get(id, desde);
    const vencidas = panorama.filter(u => u.fecha_entrega_prevista && u.fecha_entrega_prevista < hoy && !u.en_transito && !movidaHoy(u.id));
    const listas = panorama.filter(u => (u.prioridad === 3 || u.prioridad === 3.5) && (!u.estado_produccion || u.estado_produccion === 'programado'));
    const sinFecha = panorama.filter(u => !u.fecha_entrega_prevista && !u.en_transito && !u.reingreso_citado && (u.refacciones_completas || u.piezas_suficientes));
    const calidad = seguro(() => unidadesPorRevisarCalidad(db, { minHoras: HORAS_CALIDAD }), []);
    personas.push({ nombre:'Beto', renglones: [
      renglon(vencidas.length, vencidas.length === 1 ? 'vencida sin avance hoy' : 'vencidas sin avance hoy', vencidas),
      renglon(calidad.length, calidad.length === 1 ? 'terminada sin revisión de calidad' : 'terminadas sin revisión de calidad', calidad),
      renglon(listas.length, listas.length === 1 ? 'lista para iniciar y sin arrancar' : 'listas para iniciar y sin arrancar', listas),
      renglon(sinFecha.length, 'sin fecha de entrega', sinFecha),
      renglonDet('beto', 'sin motivo registrado'),
    ].filter(Boolean) });
  }

  // ---- Alejandra (clientes) ----
  {
    const a = seguro(() => require('./inicioAlejandra').calcularInicioAlejandra(db), { tarjetas: [] });
    const t = a.tarjetas;
    const entregas = t.filter(x => x.tipo === 'entrega' || x.tipo === 'retraso');
    const citas = t.filter(x => x.tipo === 'cita' && String(x.cita_fecha || '').slice(0, 10) <= hoy);
    const avisos = t.filter(x => x.tipo === 'aviso');
    const seguimientos = t.filter(x => x.tipo === 'seguimiento');
    personas.push({ nombre:'Alejandra', renglones: [
      renglon(entregas.length, entregas.length === 1 ? 'entrega de hoy sin registrar' : 'entregas de hoy sin registrar', entregas),
      renglon(citas.length, citas.length === 1 ? 'cita de hoy sin registrar llegada' : 'citas de hoy sin registrar llegada', citas),
      renglon(avisos.length, avisos.length === 1 ? 'cliente sin avisar' : 'clientes sin avisar', avisos),
      renglon(seguimientos.length, seguimientos.length === 1 ? 'seguimiento de hoy pendiente' : 'seguimientos de hoy pendientes'),
    ].filter(Boolean) });
  }

  // ---- Daniela (refacciones) ----
  {
    const d = seguro(() => require('./inicioDaniela').calcularInicioDaniela(db), null);
    const r = [];
    if(d){
      const vencidas = d.vencidas.reduce((n, g) => n + g.piezas.length, 0);
      r.push(renglon(d.recibir.length, d.recibir.length === 1 ? 'unidad con piezas entregadas sin recibir' : 'unidades con piezas entregadas sin recibir', d.recibir));
      if(vencidas) r.push(`${vencidas} ${vencidas === 1 ? 'pieza vencida' : 'piezas vencidas'} (${nombres(d.vencidas, 'proveedor')})`);
      r.push(renglon(d.correos.length, d.correos.length === 1 ? 'correo a proveedor sin aprobar' : 'correos a proveedores sin aprobar'));
      r.push(renglon(d.mal.length, d.mal.length === 1 ? 'pieza mal surtida sin resolver' : 'piezas mal surtidas sin resolver'));
    }
    r.unshift(renglonDet('daniela', 'esperando pieza'));
    personas.push({ nombre:'Daniela', renglones: r.filter(Boolean) });
  }

  // ---- Orlando (revisión técnica y expedientes) ----
  {
    const o = seguro(() => require('./inicioOrlando').calcularInicioOrlando(db), null);
    const r = [];
    if(o){
      const reaut = o.reautorizar.filter(c => c.horas_restantes !== null && c.horas_restantes <= HORAS_REAUTORIZACION);
      const revisar = o.revisar.filter(s => s.dias_esperando >= 1);
      r.push(renglon(reaut.length, reaut.length === 1 ? 'reautorización por vencer (fotos editadas)' : 'reautorizaciones por vencer (fotos editadas)', reaut));
      r.push(renglon(revisar.length, revisar.length === 1 ? 'unidad esperando revisión técnica desde ayer o antes' : 'unidades esperando revisión técnica desde ayer o antes', revisar));
      r.push(renglon(o.captura.length, o.captura.length === 1 ? 'expediente sin terminar de enviar' : 'expedientes sin terminar de enviar', o.captura));
      r.push(renglon(o.complementos.length, o.complementos.length === 1 ? 'complemento sin documentar' : 'complementos sin documentar', o.complementos));
    }
    r.unshift(renglonDet('orlando', 'por daño oculto'));
    personas.push({ nombre:'Orlando', renglones: r.filter(Boolean) });
  }

  // ---- Registro de entrada (solo si ya está activado) ----
  let sinEntrada = [];
  seguro(() => {
    const A = require('./asistencia');
    const e = A.entradasDeHoy(db);
    if(e.taller_configurado) sinEntrada = e.personas.filter(p => !p.hora).map(p => p.nombre.split(' ')[0]);
  });

  const datos = { fecha: hoy, fecha_texto: fechaLarga(ahora), personas, sin_entrada: sinEntrada };
  datos.pendientes = personas.reduce((n, p) => n + p.renglones.length, 0);
  datos.texto = textoWhatsApp(datos);
  return datos;
}

// Formato WhatsApp: *negritas*, renglones cortos.
function textoWhatsApp(d){
  const b = [`*⏱️ CORTE DE LAS 3 – ${d.fecha_texto}*`, '_Lo que sigue pendiente de hoy. Hay tiempo de resolverlo antes de salir._'];
  for(const p of d.personas){
    if(!p.renglones.length) b.push(`*${p.nombre}:* ✅ al corriente`);
    else b.push(`*${p.nombre}:*\n` + p.renglones.map(r => '• ' + r).join('\n'));
  }
  if(d.sin_entrada.length) b.push(`*🕘 Sin registrar entrada:* ${d.sin_entrada.join(', ')}`);
  b.push('_Generado por SC Control_');
  return b.join('\n\n');
}

module.exports = { calcularCorteTarde, textoWhatsApp };
