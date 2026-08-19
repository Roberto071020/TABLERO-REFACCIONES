const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const router = express.Router();

const COLUMNAS = ['numero_siniestro','aseguradora','vehiculo','placas','fecha_ingreso','responsable',
  'numero_pedido','fecha_creacion_pedido','fecha_prevista','estatus_inpart','estatus_operativo',
  'proveedor','telefono_proveedor','contacto_proveedor'];
const ESTATUS_OPERATIVO_VALIDOS = ['Nuevo','Por revisar','Esperando proveedor','En tránsito','Entrega vencida','Recibido parcial','Recibido completo','Con incidencia','Cancelado','Cerrado'];

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

function validarFilas(csvTexto){
  const filas = parseCSV(csvTexto);
  if(filas.length === 0) return { error: 'El archivo está vacío.' };
  const header = filas[0].map(h => h.trim().toLowerCase());
  const faltantes = ['numero_siniestro','aseguradora','numero_pedido','fecha_prevista'].filter(c => !header.includes(c));
  if(faltantes.length){
    return { error: `Faltan columnas obligatorias en el encabezado: ${faltantes.join(', ')}. Columnas esperadas: ${COLUMNAS.join(', ')}` };
  }

  const validas = [];
  const errores = [];
  const numerosPedidoEnArchivo = new Set();

  for(let i = 1; i < filas.length; i++){
    const cols = filas[i];
    const num = (nombre)=>{ const idx = header.indexOf(nombre); return idx===-1 ? '' : (cols[idx]||'').trim(); };
    const dato = {
      numero_siniestro: num('numero_siniestro'), aseguradora: num('aseguradora'), vehiculo: num('vehiculo'),
      placas: num('placas'), fecha_ingreso: num('fecha_ingreso'), responsable: num('responsable'),
      numero_pedido: num('numero_pedido'), fecha_creacion_pedido: num('fecha_creacion_pedido'),
      fecha_prevista: num('fecha_prevista'), estatus_inpart: num('estatus_inpart'),
      estatus_operativo: num('estatus_operativo'), proveedor: num('proveedor'),
      telefono_proveedor: num('telefono_proveedor'), contacto_proveedor: num('contacto_proveedor')
    };
    const fila = i + 1; // número de línea real en el archivo (1 = encabezado)
    const motivos = [];
    if(!dato.numero_siniestro) motivos.push('Falta número de siniestro.');
    if(!dato.aseguradora) motivos.push('Falta aseguradora.');
    if(!dato.numero_pedido) motivos.push('Falta número de pedido.');
    if(!dato.fecha_prevista) motivos.push('Falta fecha promesa (obligatoria en todo pedido).');
    if(dato.estatus_operativo && !ESTATUS_OPERATIVO_VALIDOS.includes(dato.estatus_operativo)){
      motivos.push(`Estatus operativo "${dato.estatus_operativo}" no es válido.`);
    }
    if(dato.numero_pedido){
      if(numerosPedidoEnArchivo.has(dato.numero_pedido)) motivos.push('Pedido duplicado dentro del mismo archivo.');
      else numerosPedidoEnArchivo.add(dato.numero_pedido);
      const existente = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(dato.numero_pedido);
      if(existente) motivos.push('Ya existe un pedido con ese número en el sistema (no se crean duplicados).');
    }
    if(motivos.length){ errores.push({ fila, dato, motivos }); }
    else { validas.push({ fila, dato }); }
  }
  return { total: filas.length - 1, validas, errores };
}

// Paso 1: validar. No escribe nada en la base de datos (F-carga: "validación previa... antes de registrar").
router.post('/validar', requireAuth, requireRole('operativo','admin'), (req, res)=>{
  const { csv } = req.body;
  if(!csv || !String(csv).trim()) return res.status(400).json({ error:'No se recibió contenido CSV.' });
  const resultado = validarFilas(csv);
  if(resultado.error) return res.status(400).json({ error: resultado.error });
  res.json(resultado);
});

// Paso 2: confirmar. Solo procesa las filas que el usuario decide registrar (normalmente, las que pasaron
// la validación); vuelve a validar cada una server-side por seguridad antes de insertar.
router.post('/confirmar', requireAuth, requireRole('operativo','admin'), (req, res)=>{
  const { filas } = req.body;
  if(!Array.isArray(filas) || filas.length === 0) return res.status(400).json({ error:'No se recibieron filas para registrar.' });

  let siniestrosCreados = 0, siniestrosExistentes = 0, pedidosCreados = 0, omitidos = [];

  for(const dato of filas){
    if(!dato.numero_siniestro || !dato.aseguradora || !dato.numero_pedido || !dato.fecha_prevista){
      omitidos.push({ dato, motivo:'Fila incompleta, se omitió.' }); continue;
    }
    const pedidoExistente = db.prepare('SELECT id FROM pedidos WHERE numero = ?').get(dato.numero_pedido);
    if(pedidoExistente){ omitidos.push({ dato, motivo:'El pedido ya existe, se omitió.' }); continue; }

    let siniestro = db.prepare('SELECT * FROM siniestros WHERE numero = ?').get(dato.numero_siniestro);
    if(!siniestro){
      const info = db.prepare(`INSERT INTO siniestros (numero,aseguradora,vehiculo,placas,fecha_ingreso,responsable,estatus_general,completo,creado_por)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(dato.numero_siniestro, dato.aseguradora, dato.vehiculo||'', dato.placas||'',
             dato.fecha_ingreso || new Date().toISOString().slice(0,10), dato.responsable||req.session.user.nombre,
             'Abierto', (dato.vehiculo && dato.placas) ? 1 : 0, req.session.user.id);
      siniestro = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(info.lastInsertRowid);
      siniestrosCreados++;
      registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: siniestro.id, accion:'alta_carga_masiva', usuario:req.session.user, valor_nuevo:`Siniestro ${dato.numero_siniestro} (${dato.aseguradora})` });
    } else {
      siniestrosExistentes++;
    }

    let proveedorId = null;
    if(dato.proveedor){
      let prov = db.prepare('SELECT id FROM proveedores WHERE razon_social = ?').get(dato.proveedor);
      if(!prov){
        const infoP = db.prepare('INSERT INTO proveedores (razon_social,contacto,telefono) VALUES (?,?,?)')
          .run(dato.proveedor, dato.contacto_proveedor||'', dato.telefono_proveedor||'');
        proveedorId = infoP.lastInsertRowid;
      } else proveedorId = prov.id;
    }

    const estatusOp = ESTATUS_OPERATIVO_VALIDOS.includes(dato.estatus_operativo) ? dato.estatus_operativo : 'Nuevo';
    const infoPed = db.prepare(`INSERT INTO pedidos (numero,siniestro_id,aseguradora,fecha_creacion,fecha_prevista,estatus_inpart,estatus_operativo,creado_por)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(dato.numero_pedido, siniestro.id, dato.aseguradora, dato.fecha_creacion_pedido || new Date().toISOString().slice(0,10),
           dato.fecha_prevista, dato.estatus_inpart || 'Aguardando confirmación', estatusOp, req.session.user.id);
    pedidosCreados++;
    registrarAuditoria(db, { entidad_tipo:'pedido', entidad_id: infoPed.lastInsertRowid, accion:'alta_carga_masiva', usuario:req.session.user, valor_nuevo:`Pedido ${dato.numero_pedido} (siniestro ${dato.numero_siniestro})` });
  }

  res.json({ siniestrosCreados, siniestrosExistentes, pedidosCreados, omitidos });
});

module.exports = router;
