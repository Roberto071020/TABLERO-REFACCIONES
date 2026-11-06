// Inicio de Daniela (6-nov-2026) -- ver server/inicioDaniela.js para el proceso y las reglas.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const inicio = require('../inicioDaniela');
const router = express.Router();

router.get('/', requireAuth, requireRole('operativo', 'admin', 'jefe'), (req, res)=>{
  res.json(inicio.calcularInicioDaniela(db));
});

// Solo Roberto: adelantar o repetir el archivo de correos por aprobar con más de 7 días (no se envían ni se borran).
router.post('/linea-base', requireAuth, requireRole('admin', 'jefe'), (req, res)=>{
  res.json(inicio.archivarCorreosViejos(db, { usuario: req.session.user }));
});

// "Llegó una pieza": piezas todavía no recibidas de las unidades que coinciden con el siniestro/placas/vehículo.
router.get('/piezas-pendientes', requireAuth, requireRole('operativo', 'admin', 'jefe'), (req, res)=>{
  const q = String(req.query.q || '').trim();
  if(q.length < 3) return res.json([]);
  const like = `%${q}%`;
  res.json(db.prepare(`SELECT z.id, z.descripcion, z.estatus, z.fecha_prometida, s.id AS siniestro_id, s.numero AS siniestro_numero, s.vehiculo, s.placas,
      pv.razon_social AS proveedor
    FROM piezas z JOIN pedidos p ON p.id = z.pedido_id JOIN siniestros s ON s.id = p.siniestro_id LEFT JOIN proveedores pv ON pv.id = z.proveedor_id
    WHERE z.estatus NOT IN ('Recibida físicamente','Cancelada') AND s.archivado = 0
      AND (s.numero LIKE ? OR s.placas LIKE ? OR s.vehiculo LIKE ? OR REPLACE(s.placas,'-','') LIKE ?)
    ORDER BY s.numero, z.id LIMIT 40`).all(like, like, like, `%${q.replace(/-/g, '')}%`));
});

module.exports = router;
