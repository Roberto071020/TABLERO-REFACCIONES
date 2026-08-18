/* ===================== HELPERS ===================== */
function esc(s){
  if(s===null||s===undefined) return '';
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtMoney(n){ return '$'+Number(n||0).toLocaleString('es-MX',{minimumFractionDigits:2}); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function uidLocal(){ return 'tmp'+Math.random().toString(36).slice(2); }

let currentUser = null;
const ASEGURADORAS = ['GNP','Mapfre','Inbursa','Afirme','Allianz','La Latinoamericana'];


async function api(method, url, body, opts={}){
  const res = await fetch(url, {
    method, headers: body ? {'Content-Type':'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if(res.status === 401){
    currentUser = null;
    renderLogin();
    throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
  }
  let data = null;
  const ct = res.headers.get('content-type')||'';
  if(ct.includes('application/json')) data = await res.json().catch(()=>null);
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
    const r = await api('POST','/api/auth/login', { email, password }, { silent:true });
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
  {k:'lista', label:'Lista maestra'},
  {k:'proveedores', label:'Proveedores'},
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
    else if(state.view==='reglas') app.innerHTML = viewReglas();
    else if(state.view==='siniestro') app.innerHTML = await viewSiniestro(state.siniestroId);
  }catch(e){
    if(e.message !== 'Sesión expirada. Vuelve a iniciar sesión.') app.innerHTML = `<div class="empty">No se pudo cargar la vista: ${esc(e.message)}</div>`;
  }
}

/* ===================== VISTA: INICIO ===================== */
async function viewInicio(){
  const r = await api('GET','/api/reportes/resumen');
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
    ['pedidos','Pedidos'],['piezas','Piezas'],['incidencias','Incidencias'],['comunicaciones','Comunicaciones'],['archivos','Archivos'],['timeline','Línea de tiempo']
  ];
  const ESTATUS_OPERATIVO = KANBAN_COLS;

  let body = '';
  if(state.subtabSiniestro==='cliente'){
    const eventos = await api('GET','/api/eventos-cliente?siniestro_id='+id);
    const tareas = await api('GET','/api/tareas?siniestro_id='+id);
    const ESTADOS_TAREA = {pendiente:'ambar', en_proceso:'azul', completada:'verde', cancelada:'gris'};
    body = `
    <h3>Tareas</h3>
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
    </ul>`}`;
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

  return `
  <button class="btn ghost small no-print" onclick="goTo('kanban')">← Volver</button>
  <div class="section" style="margin-top:10px;">
    ${s.completo===0?`<div class="banner ambar">Este siniestro está <b>Pendiente de completar</b> (faltan vehículo o placas). <button class="btn small secondary" onclick="abrirFormEditarSiniestro(${s.id})">Completar datos</button></div>`:''}
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div>
        <h2 style="margin-bottom:2px;">Siniestro ${esc(s.numero)} <span class="badge azul">${esc(s.aseguradora)}</span></h2>
        <p class="subtle">${esc(s.vehiculo||'')} ${esc(s.anio_modelo||'')} · Placas ${esc(s.placas||'')} · Ingreso: ${esc(s.fecha_ingreso||'')} · Responsable: ${esc(s.responsable||'')}</p>
        ${s.cliente_nombre?`<p class="subtle">Cliente: ${esc(s.cliente_nombre)}${s.cliente_telefono?' · '+esc(s.cliente_telefono):''}${s.etapa_actual?' · Etapa: '+esc(s.etapa_actual):''}</p>`:''}
      </div>
      <div><button class="btn small secondary" onclick="abrirFormEditarSiniestro(${s.id})">Editar</button></div>
    </div>
  </div>
  <div class="tabs-sub no-print">${subtabs.map(t=>`<button class="${state.subtabSiniestro===t[0]?'active':''}" onclick="setSubtabSiniestro('${t[0]}')">${t[1]}</button>`).join('')}</div>
  <div class="section">${body}</div>`;
}

async function cambiarEstatusOperativo(pedidoId, val){
  await api('PATCH','/api/pedidos/'+pedidoId, { estatus_operativo: val });
  toast('Estatus actualizado.', 'success');
  render();
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
