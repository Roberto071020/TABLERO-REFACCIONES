// Completar datos faltantes de expedientes existentes a partir de la libreta física (LIBRETA.xlsx),
// solicitado por Roberto el 2026-08-19. Reglas de seguridad:
//  - Nunca crea siniestros nuevos: solo actualiza uno que YA exista, buscado por número exacto.
//  - Nunca sobreescribe un campo que ya tenga valor: solo rellena vin/cliente_nombre/anio_modelo
//    cuando están vacíos en la base de datos real (no confía en una foto vieja del CSV).
//  - Idempotente: correrlo de nuevo no hace nada distinto (una vez lleno, deja de tocarlo).
//  - Cada cambio queda auditado igual que cualquier edición manual.
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { registrarAuditoria } = require('./utils');

function esVacio(v){ return v === null || v === undefined || String(v).trim() === ''; }

function enriquecerDesdeLibreta(){
  const dataPath = path.join(__dirname, 'data_enriquecimiento_libreta_2026-08.json');
  if(!fs.existsSync(dataPath)) return;
  const datos = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

  let actualizados = 0;
  for(const item of datos){
    const s = db.prepare('SELECT * FROM siniestros WHERE numero = ?').get(item.numero);
    if(!s) continue; // no crea expedientes nuevos, solo completa los que ya existen

    const cambios = {};
    if(item.vin && esVacio(s.vin)) cambios.vin = item.vin;
    if(item.cliente_nombre && esVacio(s.cliente_nombre)) cambios.cliente_nombre = item.cliente_nombre;
    if(item.anio_modelo && esVacio(s.anio_modelo)) cambios.anio_modelo = item.anio_modelo;
    if(Object.keys(cambios).length === 0) continue;

    const nuevo = { ...s, ...cambios };
    db.prepare(`UPDATE siniestros SET vin=?, cliente_nombre=?, anio_modelo=?, actualizado_en=datetime('now') WHERE id=?`)
      .run(nuevo.vin, nuevo.cliente_nombre, nuevo.anio_modelo, s.id);
    Object.keys(cambios).forEach(campo=>{
      registrarAuditoria(db, { entidad_tipo:'siniestro', entidad_id: s.id, accion:'completado_desde_libreta',
        campo, valor_anterior: s[campo], valor_nuevo: cambios[campo], usuario: null });
    });
    actualizados++;
  }
  if(actualizados > 0) console.log(`Completados datos faltantes (libreta) en ${actualizados} expediente(s) existente(s).`);
}

module.exports = { enriquecerDesdeLibreta };
