/* ===================== HELPERS ===================== */
function esc(s){
  if(s===null||s===undefined) return '';
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtMoney(n){ return '$'+Number(n||0).toLocaleString('es-MX',{minimumFractionDigits:2}); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function uidLocal(){ return 'tmp'+Math.random().toString(36).slice(2); }

let currentUser = null;
const ASEGURADORAS = ['GNP','ANA','Inbursa','Allianz','La Latinoamericana','Mapfre','Afirme','Zurich'];


async function api(method, url, body, opts={}){
  const res = await fetch(url, {
    method, headers: body ? {'Content-Type':'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  const ct = res.headers.get('content-type')||'';
  if(ct.includes('application/json')) data = await res.json().catch(()=>null);
  // Bug reportado por Daniela: un 401 del propio login (contraseña incorrecta) se mostraba como
  // "Sesión expirada", ocultando el motivo real. Ese mensaje genérico solo aplica cuando SÍ había
  // una sesión iniciada y dejó de ser válida — nunca al intentar iniciar sesión por primera vez.
  if(res.status === 401 && !opts.esLogin){
    currentUser = null;
    renderLogin();
    throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
  }
  if(!res.ok){
    const msg = (data && data.error) || ('Error ' + res.status);
    if(!opts.silent) toast(msg, 'error');
    const err = new Error(msg); err.data = data; err.status = res.status;
    throw err;
  }
  return data;
}

/* ===================== TOASTS (reemplaza alert/confirm bloqueantes — F-04) ===================== */
function toast(msg, type='info', ms=4500){
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = 'toast ' + (type==='error'?'error':type==='success'?'success':type==='warn'?'warn':'');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(()=>{ el.remove(); }, ms);
}
function confirmDialog(mensaje, { titulo='Confirmar', textoOk='Confirmar', peligro=false } = {}){
  return new Promise(resolve=>{
    showModal(`
      <h3>${esc(titulo)}</h3>
      <p>${esc(mensaje)}</p>
      <div class="modal-actions">
        <button class="btn secondary" id="cfDlgCancel">Cancelar</button>
        <button class="btn ${peligro?'danger':''}" id="cfDlgOk">${esc(textoOk)}</button>
      </div>
    `);
    document.getElementById('cfDlgCancel').onclick = ()=>{ closeModal(); resolve(false); };
    document.getElementById('cfDlgOk').onclick = ()=>{ closeModal(); resolve(true); };
  });
}
function showModal(html, wide=false){
  document.getElementById('modalRoot').innerHTML = `<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="modal ${wide?'wide':''}">${html}</div></div>`;
}
function closeModal(){ document.getElementById('modalRoot').innerHTML=''; }

/* ===================== LOGIN ===================== */
function renderLogin(){
  document.getElementById('topHeader').classList.add('hidden');
  document.getElementById('footerNote').classList.add('hidden');
  document.getElementById('app').innerHTML = '';
  document.getElementById('loginRoot').innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <h2>Servicio Cristian</h2>
      <p class="subtle">Tablero de Seguimiento de Refacciones</p>
      <div class="field"><label>Correo</label><input id="loginEmail" type="email" placeholder="daniela@serviciocristian.mx"></div>
      <div class="field"><label>Contraseña</label><input id="loginPass" type="password" onkeydown="if(event.key==='Enter')hacerLogin()"></div>
      <div class="field errmsg" id="loginError"></div>
      <button class="btn" style="width:100%" onclick="hacerLogin()">Entrar</button>
    </div>
  </div>`;
}
async function hacerLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPass').value;
  try{
    const r = await api('POST','/api/auth/login', { email, password }, { silent:true, esLogin:true });
    currentUser = r.user;
    document.getElementById('loginRoot').innerHTML = '';
    document.getElementById('topHeader').classList.remove('hidden');
    document.getElementById('footerNote').classList.remove('hidden');
    document.getElementById('userChip').textContent = currentUser.nombre + ' · ' + currentUser.rol;
    goTo('inicio');
  }catch(e){
    document.getElementById('loginError').textContent = e.message;
  }
}
async function hacerLogout(){
  await api('POST','/api/auth/logout');
  currentUser = null;
  renderLogin();
}
function abrirCambiarPassword(){
  showModal(`
    <h3>Cambiar contraseña</h3>
    <div class="field"><label>Contraseña actual</label><input id="pwActual" type="password"></div>
    <div class="field"><label>Contraseña nueva (mínimo 8 caracteres)</label><input id="pwNueva" type="password"></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarPassword()">Guardar</button></div>
  `);
}
async function guardarPassword(){
  const actual = document.getElementById('pwActual').value;
  const nueva = document.getElementById('pwNueva').value;
  try{
    await api('PATCH','/api/auth/password', { actual, nueva });
    toast('Contraseña actualizada.', 'success');
    closeModal();
  }catch(e){}
}

/* ===================== ESTADO / NAV ===================== */
let state = { view:'inicio', siniestroId:null, proveedorId:null, subtabSiniestro:'pedidos', filtros:{} };

const TABS = [
  {k:'inicio', label:'Inicio'},
  {k:'clientes', label:'Clientes', roles:['atencion_cliente','admin']},
  {k:'kanban', label:'Kanban'},
  {k:'incidencias', label:'Incidencias'},
  {k:'correos', label:'Correos pendientes', roles:['operativo','admin']},
  {k:'lista', label:'Lista maestra'},
  {k:'proveedores', label:'Proveedores'},
  {k:'carga', label:'Carga masiva', roles:['operativo','admin']},
  {k:'tecnica', label:'Revisión técnica', roles:['orlando','admin','jefe']},
  {k:'expediente', label:'Armado de expediente', roles:['vanessa','admin','jefe']},
  {k:'valuacion', label:'Valuación / autorización', roles:['orlando','admin','jefe']},
  {k:'produccion', label:'Producción', roles:['beto','admin','jefe']},
  {k:'calidad', label:'Calidad / entrega', roles:['beto','orlando','atencion_cliente','admin','jefe']},
  {k:'reglas', label:'Reglas'}
];
function renderTabs(){
  const visibles = TABS.filter(t=> !t.roles || (currentUser && t.roles.includes(currentUser.rol)));
  document.getElementById('mainTabs').innerHTML = visibles.map(t=>
    `<button class="${state.view===t.k?'active':''}" onclick="goTo('${t.k}')">${t.label}</button>`).join('') +
    `<button onclick="abrirCambiarPassword()" title="Cambiar contraseña">🔒</button>`;
}
function goTo(view){ state.view=view; state.siniestroId=null; state.proveedorId=null; render(); }
function goSiniestro(id){ state.view='siniestro'; state.siniestroId=id; state.subtabSiniestro='pedidos'; render(); }
function goProveedor(id){ state.view='proveedor'; state.proveedorId=id; render(); }
function setSubtabSiniestro(tab){ state.subtabSiniestro = tab; render(); }
function setFiltroListaMaestra(campo, valor){ state.filtros[campo] = valor; render(); }
function setFiltroQLive(valor){ state.filtros.q = valor; }


async function doGlobalSearch(){
  const q = document.getElementById('globalSearch').value.trim();
  if(!q) return;
  const r = await api('GET','/api/reportes/buscar?q='+encodeURIComponent(q));
  // F-20: se muestra una LISTA agrupada de coincidencias, nunca se abre automáticamente la primera.
  showModal(`
    <h3>Resultados para "${esc(q)}"</h3>
    <p class="subtle">Tipo detectado si fuera número: ${esc(r.tipoDetectado)} (regla R-02)</p>
    <div class="results-group"><h4>Siniestros (${r.siniestros.length})</h4>
      ${r.siniestros.length===0?'<div class="empty">Sin coincidencias.</div>':r.siniestros.map(s=>`<div class="result-item" onclick="closeModal();goSiniestro(${s.id})"><b>${esc(s.numero)}</b> · ${esc(s.aseguradora)} · ${esc(s.vehiculo||'')} · ${esc(s.placas||'')}</div>`).join('')}
    </div>
    <div class="results-group"><h4>Pedidos (${r.pedidos.length})</h4>
      ${r.pedidos.length===0?'<div class="empty">Sin coincidencias.</div>':r.pedidos.map(p=>`<div class="result-item" onclick="closeModal();goSiniestro(${p.siniestro_id})"><b>${esc(p.numero)}</b> · siniestro ${esc(p.siniestro_numero)}</div>`).join('')}
    </div>
    <div class="results-group"><h4>Proveedores (${r.proveedores.length})</h4>
      ${r.proveedores.length===0?'<div class="empty">Sin coincidencias.</div>':r.proveedores.map(pv=>`<div class="result-item" onclick="closeModal();goProveedor(${pv.id})"><b>${esc(pv.razon_social)}</b> · ${esc(pv.correo||'')}</div>`).join('')}
    </div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cerrar</button></div>
  `, true);
}

/* ===================== RENDER PRINCIPAL ===================== */
async function render(){
  renderTabs();
  const app = document.getElementById('app');
  app.innerHTML = '<div class="empty">Cargando…</div>';
  try{
    if(state.view==='inicio') app.innerHTML = await viewInicio();
    else if(state.view==='clientes') app.innerHTML = await viewClientes();
    else if(state.view==='kanban') app.innerHTML = await viewKanban();
    else if(state.view==='incidencias') app.innerHTML = await viewIncidencias();
    else if(state.view==='lista') app.innerHTML = await viewLista();
    else if(state.view==='proveedores') app.innerHTML = await viewProveedores();
    else if(state.view==='proveedor') app.innerHTML = await viewProveedorDetalle(state.proveedorId);
    else if(state.view==='correos') app.innerHTML = await viewCorreos();
    else if(state.view==='carga') app.innerHTML = viewCargaMasiva();
    else if(state.view==='tecnica') app.innerHTML = await viewTecnica();
    else if(state.view==='expediente') app.innerHTML = await viewExpediente();
    else if(state.view==='valuacion') app.innerHTML = await viewValuacion();
    else if(state.view==='produccion') app.innerHTML = await viewProduccion();
    else if(state.view==='calidad') app.innerHTML = await viewCalidad();
    else if(state.view==='reglas') app.innerHTML = viewReglas();
    else if(state.view==='siniestro') app.innerHTML = await viewSiniestro(state.siniestroId);
  }catch(e){
    if(e.message !== 'Sesión expirada. Vuelve a iniciar sesión.') app.innerHTML = `<div class="empty">No se pudo cargar la vista: ${esc(e.message)}</div>`;
  }
}

/* ===================== VISTA: INICIO ===================== */
async function viewInicio(){
  const r = await api('GET','/api/reportes/resumen');
  const verClientes = currentUser && ['atencion_cliente','admin','jefe'].includes(currentUser.rol);
  return `
  <h2>Resumen diario</h2>
  <p class="subtle">Vista de arranque: pedidos nuevos, piezas pendientes, incidencias y entregas atrasadas, en un solo lugar.</p>
  ${r.pendientesCompletar>0?`<div class="banner ambar">${r.pendientesCompletar} siniestro(s) están "Pendiente de completar" — les falta vehículo o placas. Complétalos desde su ficha.</div>`:''}
  <div class="grid-cards">
    <div class="card azul"><div class="num">${r.pedidosNuevos}</div><div class="label">Pedidos nuevos</div></div>
    <div class="card rojo"><div class="num">${r.piezasVencidas}</div><div class="label">Piezas vencidas</div></div>
    <div class="card ambar"><div class="num">${r.sinProveedor}</div><div class="label">Sin proveedor</div></div>
    <div class="card azul"><div class="num">${r.recibidosParciales}</div><div class="label">Recibidos parciales</div></div>
    <div class="card morado" style="border-left:4px solid #7c3aed"><div class="num">${r.incidenciasAbiertas}</div><div class="label">Incidencias abiertas</div></div>
    <div class="card verde"><div class="num">${r.cierresHoy}</div><div class="label">Cierres de hoy</div></div>
  </div>
  ${verClientes ? `
  <div class="section">
    <h3>Atención a clientes</h3>
    <p class="subtle">Seguimiento del lado del cliente (módulo de Alejandra), aparte de las refacciones.</p>
    <div class="grid-cards">
      <div class="card ${r.expedientesSinActualizar>0?'rojo':'verde'}"><div class="num">${r.expedientesSinActualizar}</div><div class="label">Expedientes sin actualizar (+3 días)</div></div>
      <div class="card ambar"><div class="num">${r.tareasPendientes}</div><div class="label">Tareas pendientes</div></div>
      <div class="card ${r.tareasVencidas>0?'rojo':'verde'}"><div class="num">${r.tareasVencidas}</div><div class="label">Tareas vencidas</div></div>
      <div class="card azul"><div class="num">${r.hitosListosSinEnviar}</div><div class="label">Hitos listos, sin avisar al cliente</div></div>
      <div class="card morado" style="border-left:4px solid #7c3aed"><div class="num">${r.mensajesIaPendientes}</div><div class="label">Mensajes de IA por revisar</div></div>
    </div>
  </div>` : ''}
  <div class="section">
    <h3>Indicadores por aseguradora</h3>
    ${r.porAseguradora.length===0?'<div class="empty">Sin datos.</div>':`
    <table><thead><tr><th>Aseguradora</th><th>Pedidos abiertos</th></tr></thead><tbody>
    ${r.porAseguradora.map(x=>`<tr><td>${esc(x.aseguradora)}</td><td>${x.abiertos}</td></tr>`).join('')}
    </tbody></table>`}
  </div>`;
}

/* ===================== VISTA: KANBAN ===================== */
const KANBAN_COLS = ['Nuevo','Por revisar','Esperando proveedor','En tránsito','Entrega vencida','Recibido parcial','Recibido completo','Con incidencia','Cancelado','Cerrado'];
async function viewKanban(){
  const pedidos = await api('GET','/api/reportes/kanban');
  let html = `<h2>Tablero Kanban</h2><p class="subtle">Todos los estatus tienen columna propia — ningún pedido desaparece (corrección F-03). Haz clic en una tarjeta para abrir el siniestro.</p><div class="kanban">`;
  KANBAN_COLS.forEach(col=>{
    const items = pedidos.filter(p=>p.estatus_operativo===col);
    html += `<div class="kcol"><h4>${esc(col)} <span class="badge gris">${items.length}</span></h4>`;
    items.forEach(p=>{
      html += `<div class="kcard" onclick="goSiniestro(${p.siniestro_id})">
        <div class="sin">${esc(p.siniestro_numero)} <span class="ase">${esc(p.aseguradora)}</span></div>
        <div class="subtle">Pedido ${esc(p.numero)} · ${esc(p.vehiculo||'')}</div>
        <div class="subtle">Prov.: ${esc(p.proveedores.join(', ')||'—')}</div>
        <div class="row">
          <span class="badge ${p.vencidas>0?'rojo':'azul'}">${p.pendientes} pend.</span>
          ${p.incidenciasAbiertas>0?`<span class="badge morado">${p.incidenciasAbiertas} inc.</span>`:`<span class="subtle">${esc(p.fecha_prevista||'')}</span>`}
        </div>
      </div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  return html;
}

/* ===================== VISTA: CORREOS PENDIENTES DE APROBACION (requerimiento de Daniela) ===================== */
async function viewCorreos(){
  const pendientes = await api('GET','/api/comunicaciones/pendientes');
  const LABEL_DISPARADOR = { pedido_nuevo:'Pedido nuevo', vencimiento_dia1:'Vencimiento (día 1)', seguimiento_2dias:'Seguimiento (2 días hábiles)', manual:'Manual' };
  let html = `<h2>Correos pendientes de aprobación</h2>
  <p class="subtle">El sistema los prepara solo (pedido nuevo, primer día de vencimiento, seguimiento a 2 días hábiles). Nada se envía sin que lo apruebes aquí.</p>`;
  if(pendientes.length===0){ html += '<div class="empty">No hay correos pendientes de aprobación por ahora.</div>'; return html; }
  html += `<table><thead><tr><th>Motivo</th><th>Siniestro</th><th>Pedido</th><th>Aseguradora</th><th>Asunto</th><th></th></tr></thead><tbody>
  ${pendientes.map(c=>`<tr>
    <td><span class="badge ambar">${esc(LABEL_DISPARADOR[c.disparador]||c.disparador)}</span></td>
    <td><a class="link" onclick="goSiniestro(${c.siniestro_id})">${esc(c.siniestro_numero)}</a></td>
    <td>${esc(c.pedido_numero)}</td>
    <td>${esc(c.aseguradora)}</td>
    <td>${esc(c.asunto)}</td>
    <td><button class="btn small" onclick="abrirRevisarCorreo(${c.id})">Revisar</button></td>
  </tr>`).join('')}
  </tbody></table>`;
  return html;
}
async function abrirRevisarCorreo(id){
  const pendientes = await api('GET','/api/comunicaciones/pendientes');
  const c = pendientes.find(x=>x.id===id);
  if(!c){ toast('Este correo ya no está pendiente (alguien más lo revisó).', 'warn'); render(); return; }
  showModal(`
    <h3>Revisar correo — ${esc(c.siniestro_numero)} / Pedido ${esc(c.pedido_numero)}</h3>
    <p class="subtle">Ajusta lo que haga falta antes de aprobar. Sigue en modo borrador: no se envía nada de verdad.</p>
    <div class="field"><label>Destinatario</label><input id="fcor_dest" value="${esc(c.destinatarios||'')}" placeholder="correo@proveedor.mx"></div>
    <div class="field"><label>Copia</label><textarea id="fcor_copia">${esc(c.copia||'')}</textarea></div>
    <div class="field"><label>Asunto</label><input id="fcor_asunto" value="${esc(c.asunto||'')}"></div>
    <div class="field"><label>Cuerpo</label><textarea id="fcor_cuerpo" style="min-height:160px;">${esc(c.cuerpo||'')}</textarea></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Cerrar</button>
      <button class="btn danger" onclick="descartarCorreoPendiente(${c.id})">Descartar</button>
      <button class="btn" onclick="aprobarCorreoPendiente(${c.id})">Aprobar</button>
    </div>
  `, true);
}
async function aprobarCorreoPendiente(id){
  const destinatarios = document.getElementById('fcor_dest').value.trim();
  if(!destinatarios){ toast('Falta el destinatario.', 'error'); return; }
  try{
    await api('PATCH', `/api/comunicaciones/${id}/aprobar`, {
      destinatarios, copia: document.getElementById('fcor_copia').value,
      asunto: document.getElementById('fcor_asunto').value, cuerpo: document.getElementById('fcor_cuerpo').value
    });
    toast('Correo aprobado (sigue en modo borrador/sandbox).', 'success');
    closeModal(); render();
  }catch(e){}
}
async function descartarCorreoPendiente(id){
  const ok = await confirmDialog('¿Descartar este correo preparado automáticamente? No se enviará ni se volverá a preparar para este mismo caso.', { textoOk:'Sí, descartar', peligro:true });
  if(!ok) return;
  await api('PATCH', `/api/comunicaciones/${id}/descartar`, {});
  toast('Correo descartado.', 'success');
  closeModal(); render();
}

/* ===================== VISTA: CARGA MASIVA (requerimiento de Daniela) ===================== */
let cargaMasivaValidada = null;
function viewCargaMasiva(){
  cargaMasivaValidada = null;
  return `
  <h2>Carga masiva</h2>
  <p class="subtle">Pega el contenido CSV (con encabezado) para incorporar expedientes y pedidos, por ejemplo los activos de GNP. Primero se valida, después confirmas antes de registrar.</p>
  <p class="subtle">Columnas esperadas: numero_siniestro, aseguradora, vehiculo, placas, fecha_ingreso, responsable, numero_pedido, fecha_creacion_pedido, fecha_prevista, estatus_inpart, estatus_operativo, proveedor, telefono_proveedor, contacto_proveedor</p>
  <div class="field"><textarea id="fcm_csv" style="min-height:180px;font-family:monospace;" placeholder="numero_siniestro,aseguradora,...,fecha_prevista,..."></textarea></div>
  <div class="modal-actions" style="justify-content:flex-start;">
    <button class="btn" onclick="validarCargaMasiva()">Validar</button>
    <input type="file" id="fcm_archivo" accept=".csv,.txt" style="display:none" onchange="cargarArchivoCsv(event)">
    <button class="btn secondary" onclick="document.getElementById('fcm_archivo').click()">Cargar desde archivo…</button>
  </div>
  <div id="cargaMasivaResultado" style="margin-top:16px;"></div>`;
}
function cargarArchivoCsv(ev){
  const file = ev.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{ document.getElementById('fcm_csv').value = reader.result; };
  reader.readAsText(file, 'utf-8');
}
async function validarCargaMasiva(){
  const csv = document.getElementById('fcm_csv').value;
  if(!csv || !csv.trim()){ toast('Pega o carga un archivo CSV primero.', 'error'); return; }
  try{
    const r = await api('POST','/api/carga-masiva/validar', { csv });
    cargaMasivaValidada = r;
    const cont = document.getElementById('cargaMasivaResultado');
    cont.innerHTML = `
    <div class="grid-cards">
      <div class="card verde"><div class="num">${r.validas.length}</div><div class="label">Filas listas para registrar</div></div>
      <div class="card rojo"><div class="num">${r.errores.length}</div><div class="label">Filas con error</div></div>
    </div>
    ${r.errores.length>0?`<h3>Errores</h3><table><thead><tr><th>Línea</th><th>Siniestro</th><th>Pedido</th><th>Motivo</th></tr></thead><tbody>
      ${r.errores.map(e=>`<tr><td>${e.fila}</td><td>${esc(e.dato.numero_siniestro)}</td><td>${esc(e.dato.numero_pedido)}</td><td>${esc(e.motivos.join(' '))}</td></tr>`).join('')}
      </tbody></table>`:''}
    ${r.validas.length>0?`<h3 style="margin-top:14px;">Listas para registrar</h3><table><thead><tr><th>Línea</th><th>Siniestro</th><th>Pedido</th><th>Aseguradora</th><th>Fecha promesa</th></tr></thead><tbody>
      ${r.validas.map(v=>`<tr><td>${v.fila}</td><td>${esc(v.dato.numero_siniestro)}</td><td>${esc(v.dato.numero_pedido)}</td><td>${esc(v.dato.aseguradora)}</td><td>${esc(v.dato.fecha_prevista)}</td></tr>`).join('')}
      </tbody></table>
      <div class="modal-actions" style="justify-content:flex-start;margin-top:10px;"><button class="btn" onclick="confirmarCargaMasiva()">Confirmar y registrar ${r.validas.length} fila(s)</button></div>`:''}`;
  }catch(e){}
}
async function confirmarCargaMasiva(){
  if(!cargaMasivaValidada || cargaMasivaValidada.validas.length===0) return;
  const ok = await confirmDialog(`¿Registrar ${cargaMasivaValidada.validas.length} fila(s) válidas? Las filas con error no se tocan.`, { textoOk:'Sí, registrar' });
  if(!ok) return;
  try{
    const r = await api('POST','/api/carga-masiva/confirmar', { filas: cargaMasivaValidada.validas.map(v=>v.dato) });
    toast(`Carga completa: ${r.siniestrosCreados} siniestro(s) nuevo(s), ${r.pedidosCreados} pedido(s) registrados.`, 'success');
    cargaMasivaValidada = null;
    document.getElementById('fcm_csv').value = '';
    document.getElementById('cargaMasivaResultado').innerHTML = r.omitidos.length ? `<p class="subtle">${r.omitidos.length} fila(s) se omitieron por ya existir.</p>` : '';
  }catch(e){}
}

/* ===================== VISTA: INCIDENCIAS (bandeja dedicada) ===================== */
async function viewIncidencias(){
  const abiertas = await api('GET','/api/incidencias?estado=abierta');
  const enProceso = await api('GET','/api/incidencias?estado=en_proceso');
  const todas = [...abiertas, ...enProceso];
  return `
  <h2>Incidencias abiertas</h2>
  <p class="subtle">Piezas incorrectas, dañadas, incompletas o con fecha incumplida que bloquean el cierre del pedido hasta resolverse (regla F-11).</p>
  ${todas.length===0?'<div class="empty">Sin incidencias abiertas. 🎉</div>':`
  <table><thead><tr><th>Siniestro</th><th>Pedido</th><th>Pieza</th><th>Tipo</th><th>Acción solicitada</th><th>Responsable</th><th>Fecha compromiso</th><th>Estado</th><th></th></tr></thead><tbody>
  ${todas.map(i=>`<tr>
    <td><span class="link" onclick="goSiniestro(${i.siniestro_id})">${esc(i.siniestro_numero)}</span></td>
    <td>${esc(i.pedido_numero)}</td>
    <td>${esc(i.pieza_descripcion)}</td>
    <td>${esc(i.tipo)}</td>
    <td>${esc(i.accion_solicitada||'—')}</td>
    <td>${esc(i.responsable||'—')}</td>
    <td>${esc(i.fecha_compromiso||'—')}</td>
    <td><span class="badge ${i.estado==='abierta'?'rojo':'ambar'}">${esc(i.estado)}</span></td>
    <td><button class="btn small secondary" onclick="goSiniestro(${i.siniestro_id})">Abrir</button></td>
  </tr>`).join('')}
  </tbody></table>`}`;
}

/* ===================== VISTA: LISTA MAESTRA ===================== */
async function viewLista(){
  const f = state.filtros;
  const params = new URLSearchParams();
  if(f.aseguradora) params.set('aseguradora', f.aseguradora);
  if(f.estatus) params.set('estatus', f.estatus);
  if(f.proveedor_id) params.set('proveedor_id', f.proveedor_id);
  if(f.q) params.set('q', f.q);
  const filas = await api('GET','/api/reportes/lista-maestra?'+params.toString());
  const proveedores = await api('GET','/api/proveedores');
  const ESTATUS_PIEZA = ['Sin proveedor','Asignada','Confirmada','Facturada','En tránsito','Entregada por proveedor','Recibida físicamente','Devuelta','Incorrecta/dañada','Cancelada'];
  const hoy = todayISO();
  function alertaColor(f){
    if(!f.pieza_id) return 'ambar';
    if(f.pieza_estatus==='Incorrecta/dañada'||f.pieza_estatus==='Devuelta') return 'rojo';
    if(['Recibida físicamente','Cancelada'].includes(f.pieza_estatus)) return 'verde';
    if(f.pieza_estatus==='Sin proveedor') return 'ambar';
    if(f.fecha_prometida && f.fecha_prometida < hoy) return 'rojo';
    return 'azul';
  }
  return `
  <h2>Lista maestra</h2>
  <div class="filters no-print">
    <input placeholder="Búsqueda global" value="${esc(f.q||'')}" oninput="setFiltroQLive(this.value)" onkeydown="if(event.key==='Enter')render()" style="min-width:180px">
    <select onchange="setFiltroListaMaestra('aseguradora', this.value)">
      <option value="">Todas las aseguradoras</option>
      ${ASEGURADORAS.map(a=>`<option value="${a}" ${f.aseguradora===a?'selected':''}>${a}</option>`).join('')}
    </select>
    <select onchange="setFiltroListaMaestra('estatus', this.value)">
      <option value="">Todos los estatus de pieza</option>
      ${ESTATUS_PIEZA.map(a=>`<option value="${a}" ${f.estatus===a?'selected':''}>${a}</option>`).join('')}
    </select>
    <select onchange="setFiltroListaMaestra('proveedor_id', this.value)">
      <option value="">Todos los proveedores</option>
      ${proveedores.map(pv=>`<option value="${pv.id}" ${String(f.proveedor_id)===String(pv.id)?'selected':''}>${esc(pv.razon_social)}</option>`).join('')}
    </select>
    <button class="btn small" onclick="render()">Buscar</button>
    <button class="btn secondary small" onclick="state.filtros={};render()">Limpiar filtros</button>
    <button class="btn small" onclick="exportarCSV()">Exportar CSV</button>
    <button class="btn small secondary" onclick="exportarExpedientesCSV()">Exportar expedientes (CSV)</button>
    <button class="btn secondary small" onclick="window.print()">Imprimir / PDF</button>
  </div>
  <table><thead><tr><th>Siniestro</th><th>Aseguradora</th><th>Pedido</th><th>Proveedor</th><th>Pieza</th><th>Estatus</th><th>Fecha prometida</th><th>Alerta</th></tr></thead>
  <tbody>
  ${filas.length===0?'<tr><td colspan="8" class="empty">Sin resultados con los filtros actuales.</td></tr>':filas.map(f=>`
    <tr>
      <td><span class="link" onclick="goSiniestro(${f.siniestro_id})">${esc(f.siniestro_numero)}</span></td>
      <td>${esc(f.aseguradora)}</td>
      <td>${esc(f.pedido_numero)}</td>
      <td>${esc(f.proveedor_nombre||'—')}</td>
      <td>${f.pieza_id ? esc(f.descripcion) : '<i>Pendiente de capturar piezas</i>'}</td>
      <td>${esc(f.pieza_estatus||'Sin piezas')}</td>
      <td>${esc(f.fecha_prometida||'—')}</td>
      <td><span class="badge ${alertaColor(f)}">&nbsp;</span></td>
    </tr>`).join('')}
  </tbody></table>
  <p class="subtle" style="margin-top:8px;">${filas.length} fila(s). Los pedidos sin piezas capturadas también se muestran (corrección F-05).</p>`;
}
function exportarCSV(){
  const f = state.filtros;
  const params = new URLSearchParams();
  if(f.aseguradora) params.set('aseguradora', f.aseguradora);
  if(f.estatus) params.set('estatus', f.estatus);
  if(f.proveedor_id) params.set('proveedor_id', f.proveedor_id);
  if(f.q) params.set('q', f.q);
  window.location.href = '/api/reportes/lista-maestra.csv?'+params.toString();
}
// Incluye TODOS los expedientes (con o sin pedido capturado), a diferencia del CSV de Lista maestra
// que parte de los pedidos y por eso no muestra los siniestros que todavía no tienen ninguno.
function exportarExpedientesCSV(){
  const f = state.filtros;
  const params = new URLSearchParams();
  if(f.aseguradora) params.set('aseguradora', f.aseguradora);
  if(f.q) params.set('q', f.q);
  window.location.href = '/api/reportes/siniestros.csv?'+params.toString();
}

/* ===================== VISTA: PROVEEDORES ===================== */
async function viewProveedores(){
  const proveedores = await api('GET','/api/proveedores');
  return `
  <h2>Proveedores</h2>
  <table><thead><tr><th>Razón social</th><th>Contacto</th><th>Correo</th><th>Activo</th><th></th></tr></thead><tbody>
  ${proveedores.map(pv=>`<tr>
    <td><span class="link" onclick="goProveedor(${pv.id})">${esc(pv.razon_social)}</span></td>
    <td>${esc(pv.contacto||'')}</td><td>${esc(pv.correo||'')}</td>
    <td>${pv.activo?'<span class="badge verde">Activo</span>':'<span class="badge gris">Inactivo</span>'}</td>
    <td><button class="btn small secondary" onclick="goProveedor(${pv.id})">Ver ficha</button></td>
  </tr>`).join('')}
  </tbody></table>`;
}
async function viewProveedorDetalle(id){
  const pv = await api('GET','/api/proveedores/'+id);
  const activos = pv.piezas.filter(z=>!['Recibida físicamente','Cancelada'].includes(z.estatus));
  const vencidas = activos.filter(z=>z.fecha_prometida && z.fecha_prometida < todayISO());
  const incidencias = pv.piezas.filter(z=>z.estatus==='Incorrecta/dañada'||z.estatus==='Devuelta');
  return `
  <button class="btn ghost small no-print" onclick="goTo('proveedores')">← Volver a proveedores</button>
  <h2 style="margin-top:10px;">${esc(pv.razon_social)}</h2>
  <p class="subtle">${esc(pv.contacto||'')} · ${esc(pv.correo||'')} · ${esc(pv.telefono||'')}</p>
  <div class="grid-cards">
    <div class="card azul"><div class="num">${activos.length}</div><div class="label">Piezas activas</div></div>
    <div class="card rojo"><div class="num">${vencidas.length}</div><div class="label">Piezas vencidas</div></div>
    <div class="card ambar"><div class="num">${incidencias.length}</div><div class="label">Incidencias</div></div>
    <div class="card verde"><div class="num">${pv.tiempoPromedioDias!=null?pv.tiempoPromedioDias+' días':'—'}</div><div class="label">Tiempo prom. de entrega</div></div>
  </div>
  <div class="section">
    <h3>Reglas especiales</h3>
    <p>${esc(pv.regla_especial) || 'Sin reglas especiales registradas.'}</p>
    <p class="subtle">Nota: ya no existe un bloqueo permanente de correos por proveedor (corrección F-14). Las exclusiones son solo por envío, desde el generador de correo, con motivo obligatorio.</p>
  </div>
  <div class="section">
    <h3>Correos (filtrados por este proveedor — corrección F-15)</h3>
    ${pv.comunicaciones.length===0?'<div class="empty">Sin correos registrados.</div>':`
    <table><thead><tr><th>Fecha</th><th>Asunto</th><th>Respuesta</th></tr></thead><tbody>
    ${pv.comunicaciones.map(c=>`<tr><td>${esc(c.fecha_envio)}</td><td>${esc(c.asunto)}</td><td>${c.respuesta_texto?esc(c.respuesta_texto):'<span class="badge ambar">Pendiente</span>'}</td></tr>`).join('')}
    </tbody></table>`}
  </div>`;
}

/* ===================== VISTA: FICHA DE SINIESTRO ===================== */
async function viewSiniestro(id){
  const s = await api('GET','/api/siniestros/'+id);
  const peds = await api('GET','/api/pedidos?siniestro_id='+id);
  const esAtencionCliente = currentUser && (currentUser.rol==='atencion_cliente' || currentUser.rol==='admin');
  const subtabs = [
    ...(esAtencionCliente ? [['cliente','Cliente']] : []),
    ['admision','Admisión / técnica'],['expediente','Expediente digital'],['valuacion','Valuación / autorización'],['produccion','Producción'],['calidad','Calidad / entrega'],
    ['pedidos','Pedidos'],['piezas','Piezas'],['incidencias','Incidencias'],['comunicaciones','Comunicaciones'],['archivos','Archivos'],['timeline','Línea de tiempo']
  ];
  const ESTATUS_OPERATIVO = KANBAN_COLS;

  let body = '';
  if(state.subtabSiniestro==='cliente'){
    const eventos = await api('GET','/api/eventos-cliente?siniestro_id='+id);
    const tareas = await api('GET','/api/tareas?siniestro_id='+id);
    const hitos = await api('GET','/api/hitos?siniestro_id='+id);
    const mensajesIa = await api('GET','/api/mensajes-ia?siniestro_id='+id);
    const ESTADOS_TAREA = {pendiente:'ambar', en_proceso:'azul', completada:'verde', cancelada:'gris'};
    const ESTADOS_HITO = {pendiente:'gris', generado:'ambar', revisado:'azul', enviado:'verde', no_aplica:'gris'};
    const LABEL_HITO = {pendiente:'Pendiente', generado:'Generado', revisado:'Revisado', enviado:'Enviado', no_aplica:'No aplica'};
    const ESTADOS_IA = {generado:'ambar', aprobado:'azul', enviado:'verde'};
    body = `
    <h3>Hitos del expediente</h3>
    <p class="subtle">Secuencia real de avisos al cliente. Los marcados "condicional" pueden omitirse con motivo.</p>
    <table><thead><tr><th>#</th><th>Hito</th><th>Estado</th><th>Detalle</th><th></th></tr></thead><tbody>
    ${hitos.map(h=>`<tr>
      <td>${h.orden}</td>
      <td>${esc(h.titulo)}${h.condicional?' <span class="badge gris">condicional</span>':''}</td>
      <td><span class="badge ${ESTADOS_HITO[h.estado]||'gris'}">${LABEL_HITO[h.estado]||h.estado}</span></td>
      <td class="subtle">${h.estado==='no_aplica'?esc(h.motivo_no_aplica||''):(h.fecha_estado?esc(h.fecha_estado):'')}</td>
      <td>
        ${!['enviado'].includes(h.estado) || h.condicional ? `<button class="btn small secondary" onclick="abrirFormHito(${h.id})">Actualizar</button>` : ''}
        <button class="btn small ghost" onclick="abrirFormIA(${id}, ${h.hito_id})">Preparar con IA</button>
      </td>
    </tr>`).join('')}
    </tbody></table>
    <h3 style="margin-top:18px;">Tareas</h3>
    <div style="margin-bottom:8px;"><button class="btn small" onclick="abrirFormNuevaTarea(${id})">+ Nueva tarea</button></div>
    ${tareas.length===0?'<div class="empty">Sin tareas registradas.</div>':`
    <table><thead><tr><th>Descripción</th><th>Responsable</th><th>Fecha límite</th><th>Origen</th><th>Estado</th><th></th></tr></thead><tbody>
    ${tareas.map(t=>`<tr>
      <td>${esc(t.descripcion)}</td><td>${esc(t.responsable_nombre||'—')}</td>
      <td>${t.fecha_limite && t.fecha_limite < todayISO() && !['completada','cancelada'].includes(t.estado) ? `<span class="badge rojo">${esc(t.fecha_limite)} vencida</span>` : esc(t.fecha_limite||'—')}</td>
      <td>${t.origen==='automatica'?'Automática':'Manual'}</td>
      <td><span class="badge ${ESTADOS_TAREA[t.estado]||'gris'}">${esc(t.estado)}</span></td>
      <td>${!['completada','cancelada'].includes(t.estado)?`<button class="btn small secondary" onclick="marcarTareaCompletada(${t.id})">Completar</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`}
    <h3 style="margin-top:18px;">Bitácora de comunicaciones con el cliente</h3>
    <div style="margin-bottom:8px;"><button class="btn small" onclick="abrirFormNuevoEvento(${id})">+ Registrar comunicación</button></div>
    ${eventos.length===0?'<div class="empty">Sin comunicaciones registradas todavía.</div>':`<ul class="timeline">
    ${eventos.map(e=>`<li><b>${esc(e.creado_en)}</b> — <span class="badge ${e.direccion==='entrante'?'azul':'ambar'}">${e.direccion==='entrante'?'Cliente → taller':'Taller → cliente'}</span>
      ${e.canal?` · ${esc(e.canal)}`:''}${e.tipo_evento?` · ${esc(e.tipo_evento)}`:''}<br>${esc(e.mensaje)}
      ${e.compromiso?`<br><span class="subtle">Compromiso: ${esc(e.compromiso)}</span>`:''}
      <span class="subtle"> (${esc(e.autor_nombre||'—')})</span></li>`).join('')}
    </ul>`}
    <h3 style="margin-top:18px;">Mensajes preparados con IA</h3>
    <p class="subtle">Borradores armados con el contexto del expediente para pegar en tu ChatGPT. El envío siempre queda a tu criterio.</p>
    ${mensajesIa.length===0?'<div class="empty">Sin mensajes preparados todavía.</div>':`
    <table><thead><tr><th>Hito</th><th>Borrador</th><th>Estado</th><th></th></tr></thead><tbody>
    ${mensajesIa.map(m=>`<tr>
      <td>${esc(m.hito_titulo||'General')}</td>
      <td style="max-width:280px;white-space:pre-wrap;">${esc((m.borrador||'').slice(0,180))}${(m.borrador||'').length>180?'…':''}</td>
      <td><span class="badge ${ESTADOS_IA[m.estado]||'gris'}">${esc(m.estado)}</span></td>
      <td>
        ${m.estado==='generado'?`<button class="btn small secondary" onclick="cambiarEstadoMensajeIa(${m.id},'aprobado')">Marcar revisado</button>`:''}
        ${m.estado!=='enviado'?`<button class="btn small" onclick="cambiarEstadoMensajeIa(${m.id},'enviado')">Marcar enviado</button>`:''}
      </td>
    </tr>`).join('')}
    </tbody></table>`}`;
  } else if(state.subtabSiniestro==='admision'){
    const hallazgos = await api('GET','/api/danos-evidencia?siniestro_id='+id);
    const archivosDisp = await api('GET','/api/archivos?entidad_tipo=siniestro&entidad_id='+id);
    const puedeAdmision = currentUser && ['atencion_cliente','vanessa','admin','jefe'].includes(currentUser.rol);
    const puedeTecnica = currentUser && ['orlando','admin','jefe'].includes(currentUser.rol);
    const LABEL_ADM = { admitido:'Admitido', condicionado:'Condicionado', no_admitido:'No admitido' };
    const BADGE_ADM = { admitido:'verde', condicionado:'ambar', no_admitido:'rojo' };
    const LABEL_REV = { en_revision:'En revisión', requiere_desarme:'Requiere desarme', revision_terminada:'Revisión terminada' };
    const LABEL_EVID = { evidencia_completa:'Evidencia completa', desarme_parcial:'Desarme parcial', dano_oculto_detectado:'Daño oculto detectado' };
    body = `
    <h3>Recepción y admisión</h3>
    <p class="subtle">Secciones 5.1/5.2 y regla de circulando vs. grúa del documento maestro.</p>
    <table class="kv"><tbody>
      <tr><td>Ingreso</td><td>${s.ingreso_tipo?`<span class="badge ${s.ingreso_tipo==='grua'?'ambar':'gris'}">${s.ingreso_tipo==='grua'?'Grúa':'Circulando'}</span>${s.ingreso_seguro===0?' <span class="badge rojo">No seguro</span>':''}`:'—'}</td></tr>
      <tr><td>Cita</td><td>${esc(s.cita_fecha||'—')}</td></tr>
      ${s.ingreso_tipo==='grua'?`<tr><td>Grúa</td><td>${esc(s.grua_operador||'—')} ${s.grua_hora?('· '+esc(s.grua_hora)):''}</td></tr>`:''}
      <tr><td>Fecha de admisión</td><td>${esc(s.fecha_admision||'—')}</td></tr>
      <tr><td>Kilometraje / combustible</td><td>${esc(s.kilometraje||'—')} ${s.combustible_nivel?('· '+esc(s.combustible_nivel)):''}</td></tr>
      <tr><td>Llaves entregadas</td><td>${s.llaves_entregadas?'Sí':'No'}</td></tr>
      <tr><td>Pertenencias</td><td>${esc(s.pertenencias||'—')}</td></tr>
      <tr><td>Estado de admisión</td><td><span class="badge ${BADGE_ADM[s.estado_admision]||'gris'}">${LABEL_ADM[s.estado_admision]||'Pendiente'}</span>${s.motivo_admision?` — ${esc(s.motivo_admision)}`:''}</td></tr>
    </tbody></table>
    ${puedeAdmision?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormAdmision(${id})">Capturar / editar admisión</button></div>`:''}

    <h3 style="margin-top:20px;">Revisión técnica (Orlando)</h3>
    <p class="subtle">Secciones 5.3/5.4 del documento maestro: daño relacionado/no relacionado, visible/oculto, y si requiere desarme.</p>
    <table class="kv"><tbody>
      <tr><td>Estado de revisión</td><td><span class="badge ${s.estado_revision_tecnica==='revision_terminada'?'verde':s.estado_revision_tecnica==='requiere_desarme'?'ambar':'gris'}">${LABEL_REV[s.estado_revision_tecnica]||'Sin iniciar'}</span></td></tr>
      <tr><td>Riesgo de seguridad</td><td>${s.riesgo_seguridad?`<span class="badge rojo">No seguro</span> — ${esc(s.riesgo_seguridad_motivo||'')}`:'No'}</td></tr>
      <tr><td>Estado de evidencia</td><td>${s.estado_evidencia?esc(LABEL_EVID[s.estado_evidencia]||s.estado_evidencia):'—'}</td></tr>
    </tbody></table>
    ${puedeTecnica?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormRevisionTecnica(${id})">Actualizar revisión técnica</button></div>`:''}

    <h4 style="margin-top:16px;">Daños y hallazgos</h4>
    ${hallazgos.length===0?'<div class="empty">Sin hallazgos registrados todavía.</div>':`
    <table><thead><tr><th>Zona/pieza</th><th>Tipo de daño</th><th>Visibilidad</th><th>Relacionado</th><th>Severidad</th><th>Foto</th><th>Autor</th><th></th></tr></thead><tbody>
    ${hallazgos.map(h=>`<tr>
      <td>${esc(h.zona_pieza)}${h.observaciones?`<div class="subtle">${esc(h.observaciones)}</div>`:''}</td>
      <td>${esc(h.tipo_dano||'—')}</td>
      <td><span class="badge ${h.visibilidad==='oculto'?'rojo':'gris'}">${h.visibilidad==='oculto'?'Oculto':'Visible'}</span></td>
      <td>${h.relacionado?'Sí':'No'}</td>
      <td>${esc(h.severidad||'—')}</td>
      <td>${h.archivo_id?`<a class="link" href="/api/archivos/${h.archivo_id}/descargar" target="_blank">Ver</a>`:'—'}</td>
      <td class="subtle">${esc(h.autor_nombre||'—')}</td>
      <td>${puedeTecnica?`<button class="btn small secondary" onclick="abrirFormEditarHallazgo(${h.id})">Editar</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`}
    ${puedeTecnica?`<div style="margin-top:8px;"><button class="btn small" onclick="abrirFormNuevoHallazgo(${id})">+ Agregar hallazgo</button></div>`:''}`;
  } else if(state.subtabSiniestro==='expediente'){
    const documentos = await api('GET','/api/documentos-expediente?siniestro_id='+id);
    const puedeExpediente = currentUser && ['vanessa','admin','jefe'].includes(currentUser.rol);
    const LABEL_EXP = { en_captura:'En captura', incompleto:'Incompleto', listo_para_valuacion:'Listo para valuación' };
    const LABEL_DOC = { faltante:'Faltante', recibido:'Recibido', no_legible:'No legible', no_aplica:'No aplica' };
    const BADGE_DOC = { faltante:'rojo', recibido:'verde', no_legible:'ambar', no_aplica:'gris' };
    body = `
    <h3>Expediente digital</h3>
    <p class="subtle">Sección 5.5 del documento maestro: checklist documental, versiones, legibilidad y sistema de valuación (módulo de Vanessa).</p>
    <table class="kv"><tbody>
      <tr><td>Estado del expediente</td><td><span class="badge ${s.estado_expediente==='listo_para_valuacion'?'verde':s.estado_expediente==='incompleto'?'rojo':'ambar'}">${LABEL_EXP[s.estado_expediente]||'Sin iniciar'}</span></td></tr>
      <tr><td>Sistema de valuación</td><td>${esc(s.sistema_valuacion||'—')}</td></tr>
      <tr><td>Folio de expediente</td><td>${esc(s.expediente_folio||'—')}</td></tr>
    </tbody></table>
    ${puedeExpediente?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormExpedienteDigital(${id})">Actualizar expediente</button></div>`:''}

    <h4 style="margin-top:16px;">Checklist documental</h4>
    ${documentos.length===0?'<div class="empty">Sin documentos registrados todavía.</div>':`
    <table><thead><tr><th>Documento</th><th>Versión</th><th>Estado</th><th>Folio</th><th>Archivo</th><th>Autor</th><th></th></tr></thead><tbody>
    ${documentos.map(d=>`<tr>
      <td>${esc(d.tipo_documento)}${d.notas?`<div class="subtle">${esc(d.notas)}</div>`:''}</td>
      <td>${d.version}</td>
      <td><span class="badge ${BADGE_DOC[d.estado]||'gris'}">${LABEL_DOC[d.estado]||d.estado}</span></td>
      <td>${esc(d.folio||'—')}</td>
      <td>${d.archivo_id?`<a class="link" href="/api/archivos/${d.archivo_id}/descargar" target="_blank">Ver</a>`:'—'}</td>
      <td class="subtle">${esc(d.autor_nombre||'—')}</td>
      <td>${puedeExpediente?`<button class="btn small secondary" onclick="abrirFormEditarDocumento(${d.id})">Editar</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`}
    ${puedeExpediente?`<div style="margin-top:8px;"><button class="btn small" onclick="abrirFormNuevoDocumento(${id})">+ Agregar documento</button></div>`:''}`;
  } else if(state.subtabSiniestro==='valuacion'){
    const puedeValuacion = currentUser && ['orlando','admin','jefe'].includes(currentUser.rol);
    const LABEL_VAL = { borrador:'Borrador', enviada:'Enviada', observada:'Observada', ajustada:'Ajustada', autorizada_parcial:'Autorizada parcial', autorizada_total:'Autorizada total', rechazada:'Rechazada' };
    const LABEL_AUT = { en_autorizacion:'En autorización', autorizada:'Autorizada', parcial:'Parcial', rechazada:'Rechazada', por_aclarar:'Por aclarar' };
    body = `
    <h3>Valuación</h3>
    <p class="subtle">Sección 5.6 del documento maestro. Sistema de valuación tomado del expediente digital (${esc(s.sistema_valuacion||'sin definir')}).</p>
    <table class="kv"><tbody>
      <tr><td>Estado de valuación</td><td>${esc(LABEL_VAL[s.estado_valuacion]||'Sin iniciar')}</td></tr>
      <tr><td>Folio / versión</td><td>${esc(s.valuacion_folio||'—')} ${s.valuacion_version?('· v'+s.valuacion_version):''}</td></tr>
      <tr><td>Importe</td><td>${s.valuacion_importe!=null?fmtMoney(s.valuacion_importe):'—'}</td></tr>
      <tr><td>Fecha de envío</td><td>${esc(s.valuacion_fecha_envio||'—')}</td></tr>
      <tr><td>Observaciones</td><td>${esc(s.valuacion_observaciones||'—')}</td></tr>
    </tbody></table>
    ${puedeValuacion?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormValuacion(${id})">Actualizar valuación</button></div>`:''}

    <h3 style="margin-top:20px;">Autorización</h3>
    <p class="subtle">Sección 5.7. Las piezas autorizadas a cambio alimentan la regla GNP 1-3 = autosurtido obligatorio.</p>
    <table class="kv"><tbody>
      <tr><td>Estado de autorización</td><td><span class="badge ${s.estado_autorizacion==='autorizada'?'verde':s.estado_autorizacion==='rechazada'?'rojo':'ambar'}">${esc(LABEL_AUT[s.estado_autorizacion]||'Sin iniciar')}</span></td></tr>
      <tr><td>Piezas autorizadas a cambio</td><td>${s.piezas_autorizadas_cambio!=null?s.piezas_autorizadas_cambio:'—'}</td></tr>
      <tr><td>Ruta de refacciones aplicada</td><td>${esc(s.aseguradora_ruta_refacciones||'—')}<div class="subtle">${esc(s.aseguradora_regla_aplicada||'')}</div></td></tr>
      <tr><td>Autorizador</td><td>${esc(s.autorizador||'—')}</td></tr>
      <tr><td>Fecha envío / respuesta</td><td>${esc(s.autorizacion_fecha_envio||'—')} / ${esc(s.autorizacion_fecha_respuesta||'—')}</td></tr>
      <tr><td>Importe autorizado</td><td>${s.autorizacion_importe!=null?fmtMoney(s.autorizacion_importe):'—'}</td></tr>
      <tr><td>Restricciones</td><td>${esc(s.autorizacion_restricciones||'—')}</td></tr>
    </tbody></table>
    ${puedeValuacion?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormAutorizacion(${id})">Actualizar autorización</button></div>`:''}`;
  } else if(state.subtabSiniestro==='produccion'){
    const puedeProduccion = currentUser && ['beto','orlando','admin','jefe'].includes(currentUser.rol);
    const ots = await api('GET','/api/ordenes-trabajo?siniestro_id='+id);
    let operaciones = [];
    for(const ot of ots){ const ops = await api('GET','/api/ot-operaciones?ot_id='+ot.id); ops.forEach(op=>operaciones.push({op,ot})); }
    const complementosLista = await api('GET','/api/complementos?siniestro_id='+id);
    const retrabajosLista = await api('GET','/api/retrabajos?siniestro_id='+id);
    const LABEL_PROD = { programado:'Programado', en_laminado:'En laminado', mecanica:'Mecánica', preparacion:'Preparación', pintura:'Pintura', armado:'Armado', detenido:'Detenido', terminado:'Terminado' };
    const LABEL_OT = { borrador:'Borrador', emitida:'Emitida', actualizada:'Actualizada', suspendida:'Suspendida', terminada:'Terminada' };
    const LABEL_OP = { programado:'Programado', en_proceso:'En proceso', detenido:'Detenido', terminado:'Terminado' };
    const LABEL_DECISION = { pendiente:'Pendiente', autorizado:'Autorizado', rechazado:'Rechazado', parcial:'Parcial' };
    const LABEL_RETRABAJO = { abierto:'Abierto', en_correccion:'En corrección', reinspeccion:'Reinspección', cerrado:'Cerrado' };
    body = `
    <h3>Producción</h3>
    <table class="kv"><tbody>
      <tr><td>Etapa de producción</td><td><span class="badge ${s.estado_produccion==='terminado'?'verde':s.estado_produccion==='detenido'?'rojo':'ambar'}">${esc(LABEL_PROD[s.estado_produccion]||'Sin iniciar')}</span></td></tr>
    </tbody></table>
    ${puedeProduccion?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormEtapaProduccion(${id})">Actualizar etapa</button></div>`:''}

    <h4 style="margin-top:16px;">Órdenes de trabajo</h4>
    ${ots.length===0?'<div class="empty">Sin OT registradas.</div>':`
    <table><thead><tr><th>Número</th><th>Versión</th><th>Estado</th><th>Alcance</th><th></th></tr></thead><tbody>
    ${ots.map(ot=>`<tr>
      <td>${esc(ot.numero)}</td><td>${ot.version}</td>
      <td><span class="badge ${ot.estado==='terminada'?'verde':ot.estado==='suspendida'?'rojo':'ambar'}">${LABEL_OT[ot.estado]||ot.estado}</span></td>
      <td>${esc(ot.alcance||'—')}</td>
      <td>${puedeProduccion?`<button class="btn small secondary" onclick="abrirFormEditarOt(${ot.id})">Editar</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`}
    ${puedeProduccion?`<div style="margin-top:8px;"><button class="btn small" onclick="abrirFormNuevaOt(${id})">+ Nueva OT</button></div>`:''}

    <h4 style="margin-top:16px;">Operaciones</h4>
    ${operaciones.length===0?'<div class="empty">Sin operaciones registradas.</div>':`
    <table><thead><tr><th>OT</th><th>Operación</th><th>Área</th><th>Técnico</th><th>Estado</th><th>Avance</th><th>Bloqueo</th><th></th></tr></thead><tbody>
    ${operaciones.map(o=>`<tr>
      <td>${esc(o.ot.numero)}</td>
      <td>${esc(o.op.descripcion)}${o.op.pieza?`<div class="subtle">${esc(o.op.pieza)}</div>`:''}</td>
      <td>${esc(o.op.area||'—')}</td>
      <td>${esc(o.op.tecnico||'—')}</td>
      <td><span class="badge ${o.op.estado==='terminado'?'verde':o.op.estado==='detenido'?'rojo':'ambar'}">${LABEL_OP[o.op.estado]||o.op.estado}</span></td>
      <td>${o.op.avance}%</td>
      <td>${esc(o.op.causa_bloqueo||'—')}</td>
      <td>${puedeProduccion?`<button class="btn small secondary" onclick="abrirFormEditarOperacion(${o.op.id})">Editar</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`}
    ${puedeProduccion && ots.length>0?`<div style="margin-top:8px;"><select id="opOtSel">${ots.map(ot=>`<option value="${ot.id}">OT ${esc(ot.numero)} v${ot.version}</option>`).join('')}</select> <button class="btn small" onclick="abrirFormNuevaOperacion()">+ Agregar operación</button></div>`:''}

    <h4 style="margin-top:16px;">Complementos por daño oculto</h4>
    ${complementosLista.length===0?'<div class="empty">Sin complementos registrados.</div>':`
    <table><thead><tr><th>Causa</th><th>Fecha</th><th>Decisión</th><th>Estado</th><th>Importe</th><th></th></tr></thead><tbody>
    ${complementosLista.map(c=>`<tr>
      <td>${esc(c.causa)}${c.pieza_operacion?`<div class="subtle">${esc(c.pieza_operacion)}</div>`:''}</td>
      <td>${esc(c.fecha||'—')}</td>
      <td><span class="badge ${c.decision==='autorizado'?'verde':c.decision==='rechazado'?'rojo':'ambar'}">${LABEL_DECISION[c.decision]||c.decision}</span></td>
      <td>${esc(c.estado)}</td>
      <td>${c.importe!=null?fmtMoney(c.importe):'—'}</td>
      <td>${puedeProduccion?`<button class="btn small secondary" onclick="abrirFormEditarComplemento(${c.id})">Editar</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`}
    ${puedeProduccion?`<div style="margin-top:8px;"><button class="btn small" onclick="abrirFormNuevoComplemento(${id})">+ Agregar complemento</button></div>`:''}

    <h4 style="margin-top:16px;">Retrabajos</h4>
    ${retrabajosLista.length===0?'<div class="empty">Sin retrabajos registrados.</div>':`
    <table><thead><tr><th>Origen</th><th>Severidad</th><th>Responsable</th><th>Estado</th><th></th></tr></thead><tbody>
    ${retrabajosLista.map(r=>`<tr>
      <td>${esc(r.origen)}${r.correccion?`<div class="subtle">Corrección: ${esc(r.correccion)}</div>`:''}</td>
      <td><span class="badge ${r.severidad==='critica'?'rojo':r.severidad==='media'?'ambar':'gris'}">${esc(r.severidad)}</span></td>
      <td>${esc(r.responsable||'—')}</td>
      <td><span class="badge ${r.estado==='cerrado'?'verde':'ambar'}">${LABEL_RETRABAJO[r.estado]||r.estado}</span></td>
      <td>${puedeProduccion?`<button class="btn small secondary" onclick="abrirFormEditarRetrabajo(${r.id})">Editar</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`}
    ${puedeProduccion?`<div style="margin-top:8px;"><button class="btn small" onclick="abrirFormNuevoRetrabajo(${id})">+ Agregar retrabajo</button></div>`:''}`;
  } else if(state.subtabSiniestro==='calidad'){
    const puedeCalidad = currentUser && ['beto','orlando','admin','jefe'].includes(currentUser.rol);
    const puedeEntregaDetalle = currentUser && ['beto','atencion_cliente','admin','jefe'].includes(currentUser.rol);
    const puedeFiniquito = currentUser && ['atencion_cliente','admin','jefe'].includes(currentUser.rol);
    const checklist = await api('GET','/api/checklist-calidad?siniestro_id='+id);
    const LABEL_CAL = { en_inspeccion:'En inspección', rechazado_a_retrabajo:'Rechazado a retrabajo', reinspeccion:'Reinspección', liberado:'Liberado' };
    const LABEL_RES = { pendiente:'Pendiente', aprobado:'Aprobado', rechazado:'Rechazado' };
    const LABEL_ENTREGA = { listo:'Listo', cita_confirmada:'Cita confirmada', entregado_con_observacion:'Entregado con observación', entregado:'Entregado' };
    const LABEL_FINIQUITO = { pendiente:'Pendiente', firmado:'Firmado', inconformidad_abierta:'Inconformidad abierta' };
    const LABEL_ENCUESTA = { pendiente:'Pendiente', enviada:'Enviada', respondida:'Respondida' };
    body = `
    <h3>Control de calidad</h3>
    <table class="kv"><tbody>
      <tr><td>Estado de calidad</td><td><span class="badge ${s.estado_calidad==='liberado'?'verde':'ambar'}">${esc(LABEL_CAL[s.estado_calidad]||'Sin iniciar')}</span></td></tr>
    </tbody></table>
    ${puedeCalidad?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormEstadoCalidad(${id})">Actualizar estado de calidad</button></div>`:''}

    <h4 style="margin-top:16px;">Checklist (7 dimensiones)</h4>
    ${checklist.length===0?'<div class="empty">Sin rubros capturados todavía.</div>':`
    <table><thead><tr><th>Dimensión</th><th>Resultado</th><th>Hallazgo</th><th>Inspector</th><th></th></tr></thead><tbody>
    ${checklist.map(c=>`<tr>
      <td>${esc(c.dimension)}</td>
      <td><span class="badge ${c.resultado==='aprobado'?'verde':c.resultado==='rechazado'?'rojo':'gris'}">${LABEL_RES[c.resultado]||c.resultado}</span></td>
      <td>${esc(c.hallazgo||'—')}</td>
      <td class="subtle">${esc(c.inspector_nombre||'—')}</td>
      <td>${puedeCalidad?`<button class="btn small secondary" onclick="abrirFormEditarChecklistCalidad(${c.id})">Editar</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`}
    ${puedeCalidad?`<div style="margin-top:8px;"><button class="btn small" onclick="abrirFormNuevoChecklistCalidad(${id})">+ Agregar rubro</button></div>`:''}

    <h3 style="margin-top:20px;">Entrega</h3>
    <table class="kv"><tbody>
      <tr><td>Fecha de entrega</td><td>${s.fecha_entrega_real?esc(s.fecha_entrega_real):'<span class="badge ambar">Sin registrar</span>'}</td></tr>
      <tr><td>Estado de entrega</td><td>${esc(LABEL_ENTREGA[s.estado_entrega]||'—')}</td></tr>
      <tr><td>Receptor</td><td>${esc(s.entrega_receptor||'—')} ${s.entrega_identificacion?('· '+esc(s.entrega_identificacion)):''}</td></tr>
      <tr><td>Kilometraje / combustible</td><td>${esc(s.entrega_kilometraje||'—')} ${s.entrega_combustible?('· '+esc(s.entrega_combustible)):''}</td></tr>
      <tr><td>Llaves entregadas</td><td>${s.entrega_llaves_entregadas?'Sí':'No'}</td></tr>
      <tr><td>Observación</td><td>${esc(s.entrega_observacion||'—')}</td></tr>
    </tbody></table>
    <p class="subtle" style="margin-top:6px;">La fecha de entrega se registra con el botón "Registrar entrega" del encabezado. Aquí se captura el detalle (tabla 18 del documento maestro).</p>
    ${puedeEntregaDetalle?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormDetalleEntrega(${id})">Capturar detalle de entrega</button></div>`:''}

    <h3 style="margin-top:20px;">Finiquito y encuesta</h3>
    <table class="kv"><tbody>
      <tr><td>Finiquito</td><td><span class="badge ${s.finiquito_estado==='firmado'?'verde':s.finiquito_estado==='inconformidad_abierta'?'rojo':'ambar'}">${esc(LABEL_FINIQUITO[s.finiquito_estado]||'Pendiente')}</span> ${s.finiquito_fecha?('· '+esc(s.finiquito_fecha)):''}</td></tr>
      <tr><td>Observación de finiquito</td><td>${esc(s.finiquito_observacion||'—')}</td></tr>
      <tr><td>Encuesta</td><td>${esc(LABEL_ENCUESTA[s.encuesta_estado]||'Pendiente')} ${s.encuesta_calificacion!=null?('· calificación '+s.encuesta_calificacion):''}</td></tr>
      <tr><td>Comentarios de encuesta</td><td>${esc(s.encuesta_comentarios||'—')}</td></tr>
    </tbody></table>
    ${puedeFiniquito?`<div style="margin-top:8px;"><button class="btn small secondary" onclick="abrirFormFiniquito(${id})">Actualizar finiquito / encuesta</button></div>`:''}`;
  } else if(state.subtabSiniestro==='pedidos'){
    body = `<table><thead><tr><th>Pedido</th><th>F. creación</th><th>F. prevista</th><th>Estatus Inpart</th><th>Estatus operativo</th><th>Total</th><th></th></tr></thead><tbody>
    ${peds.map(p=>`<tr><td>${esc(p.numero)}</td><td>${esc(p.fecha_creacion)}</td><td>${esc(p.fecha_prevista)}</td><td>${esc(p.estatus_inpart)}</td><td>
      <select onchange="cambiarEstatusOperativo(${p.id}, this.value)">${ESTATUS_OPERATIVO.map(e=>`<option ${e===p.estatus_operativo?'selected':''}>${e}</option>`).join('')}</select>
    </td><td>${fmtMoney(p.total)}</td>
    <td><button class="btn small" onclick="abrirGenerador(${p.id})">Generar correo</button></td></tr>`).join('')}
    </tbody></table>
    ${peds.length===0?'<div class="empty">Este siniestro todavía no tiene pedidos.</div>':''}`;
  } else if(state.subtabSiniestro==='piezas'){
    let allz = [];
    for(const p of peds){ const zs = await api('GET','/api/piezas?pedido_id='+p.id); zs.forEach(z=>allz.push({z,p})); }
    body = `<table><thead><tr><th>Pedido</th><th>Pieza</th><th>Proveedor</th><th>Precio</th><th>F. prometida</th><th>Estatus</th><th>Recepción</th><th></th></tr></thead><tbody>
    ${allz.map(o=>`<tr>
      <td>${esc(o.p.numero)}</td><td>${esc(o.z.descripcion)}${o.z.observaciones?`<div class="subtle">${esc(o.z.observaciones)}</div>`:''}</td>
      <td>${o.z.proveedor_id?esc('#'+o.z.proveedor_id):'—'}</td><td>${fmtMoney(o.z.precio)}</td>
      <td>${esc(o.z.fecha_prometida||'')}</td>
      <td>${esc(o.z.estatus)}</td>
      <td>${o.z.fecha_recepcion?esc(o.z.fecha_recepcion):'—'}</td>
      <td>
        ${!['Recibida físicamente','Cancelada'].includes(o.z.estatus)?`<button class="btn small secondary" onclick="marcarRecibida(${o.z.id})">Marcar recibida</button>`:''}
        <button class="btn small secondary" onclick="abrirFormIncidencia(${o.z.id})">Incidencia</button>
        <button class="btn small secondary" onclick="abrirFormEditarPieza(${o.z.id})">Editar</button>
      </td>
    </tr>`).join('')}
    </tbody></table>
    ${peds.length>0?`<div style="margin-top:10px"><select id="piezaPedidoSel">${peds.map(p=>`<option value="${p.id}">Pedido ${esc(p.numero)}</option>`).join('')}</select> <button class="btn small" onclick="abrirFormNuevaPieza()">+ Agregar pieza</button></div>`:'<div class="empty">Da de alta un pedido primero para poder agregar piezas.</div>'}`;
  } else if(state.subtabSiniestro==='incidencias'){
    let todas = [];
    for(const p of peds){ const zs = await api('GET','/api/piezas?pedido_id='+p.id); for(const z of zs){ const incs = await api('GET','/api/incidencias?pieza_id='+z.id); incs.forEach(i=>todas.push({i,z,p})); } }
    body = todas.length===0?'<div class="empty">Sin incidencias registradas para este siniestro.</div>':`
    <table><thead><tr><th>Pieza</th><th>Tipo</th><th>Acción</th><th>Fecha compromiso</th><th>Estado</th><th>Resolución</th><th></th></tr></thead><tbody>
    ${todas.map(o=>`<tr>
      <td>${esc(o.z.descripcion)}</td><td>${esc(o.i.tipo)}</td><td>${esc(o.i.accion_solicitada||'—')}</td><td>${esc(o.i.fecha_compromiso||'—')}</td>
      <td><span class="badge ${o.i.estado==='abierta'?'rojo':o.i.estado==='resuelta'?'verde':'ambar'}">${esc(o.i.estado)}</span></td>
      <td>${esc(o.i.resolucion||'—')}</td>
      <td>${o.i.estado==='abierta'||o.i.estado==='en_proceso'?`<button class="btn small secondary" onclick="abrirFormResolverIncidencia(${o.i.id})">Resolver</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`;
  } else if(state.subtabSiniestro==='comunicaciones'){
    let todas = [];
    for(const p of peds){ const cs = await api('GET','/api/comunicaciones?pedido_id='+p.id); cs.forEach(c=>todas.push(c)); }
    body = `<table><thead><tr><th>Fecha</th><th>Asunto</th><th>Destinatario</th><th>Respuesta</th><th></th></tr></thead><tbody>
    ${todas.length===0?'<tr><td colspan="5" class="empty">Sin comunicaciones registradas.</td></tr>':todas.map(c=>`<tr>
      <td>${esc(c.fecha_envio)}</td><td>${esc(c.asunto)}</td><td>${esc(c.destinatarios)}</td>
      <td>${c.respuesta_texto?esc(c.respuesta_texto):'<span class="badge ambar">Pendiente</span>'}</td>
      <td>${!c.respuesta_texto?`<button class="btn small secondary" onclick="abrirFormRespuesta(${c.id})">Registrar respuesta</button>`:''}</td>
    </tr>`).join('')}
    </tbody></table>`;
  } else if(state.subtabSiniestro==='archivos'){
    const archivos = await api('GET','/api/archivos?entidad_tipo=siniestro&entidad_id='+id);
    body = `<table><thead><tr><th>Tipo</th><th>Nombre</th><th>Fecha</th><th></th></tr></thead><tbody>
    ${archivos.length===0?'<tr><td colspan="4" class="empty">Sin archivos.</td></tr>':archivos.map(a=>`<tr><td>${esc(a.tipo)}</td><td>${esc(a.nombre_original)}</td><td>${esc(a.creado_en)}</td><td><a class="link" href="/api/archivos/${a.id}/descargar" target="_blank">Descargar</a></td></tr>`).join('')}
    </tbody></table>
    <form id="formArchivo" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;" onsubmit="return subirArchivo(event, ${id})">
      <input type="file" id="archivoInput" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" required>
      <select id="archivoTipo"><option>Evidencia</option><option>Valuación</option><option>Orden de trabajo</option><option>Comparativo</option><option>Pedido</option></select>
      <button class="btn small" type="submit">Subir archivo real</button>
    </form>`;
  } else if(state.subtabSiniestro==='timeline'){
    const eventos = await api('GET','/api/auditoria?entidad_tipo=siniestro&entidad_id='+id);
    let pedEventos = [];
    for(const p of peds){ const e = await api('GET','/api/auditoria?entidad_tipo=pedido&entidad_id='+p.id); pedEventos.push(...e); }
    const todos = [...eventos, ...pedEventos].sort((a,b)=> b.id - a.id);
    body = todos.length===0?'<div class="empty">Sin eventos.</div>':`<ul class="timeline">${todos.map(e=>`<li><b>${esc(e.fecha)}</b> — ${esc(e.accion)}${e.campo?` (${esc(e.campo)}: ${esc(e.valor_anterior)} → ${esc(e.valor_nuevo)})`:e.valor_nuevo?': '+esc(e.valor_nuevo):''} <span class="subtle">(${esc(e.usuario_nombre)})</span></li>`).join('')}</ul>`;
  }

  const puedeCerrar = currentUser && ['operativo','jefe','admin'].includes(currentUser.rol);
  const puedeEntregar = currentUser && ['operativo','atencion_cliente','admin'].includes(currentUser.rol);
  return `
  <button class="btn ghost small no-print" onclick="goTo('kanban')">← Volver</button>
  <div class="section" style="margin-top:10px;">
    ${s.completo===0?`<div class="banner ambar">Este siniestro está <b>Pendiente de completar</b> (faltan vehículo o placas). <button class="btn small secondary" onclick="abrirFormEditarSiniestro(${s.id})">Completar datos</button></div>`:''}
    ${s.estatus_general==='Cerrado'?`<div class="banner verde">Siniestro cerrado.</div>`:''}
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div>
        <h2 style="margin-bottom:2px;">Siniestro ${esc(s.numero)} <span class="badge azul">${esc(s.aseguradora)}</span> <span class="badge ${s.estatus_general==='Cerrado'?'verde':'gris'}">${esc(s.estatus_general)}</span></h2>
        <p class="subtle">${esc(s.vehiculo||'')} ${esc(s.anio_modelo||'')} · Placas ${esc(s.placas||'')} · Ingreso: ${esc(s.fecha_ingreso||'')} · Responsable: ${esc(s.responsable||'')}</p>
        ${s.cliente_nombre?`<p class="subtle">Cliente: ${esc(s.cliente_nombre)}${s.cliente_telefono?' · '+esc(s.cliente_telefono):''}${s.etapa_actual?' · Etapa: '+esc(s.etapa_actual):''}</p>`:''}
        <p class="subtle">Entrega de unidad: ${s.fecha_entrega_real?esc(s.fecha_entrega_real):'<span class="badge ambar">Sin registrar</span>'}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
        ${puedeEntregar && s.estatus_general!=='Cerrado'?`<button class="btn small secondary" onclick="abrirFormEntrega(${s.id})">${s.fecha_entrega_real?'Editar entrega':'Registrar entrega'}</button>`:''}
        ${puedeCerrar && s.estatus_general!=='Cerrado'?`<button class="btn small" onclick="intentarCerrarSiniestro(${s.id})">Cerrar siniestro</button>`:''}
        <button class="btn small secondary" onclick="abrirFormEditarSiniestro(${s.id})">Editar</button>
      </div>
    </div>
  </div>
  <div class="tabs-sub no-print">${subtabs.map(t=>`<button class="${state.subtabSiniestro===t[0]?'active':''}" onclick="setSubtabSiniestro('${t[0]}')">${t[1]}</button>`).join('')}</div>
  <div class="section">${body}</div>`;
}
function abrirFormEntrega(siniestroId){
  showModal(`
    <h3>Registrar entrega de la unidad</h3>
    <div class="field"><label>Fecha de entrega</label><input id="fent_fecha" type="date" value="${todayISO()}"></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEntrega(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarEntrega(siniestroId){
  const fecha = document.getElementById('fent_fecha').value;
  if(!fecha){ toast('Indica la fecha de entrega.', 'error'); return; }
  try{
    await api('PATCH', `/api/siniestros/${siniestroId}/entrega`, { fecha_entrega_real: fecha });
    toast('Entrega registrada.', 'success');
    closeModal(); render();
  }catch(e){}
}
function abrirFormAdmision(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Recepción y admisión</h3>
      <div class="row-flex">
        <div class="field"><label>Ingreso</label><select id="fad_ingreso_tipo">
          <option value="" ${!s.ingreso_tipo?'selected':''}>Sin definir</option>
          <option value="circulando" ${s.ingreso_tipo==='circulando'?'selected':''}>Circulando</option>
          <option value="grua" ${s.ingreso_tipo==='grua'?'selected':''}>Grúa</option>
        </select></div>
        <div class="field"><label>¿Es seguro que circule?</label><select id="fad_ingreso_seguro">
          <option value="" ${s.ingreso_seguro===null||s.ingreso_seguro===undefined?'selected':''}>Sin definir</option>
          <option value="1" ${s.ingreso_seguro===1?'selected':''}>Sí</option>
          <option value="0" ${s.ingreso_seguro===0?'selected':''}>No</option>
        </select></div>
      </div>
      <div class="row-flex">
        <div class="field"><label>Cita</label><input id="fad_cita_fecha" type="date" value="${esc(s.cita_fecha||'')}"></div>
        <div class="field"><label>Fecha de admisión</label><input id="fad_fecha_admision" type="date" value="${esc(s.fecha_admision||'')}"></div>
      </div>
      <div class="row-flex">
        <div class="field"><label>Operador de grúa</label><input id="fad_grua_operador" value="${esc(s.grua_operador||'')}"></div>
        <div class="field"><label>Hora de grúa</label><input id="fad_grua_hora" type="time" value="${esc(s.grua_hora||'')}"></div>
      </div>
      <div class="row-flex">
        <div class="field"><label>Kilometraje</label><input id="fad_kilometraje" value="${esc(s.kilometraje||'')}"></div>
        <div class="field"><label>Nivel de combustible</label><input id="fad_combustible" value="${esc(s.combustible_nivel||'')}" placeholder="Ej. 1/2"></div>
      </div>
      <div class="field"><label>¿Llaves entregadas?</label><select id="fad_llaves">
        <option value="1" ${s.llaves_entregadas?'selected':''}>Sí</option>
        <option value="0" ${!s.llaves_entregadas?'selected':''}>No</option>
      </select></div>
      <div class="field"><label>Pertenencias del vehículo</label><textarea id="fad_pertenencias">${esc(s.pertenencias||'')}</textarea></div>
      <div class="field"><label>Estado de admisión</label><select id="fad_estado_admision" onchange="document.getElementById('fad_motivo_wrap').style.display=(this.value==='condicionado'||this.value==='no_admitido')?'block':'none'">
        <option value="" ${!s.estado_admision?'selected':''}>Pendiente</option>
        <option value="admitido" ${s.estado_admision==='admitido'?'selected':''}>Admitido</option>
        <option value="condicionado" ${s.estado_admision==='condicionado'?'selected':''}>Condicionado por faltante</option>
        <option value="no_admitido" ${s.estado_admision==='no_admitido'?'selected':''}>No admitido</option>
      </select></div>
      <div id="fad_motivo_wrap" class="field" style="display:${['condicionado','no_admitido'].includes(s.estado_admision)?'block':'none'}"><label>Motivo</label><textarea id="fad_motivo_admision">${esc(s.motivo_admision||'')}</textarea></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarAdmision(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarAdmision(siniestroId){
  const payload = {
    ingreso_tipo: document.getElementById('fad_ingreso_tipo').value,
    ingreso_seguro: document.getElementById('fad_ingreso_seguro').value === '' ? null : Number(document.getElementById('fad_ingreso_seguro').value),
    cita_fecha: document.getElementById('fad_cita_fecha').value,
    fecha_admision: document.getElementById('fad_fecha_admision').value,
    grua_operador: document.getElementById('fad_grua_operador').value,
    grua_hora: document.getElementById('fad_grua_hora').value,
    kilometraje: document.getElementById('fad_kilometraje').value,
    combustible_nivel: document.getElementById('fad_combustible').value,
    llaves_entregadas: Number(document.getElementById('fad_llaves').value),
    pertenencias: document.getElementById('fad_pertenencias').value,
    estado_admision: document.getElementById('fad_estado_admision').value,
    motivo_admision: document.getElementById('fad_motivo_admision').value
  };
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, payload);
    toast('Admisión actualizada.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormRevisionTecnica(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Revisión técnica</h3>
      <div class="field"><label>Estado de revisión</label><select id="frt_estado">
        <option value="" ${!s.estado_revision_tecnica?'selected':''}>Sin iniciar</option>
        <option value="en_revision" ${s.estado_revision_tecnica==='en_revision'?'selected':''}>En revisión</option>
        <option value="requiere_desarme" ${s.estado_revision_tecnica==='requiere_desarme'?'selected':''}>Requiere desarme</option>
        <option value="revision_terminada" ${s.estado_revision_tecnica==='revision_terminada'?'selected':''}>Revisión terminada</option>
      </select></div>
      <div class="field"><label>Estado de evidencia</label><select id="frt_evidencia">
        <option value="" ${!s.estado_evidencia?'selected':''}>Sin definir</option>
        <option value="evidencia_completa" ${s.estado_evidencia==='evidencia_completa'?'selected':''}>Evidencia completa</option>
        <option value="desarme_parcial" ${s.estado_evidencia==='desarme_parcial'?'selected':''}>Desarme parcial</option>
        <option value="dano_oculto_detectado" ${s.estado_evidencia==='dano_oculto_detectado'?'selected':''}>Daño oculto detectado</option>
      </select></div>
      <div class="field"><label>¿Riesgo de seguridad (vehículo no seguro)?</label><select id="frt_riesgo" onchange="document.getElementById('frt_riesgo_motivo_wrap').style.display=this.value==='1'?'block':'none'">
        <option value="0" ${!s.riesgo_seguridad?'selected':''}>No</option>
        <option value="1" ${s.riesgo_seguridad?'selected':''}>Sí</option>
      </select></div>
      <div id="frt_riesgo_motivo_wrap" class="field" style="display:${s.riesgo_seguridad?'block':'none'}"><label>Motivo técnico del riesgo</label><textarea id="frt_riesgo_motivo">${esc(s.riesgo_seguridad_motivo||'')}</textarea></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarRevisionTecnica(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarRevisionTecnica(siniestroId){
  const payload = {
    estado_revision_tecnica: document.getElementById('frt_estado').value,
    estado_evidencia: document.getElementById('frt_evidencia').value,
    riesgo_seguridad: Number(document.getElementById('frt_riesgo').value),
    riesgo_seguridad_motivo: document.getElementById('frt_riesgo_motivo').value
  };
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, payload);
    toast('Revisión técnica actualizada.', 'success');
    closeModal(); render();
  }catch(e){}
}

async function abrirFormNuevoHallazgo(siniestroId){
  const archivos = await api('GET','/api/archivos?entidad_tipo=siniestro&entidad_id='+siniestroId);
  showModal(`
    <h3>Agregar hallazgo</h3>
    <div class="row-flex">
      <div class="field"><label>Zona / pieza</label><input id="fh_zona" placeholder="Ej. puerta delantera derecha"></div>
      <div class="field"><label>Tipo de daño</label><input id="fh_tipo"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Visibilidad</label><select id="fh_visibilidad"><option value="visible">Visible</option><option value="oculto">Oculto</option></select></div>
      <div class="field"><label>¿Relacionado con el siniestro?</label><select id="fh_relacionado"><option value="1">Sí</option><option value="0">No</option></select></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Severidad</label><input id="fh_severidad" placeholder="Leve / media / severa"></div>
      <div class="field"><label>Operación preliminar</label><input id="fh_operacion"></div>
    </div>
    <div class="field"><label>Foto asociada (opcional, ya subida en Archivos)</label><select id="fh_archivo">
      <option value="">Sin foto</option>
      ${archivos.map(a=>`<option value="${a.id}">${esc(a.nombre_original)}</option>`).join('')}
    </select></div>
    <div class="field"><label>Observaciones</label><textarea id="fh_observaciones"></textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevoHallazgo(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarNuevoHallazgo(siniestroId){
  const zona = document.getElementById('fh_zona').value.trim();
  if(!zona){ toast('Indica la zona o pieza afectada.', 'error'); return; }
  try{
    await api('POST','/api/danos-evidencia', {
      siniestro_id: siniestroId, zona_pieza: zona, tipo_dano: document.getElementById('fh_tipo').value,
      visibilidad: document.getElementById('fh_visibilidad').value, relacionado: Number(document.getElementById('fh_relacionado').value),
      severidad: document.getElementById('fh_severidad').value, operacion_preliminar: document.getElementById('fh_operacion').value,
      archivo_id: document.getElementById('fh_archivo').value || null, observaciones: document.getElementById('fh_observaciones').value
    });
    toast('Hallazgo agregado.', 'success');
    closeModal(); render();
  }catch(e){}
}
async function abrirFormEditarHallazgo(hallazgoId){
  const todos = await api('GET','/api/danos-evidencia');
  const h = todos.find(x=>x.id===hallazgoId);
  if(!h){ toast('Hallazgo no encontrado.', 'error'); return; }
  const archivos = await api('GET','/api/archivos?entidad_tipo=siniestro&entidad_id='+h.siniestro_id);
  showModal(`
    <h3>Editar hallazgo</h3>
    <div class="row-flex">
      <div class="field"><label>Zona / pieza</label><input id="fhe_zona" value="${esc(h.zona_pieza)}"></div>
      <div class="field"><label>Tipo de daño</label><input id="fhe_tipo" value="${esc(h.tipo_dano||'')}"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Visibilidad</label><select id="fhe_visibilidad">
        <option value="visible" ${h.visibilidad==='visible'?'selected':''}>Visible</option>
        <option value="oculto" ${h.visibilidad==='oculto'?'selected':''}>Oculto</option>
      </select></div>
      <div class="field"><label>¿Relacionado?</label><select id="fhe_relacionado">
        <option value="1" ${h.relacionado?'selected':''}>Sí</option>
        <option value="0" ${!h.relacionado?'selected':''}>No</option>
      </select></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Severidad</label><input id="fhe_severidad" value="${esc(h.severidad||'')}"></div>
      <div class="field"><label>Operación preliminar</label><input id="fhe_operacion" value="${esc(h.operacion_preliminar||'')}"></div>
    </div>
    <div class="field"><label>Foto asociada</label><select id="fhe_archivo">
      <option value="">Sin foto</option>
      ${archivos.map(a=>`<option value="${a.id}" ${h.archivo_id===a.id?'selected':''}>${esc(a.nombre_original)}</option>`).join('')}
    </select></div>
    <div class="field"><label>Observaciones</label><textarea id="fhe_observaciones">${esc(h.observaciones||'')}</textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionHallazgo(${hallazgoId})">Guardar</button></div>
  `);
}
async function guardarEdicionHallazgo(hallazgoId){
  const zona = document.getElementById('fhe_zona').value.trim();
  if(!zona){ toast('Indica la zona o pieza afectada.', 'error'); return; }
  try{
    await api('PATCH','/api/danos-evidencia/'+hallazgoId, {
      zona_pieza: zona, tipo_dano: document.getElementById('fhe_tipo').value,
      visibilidad: document.getElementById('fhe_visibilidad').value, relacionado: Number(document.getElementById('fhe_relacionado').value),
      severidad: document.getElementById('fhe_severidad').value, operacion_preliminar: document.getElementById('fhe_operacion').value,
      archivo_id: document.getElementById('fhe_archivo').value || null, observaciones: document.getElementById('fhe_observaciones').value
    });
    toast('Hallazgo actualizado.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormExpedienteDigital(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Actualizar expediente digital</h3>
      <div class="field"><label>Estado del expediente</label><select id="fex_estado">
        <option value="" ${!s.estado_expediente?'selected':''}>Sin iniciar</option>
        <option value="en_captura" ${s.estado_expediente==='en_captura'?'selected':''}>En captura</option>
        <option value="incompleto" ${s.estado_expediente==='incompleto'?'selected':''}>Incompleto</option>
        <option value="listo_para_valuacion" ${s.estado_expediente==='listo_para_valuacion'?'selected':''}>Listo para valuación</option>
      </select></div>
      <div class="field"><label>Sistema de valuación</label><select id="fex_sistema">
        <option value="" ${!s.sistema_valuacion?'selected':''}>Sin definir</option>
        <option value="ACG" ${s.sistema_valuacion==='ACG'?'selected':''}>ACG</option>
        <option value="BDEO" ${s.sistema_valuacion==='BDEO'?'selected':''}>BDEO</option>
        <option value="Sistema propio (Zurich)" ${s.sistema_valuacion==='Sistema propio (Zurich)'?'selected':''}>Sistema propio (Zurich)</option>
      </select><p class="subtle" style="margin:4px 0 0;">Sugerido según aseguradora; confírmalo o corrígelo si el caso lo requiere.</p></div>
      <div class="field"><label>Folio de expediente</label><input id="fex_folio" value="${esc(s.expediente_folio||'')}"></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarExpedienteDigital(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarExpedienteDigital(siniestroId){
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, {
      estado_expediente: document.getElementById('fex_estado').value,
      sistema_valuacion: document.getElementById('fex_sistema').value,
      expediente_folio: document.getElementById('fex_folio').value
    });
    toast('Expediente actualizado.', 'success');
    closeModal(); render();
  }catch(e){
    if(e.data && e.data.detalle){
      showModal(`<h3>No se puede marcar como listo</h3><p class="subtle">Faltan o no son legibles estos documentos:</p><ul>${e.data.detalle.map(d=>`<li>${esc(d)}</li>`).join('')}</ul><div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Entendido</button></div>`);
    }
  }
}

async function abrirFormNuevoDocumento(siniestroId){
  showModal(`
    <h3>Agregar documento</h3>
    <div class="row-flex">
      <div class="field"><label>Tipo de documento</label><input id="fdoc_tipo" placeholder="Ej. tarjeta de circulación, identificación, póliza"></div>
      <div class="field"><label>Versión</label><input id="fdoc_version" type="number" value="1" min="1"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Estado</label><select id="fdoc_estado">
        <option value="faltante">Faltante</option><option value="recibido">Recibido</option><option value="no_legible">No legible</option><option value="no_aplica">No aplica</option>
      </select></div>
      <div class="field"><label>Folio</label><input id="fdoc_folio"></div>
    </div>
    <div class="field"><label>Notas</label><textarea id="fdoc_notas"></textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevoDocumento(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarNuevoDocumento(siniestroId){
  const tipo = document.getElementById('fdoc_tipo').value.trim();
  if(!tipo){ toast('Indica el tipo de documento.', 'error'); return; }
  try{
    await api('POST','/api/documentos-expediente', {
      siniestro_id: siniestroId, tipo_documento: tipo, version: Number(document.getElementById('fdoc_version').value)||1,
      estado: document.getElementById('fdoc_estado').value, folio: document.getElementById('fdoc_folio').value,
      notas: document.getElementById('fdoc_notas').value
    });
    toast('Documento agregado.', 'success');
    closeModal(); render();
  }catch(e){}
}
async function abrirFormEditarDocumento(documentoId){
  const todos = await api('GET','/api/documentos-expediente');
  const d = todos.find(x=>x.id===documentoId);
  if(!d){ toast('Documento no encontrado.', 'error'); return; }
  showModal(`
    <h3>Editar documento</h3>
    <div class="row-flex">
      <div class="field"><label>Tipo de documento</label><input id="fdoce_tipo" value="${esc(d.tipo_documento)}"></div>
      <div class="field"><label>Versión</label><input id="fdoce_version" type="number" min="1" value="${d.version}"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Estado</label><select id="fdoce_estado">
        <option value="faltante" ${d.estado==='faltante'?'selected':''}>Faltante</option>
        <option value="recibido" ${d.estado==='recibido'?'selected':''}>Recibido</option>
        <option value="no_legible" ${d.estado==='no_legible'?'selected':''}>No legible</option>
        <option value="no_aplica" ${d.estado==='no_aplica'?'selected':''}>No aplica</option>
      </select></div>
      <div class="field"><label>Folio</label><input id="fdoce_folio" value="${esc(d.folio||'')}"></div>
    </div>
    <div class="field"><label>Notas</label><textarea id="fdoce_notas">${esc(d.notas||'')}</textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionDocumento(${documentoId})">Guardar</button></div>
  `);
}
async function guardarEdicionDocumento(documentoId){
  const tipo = document.getElementById('fdoce_tipo').value.trim();
  if(!tipo){ toast('Indica el tipo de documento.', 'error'); return; }
  try{
    await api('PATCH','/api/documentos-expediente/'+documentoId, {
      tipo_documento: tipo, version: Number(document.getElementById('fdoce_version').value)||1,
      estado: document.getElementById('fdoce_estado').value, folio: document.getElementById('fdoce_folio').value,
      notas: document.getElementById('fdoce_notas').value
    });
    toast('Documento actualizado.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormValuacion(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Actualizar valuación</h3>
      <p class="subtle">Sistema: ${esc(s.sistema_valuacion||'sin definir en el expediente digital')}</p>
      <div class="field"><label>Estado de valuación</label><select id="fval_estado">
        <option value="" ${!s.estado_valuacion?'selected':''}>Sin iniciar</option>
        <option value="borrador" ${s.estado_valuacion==='borrador'?'selected':''}>Borrador</option>
        <option value="enviada" ${s.estado_valuacion==='enviada'?'selected':''}>Enviada</option>
        <option value="observada" ${s.estado_valuacion==='observada'?'selected':''}>Observada</option>
        <option value="ajustada" ${s.estado_valuacion==='ajustada'?'selected':''}>Ajustada</option>
        <option value="autorizada_parcial" ${s.estado_valuacion==='autorizada_parcial'?'selected':''}>Autorizada parcial</option>
        <option value="autorizada_total" ${s.estado_valuacion==='autorizada_total'?'selected':''}>Autorizada total</option>
        <option value="rechazada" ${s.estado_valuacion==='rechazada'?'selected':''}>Rechazada</option>
      </select></div>
      <div class="row-flex">
        <div class="field"><label>Folio</label><input id="fval_folio" value="${esc(s.valuacion_folio||'')}"></div>
        <div class="field"><label>Versión</label><input id="fval_version" type="number" min="1" value="${s.valuacion_version||1}"></div>
      </div>
      <div class="row-flex">
        <div class="field"><label>Importe</label><input id="fval_importe" type="number" step="0.01" value="${s.valuacion_importe!=null?s.valuacion_importe:''}"></div>
        <div class="field"><label>Fecha de envío</label><input id="fval_fecha" type="date" value="${esc(s.valuacion_fecha_envio||'')}"></div>
      </div>
      <div class="field"><label>Observaciones</label><textarea id="fval_observaciones">${esc(s.valuacion_observaciones||'')}</textarea></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarValuacion(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarValuacion(siniestroId){
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, {
      estado_valuacion: document.getElementById('fval_estado').value,
      valuacion_folio: document.getElementById('fval_folio').value,
      valuacion_version: Number(document.getElementById('fval_version').value)||1,
      valuacion_importe: document.getElementById('fval_importe').value===''?null:Number(document.getElementById('fval_importe').value),
      valuacion_fecha_envio: document.getElementById('fval_fecha').value,
      valuacion_observaciones: document.getElementById('fval_observaciones').value
    });
    toast('Valuación actualizada.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormAutorizacion(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Actualizar autorización</h3>
      <div class="field"><label>Estado de autorización</label><select id="faut_estado">
        <option value="" ${!s.estado_autorizacion?'selected':''}>Sin iniciar</option>
        <option value="en_autorizacion" ${s.estado_autorizacion==='en_autorizacion'?'selected':''}>En autorización</option>
        <option value="autorizada" ${s.estado_autorizacion==='autorizada'?'selected':''}>Autorizada</option>
        <option value="parcial" ${s.estado_autorizacion==='parcial'?'selected':''}>Parcial</option>
        <option value="rechazada" ${s.estado_autorizacion==='rechazada'?'selected':''}>Rechazada</option>
        <option value="por_aclarar" ${s.estado_autorizacion==='por_aclarar'?'selected':''}>Por aclarar</option>
      </select></div>
      <div class="field"><label>Piezas autorizadas a cambio</label><input id="faut_piezas" type="number" min="0" value="${s.piezas_autorizadas_cambio!=null?s.piezas_autorizadas_cambio:''}">
        <p class="subtle" style="margin:4px 0 0;">Con GNP: 1 a 3 piezas activa autosurtido obligatorio; más de 3, Inpart. Se recalcula al guardar.</p></div>
      <div class="row-flex">
        <div class="field"><label>Fecha de envío</label><input id="faut_fecha_envio" type="date" value="${esc(s.autorizacion_fecha_envio||'')}"></div>
        <div class="field"><label>Fecha de respuesta</label><input id="faut_fecha_respuesta" type="date" value="${esc(s.autorizacion_fecha_respuesta||'')}"></div>
      </div>
      <div class="row-flex">
        <div class="field"><label>Autorizador</label><input id="faut_autorizador" value="${esc(s.autorizador||'')}" placeholder="Ajustador / plataforma / propietario"></div>
        <div class="field"><label>Importe autorizado</label><input id="faut_importe" type="number" step="0.01" value="${s.autorizacion_importe!=null?s.autorizacion_importe:''}"></div>
      </div>
      <div class="field"><label>Restricciones</label><textarea id="faut_restricciones">${esc(s.autorizacion_restricciones||'')}</textarea></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarAutorizacion(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarAutorizacion(siniestroId){
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, {
      estado_autorizacion: document.getElementById('faut_estado').value,
      piezas_autorizadas_cambio: document.getElementById('faut_piezas').value===''?null:Number(document.getElementById('faut_piezas').value),
      autorizacion_fecha_envio: document.getElementById('faut_fecha_envio').value,
      autorizacion_fecha_respuesta: document.getElementById('faut_fecha_respuesta').value,
      autorizador: document.getElementById('faut_autorizador').value,
      autorizacion_importe: document.getElementById('faut_importe').value===''?null:Number(document.getElementById('faut_importe').value),
      autorizacion_restricciones: document.getElementById('faut_restricciones').value
    });
    toast('Autorización actualizada.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormEtapaProduccion(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Actualizar etapa de producción</h3>
      <div class="field"><label>Etapa</label><select id="fprod_estado">
        <option value="" ${!s.estado_produccion?'selected':''}>Sin iniciar</option>
        <option value="programado" ${s.estado_produccion==='programado'?'selected':''}>Programado</option>
        <option value="en_laminado" ${s.estado_produccion==='en_laminado'?'selected':''}>En laminado</option>
        <option value="mecanica" ${s.estado_produccion==='mecanica'?'selected':''}>Mecánica</option>
        <option value="preparacion" ${s.estado_produccion==='preparacion'?'selected':''}>Preparación</option>
        <option value="pintura" ${s.estado_produccion==='pintura'?'selected':''}>Pintura</option>
        <option value="armado" ${s.estado_produccion==='armado'?'selected':''}>Armado</option>
        <option value="detenido" ${s.estado_produccion==='detenido'?'selected':''}>Detenido</option>
        <option value="terminado" ${s.estado_produccion==='terminado'?'selected':''}>Terminado</option>
      </select></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEtapaProduccion(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarEtapaProduccion(siniestroId){
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, { estado_produccion: document.getElementById('fprod_estado').value });
    toast('Etapa de producción actualizada.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormNuevaOt(siniestroId){
  showModal(`
    <h3>Nueva orden de trabajo</h3>
    <div class="row-flex">
      <div class="field"><label>Número de OT</label><input id="fot_numero"></div>
      <div class="field"><label>Versión</label><input id="fot_version" type="number" min="1" value="1"></div>
    </div>
    <div class="field"><label>Alcance autorizado</label><textarea id="fot_alcance"></textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevaOt(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarNuevaOt(siniestroId){
  const numero = document.getElementById('fot_numero').value.trim();
  if(!numero){ toast('Indica el número de OT.', 'error'); return; }
  try{
    await api('POST','/api/ordenes-trabajo', { siniestro_id: siniestroId, numero, version: Number(document.getElementById('fot_version').value)||1, alcance: document.getElementById('fot_alcance').value });
    toast('OT creada.', 'success');
    closeModal(); render();
  }catch(e){}
}
async function abrirFormEditarOt(otId){
  const todas = await api('GET','/api/ordenes-trabajo');
  const ot = todas.find(x=>x.id===otId);
  if(!ot){ toast('OT no encontrada.', 'error'); return; }
  showModal(`
    <h3>Editar OT ${esc(ot.numero)}</h3>
    <div class="field"><label>Estado</label><select id="fote_estado">
      <option value="borrador" ${ot.estado==='borrador'?'selected':''}>Borrador</option>
      <option value="emitida" ${ot.estado==='emitida'?'selected':''}>Emitida</option>
      <option value="actualizada" ${ot.estado==='actualizada'?'selected':''}>Actualizada</option>
      <option value="suspendida" ${ot.estado==='suspendida'?'selected':''}>Suspendida</option>
      <option value="terminada" ${ot.estado==='terminada'?'selected':''}>Terminada</option>
    </select></div>
    <div class="field"><label>Alcance autorizado</label><textarea id="fote_alcance">${esc(ot.alcance||'')}</textarea></div>
    <div class="field"><label>Notas</label><textarea id="fote_notas">${esc(ot.notas||'')}</textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionOt(${otId})">Guardar</button></div>
  `);
}
async function guardarEdicionOt(otId){
  try{
    await api('PATCH','/api/ordenes-trabajo/'+otId, { estado: document.getElementById('fote_estado').value, alcance: document.getElementById('fote_alcance').value, notas: document.getElementById('fote_notas').value });
    toast('OT actualizada.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormNuevaOperacion(){
  const otId = document.getElementById('opOtSel').value;
  showModal(`
    <h3>Agregar operación</h3>
    <div class="field"><label>Descripción</label><input id="fop_desc" placeholder="Ej. cambio de puerta delantera"></div>
    <div class="row-flex">
      <div class="field"><label>Pieza</label><input id="fop_pieza"></div>
      <div class="field"><label>Área</label><input id="fop_area" placeholder="Laminado / pintura / mecánica / armado"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Técnico</label><input id="fop_tecnico"></div>
      <div class="field"><label>Secuencia</label><input id="fop_secuencia" type="number" min="1"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Horas estimadas</label><input id="fop_horas" type="number" step="0.5"></div>
      <div class="field"><label>Fecha inicio</label><input id="fop_fecha_inicio" type="date"></div>
      <div class="field"><label>Fecha fin prevista</label><input id="fop_fecha_fin" type="date"></div>
    </div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevaOperacion(${otId})">Guardar</button></div>
  `);
}
async function guardarNuevaOperacion(otId){
  const desc = document.getElementById('fop_desc').value.trim();
  if(!desc){ toast('Describe la operación.', 'error'); return; }
  try{
    await api('POST','/api/ot-operaciones', {
      ot_id: otId, descripcion: desc, pieza: document.getElementById('fop_pieza').value, area: document.getElementById('fop_area').value,
      tecnico: document.getElementById('fop_tecnico').value, secuencia: document.getElementById('fop_secuencia').value||null,
      horas_estimadas: document.getElementById('fop_horas').value||null, fecha_inicio: document.getElementById('fop_fecha_inicio').value,
      fecha_fin_prevista: document.getElementById('fop_fecha_fin').value
    });
    toast('Operación agregada.', 'success');
    closeModal(); render();
  }catch(e){}
}
async function abrirFormEditarOperacion(operacionId){
  const todas = await api('GET','/api/ot-operaciones');
  const op = todas.find(x=>x.id===operacionId);
  if(!op){ toast('Operación no encontrada.', 'error'); return; }
  showModal(`
    <h3>Editar operación</h3>
    <div class="field"><label>Descripción</label><input id="fope_desc" value="${esc(op.descripcion)}"></div>
    <div class="row-flex">
      <div class="field"><label>Estado</label><select id="fope_estado" onchange="document.getElementById('fope_bloqueo_wrap').style.display=this.value==='detenido'?'block':'none'">
        <option value="programado" ${op.estado==='programado'?'selected':''}>Programado</option>
        <option value="en_proceso" ${op.estado==='en_proceso'?'selected':''}>En proceso</option>
        <option value="detenido" ${op.estado==='detenido'?'selected':''}>Detenido</option>
        <option value="terminado" ${op.estado==='terminado'?'selected':''}>Terminado</option>
      </select></div>
      <div class="field"><label>Avance (%)</label><input id="fope_avance" type="number" min="0" max="100" value="${op.avance}"></div>
    </div>
    <div id="fope_bloqueo_wrap" class="field" style="display:${op.estado==='detenido'?'block':'none'}"><label>Causa de bloqueo</label><select id="fope_causa">
      <option value="">Sin definir</option>
      <option value="pieza_faltante" ${op.causa_bloqueo==='pieza_faltante'?'selected':''}>Pieza faltante</option>
      <option value="complemento_pendiente" ${op.causa_bloqueo==='complemento_pendiente'?'selected':''}>Complemento pendiente</option>
      <option value="capacidad" ${op.causa_bloqueo==='capacidad'?'selected':''}>Capacidad</option>
      <option value="falla_equipo" ${op.causa_bloqueo==='falla_equipo'?'selected':''}>Falla de equipo</option>
      <option value="ausencia" ${op.causa_bloqueo==='ausencia'?'selected':''}>Ausencia</option>
      <option value="retrabajo" ${op.causa_bloqueo==='retrabajo'?'selected':''}>Retrabajo</option>
    </select></div>
    <div class="field"><label>Siguiente acción</label><input id="fope_siguiente" value="${esc(op.siguiente_accion||'')}"></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionOperacion(${operacionId})">Guardar</button></div>
  `);
}
async function guardarEdicionOperacion(operacionId){
  try{
    await api('PATCH','/api/ot-operaciones/'+operacionId, {
      descripcion: document.getElementById('fope_desc').value, estado: document.getElementById('fope_estado').value,
      avance: Number(document.getElementById('fope_avance').value)||0, causa_bloqueo: document.getElementById('fope_causa') ? document.getElementById('fope_causa').value||null : null,
      siguiente_accion: document.getElementById('fope_siguiente').value
    });
    toast('Operación actualizada.', 'success');
    closeModal(); render();
  }catch(e){}
}

async function abrirFormNuevoComplemento(siniestroId){
  const ots = await api('GET','/api/ordenes-trabajo?siniestro_id='+siniestroId);
  showModal(`
    <h3>Agregar complemento (daño oculto)</h3>
    <div class="field"><label>Causa / hallazgo</label><textarea id="fcomp_causa" placeholder="Descripción del daño oculto detectado"></textarea></div>
    <div class="row-flex">
      <div class="field"><label>Fecha</label><input id="fcomp_fecha" type="date" value="${todayISO()}"></div>
      <div class="field"><label>Pieza / operación afectada</label><input id="fcomp_pieza"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Importe estimado</label><input id="fcomp_importe" type="number" step="0.01"></div>
      <div class="field"><label>Impacto en días</label><input id="fcomp_impacto" type="number" min="0"></div>
    </div>
    <div class="field"><label>OT relacionada (opcional)</label><select id="fcomp_ot"><option value="">Sin ligar todavía</option>${ots.map(ot=>`<option value="${ot.id}">OT ${esc(ot.numero)} v${ot.version}</option>`).join('')}</select></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevoComplemento(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarNuevoComplemento(siniestroId){
  const causa = document.getElementById('fcomp_causa').value.trim();
  if(!causa){ toast('Describe la causa del complemento.', 'error'); return; }
  try{
    await api('POST','/api/complementos', {
      siniestro_id: siniestroId, causa, fecha: document.getElementById('fcomp_fecha').value, pieza_operacion: document.getElementById('fcomp_pieza').value,
      importe: document.getElementById('fcomp_importe').value||null, impacto_dias: document.getElementById('fcomp_impacto').value||null,
      ot_id: document.getElementById('fcomp_ot').value||null
    });
    toast('Complemento registrado.', 'success');
    closeModal(); render();
  }catch(e){}
}
async function abrirFormEditarComplemento(complementoId){
  const todos = await api('GET','/api/complementos');
  const c = todos.find(x=>x.id===complementoId);
  if(!c){ toast('Complemento no encontrado.', 'error'); return; }
  showModal(`
    <h3>Editar complemento</h3>
    <div class="field"><label>Causa / hallazgo</label><textarea id="fcompe_causa">${esc(c.causa)}</textarea></div>
    <div class="row-flex">
      <div class="field"><label>Decisión</label><select id="fcompe_decision">
        <option value="pendiente" ${c.decision==='pendiente'?'selected':''}>Pendiente</option>
        <option value="autorizado" ${c.decision==='autorizado'?'selected':''}>Autorizado</option>
        <option value="rechazado" ${c.decision==='rechazado'?'selected':''}>Rechazado</option>
        <option value="parcial" ${c.decision==='parcial'?'selected':''}>Parcial</option>
      </select></div>
      <div class="field"><label>Estado</label><select id="fcompe_estado">
        <option value="detectado" ${c.estado==='detectado'?'selected':''}>Detectado</option>
        <option value="documentando" ${c.estado==='documentando'?'selected':''}>Documentando</option>
        <option value="enviado" ${c.estado==='enviado'?'selected':''}>Enviado</option>
        <option value="en_autorizacion" ${c.estado==='en_autorizacion'?'selected':''}>En autorización</option>
        <option value="autorizado" ${c.estado==='autorizado'?'selected':''}>Autorizado</option>
        <option value="rechazado" ${c.estado==='rechazado'?'selected':''}>Rechazado</option>
        <option value="incorporado_a_ot" ${c.estado==='incorporado_a_ot'?'selected':''}>Incorporado a OT</option>
      </select></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Importe</label><input id="fcompe_importe" type="number" step="0.01" value="${c.importe!=null?c.importe:''}"></div>
      <div class="field"><label>Folio</label><input id="fcompe_folio" value="${esc(c.folio||'')}"></div>
    </div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionComplemento(${complementoId})">Guardar</button></div>
  `);
}
async function guardarEdicionComplemento(complementoId){
  try{
    await api('PATCH','/api/complementos/'+complementoId, {
      causa: document.getElementById('fcompe_causa').value, decision: document.getElementById('fcompe_decision').value, estado: document.getElementById('fcompe_estado').value,
      importe: document.getElementById('fcompe_importe').value||null, folio: document.getElementById('fcompe_folio').value
    });
    toast('Complemento actualizado.', 'success');
    closeModal(); render();
  }catch(e){
    if(e.message){ /* el toast del error ya se mostró */ }
  }
}

function abrirFormNuevoRetrabajo(siniestroId){
  showModal(`
    <h3>Agregar retrabajo</h3>
    <div class="field"><label>Origen (no conformidad)</label><textarea id="fret_origen" placeholder="Qué falló y dónde se detectó"></textarea></div>
    <div class="row-flex">
      <div class="field"><label>Categoría</label><input id="fret_categoria" placeholder="Pintura / ajuste / lámina..."></div>
      <div class="field"><label>Severidad</label><select id="fret_severidad"><option value="leve">Leve</option><option value="media" selected>Media</option><option value="critica">Crítica</option></select></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Responsable</label><input id="fret_responsable"></div>
      <div class="field"><label>Horas</label><input id="fret_horas" type="number" step="0.5"></div>
      <div class="field"><label>Costo</label><input id="fret_costo" type="number" step="0.01"></div>
    </div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevoRetrabajo(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarNuevoRetrabajo(siniestroId){
  const origen = document.getElementById('fret_origen').value.trim();
  if(!origen){ toast('Describe el origen del retrabajo.', 'error'); return; }
  try{
    await api('POST','/api/retrabajos', {
      siniestro_id: siniestroId, origen, categoria: document.getElementById('fret_categoria').value, severidad: document.getElementById('fret_severidad').value,
      responsable: document.getElementById('fret_responsable').value, horas: document.getElementById('fret_horas').value||null, costo: document.getElementById('fret_costo').value||null
    });
    toast('Retrabajo registrado.', 'success');
    closeModal(); render();
  }catch(e){}
}
async function abrirFormEditarRetrabajo(retrabajoId){
  const todos = await api('GET','/api/retrabajos');
  const r = todos.find(x=>x.id===retrabajoId);
  if(!r){ toast('Retrabajo no encontrado.', 'error'); return; }
  showModal(`
    <h3>Editar retrabajo</h3>
    <div class="field"><label>Estado</label><select id="frete_estado">
      <option value="abierto" ${r.estado==='abierto'?'selected':''}>Abierto</option>
      <option value="en_correccion" ${r.estado==='en_correccion'?'selected':''}>En corrección</option>
      <option value="reinspeccion" ${r.estado==='reinspeccion'?'selected':''}>Reinspección</option>
      <option value="cerrado" ${r.estado==='cerrado'?'selected':''}>Cerrado</option>
    </select></div>
    <div class="field"><label>Corrección aplicada</label><textarea id="frete_correccion">${esc(r.correccion||'')}</textarea></div>
    <div class="field"><label>Fecha de reinspección</label><input id="frete_fecha" type="date" value="${esc(r.fecha_reinspeccion||'')}"></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionRetrabajo(${retrabajoId})">Guardar</button></div>
  `);
}
async function guardarEdicionRetrabajo(retrabajoId){
  try{
    await api('PATCH','/api/retrabajos/'+retrabajoId, {
      estado: document.getElementById('frete_estado').value, correccion: document.getElementById('frete_correccion').value, fecha_reinspeccion: document.getElementById('frete_fecha').value
    });
    toast('Retrabajo actualizado.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormEstadoCalidad(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Actualizar estado de calidad</h3>
      <div class="field"><label>Estado</label><select id="fcal_estado">
        <option value="" ${!s.estado_calidad?'selected':''}>Sin iniciar</option>
        <option value="en_inspeccion" ${s.estado_calidad==='en_inspeccion'?'selected':''}>En inspección</option>
        <option value="rechazado_a_retrabajo" ${s.estado_calidad==='rechazado_a_retrabajo'?'selected':''}>Rechazado a retrabajo</option>
        <option value="reinspeccion" ${s.estado_calidad==='reinspeccion'?'selected':''}>Reinspección</option>
        <option value="liberado" ${s.estado_calidad==='liberado'?'selected':''}>Liberado</option>
      </select></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEstadoCalidad(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarEstadoCalidad(siniestroId){
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, { estado_calidad: document.getElementById('fcal_estado').value });
    toast('Estado de calidad actualizado.', 'success');
    closeModal(); render();
  }catch(e){
    if(e.data && e.data.detalle){
      showModal(`<h3>No se puede liberar todavía</h3><p class="subtle">Rubros rechazados sin corregir:</p><ul>${e.data.detalle.map(d=>`<li>${esc(d)}</li>`).join('')}</ul><div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Entendido</button></div>`);
    }
  }
}

function abrirFormNuevoChecklistCalidad(siniestroId){
  const DIMENSIONES = ['Alcance','Seguridad y función','Lámina/ajuste','Pintura/acabado','Armado','Presentación','Documentación'];
  showModal(`
    <h3>Agregar rubro de calidad</h3>
    <div class="field"><label>Dimensión</label><select id="fchk_dimension">${DIMENSIONES.map(d=>`<option>${d}</option>`).join('')}</select></div>
    <div class="field"><label>Resultado</label><select id="fchk_resultado"><option value="pendiente">Pendiente</option><option value="aprobado">Aprobado</option><option value="rechazado">Rechazado</option></select></div>
    <div class="field"><label>Hallazgo</label><textarea id="fchk_hallazgo"></textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevoChecklistCalidad(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarNuevoChecklistCalidad(siniestroId){
  try{
    await api('POST','/api/checklist-calidad', {
      siniestro_id: siniestroId, dimension: document.getElementById('fchk_dimension').value,
      resultado: document.getElementById('fchk_resultado').value, hallazgo: document.getElementById('fchk_hallazgo').value
    });
    toast('Rubro agregado.', 'success');
    closeModal(); render();
  }catch(e){}
}
async function abrirFormEditarChecklistCalidad(checklistId){
  const todos = await api('GET','/api/checklist-calidad');
  const c = todos.find(x=>x.id===checklistId);
  if(!c){ toast('Rubro no encontrado.', 'error'); return; }
  showModal(`
    <h3>Editar rubro: ${esc(c.dimension)}</h3>
    <div class="field"><label>Resultado</label><select id="fchke_resultado">
      <option value="pendiente" ${c.resultado==='pendiente'?'selected':''}>Pendiente</option>
      <option value="aprobado" ${c.resultado==='aprobado'?'selected':''}>Aprobado</option>
      <option value="rechazado" ${c.resultado==='rechazado'?'selected':''}>Rechazado</option>
    </select></div>
    <div class="field"><label>Hallazgo</label><textarea id="fchke_hallazgo">${esc(c.hallazgo||'')}</textarea></div>
    <div class="field"><label>Corrección aplicada</label><textarea id="fchke_correccion">${esc(c.correccion||'')}</textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionChecklistCalidad(${checklistId})">Guardar</button></div>
  `);
}
async function guardarEdicionChecklistCalidad(checklistId){
  try{
    await api('PATCH','/api/checklist-calidad/'+checklistId, {
      resultado: document.getElementById('fchke_resultado').value, hallazgo: document.getElementById('fchke_hallazgo').value, correccion: document.getElementById('fchke_correccion').value
    });
    toast('Rubro actualizado.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormDetalleEntrega(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Detalle de entrega</h3>
      <div class="row-flex">
        <div class="field"><label>Receptor</label><input id="fent2_receptor" value="${esc(s.entrega_receptor||'')}"></div>
        <div class="field"><label>Identificación</label><input id="fent2_identificacion" value="${esc(s.entrega_identificacion||'')}"></div>
      </div>
      <div class="row-flex">
        <div class="field"><label>Kilometraje</label><input id="fent2_km" value="${esc(s.entrega_kilometraje||'')}"></div>
        <div class="field"><label>Combustible</label><input id="fent2_combustible" value="${esc(s.entrega_combustible||'')}"></div>
      </div>
      <div class="field"><label>¿Llaves entregadas?</label><select id="fent2_llaves">
        <option value="1" ${s.entrega_llaves_entregadas?'selected':''}>Sí</option>
        <option value="0" ${!s.entrega_llaves_entregadas?'selected':''}>No</option>
      </select></div>
      <div class="field"><label>Estado de entrega</label><select id="fent2_estado">
        <option value="" ${!s.estado_entrega?'selected':''}>Sin definir</option>
        <option value="listo" ${s.estado_entrega==='listo'?'selected':''}>Listo</option>
        <option value="cita_confirmada" ${s.estado_entrega==='cita_confirmada'?'selected':''}>Cita confirmada</option>
        <option value="entregado_con_observacion" ${s.estado_entrega==='entregado_con_observacion'?'selected':''}>Entregado con observación</option>
        <option value="entregado" ${s.estado_entrega==='entregado'?'selected':''}>Entregado</option>
      </select></div>
      <div class="field"><label>Observación</label><textarea id="fent2_observacion">${esc(s.entrega_observacion||'')}</textarea></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarDetalleEntrega(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarDetalleEntrega(siniestroId){
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, {
      entrega_receptor: document.getElementById('fent2_receptor').value, entrega_identificacion: document.getElementById('fent2_identificacion').value,
      entrega_kilometraje: document.getElementById('fent2_km').value, entrega_combustible: document.getElementById('fent2_combustible').value,
      entrega_llaves_entregadas: Number(document.getElementById('fent2_llaves').value), estado_entrega: document.getElementById('fent2_estado').value,
      entrega_observacion: document.getElementById('fent2_observacion').value
    });
    toast('Detalle de entrega actualizado.', 'success');
    closeModal(); render();
  }catch(e){}
}

function abrirFormFiniquito(siniestroId){
  api('GET','/api/siniestros/'+siniestroId).then(s=>{
    showModal(`
      <h3>Finiquito y encuesta</h3>
      <div class="row-flex">
        <div class="field"><label>Estado de finiquito</label><select id="ffin_estado">
          <option value="" ${!s.finiquito_estado?'selected':''}>Pendiente</option>
          <option value="firmado" ${s.finiquito_estado==='firmado'?'selected':''}>Firmado</option>
          <option value="inconformidad_abierta" ${s.finiquito_estado==='inconformidad_abierta'?'selected':''}>Inconformidad abierta</option>
        </select></div>
        <div class="field"><label>Fecha</label><input id="ffin_fecha" type="date" value="${esc(s.finiquito_fecha||'')}"></div>
      </div>
      <div class="field"><label>Observación</label><textarea id="ffin_observacion">${esc(s.finiquito_observacion||'')}</textarea></div>
      <div class="row-flex">
        <div class="field"><label>Estado de encuesta</label><select id="ffin_encuesta">
          <option value="" ${!s.encuesta_estado?'selected':''}>Pendiente</option>
          <option value="enviada" ${s.encuesta_estado==='enviada'?'selected':''}>Enviada</option>
          <option value="respondida" ${s.encuesta_estado==='respondida'?'selected':''}>Respondida</option>
        </select></div>
        <div class="field"><label>Calificación (1-5)</label><input id="ffin_calificacion" type="number" min="1" max="5" value="${s.encuesta_calificacion!=null?s.encuesta_calificacion:''}"></div>
      </div>
      <div class="field"><label>Comentarios de encuesta</label><textarea id="ffin_comentarios">${esc(s.encuesta_comentarios||'')}</textarea></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarFiniquito(${siniestroId})">Guardar</button></div>
    `);
  });
}
async function guardarFiniquito(siniestroId){
  try{
    await api('PATCH','/api/siniestros/'+siniestroId, {
      finiquito_estado: document.getElementById('ffin_estado').value, finiquito_fecha: document.getElementById('ffin_fecha').value,
      finiquito_observacion: document.getElementById('ffin_observacion').value, encuesta_estado: document.getElementById('ffin_encuesta').value,
      encuesta_calificacion: document.getElementById('ffin_calificacion').value||null, encuesta_comentarios: document.getElementById('ffin_comentarios').value
    });
    toast('Finiquito/encuesta actualizado.', 'success');
    closeModal(); render();
  }catch(e){
    if(e.message){ /* el toast del error ya se mostró */ }
  }
}

async function intentarCerrarSiniestro(siniestroId){
  const ok = await confirmDialog('¿Cerrar este siniestro? Solo se puede si todos sus pedidos están recibidos/cancelados y ya se registró la entrega.', { textoOk:'Sí, cerrar' });
  if(!ok) return;
  try{
    await api('PATCH', `/api/siniestros/${siniestroId}/cerrar`, {});
    toast('Siniestro cerrado.', 'success');
    render();
  }catch(e){
    if(e.data && e.data.detalle){
      showModal(`<h3>No se puede cerrar todavía</h3><ul>${e.data.detalle.map(d=>`<li>${esc(d)}</li>`).join('')}</ul><div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Entendido</button></div>`);
    }
  }
}

async function cambiarEstatusOperativo(pedidoId, val){
  if(val === 'Cancelado'){
    showModal(`
      <h3>Cancelar pedido</h3>
      <p class="subtle">Requerimiento de Daniela: todo pedido cancelado debe conservar su motivo.</p>
      <div class="field"><label>Motivo</label>
        <select id="fcanc_motivo_sel" onchange="document.getElementById('fcanc_motivo_otro').style.display=this.value==='Otro'?'block':'none'">
          <option>Reasignación de proveedor</option><option>Pérdida total</option><option>Unidad que no repara</option><option>Otro</option>
        </select>
        <textarea id="fcanc_motivo_otro" style="display:none;margin-top:6px;" placeholder="Describe el motivo"></textarea>
      </div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal();render()">Cancelar</button><button class="btn" onclick="guardarCancelacionPedido(${pedidoId})">Guardar</button></div>
    `);
    return;
  }
  await api('PATCH','/api/pedidos/'+pedidoId, { estatus_operativo: val });
  toast('Estatus actualizado.', 'success');
  render();
}
async function guardarCancelacionPedido(pedidoId){
  const sel = document.getElementById('fcanc_motivo_sel').value;
  const motivo = sel === 'Otro' ? document.getElementById('fcanc_motivo_otro').value.trim() : sel;
  if(!motivo){ toast('Describe el motivo de cancelación.', 'error'); return; }
  try{
    await api('PATCH','/api/pedidos/'+pedidoId, { estatus_operativo:'Cancelado', motivo_cancelacion: motivo });
    toast('Pedido cancelado.', 'success');
    closeModal(); render();
  }catch(e){}
}

async function marcarRecibida(piezaId){
  const ok = await confirmDialog('¿Confirmas que esta pieza llegó correctamente y la recibiste tú, '+ (currentUser?currentUser.nombre:'') +'? Quedará registrada con tu usuario y la hora actual.', { textoOk:'Sí, marcar recibida' });
  if(!ok) return;
  try{
    await api('POST', `/api/piezas/${piezaId}/recibir`);
    toast('Pieza marcada como recibida.', 'success');
    render();
  }catch(e){ /* el mensaje de bloqueo por incidencia ya se mostró en el toast */ }
}

/* ===================== FORMULARIOS: PIEZAS / INCIDENCIAS / RESPUESTAS / ARCHIVOS ===================== */
function abrirFormNuevaPieza(){
  const pedidoId = document.getElementById('piezaPedidoSel').value;
  showModal(`
    <h3>Agregar pieza</h3>
    <div class="field"><label>Descripción</label><input id="fz_desc" placeholder="Espejo lateral derecho"></div>
    <div class="row-flex">
      <div class="field"><label>Número de parte</label><input id="fz_parte"></div>
      <div class="field"><label>Tipo</label><select id="fz_tipo"><option>Original</option><option>Genérica</option><option>Usada</option></select></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Cantidad</label><input id="fz_cant" type="number" value="1" min="1"></div>
      <div class="field"><label>Precio</label><input id="fz_precio" type="number" step="0.01" value="0"></div>
      <div class="field"><label>Fecha prometida</label><input id="fz_fecha" type="date" value="${todayISO()}"></div>
    </div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevaPieza(${pedidoId})">Guardar</button></div>
  `);
}
async function guardarNuevaPieza(pedidoId){
  const descripcion = document.getElementById('fz_desc').value.trim();
  if(!descripcion){ toast('La descripción es obligatoria.', 'error'); return; }
  await api('POST','/api/piezas', {
    pedido_id: pedidoId, descripcion, numero_parte: document.getElementById('fz_parte').value,
    tipo: document.getElementById('fz_tipo').value, cantidad: +document.getElementById('fz_cant').value,
    precio: +document.getElementById('fz_precio').value, fecha_prometida: document.getElementById('fz_fecha').value
  });
  toast('Pieza agregada.', 'success');
  closeModal(); render();
}
async function abrirFormEditarPieza(id){
  const z = await api('GET','/api/piezas/'+id);
  showModal(`
    <h3>Editar pieza</h3>
    <div class="field"><label>Descripción</label><input id="fez_desc" value="${esc(z.descripcion)}"></div>
    <div class="row-flex">
      <div class="field"><label>Número de parte</label><input id="fez_parte" value="${esc(z.numero_parte||'')}"></div>
      <div class="field"><label>Tipo</label><select id="fez_tipo">${['Original','Genérica','Usada'].map(t=>`<option ${z.tipo===t?'selected':''}>${t}</option>`).join('')}</select></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Cantidad</label><input id="fez_cant" type="number" min="1" value="${z.cantidad}"></div>
      <div class="field"><label>Precio</label><input id="fez_precio" type="number" step="0.01" value="${z.precio}"></div>
      <div class="field"><label>Fecha prometida</label><input id="fez_fecha" type="date" value="${esc(z.fecha_prometida||'')}"></div>
    </div>
    <div class="field"><label>Observaciones</label><textarea id="fez_obs">${esc(z.observaciones||'')}</textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionPieza(${id})">Guardar cambios</button></div>
  `);
}
async function guardarEdicionPieza(id){
  await api('PATCH','/api/piezas/'+id, {
    descripcion: document.getElementById('fez_desc').value, numero_parte: document.getElementById('fez_parte').value,
    tipo: document.getElementById('fez_tipo').value, cantidad: +document.getElementById('fez_cant').value,
    precio: +document.getElementById('fez_precio').value, fecha_prometida: document.getElementById('fez_fecha').value,
    observaciones: document.getElementById('fez_obs').value
  });
  toast('Pieza actualizada.', 'success');
  closeModal(); render();
}

function abrirFormIncidencia(piezaId){
  showModal(`
    <h3>Registrar incidencia</h3>
    <div class="field"><label>Tipo</label><select id="fi_tipo">
      <option value="incorrecta">Pieza incorrecta</option>
      <option value="danada">Pieza dañada</option>
      <option value="incompleta">Envío incompleto</option>
      <option value="devolucion">Devolución</option>
      <option value="cancelacion">Cancelación</option>
      <option value="fecha_incumplida">Fecha incumplida</option>
    </select></div>
    <div class="field"><label>Descripción</label><textarea id="fi_desc" placeholder="Ej. el espejo entregado no corresponde al modelo del vehículo."></textarea></div>
    <div class="row-flex">
      <div class="field"><label>Acción solicitada</label><select id="fi_accion">
        <option value="cambio">Cambio</option><option value="recoleccion">Recolección</option>
        <option value="garantia">Garantía</option><option value="reembolso">Reembolso</option>
      </select></div>
      <div class="field"><label>Fecha compromiso</label><input id="fi_fecha" type="date"></div>
    </div>
    <p class="subtle">Esta pieza NO se marcará como recibida. El pedido queda visible como "Con incidencia" en todas las vistas.</p>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarIncidencia(${piezaId})">Registrar</button></div>
  `);
}
async function guardarIncidencia(piezaId){
  await api('POST','/api/incidencias', {
    pieza_id: piezaId, tipo: document.getElementById('fi_tipo').value, descripcion: document.getElementById('fi_desc').value,
    accion_solicitada: document.getElementById('fi_accion').value, fecha_compromiso: document.getElementById('fi_fecha').value
  });
  toast('Incidencia registrada. La pieza no se marcó como recibida.', 'success');
  closeModal(); render();
}
function abrirFormResolverIncidencia(id){
  showModal(`
    <h3>Resolver incidencia</h3>
    <div class="field"><label>Estado</label><select id="fr_estado"><option value="en_proceso">En proceso</option><option value="resuelta">Resuelta</option><option value="cancelada">Cancelada</option></select></div>
    <div class="field"><label>Resolución (obligatoria para cerrar como "Resuelta")</label><textarea id="fr_resolucion" placeholder="Ej. el proveedor envió el espejo correcto, se confirmó físicamente el 20/08."></textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarResolverIncidencia(${id})">Guardar</button></div>
  `);
}
async function guardarResolverIncidencia(id){
  try{
    await api('PATCH','/api/incidencias/'+id, { estado: document.getElementById('fr_estado').value, resolucion: document.getElementById('fr_resolucion').value });
    toast('Incidencia actualizada.', 'success');
    closeModal(); render();
  }catch(e){}
}
function abrirFormRespuesta(comId){
  showModal(`
    <h3>Registrar respuesta del proveedor</h3>
    <div class="field"><label>¿Qué respondió?</label><textarea id="fresp_texto"></textarea></div>
    <div class="row-flex">
      <div class="field"><label>Fecha compromiso</label><input id="fresp_compromiso" type="date"></div>
      <div class="field"><label>Siguiente seguimiento</label><input id="fresp_siguiente" type="date"></div>
    </div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarRespuesta(${comId})">Guardar</button></div>
  `);
}
async function guardarRespuesta(comId){
  const texto = document.getElementById('fresp_texto').value.trim();
  if(!texto){ toast('Describe la respuesta.', 'error'); return; }
  await api('PATCH', `/api/comunicaciones/${comId}/respuesta`, {
    respuesta_texto: texto, compromiso_fecha: document.getElementById('fresp_compromiso').value, siguiente_seguimiento: document.getElementById('fresp_siguiente').value
  });
  toast('Respuesta registrada.', 'success');
  closeModal(); render();
}
async function subirArchivo(ev, siniestroId){
  ev.preventDefault();
  const input = document.getElementById('archivoInput');
  if(!input.files[0]){ toast('Selecciona un archivo.', 'error'); return false; }
  const fd = new FormData();
  fd.append('archivo', input.files[0]);
  fd.append('entidad_tipo','siniestro');
  fd.append('entidad_id', siniestroId);
  fd.append('tipo', document.getElementById('archivoTipo').value);
  const res = await fetch('/api/archivos', { method:'POST', body: fd });
  const data = await res.json().catch(()=>({}));
  if(!res.ok){ toast(data.error||'No se pudo subir el archivo.', 'error'); return false; }
  toast('Archivo subido.', 'success');
  render();
  return false;
}

/* ===================== GENERADOR DE CORREOS ===================== */
async function abrirGenerador(pedidoId){
  const r = await api('GET','/api/comunicaciones/generar-borrador/'+pedidoId);
  if(!r.requiereCorreo){
    showModal(`<h3>Generador de correo</h3><p><span class="badge verde">No requiere correo</span></p><p>${esc(r.mensaje)}</p><div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cerrar</button></div>`);
    return;
  }
  const content = r.borradores.map((d,idx)=>`
    <div class="email-block" id="email-${idx}">
      <div style="display:flex;justify-content:space-between;align-items:center;"><b>${esc(d.proveedor_nombre)}</b><span class="badge ${d.tipo_plantilla==='incidencia'?'morado':'azul'}">${esc(d.tipo_plantilla)}</span></div>
      <div class="field"><label>Excluir de este envío (temporal, requiere motivo — regla R-07)</label>
        <label style="display:flex;gap:6px;align-items:center;font-weight:400;font-size:12.5px;">
          <input type="checkbox" onchange="document.getElementById('email-${idx}').classList.toggle('excluded', this.checked)"> Excluir solo este seguimiento
        </label>
        <input type="text" placeholder="Motivo de exclusión" id="motivo-${idx}" style="margin-top:4px;">
      </div>
      <div class="field"><label>Destinatario</label><input type="text" id="dest-${idx}" value="${esc(d.destinatario)}"></div>
      <div class="field"><label>Copia</label><input type="text" id="cc-${idx}" value="${esc(d.copia)}"></div>
      <div class="field"><label>Asunto</label><input type="text" id="asunto-${idx}" value="${esc(d.asunto)}"></div>
      <div class="field"><label>Cuerpo</label><textarea id="cuerpo-${idx}" style="min-height:160px;">${esc(d.cuerpo)}</textarea></div>
      <button class="btn small" ${d.proveedor_id?'':'disabled'} onclick="aprobarCorreo(${pedidoId}, ${idx}, ${d.proveedor_id||'null'})">Aprobar y registrar (borrador/sandbox)</button>
    </div>`).join('');
  showModal(`<h3>Generador de correo de seguimiento</h3><p class="subtle">Piezas recibidas o canceladas nunca aparecen aquí (regla R-04). No se envían correos reales todavía.</p>${content}<div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cerrar</button></div>`, true);
}
async function aprobarCorreo(pedidoId, idx, proveedorId){
  const bloque = document.getElementById('email-'+idx);
  if(bloque.classList.contains('excluded')){
    const motivo = document.getElementById('motivo-'+idx).value.trim();
    if(!motivo){ toast('El motivo de exclusión es obligatorio (regla R-07).', 'error'); return; }
    await api('POST','/api/comunicaciones/exclusiones', { pedido_id: pedidoId, proveedor_id: proveedorId, motivo });
    toast('Proveedor excluido de este envío únicamente. Sigue disponible para pedidos futuros.', 'warn');
    return;
  }
  const destinatarios = document.getElementById('dest-'+idx).value.trim();
  if(!destinatarios){ toast('El destinatario es obligatorio.', 'error'); return; }
  await api('POST','/api/comunicaciones', {
    pedido_id: pedidoId, proveedor_id: proveedorId, destinatarios, copia: document.getElementById('cc-'+idx).value,
    asunto: document.getElementById('asunto-'+idx).value, cuerpo: document.getElementById('cuerpo-'+idx).value
  });
  toast('Correo aprobado y registrado en el historial (no se envió automáticamente).', 'success');
  closeModal(); render();
}

/* ===================== ALTA / EDICIÓN CON VALIDACIÓN DE DUPLICADOS ===================== */
function openNuevoMenu(){
  const esAtencionCliente = currentUser && (currentUser.rol==='atencion_cliente' || currentUser.rol==='admin');
  showModal(`
    <h3>¿Qué deseas registrar?</h3>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${esAtencionCliente?`<button class="btn secondary" onclick="closeModal();formNuevoExpediente()">Expediente (recepción de cliente)</button>`:''}
      <button class="btn secondary" onclick="closeModal();formNuevoSiniestro()">Siniestro</button>
      <button class="btn secondary" onclick="closeModal();formNuevoPedido()">Pedido (ligado a un siniestro)</button>
      <button class="btn secondary" onclick="closeModal();formNuevoProveedor()">Proveedor</button>
    </div>
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cancelar</button></div>
  `);
}

/* ===================== MÓDULO ALEJANDRA: expediente desde recepción ===================== */
function formNuevoExpediente(){
  showModal(`
    <h3>Nuevo expediente (recepción de cliente)</h3>
    <div class="row-flex">
      <div class="field"><label>Nombre del cliente *</label><input id="fx_cliente_nombre" placeholder="Nombre completo"></div>
      <div class="field"><label>Teléfono / WhatsApp *</label><input id="fx_cliente_telefono" placeholder="55-0000-0000"></div>
    </div>
    <div class="field"><label>Correo *</label><input id="fx_cliente_correo" type="email"></div>
    <div class="field"><label>Notas de contacto (opcional, libre)</label><textarea id="fx_cliente_notas"></textarea></div>
    <div class="row-flex">
      <div class="field"><label>Número de siniestro</label><input id="fx_numero" placeholder="Si aún no lo tienes, usa un folio propio"></div>
      <div class="field"><label>Orden de admisión</label><input id="fx_orden_admision"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Aseguradora</label><select id="fx_aseguradora">${ASEGURADORAS.map(a=>`<option>${a}</option>`).join('')}</select></div>
      <div class="field"><label>Canal de origen</label><select id="fx_canal"><option>WhatsApp</option><option>Teléfono</option><option>Presencial</option><option>Otro</option></select></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Vehículo</label><input id="fx_vehiculo" placeholder="Marca / modelo (si ya se sabe)"></div>
      <div class="field"><label>Placas</label><input id="fx_placas"></div>
    </div>
    <div class="field"><label>¿Requiere cambio de refacciones?</label><select id="fx_requiere_refacciones">
      <option value="por_definir">Por definir (aún no se sabe)</option>
      <option value="si">Sí</option>
      <option value="no">No</option>
    </select></div>
    <p class="subtle">* Campos obligatorios. El resto se puede completar después conforme avance el caso.</p>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarExpediente()">Guardar</button></div>
  `);
}
async function guardarExpediente(){
  const cliente_nombre = document.getElementById('fx_cliente_nombre').value.trim();
  const cliente_telefono = document.getElementById('fx_cliente_telefono').value.trim();
  const cliente_correo = document.getElementById('fx_cliente_correo').value.trim();
  if(!cliente_nombre || !cliente_telefono || !cliente_correo){
    toast('Nombre, teléfono y correo del cliente son obligatorios.', 'error'); return;
  }
  let numero = document.getElementById('fx_numero').value.trim();
  if(!numero) numero = 'EXP-' + Date.now().toString(36).toUpperCase();
  try{
    const s = await api('POST','/api/siniestros', {
      numero, cliente_nombre, cliente_telefono, cliente_correo,
      cliente_notas: document.getElementById('fx_cliente_notas').value,
      orden_admision: document.getElementById('fx_orden_admision').value,
      aseguradora: document.getElementById('fx_aseguradora').value,
      canal_origen: document.getElementById('fx_canal').value,
      vehiculo: document.getElementById('fx_vehiculo').value,
      placas: document.getElementById('fx_placas').value,
      requiere_refacciones: document.getElementById('fx_requiere_refacciones').value
    });
    toast('Expediente registrado.', 'success');
    closeModal(); goSiniestro(s.id);
  }catch(e){
    if(e.data && e.data.duplicado){ closeModal(); goSiniestro(e.data.duplicado.id); }
  }
}
async function viewClientes(){
  const expedientes = await api('GET','/api/reportes/bandeja-clientes');
  const REQ_LABEL = { si:'Sí', no:'No', por_definir:'Por definir' };
  return `
  <h2>Clientes — expedientes</h2>
  <p class="subtle">Todos los expedientes desde recepción, tengan o no cambio de refacciones. Da clic en un renglón para abrir su ficha completa.</p>
  <table><thead><tr><th>Siniestro</th><th>Cliente</th><th>Teléfono</th><th>Aseguradora</th><th>Etapa</th><th>¿Refacciones?</th><th>Sin actualizar</th><th>Tareas</th></tr></thead><tbody>
  ${expedientes.length===0?'<tr><td colspan="8" class="empty">Sin expedientes registrados todavía.</td></tr>':expedientes.map(s=>`
    <tr>
      <td><span class="link" onclick="goSiniestro(${s.id})">${esc(s.numero)}</span></td>
      <td>${esc(s.cliente_nombre||'—')}</td>
      <td>${esc(s.cliente_telefono||'—')}</td>
      <td>${esc(s.aseguradora)}</td>
      <td>${esc(s.etapa_actual||'—')}</td>
      <td><span class="badge ${s.requiere_refacciones==='si'?'azul':s.requiere_refacciones==='no'?'gris':'ambar'}">${REQ_LABEL[s.requiere_refacciones]||'Por definir'}</span></td>
      <td>${s.dias_sin_actualizacion!=null ? `<span class="badge ${s.dias_sin_actualizacion>=2?'rojo':'gris'}">${s.dias_sin_actualizacion} día(s)</span>` : '—'}</td>
      <td>${s.tareas_pendientes>0 ? `<span class="badge ${s.tareas_vencidas>0?'rojo':'azul'}">${s.tareas_pendientes} pend.${s.tareas_vencidas>0?` (${s.tareas_vencidas} vencida${s.tareas_vencidas>1?'s':''})`:''}</span>` : '—'}</td>
    </tr>`).join('')}
  </tbody></table>
  <p class="subtle" style="margin-top:8px;">${expedientes.length} expediente(s). Se marca en rojo "Sin actualizar" a partir de 2 días sin comunicación registrada con el cliente.</p>`;
}
/* ===================== VISTA: CALIDAD / ENTREGA ===================== */
async function viewCalidad(){
  const expedientes = await api('GET','/api/reportes/bandeja-calidad');
  const LABEL_CAL = { en_inspeccion:'En inspección', rechazado_a_retrabajo:'Rechazado a retrabajo', reinspeccion:'Reinspección', liberado:'Liberado' };
  return `
  <h2>Calidad / entrega</h2>
  <p class="subtle">Expedientes con producción terminada, pendientes de liberar calidad o de entregar (secciones 5.12-5.15 del documento maestro).</p>
  <table><thead><tr><th>Siniestro</th><th>Aseguradora</th><th>Calidad</th><th>Rechazos abiertos</th><th>Retrabajos críticos</th><th>Entrega</th></tr></thead><tbody>
  ${expedientes.length===0?'<tr><td colspan="6" class="empty">Sin expedientes pendientes de calidad/entrega.</td></tr>':expedientes.map(s=>`
    <tr>
      <td><span class="link" onclick="goSiniestro(${s.id})">${esc(s.numero)}</span></td>
      <td>${esc(s.aseguradora)}</td>
      <td><span class="badge ${s.estado_calidad==='liberado'?'verde':'ambar'}">${esc(LABEL_CAL[s.estado_calidad]||'Sin iniciar')}</span></td>
      <td>${s.checklist_rechazados>0?`<span class="badge rojo">${s.checklist_rechazados}</span>`:'—'}</td>
      <td>${s.retrabajos_criticos>0?`<span class="badge rojo">${s.retrabajos_criticos}</span>`:'—'}</td>
      <td>${s.fecha_entrega_real?esc(s.fecha_entrega_real):'<span class="badge ambar">Pendiente</span>'}</td>
    </tr>`).join('')}
  </tbody></table>
  <p class="subtle" style="margin-top:8px;">${expedientes.length} expediente(s). Entra a la ficha del expediente, pestaña "Calidad / entrega".</p>`;
}

/* ===================== VISTA: PRODUCCIÓN (Beto) ===================== */
async function viewProduccion(){
  const expedientes = await api('GET','/api/reportes/bandeja-produccion');
  const LABEL_PROD = { programado:'Programado', en_laminado:'En laminado', mecanica:'Mecánica', preparacion:'Preparación', pintura:'Pintura', armado:'Armado', detenido:'Detenido', terminado:'Terminado' };
  return `
  <h2>Producción</h2>
  <p class="subtle">Expedientes autorizados en proceso de reparación (módulo de Beto). Sección 5.10 y 9 del documento maestro: prioridades, bloqueos y retrabajos.</p>
  <table><thead><tr><th>Siniestro</th><th>Aseguradora</th><th>Etapa de producción</th><th>Operaciones bloqueadas</th><th>Retrabajos abiertos</th><th>Complementos pendientes</th></tr></thead><tbody>
  ${expedientes.length===0?'<tr><td colspan="6" class="empty">Sin expedientes en producción pendientes.</td></tr>':expedientes.map(s=>`
    <tr>
      <td><span class="link" onclick="goSiniestro(${s.id})">${esc(s.numero)}</span></td>
      <td>${esc(s.aseguradora)}</td>
      <td>${esc(LABEL_PROD[s.estado_produccion]||'Sin iniciar')}</td>
      <td>${s.operaciones_bloqueadas>0?`<span class="badge rojo">${s.operaciones_bloqueadas}</span>`:'—'}</td>
      <td>${s.retrabajos_abiertos>0?`<span class="badge ambar">${s.retrabajos_abiertos}</span>`:'—'}</td>
      <td>${s.complementos_pendientes>0?`<span class="badge ambar">${s.complementos_pendientes}</span>`:'—'}</td>
    </tr>`).join('')}
  </tbody></table>
  <p class="subtle" style="margin-top:8px;">${expedientes.length} expediente(s) en producción. Entra a la ficha del expediente, pestaña "Producción", para la OT, operaciones, complementos y retrabajos.</p>`;
}

/* ===================== VISTA: VALUACIÓN / AUTORIZACIÓN ===================== */
async function viewValuacion(){
  const expedientes = await api('GET','/api/reportes/bandeja-valuacion');
  const LABEL_VAL = { borrador:'Borrador', enviada:'Enviada', observada:'Observada', ajustada:'Ajustada', autorizada_parcial:'Autorizada parcial', autorizada_total:'Autorizada total', rechazada:'Rechazada' };
  const LABEL_AUT = { en_autorizacion:'En autorización', autorizada:'Autorizada', parcial:'Parcial', rechazada:'Rechazada', por_aclarar:'Por aclarar' };
  const BADGE_AUT = { autorizada:'verde', parcial:'ambar', rechazada:'rojo', por_aclarar:'ambar', en_autorizacion:'gris' };
  return `
  <h2>Valuación y autorización</h2>
  <p class="subtle">Expedientes con checklist documental listo, pendientes de resolver su valuación y autorización. La ruta de refacciones (Inpart/autosurtido/pago de daños) se recalcula sola según la aseguradora y las piezas autorizadas.</p>
  <table><thead><tr><th>Siniestro</th><th>Aseguradora</th><th>Sistema</th><th>Valuación</th><th>Autorización</th><th>Ruta refacciones</th></tr></thead><tbody>
  ${expedientes.length===0?'<tr><td colspan="6" class="empty">Sin expedientes pendientes de valuación/autorización.</td></tr>':expedientes.map(s=>`
    <tr>
      <td><span class="link" onclick="goSiniestro(${s.id})">${esc(s.numero)}</span></td>
      <td>${esc(s.aseguradora)}</td>
      <td>${esc(s.sistema_valuacion||'—')}</td>
      <td>${esc(LABEL_VAL[s.estado_valuacion]||'Sin iniciar')}</td>
      <td><span class="badge ${BADGE_AUT[s.estado_autorizacion]||'gris'}">${LABEL_AUT[s.estado_autorizacion]||'Sin iniciar'}</span> ${s.autorizacion_vencida?'<span class="badge rojo">Sin respuesta (3+ días hábiles)</span>':''}</td>
      <td>${esc(s.aseguradora_ruta_refacciones||'—')}</td>
    </tr>`).join('')}
  </tbody></table>
  <p class="subtle" style="margin-top:8px;">${expedientes.length} expediente(s) pendientes. Entra a la ficha del expediente, pestaña "Valuación / autorización".</p>`;
}

/* ===================== VISTA: ARMADO DE EXPEDIENTE (Vanessa) ===================== */
async function viewExpediente(){
  const expedientes = await api('GET','/api/reportes/bandeja-expediente');
  const LABEL_EXP = { en_captura:'En captura', incompleto:'Incompleto', listo_para_valuacion:'Listo para valuación' };
  const BADGE_EXP = { en_captura:'ambar', incompleto:'rojo', listo_para_valuacion:'verde' };
  return `
  <h2>Armado de expediente</h2>
  <p class="subtle">Expedientes admitidos pendientes de digitalizar y validar documentalmente antes de enviarlos a valuación (módulo de Vanessa).</p>
  <table><thead><tr><th>Siniestro</th><th>Vehículo</th><th>Aseguradora</th><th>Sistema valuación</th><th>Estado expediente</th><th>Documentos</th></tr></thead><tbody>
  ${expedientes.length===0?'<tr><td colspan="6" class="empty">Sin expedientes pendientes de armar.</td></tr>':expedientes.map(s=>`
    <tr>
      <td><span class="link" onclick="goSiniestro(${s.id})">${esc(s.numero)}</span></td>
      <td>${esc(s.vehiculo||'—')} ${esc(s.placas?('· '+s.placas):'')}</td>
      <td>${esc(s.aseguradora)}</td>
      <td>${esc(s.sistema_valuacion||'—')}</td>
      <td><span class="badge ${BADGE_EXP[s.estado_expediente]||'gris'}">${LABEL_EXP[s.estado_expediente]||'Sin iniciar'}</span></td>
      <td>${s.documentos_total>0?`${s.documentos_total} total${s.documentos_faltantes>0?` <span class="badge rojo">${s.documentos_faltantes} faltante${s.documentos_faltantes>1?'s':''}</span>`:''}`:'—'}</td>
    </tr>`).join('')}
  </tbody></table>
  <p class="subtle" style="margin-top:8px;">${expedientes.length} expediente(s) pendientes. Entra a la ficha del expediente, pestaña "Expediente digital", para el checklist documental.</p>`;
}

/* ===================== VISTA: REVISIÓN TÉCNICA (Orlando) ===================== */
async function viewTecnica(){
  const expedientes = await api('GET','/api/reportes/bandeja-tecnica');
  const LABEL_REV = { en_revision:'En revisión', requiere_desarme:'Requiere desarme', revision_terminada:'Revisión terminada' };
  const BADGE_REV = { en_revision:'ambar', requiere_desarme:'rojo', revision_terminada:'verde' };
  return `
  <h2>Revisión técnica</h2>
  <p class="subtle">Expedientes admitidos pendientes de revisión de daños, desarme y evidencia (módulo de Orlando).</p>
  <table><thead><tr><th>Siniestro</th><th>Vehículo</th><th>Aseguradora</th><th>Ingreso</th><th>Admisión</th><th>Revisión</th><th>Hallazgos</th><th>Riesgo</th></tr></thead><tbody>
  ${expedientes.length===0?'<tr><td colspan="8" class="empty">Sin expedientes pendientes de revisión técnica.</td></tr>':expedientes.map(s=>`
    <tr>
      <td><span class="link" onclick="goSiniestro(${s.id})">${esc(s.numero)}</span></td>
      <td>${esc(s.vehiculo||'—')} ${esc(s.placas?('· '+s.placas):'')}</td>
      <td>${esc(s.aseguradora)}</td>
      <td>${s.ingreso_tipo?`<span class="badge ${s.ingreso_tipo==='grua'?'ambar':'gris'}">${s.ingreso_tipo==='grua'?'Grúa':'Circulando'}</span>`:'—'}</td>
      <td>${esc(s.estado_admision||'Pendiente')}</td>
      <td><span class="badge ${BADGE_REV[s.estado_revision_tecnica]||'gris'}">${LABEL_REV[s.estado_revision_tecnica]||'Sin iniciar'}</span></td>
      <td>${s.hallazgos>0?`${s.hallazgos}${s.hallazgos_ocultos>0?` (${s.hallazgos_ocultos} oculto${s.hallazgos_ocultos>1?'s':''})`:''}`:'—'}</td>
      <td>${s.riesgo_seguridad?'<span class="badge rojo">No seguro</span>':'—'}</td>
    </tr>`).join('')}
  </tbody></table>
  <p class="subtle" style="margin-top:8px;">${expedientes.length} expediente(s) pendientes. Entra a la ficha del expediente, pestaña "Admisión / técnica", para capturar la admisión y los hallazgos.</p>`;
}

function abrirFormNuevoEvento(siniestroId){
  showModal(`
    <h3>Registrar comunicación con el cliente</h3>
    <div class="field"><label>Dirección</label><select id="fev_direccion"><option value="saliente">Taller → cliente</option><option value="entrante">Cliente → taller</option></select></div>
    <div class="row-flex">
      <div class="field"><label>Canal</label><select id="fev_canal"><option>WhatsApp</option><option>Teléfono</option><option>Correo</option><option>Presencial</option></select></div>
      <div class="field"><label>Tipo</label><input id="fev_tipo" placeholder="Ej. mensaje, llamada, consulta"></div>
    </div>
    <div class="field"><label>Mensaje / resumen</label><textarea id="fev_mensaje" placeholder="Qué se dijo o qué preguntó el cliente"></textarea></div>
    <div class="row-flex">
      <div class="field"><label>Compromiso asumido</label><input id="fev_compromiso" placeholder="Ej. avisar mañana cuando lleguen las refacciones"></div>
      <div class="field"><label>Próxima acción</label><input id="fev_proxima"></div>
    </div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevoEvento(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarNuevoEvento(siniestroId){
  const mensaje = document.getElementById('fev_mensaje').value.trim();
  if(!mensaje){ toast('Describe el mensaje o resultado del contacto.', 'error'); return; }
  await api('POST','/api/eventos-cliente', {
    siniestro_id: siniestroId, direccion: document.getElementById('fev_direccion').value, canal: document.getElementById('fev_canal').value,
    tipo_evento: document.getElementById('fev_tipo').value, mensaje, compromiso: document.getElementById('fev_compromiso').value,
    proxima_accion: document.getElementById('fev_proxima').value
  });
  toast('Comunicación registrada.', 'success');
  closeModal(); render();
}
function abrirFormNuevaTarea(siniestroId){
  showModal(`
    <h3>Nueva tarea</h3>
    <div class="field"><label>Descripción</label><textarea id="ft_desc" placeholder="Ej. llamar al cliente mañana a las 10am"></textarea></div>
    <div class="field"><label>Fecha límite</label><input id="ft_fecha" type="date" value="${todayISO()}"></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarNuevaTarea(${siniestroId})">Guardar</button></div>
  `);
}
async function guardarNuevaTarea(siniestroId){
  const descripcion = document.getElementById('ft_desc').value.trim();
  if(!descripcion){ toast('Describe la tarea.', 'error'); return; }
  await api('POST','/api/tareas', { siniestro_id: siniestroId, descripcion, fecha_limite: document.getElementById('ft_fecha').value });
  toast('Tarea creada.', 'success');
  closeModal(); render();
}
async function marcarTareaCompletada(id){
  await api('PATCH','/api/tareas/'+id, { estado:'completada' });
  toast('Tarea marcada como completada.', 'success');
  render();
}
async function abrirFormHito(id){
  const h = await api('GET','/api/hitos/'+id);
  showModal(`
    <h3>Actualizar hito: ${esc(h.titulo)}</h3>
    <p class="subtle">${esc(h.hito_descripcion||'')}</p>
    <div class="field"><label>Nuevo estado</label><select id="fh_estado" onchange="document.getElementById('fh_motivo_wrap').style.display=this.value==='no_aplica'?'block':'none';document.getElementById('fh_mensaje_wrap').style.display=this.value==='enviado'?'block':'none';">
      <option value="pendiente" ${h.estado==='pendiente'?'selected':''}>Pendiente</option>
      <option value="generado" ${h.estado==='generado'?'selected':''}>Generado (borrador listo)</option>
      <option value="revisado" ${h.estado==='revisado'?'selected':''}>Revisado</option>
      <option value="enviado" ${h.estado==='enviado'?'selected':''}>Enviado al cliente</option>
      ${h.condicional?`<option value="no_aplica" ${h.estado==='no_aplica'?'selected':''}>No aplica</option>`:''}
    </select></div>
    <div class="field" id="fh_motivo_wrap" style="display:${h.estado==='no_aplica'?'block':'none'}"><label>Motivo de "no aplica"</label><input id="fh_motivo" value="${esc(h.motivo_no_aplica||'')}"></div>
    <div class="field" id="fh_mensaje_wrap" style="display:none"><label>Mensaje enviado al cliente (queda registrado en la bitácora)</label><textarea id="fh_mensaje"></textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarHito(${id})">Guardar</button></div>
  `);
}
async function guardarHito(id){
  const estado = document.getElementById('fh_estado').value;
  try{
    await api('PATCH','/api/hitos/'+id, {
      estado, motivo_no_aplica: document.getElementById('fh_motivo').value,
      mensaje: document.getElementById('fh_mensaje') ? document.getElementById('fh_mensaje').value : ''
    });
    toast('Hito actualizado.', 'success');
    closeModal(); render();
  }catch(e){}
}

/* ===================== MÓDULO ALEJANDRA: copiloto de IA (sin API conectada — copiar/pegar) ===================== */
async function abrirFormIA(siniestroId, hitoId){
  const r = await api('GET', `/api/mensajes-ia/contexto?siniestro_id=${siniestroId}${hitoId?`&hito_id=${hitoId}`:''}`);
  showModal(`
    <h3>Preparar mensaje con IA</h3>
    <ol style="padding-left:18px;margin:0 0 10px;">
      <li>Copia el contexto de abajo.</li>
      <li>Pégalo en tu ChatGPT y pide que redacte el mensaje para el cliente.</li>
      <li>Pega aquí la respuesta que te dio la IA y guarda el borrador.</li>
    </ol>
    <div class="field"><label>Contexto (solo lectura)</label><textarea id="fia_contexto" readonly style="min-height:180px;">${esc(r.texto)}</textarea></div>
    <button class="btn small secondary" type="button" onclick="copiarContextoIA()">Copiar contexto</button>
    <div class="field" style="margin-top:10px;"><label>Borrador de la IA (pégalo aquí)</label><textarea id="fia_borrador" style="min-height:120px;" placeholder="Pega aquí lo que te devolvió tu ChatGPT..."></textarea></div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cerrar</button><button class="btn" onclick="guardarMensajeIa(${siniestroId}, ${hitoId||'null'})">Guardar borrador</button></div>
  `, true);
}
function copiarContextoIA(){
  const el = document.getElementById('fia_contexto');
  el.select();
  try{
    if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(el.value);
    else document.execCommand('copy');
    toast('Contexto copiado.', 'success');
  }catch(e){ toast('No se pudo copiar automáticamente; selecciona el texto manualmente.', 'warn'); }
}
async function guardarMensajeIa(siniestroId, hitoId){
  const contexto_usado = document.getElementById('fia_contexto').value;
  const borrador = document.getElementById('fia_borrador').value.trim();
  await api('POST','/api/mensajes-ia', { siniestro_id: siniestroId, hito_id: hitoId, contexto_usado, borrador });
  toast('Borrador guardado.', 'success');
  closeModal(); render();
}
async function cambiarEstadoMensajeIa(id, estado){
  try{
    await api('PATCH','/api/mensajes-ia/'+id, { estado });
    toast(estado==='enviado' ? 'Mensaje marcado como enviado y registrado en la bitácora.' : 'Mensaje marcado como revisado.', 'success');
    render();
  }catch(e){}
}
function formNuevoSiniestro(){
  showModal(`
    <h3>Nuevo siniestro</h3>
    <div class="field"><label>Número de siniestro</label><input id="f_numero" placeholder="0186561262A"></div>
    <div class="row-flex">
      <div class="field"><label>Aseguradora</label><select id="f_aseguradora">${ASEGURADORAS.map(a=>`<option>${a}</option>`).join('')}</select></div>
      <div class="field"><label>Vehículo</label><input id="f_vehiculo" placeholder="Marca / modelo"></div>
    </div>
    <div class="row-flex">
      <div class="field"><label>Placas</label><input id="f_placas"></div>
      <div class="field"><label>Fecha de ingreso</label><input id="f_fecha" type="date" value="${todayISO()}"></div>
    </div>
    <p class="subtle">Si dejas vehículo o placas vacíos, el siniestro se guarda como "Pendiente de completar" y podrás editarlo después.</p>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarSiniestro()">Guardar</button></div>
  `);
}
async function guardarSiniestro(){
  try{
    const s = await api('POST','/api/siniestros', {
      numero: document.getElementById('f_numero').value.trim(), aseguradora: document.getElementById('f_aseguradora').value,
      vehiculo: document.getElementById('f_vehiculo').value, placas: document.getElementById('f_placas').value, fecha_ingreso: document.getElementById('f_fecha').value
    });
    if(s.advertencia) toast(s.advertencia, 'warn'); else toast('Siniestro registrado.', 'success');
    closeModal(); goSiniestro(s.id);
  }catch(e){
    if(e.data && e.data.duplicado){ closeModal(); goSiniestro(e.data.duplicado.id); }
  }
}
function abrirFormEditarSiniestro(id){
  api('GET','/api/siniestros/'+id).then(s=>{
    const esAtencionCliente = currentUser && (currentUser.rol==='atencion_cliente' || currentUser.rol==='admin');
    const REQ_OPCIONES = [['por_definir','Por definir'],['si','Sí'],['no','No']];
    showModal(`
      <h3>Editar siniestro ${esc(s.numero)}</h3>
      <div class="row-flex">
        <div class="field"><label>Aseguradora</label><select id="fe_aseguradora">${ASEGURADORAS.map(a=>`<option ${s.aseguradora===a?'selected':''}>${a}</option>`).join('')}</select></div>
        <div class="field"><label>Vehículo</label><input id="fe_vehiculo" value="${esc(s.vehiculo||'')}"></div>
      </div>
      <div class="row-flex">
        <div class="field"><label>Placas</label><input id="fe_placas" value="${esc(s.placas||'')}"></div>
        <div class="field"><label>Año/modelo</label><input id="fe_anio" value="${esc(s.anio_modelo||'')}"></div>
      </div>
      <div class="field"><label>Notas</label><textarea id="fe_notas">${esc(s.notas||'')}</textarea></div>
      ${esAtencionCliente?`
      <div class="section" style="border-top:1px solid var(--borde,#e5e7eb);margin-top:10px;padding-top:10px;">
        <h4 style="margin:0 0 8px;">Datos de cliente (módulo Alejandra)</h4>
        <div class="row-flex">
          <div class="field"><label>Nombre del cliente</label><input id="fe_cliente_nombre" value="${esc(s.cliente_nombre||'')}"></div>
          <div class="field"><label>Teléfono / WhatsApp</label><input id="fe_cliente_telefono" value="${esc(s.cliente_telefono||'')}"></div>
        </div>
        <div class="field"><label>Correo</label><input id="fe_cliente_correo" type="email" value="${esc(s.cliente_correo||'')}"></div>
        <div class="field"><label>Notas de contacto</label><textarea id="fe_cliente_notas">${esc(s.cliente_notas||'')}</textarea></div>
        <div class="row-flex">
          <div class="field"><label>Orden de admisión</label><input id="fe_orden_admision" value="${esc(s.orden_admision||'')}"></div>
          <div class="field"><label>Etapa actual</label><input id="fe_etapa_actual" value="${esc(s.etapa_actual||'')}"></div>
        </div>
        <div class="field"><label>¿Requiere cambio de refacciones?</label><select id="fe_requiere_refacciones">
          ${REQ_OPCIONES.map(([v,l])=>`<option value="${v}" ${s.requiere_refacciones===v?'selected':''}>${l}</option>`).join('')}
        </select></div>
      </div>`:''}
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarEdicionSiniestro(${id})">Guardar cambios</button></div>
    `);
  });
}
async function guardarEdicionSiniestro(id){
  const payload = {
    aseguradora: document.getElementById('fe_aseguradora').value, vehiculo: document.getElementById('fe_vehiculo').value,
    placas: document.getElementById('fe_placas').value, anio_modelo: document.getElementById('fe_anio').value, notas: document.getElementById('fe_notas').value
  };
  const campoCliente = document.getElementById('fe_cliente_nombre');
  if(campoCliente){
    payload.cliente_nombre = campoCliente.value;
    payload.cliente_telefono = document.getElementById('fe_cliente_telefono').value;
    payload.cliente_correo = document.getElementById('fe_cliente_correo').value;
    payload.cliente_notas = document.getElementById('fe_cliente_notas').value;
    payload.orden_admision = document.getElementById('fe_orden_admision').value;
    payload.etapa_actual = document.getElementById('fe_etapa_actual').value;
    payload.requiere_refacciones = document.getElementById('fe_requiere_refacciones').value;
  }
  await api('PATCH','/api/siniestros/'+id, payload);
  toast('Siniestro actualizado.', 'success');
  closeModal(); render();
}
function formNuevoPedido(){
  api('GET','/api/siniestros').then(siniestros=>{
    showModal(`
      <h3>Nuevo pedido</h3>
      <div class="field"><label>Siniestro</label><select id="f_sin">${siniestros.map(s=>`<option value="${s.id}">${esc(s.numero)} — ${esc(s.vehiculo||'')}</option>`).join('')}</select></div>
      <div class="row-flex">
        <div class="field"><label>Número de pedido</label><input id="f_numped" placeholder="1137000"></div>
        <div class="field"><label>Fecha prevista</label><input id="f_fechaprev" type="date" value="${todayISO()}"></div>
      </div>
      <div class="field"><label>Estatus Inpart</label><select id="f_estinpart">${['Aguardando confirmación','En procesamiento','Facturado','Entregado','Recibido','Cancelado','Otro'].map(e=>`<option>${e}</option>`).join('')}</select></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarPedido()">Guardar</button></div>
    `);
  });
}
async function guardarPedido(){
  try{
    const p = await api('POST','/api/pedidos', {
      numero: document.getElementById('f_numped').value.trim(), siniestro_id: +document.getElementById('f_sin').value,
      fecha_prevista: document.getElementById('f_fechaprev').value, estatus_inpart: document.getElementById('f_estinpart').value
    });
    if(p.advertencias && p.advertencias.length) p.advertencias.forEach(a=>toast(a,'warn')); else toast('Pedido registrado.', 'success');
    closeModal(); goSiniestro(p.siniestro_id);
  }catch(e){
    if(e.data && e.data.duplicado){ closeModal(); goSiniestro(e.data.duplicado.siniestro_id); }
  }
}
function formNuevoProveedor(){
  showModal(`
    <h3>Nuevo proveedor</h3>
    <div class="field"><label>Razón social</label><input id="f_rs"></div>
    <div class="row-flex">
      <div class="field"><label>Contacto</label><input id="f_cont"></div>
      <div class="field"><label>Correo</label><input id="f_correo" type="email"></div>
    </div>
    <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" onclick="guardarProveedor()">Guardar</button></div>
  `);
}
async function guardarProveedor(){
  const pv = await api('POST','/api/proveedores', { razon_social: document.getElementById('f_rs').value.trim(), contacto: document.getElementById('f_cont').value, correo: document.getElementById('f_correo').value });
  toast('Proveedor registrado.', 'success');
  closeModal(); goProveedor(pv.id);
}

/* ===================== VISTA: REGLAS ===================== */
function viewReglas(){
  const reglas = [
    ['R-01','Al revisar Inpart, usar como fecha inicial el 1 de enero del año en curso y como final el día actual.'],
    ['R-02','Número que empieza con "018" y termina en "A" se trata como siniestro GNP; los más cortos suelen ser pedidos.'],
    ['R-03','Antes de generar un correo, se agrupan y revisan todas las piezas de cada proveedor en ese pedido.'],
    ['R-04','Cualquier pieza recibida se excluye del correo, sin mencionarlo en el cuerpo.'],
    ['R-05','Si todas las piezas del pedido están recibidas o canceladas, no se genera correo.'],
    ['R-06','Facturado no equivale a recibido: sigue pendiente hasta confirmar recepción física.'],
    ['R-07','Ningún proveedor se bloquea permanentemente; solo exclusiones temporales por envío con motivo.'],
    ['R-08','Seguimientos GNP copian por defecto a cristian.hernandezortiz@gnp.com.mx, luis.ramirezalvarez@gnp.com.mx y roveytia@hotmail.com.'],
    ['R-09','Los destinatarios de copia se pueden editar o quitar antes de aprobar el correo.'],
    ['R-10','Nunca se guardan contraseñas de Inpart, Gmail ni ningún otro sistema en el tablero.']
  ];
  return `
  <h2>Reglas operativas</h2>
  <div class="section"><table><thead><tr><th>ID</th><th>Regla</th></tr></thead><tbody>
  ${reglas.map(r=>`<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="section">
    <h3>Sobre las pruebas de este sistema</h3>
    <p class="subtle">Las pruebas de aceptación (CA-01 a CA-10 y el caso real de Daniela) ahora son un archivo de pruebas automatizadas real en el proyecto (<code>tests/api.test.js</code>), que falla de verdad si una regla se rompe — no un panel que siempre marca "aprobado" (corrección F-09).</p>
  </div>`;
}

/* ===================== INIT ===================== */
(async function init(){
  try{
    const r = await api('GET','/api/auth/me', null, { silent:true });
    currentUser = r.user;
    document.getElementById('topHeader').classList.remove('hidden');
    document.getElementById('footerNote').classList.remove('hidden');
    document.getElementById('userChip').textContent = currentUser.nombre + ' · ' + currentUser.rol;
    render();
  }catch(e){
    renderLogin();
  }
})();
