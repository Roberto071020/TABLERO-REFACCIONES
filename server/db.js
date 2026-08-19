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


/* ===================== MIGRACIONES ADITIVAS — Módulo Alejandra (Fase 0) =====================
   Reglas: nunca se borra ni renombra nada que ya use Daniela. Todo es aditivo e idempotente
   (seguro de correr en cada arranque, incluso sobre la base de producción ya poblada). */

function tieneColumna(tabla, columna){
  return db.prepare(`PRAGMA table_info(${tabla})`).all().some(c => c.name === columna);
}

// 1) Expediente maestro ampliado: nuevas columnas en siniestros (todas opcionales o con default)
const NUEVAS_COLUMNAS_SINIESTROS = [
  ['cliente_nombre', 'TEXT'],
  ['cliente_telefono', 'TEXT'],
  ['cliente_correo', 'TEXT'],
  ['cliente_notas', 'TEXT'],
  ['orden_admision', 'TEXT'],
  ['canal_origen', 'TEXT'],
  ['etapa_actual', 'TEXT'],
  ['prioridad', 'TEXT'],
  ['requiere_refacciones', "TEXT NOT NULL DEFAULT 'por_definir'"], // 'si' | 'no' | 'por_definir'
  ['deducible', 'REAL'],
  ['forma_pago', 'TEXT'],
  ['fecha_entrega_prevista', 'TEXT'],
  ['fecha_entrega_real', 'TEXT'],
  ['postventa_programada', 'TEXT'],
  ['postventa_completada', 'TEXT']
];
for(const [col, def] of NUEVAS_COLUMNAS_SINIESTROS){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}

// 2) Nuevo rol 'atencion_cliente'. SQLite no permite modificar un CHECK con ALTER TABLE,
//    así que se recrea la tabla usuarios preservando todos los datos existentes.
const usuariosSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usuarios'").get();
if(usuariosSql && !usuariosSql.sql.includes('atencion_cliente')){
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE usuarios_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'operativo' CHECK(rol IN ('operativo','jefe','consulta','admin','atencion_cliente')),
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO usuarios_new (id,nombre,email,password_hash,rol,activo,creado_en)
      SELECT id,nombre,email,password_hash,rol,activo,creado_en FROM usuarios;
    DROP TABLE usuarios;
    ALTER TABLE usuarios_new RENAME TO usuarios;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

// 3) Tablas nuevas del módulo de Alejandra (atención y seguimiento a clientes).
//    Ninguna reemplaza ni interfiere con pedidos/piezas/proveedores/comunicaciones de Daniela.
db.exec(`
CREATE TABLE IF NOT EXISTS eventos_cliente (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  direccion TEXT NOT NULL CHECK(direccion IN ('entrante','saliente')),
  canal TEXT,
  tipo_evento TEXT,
  autor_id INTEGER REFERENCES usuarios(id),
  mensaje TEXT,
  adjuntos TEXT,
  resultado TEXT,
  compromiso TEXT,
  proxima_accion TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tareas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  tipo TEXT,
  descripcion TEXT NOT NULL,
  responsable_id INTEGER REFERENCES usuarios(id),
  fecha_limite TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','en_proceso','completada','cancelada')),
  origen TEXT NOT NULL DEFAULT 'manual' CHECK(origen IN ('manual','automatica')),
  disparador TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  completado_en TEXT,
  completado_por INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS catalogo_hitos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orden INTEGER NOT NULL,
  clave TEXT NOT NULL UNIQUE,
  titulo TEXT NOT NULL,
  descripcion TEXT,
  condicional INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS siniestro_hitos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  hito_id INTEGER NOT NULL REFERENCES catalogo_hitos(id),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','generado','revisado','enviado','no_aplica')),
  motivo_no_aplica TEXT,
  fecha_estado TEXT,
  responsable_id INTEGER REFERENCES usuarios(id),
  evento_cliente_id INTEGER REFERENCES eventos_cliente(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(siniestro_id, hito_id)
);

CREATE TABLE IF NOT EXISTS mensajes_ia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  hito_id INTEGER REFERENCES catalogo_hitos(id),
  contexto_usado TEXT,
  borrador TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'generado' CHECK(estado IN ('generado','aprobado','enviado')),
  generado_por INTEGER REFERENCES usuarios(id),
  generado_en TEXT NOT NULL DEFAULT (datetime('now')),
  aprobado_por INTEGER REFERENCES usuarios(id),
  aprobado_en TEXT,
  evento_cliente_id INTEGER REFERENCES eventos_cliente(id)
);

CREATE INDEX IF NOT EXISTS idx_eventos_cliente_siniestro ON eventos_cliente(siniestro_id);
CREATE INDEX IF NOT EXISTS idx_tareas_siniestro ON tareas(siniestro_id);
CREATE INDEX IF NOT EXISTS idx_tareas_estado_fecha ON tareas(estado, fecha_limite);
CREATE INDEX IF NOT EXISTS idx_siniestro_hitos_siniestro ON siniestro_hitos(siniestro_id);
CREATE INDEX IF NOT EXISTS idx_siniestros_requiere_refacciones ON siniestros(requiere_refacciones);
`);

// 4) Catálogo real de hitos de Alejandra (se siembra una sola vez; después es editable a mano)
const hitosCount = db.prepare('SELECT COUNT(*) c FROM catalogo_hitos').get().c;
if(hitosCount === 0){
  const insHito = db.prepare('INSERT INTO catalogo_hitos (orden,clave,titulo,descripcion,condicional) VALUES (?,?,?,?,?)');
  const HITOS = [
    [1,  'recepcion',             'Recepción / orden de admisión',          'Registro inicial del expediente y creación del grupo de WhatsApp con el cliente.', 0],
    [2,  'revision',               'Revisión realizada',                     'Se informa al cliente que la revisión inicial del vehículo fue realizada.', 0],
    [3,  'valuacion_enviada',      'Enviado a valuación',                    'La unidad fue enviada a valuación con la aseguradora.', 0],
    [4,  'valuacion_autorizada',   'Valuación autorizada',                   'La aseguradora autorizó la valuación.', 0],
    [5,  'espera_refacciones',     'En espera de refacciones',               'Solo aplica si el expediente requiere cambio de piezas.', 1],
    [6,  'refacciones_completas',  'Refacciones completas',                  'Todas las piezas del expediente fueron recibidas (se dispara desde el módulo de Daniela).', 1],
    [7,  'cita_reingreso',         'Cita de reingreso',                      'Solo si la unidad está circulando: se agenda el reingreso al taller.', 1],
    [8,  'reprogramacion_cita',    'Reprogramación de cita',                 'Solo si la unidad no ingresó en la fecha programada.', 1],
    [9,  'hojalateria',            'En hojalatería',                         'La unidad se encuentra en proceso de hojalatería.', 0],
    [10, 'mecanica',               'En mecánica',                            'Solo aplica si el expediente requiere trabajo mecánico.', 1],
    [11, 'pintura',                'En pintura',                             'La unidad se encuentra en proceso de pintura.', 0],
    [12, 'detallado_pulido',       'Detallado y pulido',                     'En este punto se confirma la fecha de entrega con el cliente.', 0],
    [13, 'listo_entrega',          'Unidad revisada, lista para entrega',    'La unidad fue revisada y está lista para ser entregada.', 0],
    [14, 'entrega',                'Entrega',                                'Entrega de la unidad; incluye deducible y forma de pago cuando aplique.', 0],
    [15, 'postventa',              'Seguimiento postventa',                  'Mensaje de seguimiento 2-3 días después de la entrega.', 0]
  ];
  for(const h of HITOS) insHito.run(...h);
}


/* ===================== MIGRACIONES ADITIVAS — Requerimientos de Daniela (Fase 0) =====================
   Igual que las anteriores: aditivas e idempotentes, seguras de correr sobre la base ya poblada. */

// 1) Motivo de cancelación en pedidos (para conservar el motivo cuando un pedido se cancela).
if(!tieneColumna('pedidos', 'motivo_cancelacion')){
  db.exec("ALTER TABLE pedidos ADD COLUMN motivo_cancelacion TEXT;");
}

// 2) Bandeja de aprobación de correos: estado, disparador y quién/cuándo aprobó.
//    Las comunicaciones ya existentes (todas creadas y aprobadas en un solo paso hasta ahora)
//    quedan con estado='aprobado' por default, para no alterar su significado histórico.
if(!tieneColumna('comunicaciones', 'estado')){
  db.exec("ALTER TABLE comunicaciones ADD COLUMN estado TEXT NOT NULL DEFAULT 'aprobado';");
}
if(!tieneColumna('comunicaciones', 'disparador')){
  db.exec("ALTER TABLE comunicaciones ADD COLUMN disparador TEXT NOT NULL DEFAULT 'manual';");
}
if(!tieneColumna('comunicaciones', 'aprobado_por')){
  db.exec("ALTER TABLE comunicaciones ADD COLUMN aprobado_por INTEGER REFERENCES usuarios(id);");
}
if(!tieneColumna('comunicaciones', 'aprobado_en')){
  db.exec("ALTER TABLE comunicaciones ADD COLUMN aprobado_en TEXT;");
}

// 3) Archivo de siniestros a 3 meses de la entrega: no se borra nada, solo se marca y se oculta de vistas diarias.
if(!tieneColumna('siniestros', 'archivado')){
  db.exec("ALTER TABLE siniestros ADD COLUMN archivado INTEGER NOT NULL DEFAULT 0;");
}
if(!tieneColumna('siniestros', 'archivado_en')){
  db.exec("ALTER TABLE siniestros ADD COLUMN archivado_en TEXT;");
}
if(!tieneColumna('siniestros', 'no_auto_archivar')){
  db.exec("ALTER TABLE siniestros ADD COLUMN no_auto_archivar INTEGER NOT NULL DEFAULT 0;");
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_comunicaciones_estado ON comunicaciones(estado);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_siniestros_archivado ON siniestros(archivado);`);

module.exports = db;
