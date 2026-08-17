const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // módulo integrado en Node 22+: sin compilación nativa ni descargas al instalar

const DB_PATH = process.env.TEST_DB_PATH || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'tablero.db') : path.join(__dirname, '..', 'data', 'tablero.db'));
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = DELETE;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'operativo' CHECK(rol IN ('operativo','jefe','consulta','admin')),
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS siniestros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  aseguradora TEXT NOT NULL,
  vehiculo TEXT,
  anio_modelo TEXT,
  placas TEXT,
  vin TEXT,
  fecha_ingreso TEXT,
  ubicacion TEXT,
  responsable TEXT,
  estatus_general TEXT NOT NULL DEFAULT 'Abierto',
  notas TEXT,
  completo INTEGER NOT NULL DEFAULT 1,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  cotizacion TEXT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  aseguradora TEXT,
  fecha_creacion TEXT,
  fecha_prevista TEXT,
  estatus_inpart TEXT DEFAULT 'Aguardando confirmación',
  total REAL DEFAULT 0,
  tipo_evaluacion TEXT,
  estatus_operativo TEXT NOT NULL DEFAULT 'Nuevo',
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proveedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  razon_social TEXT NOT NULL UNIQUE,
  contacto TEXT,
  correo TEXT,
  telefono TEXT,
  aseguradoras TEXT DEFAULT '[]',
  regla_especial TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS piezas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  proveedor_id INTEGER REFERENCES proveedores(id),
  descripcion TEXT NOT NULL,
  numero_parte TEXT,
  tipo TEXT DEFAULT 'Original',
  cantidad INTEGER DEFAULT 1,
  precio REAL DEFAULT 0,
  fecha_prometida TEXT,
  estatus TEXT NOT NULL DEFAULT 'Sin proveedor',
  fecha_recepcion TEXT,
  recibido_por INTEGER REFERENCES usuarios(id),
  observaciones TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incidencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pieza_id INTEGER NOT NULL REFERENCES piezas(id),
  tipo TEXT NOT NULL CHECK(tipo IN ('incorrecta','danada','incompleta','devolucion','cancelacion','fecha_incumplida')),
  descripcion TEXT,
  accion_solicitada TEXT CHECK(accion_solicitada IN ('cambio','recoleccion','garantia','reembolso') OR accion_solicitada IS NULL),
  responsable TEXT,
  fecha_compromiso TEXT,
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK(estado IN ('abierta','en_proceso','resuelta','cancelada')),
  resolucion TEXT,
  fecha_resolucion TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comunicaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  proveedor_id INTEGER REFERENCES proveedores(id),
  canal TEXT DEFAULT 'Correo',
  asunto TEXT,
  destinatarios TEXT,
  copia TEXT,
  cuerpo TEXT,
  tipo_plantilla TEXT DEFAULT 'estatus',
  enviado_por INTEGER REFERENCES usuarios(id),
  fecha_envio TEXT NOT NULL DEFAULT (datetime('now')),
  respuesta_texto TEXT,
  respuesta_fecha TEXT,
  compromiso_fecha TEXT,
  siguiente_seguimiento TEXT
);

CREATE TABLE IF NOT EXISTS exclusiones_envio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  proveedor_id INTEGER REFERENCES proveedores(id),
  motivo TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS archivos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad_tipo TEXT NOT NULL CHECK(entidad_tipo IN ('siniestro','pedido','pieza','incidencia')),
  entidad_id INTEGER NOT NULL,
  tipo TEXT,
  nombre_original TEXT NOT NULL,
  nombre_almacenado TEXT NOT NULL,
  mime TEXT,
  tamano INTEGER,
  subido_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad_tipo TEXT NOT NULL,
  entidad_id INTEGER,
  accion TEXT NOT NULL,
  campo TEXT,
  valor_anterior TEXT,
  valor_nuevo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pedidos_siniestro ON pedidos(siniestro_id);
CREATE INDEX IF NOT EXISTS idx_piezas_pedido ON piezas(pedido_id);
CREATE INDEX IF NOT EXISTS idx_incidencias_pieza ON incidencias(pieza_id);
CREATE INDEX IF NOT EXISTS idx_comunicaciones_pedido ON comunicaciones(pedido_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria(entidad_tipo, entidad_id);
`);

module.exports = db;
