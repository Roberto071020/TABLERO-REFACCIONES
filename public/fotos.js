/* ===================== Fotos de la unidad (4-nov-2026) =====================
   Pedido de Roberto: fotos de recepción (Alejandra) y del avance en cada etapa de reparación, visibles y
   descargables para todo el equipo. Las fotos se comprimen en el celular antes de subir (~1600 px, JPEG)
   para no llenar el disco, y se genera una miniatura (~400 px) para que la galería cargue rápido.
   Se apoya en funciones globales de app.js: showModal, closeModal, toast, esc, api, render, currentUser. */
(function(){
  const ETIQUETAS = { recepcion:'Recepción', mecanica:'Mecánica', en_laminado:'Hojalatería', preparacion:'Preparación',
    pintura:'Pintura', armado:'Armado', pulido:'Pulido', lavado:'Lavado', terminado:'Terminado', reautorizacion:'Fotos editadas (reautorización)', paro:'Evidencia de patio (paro)', otra:'Otras' };
  const ORDEN = Object.keys(ETIQUETAS);

  // Estilos propios de la galería (se inyectan una sola vez).
  const css = `
  .fg-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;}
  .fg-etapa{margin-top:18px;}
  .fg-etapa h4{margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;}
  .fg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;}
  .fg-grid button{padding:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--gris-100);aspect-ratio:1/1;cursor:pointer;}
  .fg-grid img{width:100%;height:100%;object-fit:cover;display:block;}
  .fg-vacio{color:var(--gris-500);font-size:13px;}
  .fg-sel{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;margin:10px 0;}
  .fg-sel img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;border:1px solid var(--border);}
  .fg-botones{display:flex;gap:8px;flex-wrap:wrap;}
  .fg-botones label.btn{display:inline-flex;align-items:center;gap:6px;cursor:pointer;}
  .fg-prog{height:8px;background:var(--gris-100);border-radius:99px;overflow:hidden;margin-top:10px;}
  .fg-prog div{height:100%;background:var(--verde);width:0;transition:width .2s;}
  .fg-visor{text-align:center;}
  .fg-visor img{max-width:100%;max-height:68vh;border-radius:10px;}
  .fg-visor .fg-nav{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;}
  .fg-aviso{background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:10px;}
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ---------- Compresión en el celular ---------- */
  async function decodificar(file){
    if(window.createImageBitmap){
      try{ return await createImageBitmap(file, { imageOrientation:'from-image' }); }catch(e){}
    }
    return await new Promise((ok, mal) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); mal(new Error('no se pudo leer la imagen')); };
      img.src = url;
    });
  }
  function aJpeg(img, maxLado, calidad){
    const w = img.width, h = img.height;
    const k = Math.min(1, maxLado / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise(ok => c.toBlob(b => ok(b), 'image/jpeg', calidad));
  }
  // Regresa { foto, miniatura } ya comprimidas; si el navegador no puede leer el formato (p. ej. HEIC en
  // Android), sube el archivo original sin miniatura para no perder la foto.
  async function comprimir(file){
    try{
      const img = await decodificar(file);
      const foto = await aJpeg(img, 1600, 0.78);
      const miniatura = await aJpeg(img, 400, 0.7);
      if(img.close) img.close();
      if(!foto) throw new Error('sin blob');
      return { foto, miniatura, nombre: (file.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg' };
    }catch(e){
      return { foto: file, miniatura: null, nombre: file.name || 'foto.jpg' };
    }
  }

  async function subirUna(file, siniestroId, etapa){
    const c = await comprimir(file);
    const fd = new FormData();
    fd.append('siniestro_id', siniestroId);
    fd.append('etapa', etapa);
    fd.append('foto', c.foto, c.nombre);
    if(c.miniatura) fd.append('miniatura', c.miniatura, 'mini.jpg');
    const res = await fetch('/api/fotos', { method:'POST', body: fd });
    if(!res.ok){
      const d = await res.json().catch(()=>({}));
      throw new Error(d.error || ('Error ' + res.status));
    }
    return res.json();
  }

  // Sube varias fotos una tras otra; regresa cuántas subieron y cuántas fallaron.
  async function subirVarias(files, siniestroId, etapa, alAvanzar){
    let ok = 0, fallas = 0, ultimoError = '';
    for(let i = 0; i < files.length; i++){
      try{ await subirUna(files[i], siniestroId, etapa); ok++; }
      catch(e){ fallas++; ultimoError = e.message; }
      if(alAvanzar) alAvanzar(i + 1, files.length);
    }
    return { ok, fallas, ultimoError };
  }

  /* ---------- Ventana para tomar / elegir fotos ---------- */
  // opciones: { titulo, aviso, alTerminar(ok) }
  function abrirSubirFotos(siniestroId, etapa, opciones = {}){
    const titulo = opciones.titulo || ('Fotos de ' + ETIQUETAS[etapa]);
    let seleccion = [];
    showModal(`
      <h3>${esc(titulo)}</h3>
      ${opciones.aviso ? `<div class="fg-aviso">${esc(opciones.aviso)}</div>` : ''}
      <div class="fg-botones">
        <label class="btn">📷 Tomar foto<input type="file" accept="image/*" capture="environment" id="fgCamara" hidden></label>
        <label class="btn secondary">🖼️ Elegir de la galería<input type="file" accept="image/*" multiple id="fgGaleria" hidden></label>
      </div>
      <p class="subtle" id="fgCuenta" style="margin-top:10px;">Todavía no hay fotos seleccionadas. Puedes tomar varias, una por una, o elegir varias de la galería.</p>
      <div class="fg-sel" id="fgSel"></div>
      <div class="fg-prog hidden" id="fgProg"><div></div></div>
      <div class="modal-actions">
        <button class="btn secondary" type="button" onclick="closeModal()">Cancelar</button>
        <button class="btn" type="button" id="fgSubir" disabled>Subir fotos</button>
      </div>`);
    const pintar = () => {
      document.getElementById('fgCuenta').textContent = seleccion.length
        ? `${seleccion.length} foto${seleccion.length === 1 ? '' : 's'} lista${seleccion.length === 1 ? '' : 's'} para subir.`
        : 'Todavía no hay fotos seleccionadas.';
      document.getElementById('fgSel').innerHTML = seleccion.map((f, i) => `<img alt="Foto ${i+1}" src="${URL.createObjectURL(f)}">`).join('');
      document.getElementById('fgSubir').disabled = seleccion.length === 0;
    };
    const agregar = ev => { seleccion = seleccion.concat(Array.from(ev.target.files || [])); ev.target.value = ''; pintar(); };
    document.getElementById('fgCamara').addEventListener('change', agregar);
    document.getElementById('fgGaleria').addEventListener('change', agregar);
    document.getElementById('fgSubir').addEventListener('click', async () => {
      const boton = document.getElementById('fgSubir');
      boton.disabled = true; boton.textContent = 'Subiendo…';
      const prog = document.getElementById('fgProg'); prog.classList.remove('hidden');
      const r = await subirVarias(seleccion, siniestroId, etapa, (i, n) => { prog.firstElementChild.style.width = Math.round(i / n * 100) + '%'; });
      if(r.fallas) toast(`${r.fallas} foto(s) no se pudieron subir: ${r.ultimoError}`, 'error', 7000);
      if(r.ok) toast(`${r.ok} foto(s) guardada(s).`, 'success');
      closeModal();
      if(opciones.alTerminar) opciones.alTerminar(r.ok);
      else if(typeof render === 'function') render();
    });
  }

  /* ---------- Cambio de etapa con fotos obligatorias ---------- */
  // Hace el PATCH; si el servidor pide fotos, abre la ventana y al terminar vuelve a intentar solo.
  async function cambiarEtapaConFotos(siniestroId, body, alTerminar){
    try{
      await api('PATCH', '/api/siniestros/' + siniestroId, body, { silent:true });
      toast('Etapa actualizada.', 'success');
      closeModal();
      if(alTerminar) alTerminar(); else render();
    }catch(e){
      if(e.data && e.data.codigo === 'FOTOS_REQUERIDAS'){
        abrirSubirFotos(siniestroId, e.data.etapa, {
          titulo: 'Fotos de ' + (e.data.etiqueta || ETIQUETAS[e.data.etapa]),
          aviso: e.data.error + ' Al subirlas, la etapa se actualiza sola.',
          alTerminar: ok => { if(ok > 0) cambiarEtapaConFotos(siniestroId, body, alTerminar); else render(); }
        });
      } else {
        toast(e.message, 'error');
      }
    }
  }

  /* ---------- Galería de la unidad ---------- */
  let ultimaLista = [];
  async function renderFotosSiniestro(siniestroId){
    const d = await api('GET', '/api/fotos?siniestro_id=' + siniestroId);
    ultimaLista = d.fotos;
    const esJefe = currentUser && ['admin','jefe'].includes(currentUser.rol);
    let espacio = '';
    if(esJefe){
      const e = await api('GET', '/api/fotos/espacio', null, { silent:true }).catch(() => null);
      if(e && e.disco){
        const gb = n => (n / 1073741824).toFixed(1);
        espacio = `<p class="subtle">Espacio del disco: ${gb(e.disco.usado)} de ${gb(e.disco.total)} GB usados (${Math.round(e.disco.pct * 100)}%). Las fotos de unidades entregadas hace más de 12 meses se borran solas.</p>`;
      }
    }
    const porEtapa = {};
    for(const f of d.fotos){ (porEtapa[f.etapa] = porEtapa[f.etapa] || []).push(f); }
    const secciones = d.etapas.filter(e => e.etapa !== 'otra' || porEtapa.otra).map(e => {
      const fotos = porEtapa[e.etapa] || [];
      return `<div class="fg-etapa">
        <h4>${esc(e.etiqueta)} <span class="badge ${fotos.length ? 'verde' : 'gris'}">${fotos.length}</span>
          ${e.obligatoria ? '<span class="subtle" style="font-weight:500;">obligatoria para avanzar</span>' : ''}
          ${e.etapa !== 'otra' ? `<button class="btn small secondary" onclick="FotosSC.abrirSubirFotos(${siniestroId}, '${e.etapa}')">+ Agregar</button>` : ''}
          ${fotos.length ? `<button class="btn small secondary" onclick="FotosSC.compartirFotos([${fotos.map(f => f.id).join(',')}], 'Fotos de ${esc(e.etiqueta)}')">📤 Compartir</button>
            <a class="link" style="font-size:12px;" href="/api/fotos/zip?siniestro_id=${siniestroId}&etapa=${e.etapa}">Descargar estas</a>` : ''}
        </h4>
        ${fotos.length ? `<div class="fg-grid">${fotos.map(f => `<button type="button" onclick="FotosSC.verFoto(${f.id})" title="${esc(f.subido_por_nombre || '')} · ${esc(f.creado_en)}">
          <img loading="lazy" alt="Foto de ${esc(e.etiqueta)}" src="/api/fotos/${f.id}/imagen?mini=1"></button>`).join('')}</div>`
          : '<div class="fg-vacio">Sin fotos.</div>'}
      </div>`;
    }).join('');
    return `<div class="fg-head">
        <div><b>${d.fotos.length} foto${d.fotos.length === 1 ? '' : 's'}</b> de esta unidad. Todo el equipo las puede ver y descargar.</div>
        ${d.fotos.length ? `<a class="btn small" href="/api/fotos/zip?siniestro_id=${siniestroId}">⬇ Descargar todas (.zip)</a>` : ''}
      </div>${espacio}${secciones}`;
  }

  function verFoto(id){
    const i = ultimaLista.findIndex(f => f.id === id);
    const f = ultimaLista[i];
    if(!f) return;
    const ant = ultimaLista[i - 1], sig = ultimaLista[i + 1];
    showModal(`<div class="fg-visor">
      <h3 style="text-align:left;">${esc(ETIQUETAS[f.etapa] || 'Foto')} <span class="subtle" style="font-weight:500;font-size:13px;">${i + 1} de ${ultimaLista.length} · ${esc(f.subido_por_nombre || '')} · ${esc(f.creado_en)}</span></h3>
      <img alt="Foto" src="/api/fotos/${f.id}/imagen">
      <div class="fg-nav">
        <button class="btn small secondary" ${ant ? `onclick="FotosSC.verFoto(${ant.id})"` : 'disabled'}>← Anterior</button>
        <div class="fg-botones">
          <button class="btn small" onclick="FotosSC.compartirFotos([${f.id}], 'Foto de ${esc(ETIQUETAS[f.etapa] || '')}')">📤 Compartir</button>
          <a class="btn small secondary" href="/api/fotos/${f.id}/descargar">⬇ Descargar</a>
          ${f.puede_borrar && f.tipo === 'foto' ? `<button class="btn small danger" onclick="FotosSC.quitarFoto(${f.id})">Quitar</button>` : ''}
          <button class="btn small secondary" onclick="closeModal()">Cerrar</button>
        </div>
        <button class="btn small secondary" ${sig ? `onclick="FotosSC.verFoto(${sig.id})"` : 'disabled'}>Siguiente →</button>
      </div></div>`, true);
  }

  async function quitarFoto(id){
    const ok = await confirmDialog('¿Quitar esta foto? Queda en la papelera de Archivos por si fue un error.', { textoOk:'Sí, quitar', peligro:true });
    if(!ok) return;
    try{ await api('DELETE', '/api/fotos/' + id); toast('Foto quitada.', 'success'); closeModal(); render(); }catch(e){}
  }

  /* ---------- Compartir por WhatsApp (5-nov-2026) ----------
     Abre el menú de compartir del celular con el archivo ya adjunto (PDF de la OT o fotos); ahí se elige
     WhatsApp y el contacto/grupo. Si el navegador no permite compartir archivos (p. ej. en computadora),
     se descarga para mandarlo a mano. */
  async function cargarArchivo(url, nombre){
    const r = await fetch(url, { credentials:'same-origin' });
    if(!r.ok) throw new Error('No se pudo obtener el archivo.');
    const b = await r.blob();
    return new File([b], nombre, { type: b.type || 'application/octet-stream' });
  }
  function descargarComo(file){
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function compartirArchivos(files, titulo){
    if(!(navigator.canShare && navigator.canShare({ files }))){
      files.forEach(descargarComo);
      toast('Este equipo no permite compartir directo. Se descargó: ábrelo y compártelo por WhatsApp.', 'info', 7000);
      return;
    }
    try{ await navigator.share({ files, title: titulo }); }
    catch(e){
      if(e && e.name === 'AbortError') return; // la persona cerró el menú
      // Si tardó en cargar, el navegador pide un toque nuevo para abrir el menú de compartir.
      showModal(`<h3>${esc(titulo)}</h3><p>${files.length === 1 ? 'El archivo está listo.' : files.length + ' archivos listos.'}</p>
        <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">Cancelar</button><button class="btn" id="fgCompartirYa">📤 Compartir ahora</button></div>`);
      document.getElementById('fgCompartirYa').addEventListener('click', async () => {
        closeModal();
        try{ await navigator.share({ files, title: titulo }); }catch(err){ if(!err || err.name !== 'AbortError') toast('No se pudo compartir: ' + (err && err.message || ''), 'error'); }
      });
    }
  }
  // OT (o cualquier archivo del expediente) por id.
  async function compartirOt(archivoId, numero){
    try{
      toast('Preparando la OT…', 'info', 2000);
      const f = await cargarArchivo(`/api/archivos/${archivoId}/descargar`, `OT_${numero || archivoId}.pdf`);
      const ext = f.type.includes('pdf') ? '.pdf' : f.type.includes('png') ? '.png' : f.type.includes('image') ? '.jpg' : '';
      const final = ext && !f.name.endsWith(ext) ? new File([f], f.name.replace(/\.[^.]+$/, '') + ext, { type: f.type }) : f;
      await compartirArchivos([final], 'Orden de trabajo ' + (numero || ''));
    }catch(e){ toast(e.message, 'error'); }
  }
  // Fotos por id (máximo 10 a la vez para no saturar WhatsApp).
  async function compartirFotos(ids, titulo){
    try{
      const lista = ids.slice(0, 10);
      if(ids.length > 10) toast('Se comparten las primeras 10 fotos. Para todas, usa "Descargar todas".', 'info', 6000);
      else toast('Preparando fotos…', 'info', 2000);
      const files = [];
      for(let i = 0; i < lista.length; i++) files.push(await cargarArchivo(`/api/fotos/${lista[i]}/imagen`, `foto_${i + 1}.jpg`));
      await compartirArchivos(files, titulo || 'Fotos');
    }catch(e){ toast(e.message, 'error'); }
  }

  window.FotosSC = { comprimir, compartirOt, compartirFotos, abrirSubirFotos, subirVarias, cambiarEtapaConFotos, renderFotosSiniestro, verFoto, quitarFoto, ETIQUETAS };
})();
