const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria, corregirBorradoresAutomaticosExistentes, normalizarFechaISO, normalizarFechasCreacionPedidosExistentes } = require('../utils');
const router = express.Router();

/* ===================== Documento de Daniela (25-ago-2026), items 3/4/6 =====================
   Rediseño completo de la carga masiva. Antes: solo pedidos, sin piezas/precio/proveedor real,
   sin actualizar registros existentes, y con estatus_operativo cayendo siempre en 'Nuevo' si el
   CSV no traía ese campo exacto (causa raíz de la mayoría de las fallas del documento).

   Ahora:
   - Cada fila del CSV puede traer una PIEZA (numero_parte/descripcion + precio + proveedor). Varias
     filas con el mismo numero_pedido se agrupan en un solo pedido con varias piezas.
   - Reimportar ACTUALIZA lo que ya existe (REQ-002), no solo crea.
   - El estatus de Inpart se traduce vía la tabla editable mapeo_estatus_inpart (REQ-008), nunca vía
     un valor fijo en el código.
   - Regla dura (CLAUDE-06): ningún valor de Inpart mueve una pieza a "Recibida físicamente" — esa
     transición es exclusiva de la confirmación física manual (endpoint /api/piezas/:id/recibir).
   - Ningún campo con valor real existente se sobrescribe en silencio (REQ-024): los campos de
     "hecho vivo" (precio, estatus, fecha prevista) siempre se sincronizan; los campos "descriptivos/
     de contacto" (vehículo, placas, VIN, contacto de proveedor) solo se llenan si están vacíos, o se
     reportan como conflicto si el valor entrante es distinto al ya capturado.
   - Cada carga confirmada queda registrada como un lote (cargas_masivas) y puede revertirse sin
     borrar nada (soft-revert), igual que el resto del sistema. */

const ESTATUS_OPERATIVO_VALIDOS = ['Nuevo','Por revisar','Esperando proveedor','En tránsito','Entrega vencida','Recibido parcial','Recibido completo','Con incidencia','Cancelado','Cerrado'];
const ESTATUS_PIEZA_VALIDOS = ['Sin proveedor','Asignada','Confirmada','Facturada','En tránsito','Entregada por proveedor','Recibida físicamente','Devuelta','Incorrecta/dañada','Cancelada'];
const ESTATUS_PEDIDO_TERMINALES_MANUALES = ['Cancelado','Cerrado'];
const ESTATUS_PIEZA_TERMINALES_MANUALES = ['Recibida físicamente','Cancelada','Devuelta','Incorrecta/dañada'];
const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

const COLUMNAS = [
  'numero_siniestro','aseguradora','vehiculo','placas','vin','fecha_ingreso','responsable',
  'numero_pedido','fecha_creacion_pedido','fecha_prevista','estatus_inpart','estatus_operativo',
  'numero_parte','descripcion_pieza','tipo_pieza','cantidad','precio','estatus_inpart_pieza','fecha_prometida_pieza',
  'proveedor','contacto_proveedor','telefono_proveedor','correo_proveedor'
];

// Parser CSV simple (RFC4180: soporta comillas dobles y comas dentro de campos entrecomillados).
function parseCSV(texto){
  const filas = [];
  let fila = [], campo = '', dentroComillas = false;
  const s = texto.replace(/\r\n/g, '\n');
  for(let i=0; i<s.length; i++){
    const c = s[i];
    if(dentroComillas){
      if(c === '"'){
        if(s[i+1] === '"'){ campo += '"'; i++; }
        else dentroComillas = false;
      } else campo += c;
    } else {
      if(c === '"') dentroComillas = true;
      else if(c === ','){ fila.push(campo); campo = ''; }
      else if(c === '\n'){ fila.push(campo); filas.push(fila); fila = []; campo = ''; }
      else campo += c;
    }
  }
  if(campo !== '' || fila.length){ fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.length > 1 || (f.length===1 && f[0].trim() !== ''));
}

function mapaMapeoInpart(){
  const filas = db.prepare('SELECT * FROM mapeo_estatus_inpart WHERE activo = 1').all();
  const mapa = {};
  filas.forEach(f => { mapa[f.valor_inpart.trim().toLowerCase()] = f; });
  return mapa;
}

function validarTelefono(v){
  return /^[\d\s()+-]{7,20}$/.test(v);
}

// Agrupa las filas del CSV por numero_pedido (una fila = una pieza, o un pedido sin piezas todavía).
function agruparFilas(csvTexto){
  const filas = parseCSV(csvTexto);
  if(filas.length === 0) return { error: 'El archivo está vacío.' };
  const header = filas[0].map(h => h.trim().toLowerCase());
  const faltantes = ['numero_siniestro','aseguradora','numero_pedido','fecha_prevista'].filter(c => !header.includes(c));
  if(faltantes.length){
    return { error: `Faltan columnas obligatorias en el encabezado: ${faltantes.join(', ')}. Columnas esperadas: ${COLUMNAS.join(', ')}` };
  }
  const mapeo = mapaMapeoInpart();
  const pedidosPorNumero = new Map();
  const erroresGenerales = [];

  for(let i = 1; i < filas.length; i++){
    const cols = filas[i];
    const num = (nombre)=>{ const idx = header.indexOf(nombre); return idx===-1 ? '' : (cols[idx]||'').trim(); };
    const fila = i + 1;
    const dato = {
      numero_siniestro: num('numero_siniestro'), aseguradora: num('aseguradora'), vehiculo: num('vehiculo'),
      placas: num('placas'), vin: num('vin'), fecha_ingreso: num('fecha_ingreso'), responsable: num('responsable'),
      numero_pedido: num('numero_pedido'), fecha_creacion_pedido: num('fecha_creacion_pedido'),
      fecha_prevista: num('fecha_prevista'), estatus_inpart: num('estatus_inpart'), estatus_operativo: num('estatus_operativo'),
      numero_parte: num('numero_parte'), descripcion_pieza: num('descripcion_pieza'), tipo_pieza: num('tipo_pieza'),
      cantidad: num('cantidad'), precio: num('precio'), estatus_inpart_pieza: num('estatus_inpart_pieza'),
      fecha_prometida_pieza: num('fecha_prometida_pieza'),
      proveedor: num('proveedor'), contacto_proveedor: num('contacto_proveedor'), telefono_proveedor: num('telefono_proveedor'),
      correo_proveedor: num('correo_proveedor')
    };
    const errores = [];
    const advertencias = [];
    if(!dato.numero_siniestro) errores.push('Falta número de siniestro.');
    if(!dato.aseguradora) errores.push('Falta aseguradora.');
    if(!dato.numero_pedido) errores.push('Falta número de pedido.');
    if(!dato.fecha_prevista) errores.push('Falta fecha promesa (obligatoria en todo pedido).');
    if(dato.fecha_prevista && !ISO_FECHA.test(dato.fecha_prevista)) errores.push(`Fecha promesa "${dato.fecha_prevista}" no tiene formato ISO (AAAA-MM-DD).`);
    if(dato.fecha_ingreso && !ISO_FECHA.test(dato.fecha_ingreso)) errores.push(`Fecha de ingreso "${dato.fecha_ingreso}" no tiene formato ISO (AAAA-MM-DD).`);
    if(dato.fecha_prometida_pieza && !ISO_FECHA.test(dato.fecha_prometida_pieza)) errores.push(`Fecha prometida de pieza "${dato.fecha_prometida_pieza}" no tiene formato ISO (AAAA-MM-DD).`);
    if(dato.estatus_operativo && !ESTATUS_OPERATIVO_VALIDOS.includes(dato.estatus_operativo)){
      errores.push(`Estatus operativo "${dato.estatus_operativo}" no es válido. Valores permitidos: ${ESTATUS_OPERATIVO_VALIDOS.join(', ')}.`);
    }
    if(dato.cantidad && (!/^\d+$/.test(dato.cantidad) || Number(dato.cantidad) < 1)) errores.push(`Cantidad "${dato.cantidad}" debe ser un entero mayor o igual a 1.`);
    if(dato.precio && (isNaN(Number(dato.precio)) || Number(dato.precio) < 0)) errores.push(`Precio "${dato.precio}" no es un número válido.`);
    if(dato.telefono_proveedor && !validarTelefono(dato.telefono_proveedor)) errores.push(`Teléfono de proveedor "${dato.telefono_proveedor}" tiene caracteres no válidos.`);
    if(dato.correo_proveedor && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dato.correo_proveedor)) errores.push(`Correo de proveedor "${dato.correo_proveedor}" no tiene formato válido.`);
    if(dato.estatus_inpart_pieza && !mapeo[dato.estatus_inpart_pieza.trim().toLowerCase()]){
      advertencias.push(`Estatus de Inpart "${dato.estatus_inpart_pieza}" no está mapeado todavía — la pieza se guardará sin cambiar su estatus automáticamente. Se puede mapear en Configuración.`);
    }

    let grupo = pedidosPorNumero.get(dato.numero_pedido);
    if(!grupo){
      grupo = { fila, dato: { ...dato }, piezas: [], errores: [...errores], advertencias: [...advertencias] };
      pedidosPorNumero.set(dato.numero_pedido, grupo);
    } else {
      // Fila adicional del mismo pedido: valida consistencia de los datos de cabecera.
      if(dato.numero_siniestro && grupo.dato.numero_siniestro && dato.numero_siniestro !== grupo.dato.numero_siniestro){
        grupo.errores.push(`Fila ${fila}: numero_siniestro "${dato.numero_siniestro}" no coincide con el de la primera fila de este pedido ("${grupo.dato.numero_siniestro}").`);
      }
      if(dato.aseguradora && grupo.dato.aseguradora && dato.aseguradora !== grupo.dato.aseguradora){
        grupo.errores.push(`Fila ${fila}: aseguradora "${dato.aseguradora}" no coincide con la de la primera fila de este pedido ("${grupo.dato.aseguradora}").`);
      }
      grupo.errores.push(...errores.map(e=>`Fila ${fila}: ${e}`));
      grupo.advertencias.push(...advertencias.map(a=>`Fila ${fila}: ${a}`));
    }

    if(dato.numero_parte || dato.descripcion_pieza){
      if(!dato.descripcion_pieza){
        grupo.errores.push(`Fila ${fila}: si se indica número de parte, también hace falta la descripción de la pieza.`);
      } else {
        grupo.piezas.push({
          fila, numero_parte: dato.numero_parte, descripcion: dato.descripcion_pieza, tipo: dato.tipo_pieza || 'Original',
          cantidad: dato.cantidad ? Number(dato.cantidad) : 1, precio: dato.precio ? Number(dato.precio) : 0,
          estatus_inpart_pieza: dato.estatus_inpart_pieza, fecha_prometida: dato.fecha_prometida_pieza || dato.fecha_prevista,
          proveedor: dato.proveedor, contacto_proveedor: dato.contacto_proveedor, telefono_proveedor: dato.telefono_proveedor,
          correo_proveedor: dato.correo_proveedor
        });
      }
    }
  }

  const pedidos = [...pedidosPorNumero.values()].map(g=>{
    const existente = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(g.dato.numero_pedido);
    return { ...g, accion: existente ? 'actualizar' : 'crear', pedido_id_existente: existente ? existente.id : null };
  });

  return { total: pedidos.length, pedidos, erroresGenerales };
}

router.post('/validar', requireAuth, requireRole('operativo','admin'), (req, res)=>{
  const { csv } = req.body;
  if(!csv || !String(csv).trim()) return res.status(400).json({ error:'No se recibió contenido CSV.' });
  const resultado = agruparFilas(csv);
  if(resultado.error) return res.status(400).json({ error: resultado.error });
  const resumen = {
    pedidosTotal: resultado.pedidos.length,
    pedidosConError: resultado.pedidos.filter(p=>p.errores.length).length,
    pedidosNuevos: resultado.pedidos.filter(p=>!p.errores.length && p.accion==='crear').length,
    pedidosActualizar: resultado.pedidos.filter(p=>!p.errores.length && p.accion==='actualizar').length,
    piezasTotal: resultado.pedidos.reduce((a,p)=>a+p.piezas.length,0)
  };
  res.json({ ...resultado, resumen });
});

router.post('/confirmar', requireAuth, requireRole('operativo','admin'), (req, res)=>{
  const { pedidos } = req.body;
  if(!Array.isArray(pedidos) || pedidos.length === 0) return res.status(400).json({ error:'No se recibieron pedidos para registrar.' });
  const mapeo = mapaMapeoInpart();

  let siniestrosCreados = 0, siniestrosActualizados = 0, pedidosCreados = 0, pedidosActualizados = 0;
  let piezasCreadas = 0, piezasActualizadas = 0, proveedoresCreados = 0;
  const omitidos = [], conflictos = [];

  const loteInfo = db.prepare(`INSERT INTO cargas_masivas (usuario_id, resumen, estado) VALUES (?,?,?)`).run(req.session.user.id, '', 'confirmada');
  const loteId = loteInfo.lastInsertRowid;

  for(const grupo of pedidos){
    const dato = grupo.dato || {};
    if(!dato.numero_siniestro || !dato.aseguradora || !dato.numero_pedido || !dato.fecha_prevista){
      omitidos.push({ dato, motivo:'Pedido incompleto, se omitió.' }); continue;
    }

    // Siniestro: crear o actualizar (llenando solo lo que esté vacío; lo que ya tiene valor se reporta como conflicto).
    let siniestro = db.prepare('SELECT * FROM siniestros WHERE numero = ?').get(dato.numero_siniestro);
    if(!siniestro){
      const info = db.prepare(`INSERT INTO siniestros (numero,aseguradora,vehiculo,placas,vin,fecha_ingreso,responsable,estatus_general,completo,creado_por,creado_por_lote_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(dato.numero_siniestro, dato.aseguradora, dato.vehiculo||'', dato.placas||'', dato.vin||'',
             dato.fecha_ingreso || new Date().toISOString().slice(0,10), dato.responsable||req.session.user.nombre,
             'Abierto', (dato.vehiculo && dato.placas) ? 1 : 0, req.session.user.id, loteId);
      siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(info.lastInsertRowid);
      siniestrosCreados++;
      registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: siniestro.id, accion:'alta_carga_masiva', usuario:req.session.user, valor_nuevo:`Siniestro ${dato.numero_siniestro} (${dato.aseguradora}), lote #${loteId}` });
    } else {
      const camposConflicto = { vehiculo: dato.vehiculo, placas: dato.placas, vin: dato.vin };
      const updates = {};
      for(const [campo, valorNuevo] of Object.entries(camposConflicto)){
        if(!valorNuevo) continue;
        const valorActual = siniestro[campo];
        if(!valorActual || !String(valorActual).trim()){ updates[campo] = valorNuevo; }
        else if(String(valorActual).trim() !== String(valorNuevo).trim()){
          conflictos.push({ tipo:'siniestro', numero: dato.numero_siniestro, campo, valorActual, valorNuevo, motivo:'El siniestro ya tiene un valor distinto capturado; no se sobrescribió.' });
        }
      }
      if(Object.keys(updates).length){
        const nuevo = { ...siniestro, ...updates };
        db.prepare(`UPDATE siniestros SET vehiculo=?,placas=?,vin=?,completo=? WHERE id=?`)
          .run(nuevo.vehiculo, nuevo.placas, nuevo.vin, (nuevo.vehiculo && nuevo.placas) ? 1 : 0, siniestro.id);
        siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(siniestro.id);
        siniestrosActualizados++;
        registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: siniestro.id, accion:'actualizacion_carga_masiva', usuario:req.session.user, valor_nuevo:`Campos completados: ${Object.keys(updates).join(', ')} (lote #${loteId})` });
      }
    }

    // Pedido: crear o actualizar.
    const estatusMapeadoPedido = dato.estatus_inpart ? mapeo[dato.estatus_inpart.trim().toLowerCase()] : null;
    let pedido = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(dato.numero_pedido);
    if(!pedido){
      const estatusOp = dato.estatus_operativo && ESTATUS_OPERATIVO_VALIDOS.includes(dato.estatus_operativo)
        ? dato.estatus_operativo
        : (estatusMapeadoPedido && estatusMapeadoPedido.estatus_pedido) || 'Nuevo';
      const infoPed = db.prepare(`INSERT INTO pedidos (numero,siniestro_id,aseguradora,fecha_creacion,fecha_prevista,estatus_inpart,estatus_operativo,creado_por,creado_por_lote_id)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        // Hallazgo real (27-ago-2026): Inpart entrega fecha_creacion_pedido en DD/MM/AAAA; se normaliza
        // a ISO aquí mismo para que la ventana operativa (1-jun-2026) la lea correctamente.
        .run(dato.numero_pedido, siniestro.id, dato.aseguradora, normalizarFechaISO(dato.fecha_creacion_pedido) || new Date().toISOString().slice(0,10),
             dato.fecha_prevista, dato.estatus_inpart || 'Aguardando confirmación', estatusOp, req.session.user.id, loteId);
      pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(infoPed.lastInsertRowid);
      pedidosCreados++;
      registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id: pedido.id, accion:'alta_carga_masiva', usuario:req.session.user, valor_nuevo:`Pedido ${dato.numero_pedido} (siniestro ${dato.numero_siniestro}), lote #${loteId}` });
    } else {
      // Hechos vivos de Inpart: fecha prevista y estatus_inpart siempre se sincronizan. El estatus
      // operativo solo se toca si el pedido no está en un estado terminal capturado manualmente.
      let nuevoEstatusOp = pedido.estatus_operativo;
      if(!ESTATUS_PEDIDO_TERMINALES_MANUALES.includes(pedido.estatus_operativo)){
        if(dato.estatus_operativo && ESTATUS_OPERATIVO_VALIDOS.includes(dato.estatus_operativo)) nuevoEstatusOp = dato.estatus_operativo;
        else if(estatusMapeadoPedido && estatusMapeadoPedido.estatus_pedido) nuevoEstatusOp = estatusMapeadoPedido.estatus_pedido;
      }
      db.prepare(`UPDATE pedidos SET fecha_prevista=?,estatus_inpart=?,estatus_operativo=?,actualizado_en=datetime('now') WHERE id=?`)
        .run(dato.fecha_prevista || pedido.fecha_prevista, dato.estatus_inpart || pedido.estatus_inpart, nuevoEstatusOp, pedido.id);
      pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedido.id);
      pedidosActualizados++;
      registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id: pedido.id, accion:'actualizacion_carga_masiva', usuario:req.session.user, valor_nuevo:`Sincronizado desde Inpart (lote #${loteId})` });
    }

    // Piezas del pedido.
    for(const zDato of (grupo.piezas || [])){
      let proveedorId = null;
      if(zDato.proveedor){
        let prov = db.prepare('SELECT * FROM proveedores WHERE razon_social = ? COLLATE NOCASE').get(zDato.proveedor.trim());
        if(!prov){
          const infoP = db.prepare('INSERT INTO proveedores (razon_social,contacto,telefono,correo,creado_por_lote_id) VALUES (?,?,?,?,?)')
            .run(zDato.proveedor.trim(), zDato.contacto_proveedor||'', zDato.telefono_proveedor||'', zDato.correo_proveedor||'', loteId);
          proveedorId = infoP.lastInsertRowid;
          proveedoresCreados++;
          registrarAuditoria(db, { entidad_tipo:'proveedor', entidad_id: proveedorId, accion:'alta_carga_masiva', usuario:req.session.user, valor_nuevo:`${zDato.proveedor} (lote #${loteId})` });
        } else {
          proveedorId = prov.id;
          const updates = {};
          if(zDato.contacto_proveedor && !(prov.contacto||'').trim()) updates.contacto = zDato.contacto_proveedor;
          if(zDato.telefono_proveedor && !(prov.telefono||'').trim()) updates.telefono = zDato.telefono_proveedor;
          if(zDato.correo_proveedor && !(prov.correo||'').trim()) updates.correo = zDato.correo_proveedor;
          if(Object.keys(updates).length){
            const nuevo = { ...prov, ...updates };
            db.prepare(`UPDATE proveedores SET contacto=?,telefono=?,correo=? WHERE id=?`).run(nuevo.contacto, nuevo.telefono, nuevo.correo, prov.id);
          }
        }
      }

      const estatusMapeadoPieza = zDato.estatus_inpart_pieza ? mapeo[zDato.estatus_inpart_pieza.trim().toLowerCase()] : null;
      let piezaExistente = null;
      if(zDato.numero_parte){
        piezaExistente = db.prepare('SELECT * FROM piezas WHERE pedido_id = ? AND numero_parte = ? AND numero_parte != \'\'').get(pedido.id, zDato.numero_parte);
      }
      if(!piezaExistente){
        piezaExistente = db.prepare('SELECT * FROM piezas WHERE pedido_id = ? AND descripcion = ? COLLATE NOCASE').get(pedido.id, zDato.descripcion);
      }

      if(!piezaExistente){
        const estatusInicial = (estatusMapeadoPieza && estatusMapeadoPieza.estatus_pieza) || (proveedorId ? 'Asignada' : 'Sin proveedor');
        const infoZ = db.prepare(`INSERT INTO piezas (pedido_id,proveedor_id,descripcion,numero_parte,tipo,cantidad,precio,fecha_prometida,estatus,creado_por_lote_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(pedido.id, proveedorId, zDato.descripcion, zDato.numero_parte||'', zDato.tipo||'Original', zDato.cantidad||1, zDato.precio||0, zDato.fecha_prometida||dato.fecha_prevista, estatusInicial, loteId);
        piezasCreadas++;
        registrarAuditoria(db, { entidad_tipo:'pieza', entidad_id: infoZ.lastInsertRowid, accion:'alta_carga_masiva', usuario:req.session.user, valor_nuevo:`${zDato.descripcion} (lote #${loteId})` });
      } else {
        let nuevoEstatusZ = piezaExistente.estatus;
        if(!ESTATUS_PIEZA_TERMINALES_MANUALES.includes(piezaExistente.estatus) && estatusMapeadoPieza && estatusMapeadoPieza.estatus_pieza){
          nuevoEstatusZ = estatusMapeadoPieza.estatus_pieza;
        }
        const nuevoProveedorId = proveedorId || piezaExistente.proveedor_id;
        db.prepare(`UPDATE piezas SET proveedor_id=?,precio=?,cantidad=?,fecha_prometida=?,estatus=?,actualizado_en=datetime('now') WHERE id=?`)
          .run(nuevoProveedorId, zDato.precio||piezaExistente.precio, zDato.cantidad||piezaExistente.cantidad, zDato.fecha_prometida||piezaExistente.fecha_prometida, nuevoEstatusZ, piezaExistente.id);
        piezasActualizadas++;
        registrarAuditoria(db, { entidad_tipo:'pieza', entidad_id: piezaExistente.id, accion:'actualizacion_carga_masiva', usuario:req.session.user, valor_nuevo:`Sincronizado desde Inpart (lote #${loteId})` });
      }
    }

    // Recalcula el total del pedido a partir de sus piezas (soluciona los importes en $0.00).
    const piezasPedido = db.prepare('SELECT precio, cantidad FROM piezas WHERE pedido_id = ?').all(pedido.id);
    const total = piezasPedido.reduce((a,z)=>a + (Number(z.precio)||0) * (Number(z.cantidad)||1), 0);
    db.prepare('UPDATE pedidos SET total = ? WHERE id = ?').run(total, pedido.id);
  }

  const resumen = { siniestrosCreados, siniestrosActualizados, pedidosCreados, pedidosActualizados, piezasCreadas, piezasActualizadas, proveedoresCreados, omitidos: omitidos.length, conflictos: conflictos.length };
  db.prepare('UPDATE cargas_masivas SET resumen = ? WHERE id = ?').run(JSON.stringify(resumen), loteId);

  // Hallazgo de Daniela (27-ago-2026): un borrador automatico marcado "incompleto" (o con datos
  // desactualizados) no se recalculaba solo hasta el proximo reinicio del servidor. Si esta misma
  // carga masiva acaba de traer el proveedor/correo real de un pedido con un borrador pendiente,
  // lo recalculamos aqui mismo para no dejarlo obsoleto hasta el proximo despliegue.
  corregirBorradoresAutomaticosExistentes(db);
  normalizarFechasCreacionPedidosExistentes(db);

  res.json({ loteId, ...resumen, omitidos, conflictos_detalle: conflictos });
});

// Item 6: revertir un lote — SOLO deshace lo que ese lote CREÓ (nunca actualizaciones, nunca borra
// nada). Igual que el resto del sistema: se marca como cancelado/archivado, no se elimina.
router.post('/:loteId/revertir', requireAuth, requireRole('operativo','admin'), (req, res)=>{
  const lote = db.prepare('SELECT * FROM cargas_masivas WHERE id = ?').get(req.params.loteId);
  if(!lote) return res.status(404).json({ error:'Lote no encontrado.' });
  if(lote.estado === 'revertida') return res.status(400).json({ error:'Este lote ya fue revertido.' });

  const piezas = db.prepare('SELECT * FROM piezas WHERE creado_por_lote_id = ?').all(lote.id);
  piezas.forEach(z=>{
    if(!ESTATUS_PIEZA_TERMINALES_MANUALES.includes(z.estatus) || z.estatus === 'Cancelada'){
      db.prepare(`UPDATE piezas SET estatus='Cancelada', observaciones = observaciones || ' [Revertida: lote de carga masiva #' || ? || ']', actualizado_en=datetime('now') WHERE id=?`).run(lote.id, z.id);
    }
  });
  const pedidos = db.prepare('SELECT * FROM pedidos WHERE creado_por_lote_id = ?').all(lote.id);
  pedidos.forEach(p=>{
    db.prepare(`UPDATE pedidos SET estatus_operativo='Cancelado', actualizado_en=datetime('now') WHERE id=?`).run(p.id);
  });
  const siniestros = db.prepare('SELECT * FROM siniestros WHERE creado_por_lote_id = ?').all(lote.id);
  siniestros.forEach(s=>{
    // Solo se archiva si TODOS sus pedidos vinieron de este mismo lote (si tiene otros pedidos ajenos, se conserva activo).
    const otrosPedidos = db.prepare('SELECT COUNT(*) n FROM pedidos WHERE siniestro_id = ? AND (creado_por_lote_id IS NULL OR creado_por_lote_id != ?)').get(s.id, lote.id).n;
    if(otrosPedidos === 0){
      db.prepare(`UPDATE siniestros SET archivado=1, archivado_en=datetime('now') WHERE id=?`).run(s.id);
    }
  });

  db.prepare(`UPDATE cargas_masivas SET estado='revertida', revertido_en=datetime('now'), revertido_por=? WHERE id=?`).run(req.session.user.id, lote.id);
  registrarAuditoria(db, { entidad_tipo:'carga_masiva', entidad_id: lote.id, accion:'reversion', usuario:req.session.user,
    valor_nuevo:`Lote #${lote.id} revertido: ${piezas.length} piezas y ${pedidos.length} pedidos marcados como cancelados, ${siniestros.length} siniestros evaluados para archivo.` });

  res.json({ ok:true, piezasCanceladas: piezas.length, pedidosCancelados: pedidos.length, siniestrosArchivados: siniestros.filter(s=>{
    const otros = db.prepare('SELECT COUNT(*) n FROM pedidos WHERE siniestro_id = ? AND (creado_por_lote_id IS NULL OR creado_por_lote_id != ?)').get(s.id, lote.id).n;
    return otros === 0;
  }).length });
});

router.get('/lotes', requireAuth, requireRole('operativo','admin'), (req, res)=>{
  res.json(db.prepare(`SELECT cm.*, u.nombre as usuario_nombre FROM cargas_masivas cm LEFT JOIN usuarios u ON u.id = cm.usuario_id ORDER BY cm.creado_en DESC LIMIT 50`).all());
});

module.exports = router;
