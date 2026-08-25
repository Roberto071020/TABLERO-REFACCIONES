const express = require('express');
const path = require('path');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const { crearRespaldoDB, rotarRespaldos, listarRespaldos, dirRespaldos } = require('../backup');
const router = express.Router();

// Item 11 del triage de Daniela: solo admin puede ver, crear o descargar respaldos — el mismo
// criterio de mínimo privilegio que gestión de usuarios (sección "Gestión de usuarios" de la
// matriz de roles). jefe queda fuera a propósito: respaldar/restaurar es una decisión técnica,
// no una decisión operativa de supervisión.

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  res.json(listarRespaldos(db.DATA_DIR));
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const archivo = crearRespaldoDB(db, db.DATA_DIR);
  const eliminados = rotarRespaldos(db.DATA_DIR);
  registrarAuditoria(db, { entidad_tipo: 'sistema', entidad_id: null, accion: 'respaldo_creado', valor_nuevo: path.basename(archivo), usuario: req.session.user });
  res.status(201).json({ nombre: path.basename(archivo), eliminados_por_rotacion: eliminados });
});

router.get('/:nombre/descargar', requireAuth, requireRole('admin'), (req, res) => {
  // Se valida contra la lista real en vez de confiar en el parámetro, para no exponer un path
  // arbitrario del disco a través del nombre de archivo (mismo criterio que /api/archivos).
  const nombre = req.params.nombre;
  const existe = listarRespaldos(db.DATA_DIR).some(r => r.nombre === nombre);
  if(!existe) return res.status(404).json({ error: 'Respaldo no encontrado.' });
  registrarAuditoria(db, { entidad_tipo: 'sistema', entidad_id: null, accion: 'respaldo_descargado', valor_nuevo: nombre, usuario: req.session.user });
  res.download(path.join(dirRespaldos(db.DATA_DIR), nombre));
});

module.exports = router;
