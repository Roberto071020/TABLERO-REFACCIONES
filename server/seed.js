const bcrypt = require('bcryptjs');
const db = require('./db');

const TEMP_PASSWORD = 'ServicioCristian2026!';

function seed(){
  const count = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n;
  if(count > 0){ console.log('Ya existen usuarios; se omite el seed de usuarios.'); }
  else {
    const hash = bcrypt.hashSync(TEMP_PASSWORD, 10);
    db.prepare(`INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)`)
      .run('Daniela Sosa', 'daniela@serviciocristian.mx', hash, 'operativo');
    db.prepare(`INSERT INTO usuarios (nombre,email,password_hash,rol) VALUES (?,?,?,?)`)
      .run('Administrador', 'admin@serviciocristian.mx', hash, 'admin');
    console.log('Usuarios creados. Contraseña temporal para ambos:', TEMP_PASSWORD);
    console.log('IMPORTANTE: cambiar la contraseña en el primer inicio de sesión (PATCH /api/auth/password).');
  }

  const provCount = db.prepare('SELECT COUNT(*) n FROM proveedores').get().n;
  if(provCount === 0){
    const provs = [
      ['DNA Collision','Juan Pérez','ventas@dnacollision.mx','55-1234-5678', '["GNP"]', ''],
      ['Vale Automotriz','María López','pedidos@valeautomotriz.mx','55-2233-4455', '["GNP"]', ''],
      ['Refaccionaria Central','Luis Gómez','contacto@refaccentral.mx','55-3344-5566', '["GNP"]', ''],
      ['AutoPartes del Bajío','Sofía Ramírez','ventas@autopartesbajio.mx','477-100-2020', '["Mapfre"]', 'Confirmar siempre por teléfono además de correo.'],
      ['Refacciones López','Pedro López','pedidos@refaccioneslopez.mx','55-4455-6677', '["Afirme"]', ''],
      ['Cristal y Espejos MX','Ana Torres','ventas@cristalyespejos.mx','55-5566-7788', '["Allianz","Mapfre"]', ''],
    ];
    const ins = db.prepare('INSERT INTO proveedores (razon_social,contacto,correo,telefono,aseguradoras,regla_especial) VALUES (?,?,?,?,?,?)');
    provs.forEach(p=>ins.run(...p));
    console.log('Proveedores de ejemplo creados.');
  }

  // Caso real de la prueba de Daniela (Reporte_Pruebas_Tablero_Refacciones), para repetir el criterio de aceptación.
  const existeCaso = db.prepare('SELECT id FROM siniestros WHERE numero = ?').get('4264105314000171');
  if(!existeCaso){
    const admin = db.prepare("SELECT id FROM usuarios WHERE email='admin@serviciocristian.mx'").get();
    const sIns = db.prepare(`INSERT INTO siniestros (numero,aseguradora,vehiculo,anio_modelo,placas,fecha_ingreso,ubicacion,responsable,estatus_general,completo,creado_por)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('4264105314000171','Mapfre','Por confirmar','','Por confirmar', new Date().toISOString().slice(0,10), 'Piso', 'Daniela Sosa', 'Abierto', 0, admin ? admin.id : null);
    const siniestroId = sIns.lastInsertRowid;
    const proveedorEspejos = db.prepare("SELECT id FROM proveedores WHERE razon_social='Cristal y Espejos MX'").get();
    const pIns = db.prepare(`INSERT INTO pedidos (numero,siniestro_id,aseguradora,fecha_creacion,fecha_prevista,estatus_inpart,estatus_operativo,creado_por)
                              VALUES (?,?,?,?,?,?,?,?)`)
      .run('337196', siniestroId, 'Mapfre', new Date().toISOString().slice(0,10), new Date().toISOString().slice(0,10), 'Entregado', 'Con incidencia', admin ? admin.id : null);
    const pedidoId = pIns.lastInsertRowid;
    const zIns = db.prepare(`INSERT INTO piezas (pedido_id, proveedor_id, descripcion, tipo, cantidad, fecha_prometida, estatus)
                              VALUES (?,?,?,?,?,?,?)`)
      .run(pedidoId, proveedorEspejos ? proveedorEspejos.id : null, 'Espejo lateral derecho', 'Original', 1, new Date().toISOString().slice(0,10), 'Entregada por proveedor');
    const piezaId = zIns.lastInsertRowid;
    db.prepare(`INSERT INTO incidencias (pieza_id, tipo, descripcion, accion_solicitada, responsable, estado)
                VALUES (?,?,?,?,?,?)`)
      .run(piezaId, 'incorrecta', 'Espejo entregado no corresponde al pedido (color/modelo incorrecto).', 'cambio', 'Daniela Sosa', 'abierta');
    console.log('Caso real de prueba (siniestro 4264105314000171 / pedido 337196 / espejo incorrecto) sembrado para repetir la validación del reporte.');
  }
}

seed();
module.exports = { seed, TEMP_PASSWORD };
