const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // módulo integrado en Node 22+: sin compilación nativa ni descargas al instalar

const DATA_DIR = process.env.TEST_DB_PATH ? path.dirname(process.env.TEST_DB_PATH) : (process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const DB_PATH = process.env.TEST_DB_PATH || path.join(DATA_DIR, 'tablero.db');
const db = new DatabaseSync(DB_PATH);
db.DATA_DIR = DATA_DIR; // Item 11 (respaldo/restauración): otros módulos necesitan saber dónde vive la carpeta de datos.
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
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','en_complemento','esperando_autorizacion','en_proceso','generado','revisado','autorizado','completado','enviado','bloqueado','no_aplica')),
  motivo_no_aplica TEXT,
  detalle TEXT,
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

// Investigación Inpart/Gmail (25-ago-2026): columna para el envío automático real por Gmail,
// cuando Roberto configure GMAIL_USER/GMAIL_APP_PASSWORD. Se agrega vacía y no cambia en nada
// el comportamiento de "aprobado" existente (que sigue siendo copiar/pegar manual mientras esto
// no esté configurado).
if(!tieneColumna('comunicaciones', 'enviado_automaticamente_en')){
  db.exec("ALTER TABLE comunicaciones ADD COLUMN enviado_automaticamente_en TEXT;");
}

// Hallazgo de Daniela (27-ago-2026): marca explicita para los borradores automaticos cuyo destinatario
// no se pudo resolver a un correo real de proveedor (proveedor sin correo valido, o piezas pendientes
// con mas de un proveedor distinto). Bloquea la aprobacion hasta que alguien lo complete a mano.
if(!tieneColumna('comunicaciones', 'incompleto')){
  db.exec("ALTER TABLE comunicaciones ADD COLUMN incompleto INTEGER NOT NULL DEFAULT 0;");
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


/* ===================== Almacén de sesiones persistente (corrige "Sesión expirada" reportado por Daniela) =====================
   express-session usaba MemoryStore por default: se vacía cada vez que el proceso se reinicia (cada
   despliegue, o cualquier reinicio de Render), invalidando a todos los usuarios conectados de golpe.
   Esta tabla vive en la misma base de datos, así que sobrevive a reinicios del proceso. */
db.exec(`
CREATE TABLE IF NOT EXISTS sesiones (
  sid TEXT PRIMARY KEY,
  datos TEXT NOT NULL,
  expira_en INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiones_expira ON sesiones(expira_en);
`);


/* ===================== MIGRACIONES ADITIVAS — Documento Maestro / Fase A (2026-08-24) =====================
   Roles nuevos (Orlando, Vanessa, Beto) y modelo de estado ampliado del expediente, siguiendo la
   especificación del "Documento Maestro de Operación y Reglas de Negocio". Todo aditivo: no se toca
   nada de lo que ya usan Daniela ni Alejandra. Angélica/facturación queda fuera por instrucción de Roberto. */

// 1) Nuevos roles: recrear tabla usuarios preservando datos (mismo patrón que el rol 'atencion_cliente').
const usuariosSqlFaseA = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usuarios'").get();
if(usuariosSqlFaseA && !usuariosSqlFaseA.sql.includes('orlando')){
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE usuarios_new_a (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'operativo' CHECK(rol IN ('operativo','jefe','consulta','admin','atencion_cliente','orlando','vanessa','beto')),
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO usuarios_new_a (id,nombre,email,password_hash,rol,activo,creado_en)
      SELECT id,nombre,email,password_hash,rol,activo,creado_en FROM usuarios;
    DROP TABLE usuarios;
    ALTER TABLE usuarios_new_a RENAME TO usuarios;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

// 2) Modelo de estado ampliado: el documento pide separar dimensiones de estado en vez de una sola bandera.
//    etapa_actual ya existía (agregada para Alejandra) pero libre/sin usar; aquí se formaliza su secuencia
//    conceptual. Se agregan además las dimensiones que todavía no tenían ningún campo propio.
const NUEVAS_COLUMNAS_FASE_A = [
  ['estado_valuacion', 'TEXT'],       // Borrador/enviada/observada/ajustada/autorizada parcial/total/rechazada
  ['estado_produccion', 'TEXT'],      // Programado/en laminado/mecánica/preparación/pintura/armado/detenido/terminado
  ['estado_calidad', 'TEXT'],         // En inspección/rechazado a retrabajo/reinspección/liberado
  ['ingreso_tipo', 'TEXT'],           // 'circulando' | 'grua'
  ['ingreso_seguro', 'INTEGER'],      // 1/0 — ¿es seguro que circule?
  ['aseguradora_ruta_refacciones', 'TEXT'],  // 'inpart' | 'autosurtido' | 'pago_danos' | 'pendiente_confirmar'
  ['aseguradora_regla_aplicada', 'TEXT'],    // texto de la regla aplicada, para trazabilidad (F-17 del documento)
  ['piezas_autorizadas_cambio', 'INTEGER']   // conteo usado para la regla GNP 1-3 piezas
];
for(const [col, def] of NUEVAS_COLUMNAS_FASE_A){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}



/* ===================== MIGRACIONES ADITIVAS — Documento Maestro / Fase B (2026-08-24) =====================
   Recepción, admisión y revisión técnica (Orlando), secciones 5.1-5.4 y tabla 21 del documento maestro.
   Todo aditivo. ingreso_tipo/ingreso_seguro ya existían desde Fase A (tabla 21 los reutiliza tal cual,
   no se duplican). Nada de esto toca los módulos ya usados por Daniela, Alejandra u Orlando/Vanessa/Beto
   como cuentas de acceso (Fase A). */

const NUEVAS_COLUMNAS_FASE_B = [
  // 5.1 Recepción y primer contacto
  ['cita_fecha', 'TEXT'],
  ['grua_operador', 'TEXT'],
  ['grua_hora', 'TEXT'],
  // 5.2 Orden de admisión e ingreso físico
  ['fecha_admision', 'TEXT'],
  ['kilometraje', 'TEXT'],
  ['combustible_nivel', 'TEXT'],
  ['llaves_entregadas', 'INTEGER'],
  ['pertenencias', 'TEXT'],
  ['estado_admision', 'TEXT'],           // 'admitido' | 'condicionado' | 'no_admitido'
  ['motivo_admision', 'TEXT'],           // obligatorio si condicionado/no_admitido
  // 5.3 Revisión de daños (Orlando)
  ['estado_revision_tecnica', 'TEXT'],   // 'en_revision' | 'requiere_desarme' | 'revision_terminada'
  ['riesgo_seguridad', 'INTEGER'],       // 1/0 — vehículo no seguro para circular
  ['riesgo_seguridad_motivo', 'TEXT'],   // obligatorio si riesgo_seguridad = 1
  // 5.4 Fotografías y desarme — estado agregado del paquete de evidencia (el detalle vive en danos_evidencia)
  ['estado_evidencia', 'TEXT']           // 'evidencia_completa' | 'desarme_parcial' | 'dano_oculto_detectado'
];
for(const [col, def] of NUEVAS_COLUMNAS_FASE_B){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}

// Daños y evidencia (entidad propia del documento maestro, tabla 3): un renglón por hallazgo/zona,
// opcionalmente ligado a una foto ya subida por el endpoint de archivos existente (no se duplica esa infraestructura).
db.exec(`
CREATE TABLE IF NOT EXISTS danos_evidencia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  zona_pieza TEXT NOT NULL,
  tipo_dano TEXT,
  visibilidad TEXT NOT NULL DEFAULT 'visible' CHECK(visibilidad IN ('visible','oculto')),
  relacionado INTEGER NOT NULL DEFAULT 1,
  severidad TEXT,
  operacion_preliminar TEXT,
  observaciones TEXT,
  archivo_id INTEGER REFERENCES archivos(id),
  autor_id INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_danos_evidencia_siniestro ON danos_evidencia(siniestro_id);
`);



/* ===================== MIGRACIONES ADITIVAS — Documento Maestro / Fase C (2026-08-24) =====================
   Captura y armado del expediente digital (Vanessa), sección 5.5 y tabla 9 del documento maestro.
   Todo aditivo; no toca nada de recepción/admisión/revisión técnica (Fase B) ni de Daniela/Alejandra. */

const NUEVAS_COLUMNAS_FASE_C = [
  ['estado_expediente', 'TEXT'],       // 'en_captura' | 'incompleto' | 'listo_para_valuacion'
  ['sistema_valuacion', 'TEXT'],       // 'ACG' | 'BDEO' | 'Sistema propio (Zurich)' — confirmado por Vanessa/Orlando
  ['expediente_folio', 'TEXT']         // folio/número de expediente en el sistema de valuación, cuando exista
];
for(const [col, def] of NUEVAS_COLUMNAS_FASE_C){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}

// Checklist documental del expediente (tabla 9: "checklist documental, versiones, legibilidad, folios y
// faltantes"). No se define aquí un catálogo fijo de documentos por aseguradora porque el propio documento
// maestro (sección 19) marca ese requisito como pendiente de confirmación: tipo_documento queda libre para
// que Vanessa lo use según el caso, sin inventar una política no confirmada.
db.exec(`
CREATE TABLE IF NOT EXISTS documentos_expediente (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  tipo_documento TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  estado TEXT NOT NULL DEFAULT 'faltante' CHECK(estado IN ('faltante','recibido','no_legible','no_aplica')),
  folio TEXT,
  notas TEXT,
  archivo_id INTEGER REFERENCES archivos(id),
  autor_id INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documentos_expediente_siniestro ON documentos_expediente(siniestro_id);
`);



/* ===================== MIGRACIONES ADITIVAS — Documento Maestro / Fase D (2026-08-24) =====================
   Valuación y autorización, secciones 5.6/5.7 y tablas 10/11 del documento maestro. El motor de reglas por
   aseguradora (calcularRutaAseguradora) y el campo sistema_valuacion ya existían (Fases A y C) y se reutilizan
   tal cual, sin duplicarlos. estado_valuacion también ya existía (Fase A) pero sin usarse: aquí se activa. */

const NUEVAS_COLUMNAS_FASE_D = [
  // 5.6 Valuación (tabla 10)
  ['valuacion_folio', 'TEXT'],
  ['valuacion_version', 'INTEGER'],
  ['valuacion_importe', 'REAL'],
  ['valuacion_fecha_envio', 'TEXT'],
  ['valuacion_observaciones', 'TEXT'],
  // 5.7 Autorización (tabla 11) — dimensión separada de estado_valuacion, tal como pide la sección 4.2
  ['estado_autorizacion', 'TEXT'],           // 'en_autorizacion' | 'autorizada' | 'parcial' | 'rechazada' | 'por_aclarar'
  ['autorizacion_fecha_envio', 'TEXT'],
  ['autorizacion_fecha_respuesta', 'TEXT'],
  ['autorizador', 'TEXT'],
  ['autorizacion_importe', 'REAL'],
  ['autorizacion_restricciones', 'TEXT']
];
for(const [col, def] of NUEVAS_COLUMNAS_FASE_D){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}



/* ===================== MIGRACIONES ADITIVAS — Documento Maestro / Fase E (2026-08-24) =====================
   Orden de trabajo y producción (Beto), secciones 5.8/5.10/5.11 y sección 9, tablas 12/14/15 del documento
   maestro. estado_produccion ya existía en siniestros desde Fase A (columna sin usar); aquí se activa.
   No se toca nada de Daniela (piezas/pedidos) ni de las fases B/C/D. */

// La OT (tabla 12) y las etapas de producción (tabla 14) comparten exactamente los mismos campos por
// operación (técnico/área, secuencia, horas, fechas, avance, bloqueo), así que se modelan en una sola
// entidad (ot_operaciones) en vez de duplicar dos tablas paralelas para lo mismo.
db.exec(`
CREATE TABLE IF NOT EXISTS ordenes_trabajo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  numero TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK(estado IN ('borrador','emitida','actualizada','suspendida','terminada')),
  alcance TEXT,
  notas TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ot_siniestro ON ordenes_trabajo(siniestro_id);

CREATE TABLE IF NOT EXISTS ot_operaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ot_id INTEGER NOT NULL REFERENCES ordenes_trabajo(id),
  descripcion TEXT NOT NULL,
  pieza TEXT,
  area TEXT,
  tecnico TEXT,
  secuencia INTEGER,
  horas_estimadas REAL,
  estado TEXT NOT NULL DEFAULT 'programado' CHECK(estado IN ('programado','en_proceso','detenido','terminado')),
  fecha_inicio TEXT,
  fecha_fin_prevista TEXT,
  fecha_fin_real TEXT,
  avance INTEGER NOT NULL DEFAULT 0,
  causa_bloqueo TEXT CHECK(causa_bloqueo IS NULL OR causa_bloqueo IN ('pieza_faltante','complemento_pendiente','capacidad','falla_equipo','ausencia','retrabajo')),
  siguiente_accion TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ot_operaciones_ot ON ot_operaciones(ot_id);

-- Complementos por daño oculto (tabla 15): hallazgo durante desarme/producción que puede requerir
-- autorización adicional y modificar la OT/fechas/refacciones.
CREATE TABLE IF NOT EXISTS complementos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  ot_id INTEGER REFERENCES ordenes_trabajo(id),
  causa TEXT NOT NULL,
  fecha TEXT,
  pieza_operacion TEXT,
  archivo_id INTEGER REFERENCES archivos(id),
  importe REAL,
  folio TEXT,
  decision TEXT NOT NULL DEFAULT 'pendiente' CHECK(decision IN ('pendiente','autorizado','rechazado','parcial')),
  impacto_dias INTEGER,
  estado TEXT NOT NULL DEFAULT 'detectado' CHECK(estado IN ('detectado','documentando','enviado','en_autorizacion','autorizado','rechazado','incorporado_a_ot')),
  autor_id INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_complementos_siniestro ON complementos(siniestro_id);

-- Retrabajos (sección 9): nacen de una no conformidad. Un expediente no puede pasar a "listo para
-- entrega" (Fase F) mientras tenga retrabajos críticos abiertos.
CREATE TABLE IF NOT EXISTS retrabajos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  ot_operacion_id INTEGER REFERENCES ot_operaciones(id),
  origen TEXT,
  categoria TEXT,
  severidad TEXT NOT NULL DEFAULT 'media' CHECK(severidad IN ('leve','media','critica')),
  responsable TEXT,
  horas REAL,
  costo REAL,
  correccion TEXT,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK(estado IN ('abierto','en_correccion','reinspeccion','cerrado')),
  fecha_reinspeccion TEXT,
  autor_id INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retrabajos_siniestro ON retrabajos(siniestro_id);
`);



/* ===================== MIGRACIONES ADITIVAS — Documento Maestro / Fase F (2026-08-24) =====================
   Control de calidad, entrega, finiquito y encuesta, secciones 5.12-5.15 y tablas 16/18/19/23 del
   documento maestro. estado_calidad ya existía en siniestros desde Fase A (sin usar); aquí se activa.
   Reutiliza fecha_entrega_real y el endpoint /entrega ya construidos para Daniela (Fase 2 previa):
   no se duplica esa lógica, solo se le agrega la validación de retrabajos críticos que pide el documento. */

const NUEVAS_COLUMNAS_FASE_F = [
  // 5.14 Preparación y entrega (tabla 18) — complementa fecha_entrega_real, que ya existía.
  ['entrega_receptor', 'TEXT'],
  ['entrega_identificacion', 'TEXT'],
  ['entrega_kilometraje', 'TEXT'],
  ['entrega_combustible', 'TEXT'],
  ['entrega_llaves_entregadas', 'INTEGER'],
  ['entrega_observacion', 'TEXT'],
  ['estado_entrega', 'TEXT'],           // 'listo' | 'cita_confirmada' | 'entregado_con_observacion' | 'entregado'
  // 5.15 Finiquito y encuesta (tabla 19)
  ['finiquito_estado', 'TEXT'],         // 'pendiente' | 'firmado' | 'inconformidad_abierta'
  ['finiquito_fecha', 'TEXT'],
  ['finiquito_observacion', 'TEXT'],
  ['encuesta_estado', 'TEXT'],          // 'pendiente' | 'enviada' | 'respondida'
  ['encuesta_calificacion', 'INTEGER'],
  ['encuesta_comentarios', 'TEXT']
];
for(const [col, def] of NUEVAS_COLUMNAS_FASE_F){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}

// Checklist de calidad (tabla 23): las 7 dimensiones son un catálogo fijo, definido explícitamente por
// el propio documento maestro (no se inventa), así que se valida con CHECK en vez de texto libre.
db.exec(`
CREATE TABLE IF NOT EXISTS checklist_calidad (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  dimension TEXT NOT NULL CHECK(dimension IN ('Alcance','Seguridad y función','Lámina/ajuste','Pintura/acabado','Armado','Presentación','Documentación')),
  resultado TEXT NOT NULL DEFAULT 'pendiente' CHECK(resultado IN ('pendiente','aprobado','rechazado')),
  hallazgo TEXT,
  severidad TEXT,
  correccion TEXT,
  inspector_id INTEGER REFERENCES usuarios(id),
  fecha TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checklist_calidad_siniestro ON checklist_calidad(siniestro_id);
`);



/* ===================== MIGRACIONES ADITIVAS — Propuesta Orlando/Vanessa fusionados + paneles por rol (2026-08-24) =====================
   Documento "Propuesta_Orlando_Vanessa_Beto": Orlando absorbe la captura de Vanessa (Excel, fotos, envío
   al propietario) de cara a su ausencia por nacimiento de su bebé (~40 días), sin necesitar su usuario.
   Es una capa ADITIVA sobre lo ya construido en la Fase B (revisión técnica) y Fase C (expediente digital):
   no reemplaza esa lógica, según confirmó Roberto. */

const NUEVAS_COLUMNAS_FUSION_OV = [
  ['fecha_borrador_captura', 'TEXT'],   // Fecha de entrega del borrador a captura. Campo compartido: gana
                                          // la primera vez que se registra (confirmado por Roberto), sin
                                          // importar si lo capturó Orlando o Vanessa.
  ['excel_capturado', 'INTEGER NOT NULL DEFAULT 0'],
  ['excel_capturado_fecha', 'TEXT'],
  ['fotos_completas', 'INTEGER NOT NULL DEFAULT 0'],
  ['fotos_completas_fecha', 'TEXT'],
  ['enviado_propietario', 'INTEGER NOT NULL DEFAULT 0'],
  ['enviado_propietario_fecha', 'TEXT']
];
for(const [col, def] of NUEVAS_COLUMNAS_FUSION_OV){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}

/* ===================== Triage documento de Daniela (25-ago-2026), item 1 =====================
   REQ-005: falta el campo "telefono alterno" en la ficha de proveedor (el backend ya soportaba
   telefono y regla_especial, pero no telefono_alterno). Aditivo, mismo patron de siempre. */
if(!tieneColumna('proveedores', 'telefono_alterno')){
  db.exec(`ALTER TABLE proveedores ADD COLUMN telefono_alterno TEXT;`);
}

/* ===================== Triage documento de Daniela (25-ago-2026), items 3/4/6 =====================
   Rediseño de la carga masiva: importación a nivel pieza, mapeo de estatus Inpart editable (no
   hard-codeado), y trazabilidad por lote para poder revertir una carga sin borrar nada (soft-revert,
   igual que el resto del sistema: nunca se elimina físicamente). */

// Mapeo de estatus de Inpart -> estatus internos. Vive en tabla editable (no en código) porque Inpart
// puede usar textos distintos con el tiempo; admin/operativo lo pueden ajustar desde /api/mapeo-estatus-inpart.
db.exec(`
CREATE TABLE IF NOT EXISTS mapeo_estatus_inpart (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  valor_inpart TEXT NOT NULL UNIQUE,
  estatus_pieza TEXT,
  estatus_pedido TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
const seedMapeo = db.prepare('SELECT COUNT(*) n FROM mapeo_estatus_inpart').get().n;
if(seedMapeo === 0){
  // Regla dura (hallazgo CLAUDE-06 del documento de Daniela): "Facturado no significa recibido
  // físicamente". Ningún valor de Inpart mapea a 'Recibida físicamente' — esa transición es EXCLUSIVA
  // de la confirmación manual del taller (endpoint /recibir), nunca de una importación.
  const filas = [
    ['Aguardando confirmación', 'Sin proveedor', 'Nuevo'],
    ['Pendiente', 'Sin proveedor', 'Nuevo'],
    ['Cotizado', 'Asignada', 'Por revisar'],
    ['Confirmado', 'Confirmada', 'Esperando proveedor'],
    ['Facturado', 'Facturada', 'Esperando proveedor'],
    ['En tránsito', 'En tránsito', 'Esperando proveedor'],
    ['Entregado', 'Entregada por proveedor', 'Recibido parcial'],
    ['Recibido en almacén', 'Entregada por proveedor', 'Recibido parcial'],
    ['Devuelto', 'Devuelta', 'Con incidencia'],
    ['Incorrecto', 'Incorrecta/dañada', 'Con incidencia'],
    ['Dañado', 'Incorrecta/dañada', 'Con incidencia'],
    ['Cancelado', 'Cancelada', 'Cancelado'],
  ];
  const ins = db.prepare('INSERT INTO mapeo_estatus_inpart (valor_inpart,estatus_pieza,estatus_pedido) VALUES (?,?,?)');
  filas.forEach(f=>ins.run(...f));
}

// Trazabilidad por lote de carga masiva, para poder revertir sin borrar nada.
db.exec(`
CREATE TABLE IF NOT EXISTS cargas_masivas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  resumen TEXT,
  estado TEXT NOT NULL DEFAULT 'confirmada' CHECK(estado IN ('confirmada','revertida')),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  revertido_en TEXT,
  revertido_por INTEGER REFERENCES usuarios(id)
);
`);
if(!tieneColumna('siniestros', 'creado_por_lote_id')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN creado_por_lote_id INTEGER REFERENCES cargas_masivas(id);`);
}
if(!tieneColumna('pedidos', 'creado_por_lote_id')){
  db.exec(`ALTER TABLE pedidos ADD COLUMN creado_por_lote_id INTEGER REFERENCES cargas_masivas(id);`);
}
if(!tieneColumna('piezas', 'creado_por_lote_id')){
  db.exec(`ALTER TABLE piezas ADD COLUMN creado_por_lote_id INTEGER REFERENCES cargas_masivas(id);`);
}
if(!tieneColumna('proveedores', 'creado_por_lote_id')){
  db.exec(`ALTER TABLE proveedores ADD COLUMN creado_por_lote_id INTEGER REFERENCES cargas_masivas(id);`);
}

/* ===================== Triage documento de Daniela (25-ago-2026), item 7 =====================
   REQ-018: faltaba sustitución y eliminación recuperable de archivos. Aditivo, mismo patrón. */
if(!tieneColumna('archivos', 'eliminado')){
  db.exec(`ALTER TABLE archivos ADD COLUMN eliminado INTEGER NOT NULL DEFAULT 0;`);
}
if(!tieneColumna('archivos', 'eliminado_en')){
  db.exec(`ALTER TABLE archivos ADD COLUMN eliminado_en TEXT;`);
}
if(!tieneColumna('archivos', 'eliminado_por')){
  db.exec(`ALTER TABLE archivos ADD COLUMN eliminado_por INTEGER REFERENCES usuarios(id);`);
}
if(!tieneColumna('archivos', 'version')){
  db.exec(`ALTER TABLE archivos ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS archivos_versiones_anteriores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archivo_id INTEGER NOT NULL REFERENCES archivos(id),
  version INTEGER NOT NULL,
  nombre_original TEXT,
  nombre_almacenado TEXT NOT NULL,
  mime TEXT,
  tamano INTEGER,
  reemplazado_por INTEGER REFERENCES usuarios(id),
  reemplazado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
`);


/* ===================== Propuesta de Alejandra: nuevos estados de hitos + "Pendientes de hoy" (27-ago-2026) =====================
   Documento "SEGUIMIENTO TABLERO ALE.docx": estados más específicos por hito (en vez de solo
   pendiente/generado/revisado/enviado/no_aplica), un campo de detalle para explicar de qué se está
   esperando o por qué está bloqueado, y la pregunta "¿Cubre deducible?" en el hito de entrega. */

// 1) siniestro_hitos.detalle: texto libre para "en_complemento" (qué falta) y "bloqueado" (motivo).
if(!tieneColumna('siniestro_hitos', 'detalle')){
  db.exec(`ALTER TABLE siniestro_hitos ADD COLUMN detalle TEXT;`);
}

// 2) siniestros.cubre_deducible: NULL = todavía no se preguntó; 1 = Sí; 0 = No. Es un flag de
//    cobertura, DISTINTO de siniestros.deducible (que guarda el MONTO en pesos, ya existía).
if(!tieneColumna('siniestros', 'cubre_deducible')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN cubre_deducible INTEGER;`);
}

// 3) Amplía el CHECK de siniestro_hitos.estado para los nuevos estados propuestos por Alejandra.
//    SQLite no permite ALTER de un CHECK existente; se recrea la tabla completa de forma seguraw:
//    se copian TODAS las filas (misma cantidad antes/después, verificado) y solo se reemplaza si el
//    CHECK viejo todavía no incluye 'bloqueado' -- así es idempotente y nunca se repite ni pierde datos.
{
  const filaEsquema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='siniestro_hitos'`).get();
  if(filaEsquema && !filaEsquema.sql.includes("'bloqueado'")){
    const totalAntes = db.prepare('SELECT COUNT(*) c FROM siniestro_hitos').get().c;
    db.exec(`
      CREATE TABLE siniestro_hitos_nueva (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
        hito_id INTEGER NOT NULL REFERENCES catalogo_hitos(id),
        estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','en_complemento','esperando_autorizacion','en_proceso','generado','revisado','autorizado','completado','enviado','bloqueado','no_aplica')),
        motivo_no_aplica TEXT,
        detalle TEXT,
        fecha_estado TEXT,
        responsable_id INTEGER REFERENCES usuarios(id),
        evento_cliente_id INTEGER REFERENCES eventos_cliente(id),
        creado_en TEXT NOT NULL DEFAULT (datetime('now')),
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(siniestro_id, hito_id)
      );
      INSERT INTO siniestro_hitos_nueva (id,siniestro_id,hito_id,estado,motivo_no_aplica,detalle,fecha_estado,responsable_id,evento_cliente_id,creado_en,actualizado_en)
        SELECT id,siniestro_id,hito_id,estado,motivo_no_aplica,detalle,fecha_estado,responsable_id,evento_cliente_id,creado_en,actualizado_en FROM siniestro_hitos;
    `);
    const totalDespues = db.prepare('SELECT COUNT(*) c FROM siniestro_hitos_nueva').get().c;
    if(totalDespues !== totalAntes){
      throw new Error(`Migración de siniestro_hitos abortada: ${totalAntes} filas antes, ${totalDespues} después de copiar. No se reemplaza la tabla.`);
    }
    db.exec(`
      DROP TABLE siniestro_hitos;
      ALTER TABLE siniestro_hitos_nueva RENAME TO siniestro_hitos;
      CREATE INDEX IF NOT EXISTS idx_siniestro_hitos_siniestro ON siniestro_hitos(siniestro_id);
    `);
  }
}


/* ===================== Propuesta de Orlando: compuerta de disponibilidad + SLA de revision (27-ago-2026) =====================
   "Propuesta_Integracion_Tablero_Servicio_Cristian.docx". Un vehiculo solo debe aparecer en la
   bandeja de revision tecnica de Orlando cuando Alejandra ya completo los requisitos de admision
   (inventario fisico + orden de admision subidos, llaves confirmadas, y dado de seguridad si aplica
   por dano de suspension). Se agregan las marcas de tiempo para medir el plazo de 72 horas habiles. */
const NUEVAS_COLUMNAS_PROPUESTA_ORLANDO = [
  ['requiere_dado_seguridad', 'INTEGER'],        // 1/0 -- Alejandra lo marca si hay dano de suspension
  ['dado_seguridad_colocado', 'INTEGER'],        // 1/0 -- confirmacion de que ya se coloco
  ['fecha_hora_disponible_revision', 'TEXT'],    // se sella solo, una vez, cuando se cumplen los requisitos
  ['fecha_hora_revision_concluida', 'TEXT']      // se sella solo cuando Orlando marca revision_terminada
];
for(const [col, def] of NUEVAS_COLUMNAS_PROPUESTA_ORLANDO){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}

/* ===================== Modificaciones_Tablero_SC_Control.docx (28-ago-2026) =====================
   Roberto explicó el proceso completo de principio a fin y de ahí salieron 7 modificaciones puntuales
   + una regla por aseguradora. Todo aditivo, nada se borra ni se renombra. */

// Modificación 4: seguimiento de posventa -- ya existía postventa_programada/postventa_completada
// (tarea automática 2-3 días después de la entrega); falta el RESULTADO del contacto, distinto de la
// fecha en que se completó la tarea. NULL = todavía no se sabe; 'contactado' | 'no_contesta'.
// Modificación 5: el deducible YA se "informa" al cliente cuando se captura el monto (columna
// `deducible`, ya existente); lo que faltaba es un sello de fecha de PAGO CONFIRMADO, distinto e
// independiente de solo haberlo informado, para no entregar la unidad sin la confirmación bancaria.
// Modificación 4 (GNP): paso adicional del checklist de entrega -- pedirle al cliente que conteste la
// encuesta de satisfacción ahí mismo, en el momento de la entrega (solo aplica a GNP).
const NUEVAS_COLUMNAS_MODIFICACIONES_SC_CONTROL = [
  ['postventa_resultado', 'TEXT'],                  // NULL | 'contactado' | 'no_contesta'
  ['deducible_pagado_confirmado_en', 'TEXT'],       // fecha en que se confirmó el pago (no solo informado)
  ['entrega_encuesta_gnp_solicitada', 'INTEGER']    // 1/0 -- solo aplica/se muestra cuando aseguradora = GNP
];
for(const [col, def] of NUEVAS_COLUMNAS_MODIFICACIONES_SC_CONTROL){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}

// Modificación 2: "discrepancia proveedor" -- un proveedor marca una pieza como entregada en Impart sin
// haberla enviado; cuando se descubre la falta, la aseguradora reclama por qué no se avisó a tiempo.
// Tabla nueva (no se reutiliza `incidencias` porque esa tabla exige pieza_id NOT NULL y un CHECK de tipo
// cerrado; esto necesita quedar documentado aunque la pieza/proveedor todavía no estén identificados).
db.exec(`
CREATE TABLE IF NOT EXISTS discrepancias_proveedor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  pieza_id INTEGER REFERENCES piezas(id),
  proveedor_id INTEGER REFERENCES proveedores(id),
  descripcion TEXT NOT NULL,
  fecha_marcado_entregado TEXT,
  fecha_real_llegada TEXT,
  no_llego INTEGER NOT NULL DEFAULT 0,
  correo_enviado_en TEXT,
  correo_texto TEXT,
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK(estado IN ('abierta','resuelta')),
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discrepancias_siniestro ON discrepancias_proveedor(siniestro_id);
`);

// Modificación 3: "vale pendiente" -- al entregar con una pieza faltante (ej. un emblema) se da un vale
// al cliente, pero hoy no hay seguimiento formal y se olvida hasta que el cliente pregunta.
db.exec(`
CREATE TABLE IF NOT EXISTS vales_pendientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  pieza_pendiente TEXT NOT NULL,
  fecha_entrega_vehiculo TEXT,
  fecha_estimada_llegada TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','surtido','cancelado')),
  notas TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vales_siniestro ON vales_pendientes(siniestro_id);
`);

// Modificación 6: orden real de producción confirmado por Roberto: mecánica -> hojalatería -> pintura ->
// armado -> pulido -> lavado -> entrega. El catálogo de hitos (checklist de avisos al cliente de
// Alejandra) tenía hojalatería (orden 9) antes que mecánica (orden 10); se corrige el orden de
// despliegue nada más -- no se toca la clave ni se borra el hito, así que no afecta lo ya capturado
// en siniestro_hitos (que referencia hito_id, no el número de orden).
db.prepare("UPDATE catalogo_hitos SET orden = 9 WHERE clave = 'mecanica'").run();
db.prepare("UPDATE catalogo_hitos SET orden = 10 WHERE clave = 'hojalateria'").run();

/* ===================== Informe_funcional_tablero_refacciones_para_Claude.docx (28-ago-2026) =====================
   Auditoría de Daniela sobre el área de Refacciones: 4 críticos, 7 altos, 5 medios. Aditivo, nada se borra. */

const NUEVAS_COLUMNAS_INFORME_DANIELA = [
  // A-03: normalizar aseguradoras duplicadas por variantes de nombre sin perder el texto original importado.
  ['aseguradora_texto_importado', 'TEXT'],
  // A-05: motivo/confirmación explícita cuando la fecha prevista de un pedido no es estrictamente futura.
  ['fecha_prevista_confirmada_por', 'TEXT']
];
for(const [col, def] of NUEVAS_COLUMNAS_INFORME_DANIELA){
  if(!tieneColumna('siniestros', col)){
    db.exec(`ALTER TABLE siniestros ADD COLUMN ${col} ${def};`);
  }
}
if(!tieneColumna('pedidos', 'fecha_prevista_confirmada_por')){
  db.exec(`ALTER TABLE pedidos ADD COLUMN fecha_prevista_confirmada_por TEXT;`);
}
// C-03: registrar el id de mensaje real que regresa Gmail al enviar, para trazabilidad (ya existía
// enviado_automaticamente_en; esto guarda el identificador que Gmail asigna a ese envío concreto).
if(!tieneColumna('comunicaciones', 'enviado_id_mensaje')){
  db.exec(`ALTER TABLE comunicaciones ADD COLUMN enviado_id_mensaje TEXT;`);
}
// C-04 (parcial, sin credenciales reales de InPart): "actualizado_en" del pedido cambia con CUALQUIER
// edición (precio, cotización, etc.), no solo cuando cambia el estatus de Inpart -- así que no servía
// para responder "¿cuándo se actualizó por última vez el estatus de Inpart?". Esta columna solo se
// toca cuando estatus_inpart específicamente cambia.
if(!tieneColumna('pedidos', 'estatus_inpart_actualizado_en')){
  db.exec(`ALTER TABLE pedidos ADD COLUMN estatus_inpart_actualizado_en TEXT;`);
}
// Proceso_Completo_Servicio_Cristian.docx (sección 7): "solicitud de complemento" por piezas NO
// autorizadas en la evaluación inicial es un evento distinto al complemento por daño oculto que ya
// existía (tabla 15) -- ocurre antes de producción, con un plazo corto (~24h) para reautorizar con
// fotos editadas. Se reutiliza la misma tabla "complementos" (misma estructura: causa, archivo,
// decisión, estado) distinguiendo el tipo, en vez de crear una tabla paralela.
if(!tieneColumna('complementos', 'tipo')){
  db.exec(`ALTER TABLE complementos ADD COLUMN tipo TEXT NOT NULL DEFAULT 'dano_oculto' CHECK(tipo IN ('dano_oculto','no_autorizado_inicial'));`);
}
if(!tieneColumna('complementos', 'fecha_limite')){
  db.exec(`ALTER TABLE complementos ADD COLUMN fecha_limite TEXT;`);
}
// Proceso_Completo_Servicio_Cristian.docx (sección 5): ya existía valuacion_fecha_envio (cuándo Roberto
// mandó los datos al centro de evaluación remoto) pero no había forma de registrar cuándo REGRESÓ ya
// autorizada -- el documento lo describe como un paso propio ("de ahí regresa una evaluación autorizada").
if(!tieneColumna('siniestros', 'valuacion_fecha_respuesta')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN valuacion_fecha_respuesta TEXT;`);
}
// Sección 2: grupo de WhatsApp de admisión -- sin credenciales de WhatsApp Business API no se puede
// crear el grupo ni mandar el mensaje solo; se deja registrado si ya se creó, para que quede visible
// en el checklist de admisión igual que las otras casillas de ese grupo.
if(!tieneColumna('siniestros', 'grupo_whatsapp_creado')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN grupo_whatsapp_creado INTEGER;`);
}

// Roberto explicó (28-ago-2026) cinco momentos propios que hoy vive solo en correo/Excel y que quiere
// ver reflejados en el tablero: cuándo un expediente queda listo para valuar (para medir su propio
// tiempo de respuesta), cuándo avisó que ya está autorizado pero sin proveedor, y cuándo soltó el
// expediente completo al equipo (con proveedor ya asignado). Todo aditivo, mismo patrón que las demás
// "fecha_x" que se sellan solas la primera vez.
if(!tieneColumna('siniestros', 'expediente_listo_fecha')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN expediente_listo_fecha TEXT;`);
}
if(!tieneColumna('siniestros', 'proveedores_aviso_pendiente_en')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN proveedores_aviso_pendiente_en TEXT;`);
}
if(!tieneColumna('siniestros', 'expediente_completo_enviado_en')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN expediente_completo_enviado_en TEXT;`);
}
// Para medir "cuánto tardó Orlando en resolver el complemento": se sella la primera vez que la
// decisión deja de ser 'pendiente' (igual que fecha_borrador_captura y similares).
if(!tieneColumna('complementos', 'decision_en')){
  db.exec(`ALTER TABLE complementos ADD COLUMN decision_en TEXT;`);
}

// MODIFICACIONES DE TABLERO ALEJANDRA (28-ago-2026): tipo de reparación lo captura Orlando durante su
// revisión técnica (no Alejandra en el alta), con 6 valores fijos del taller.
if(!tieneColumna('siniestros', 'tipo_reparacion')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN tipo_reparacion TEXT CHECK(tipo_reparacion IS NULL OR tipo_reparacion IN ('TRADICIONAL','EXPRES','AUTO_SURTIDO','BDEO','PDD','CE'));`);
}
// Cliente particular (sin aseguradora): al marcarlo, el frontend fija aseguradora='Particular' y
// deshabilita número de siniestro / orden de admisión (no aplican sin aseguradora de por medio).
if(!tieneColumna('siniestros', 'es_particular')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN es_particular INTEGER DEFAULT 0;`);
}
// Roberto aclaró (28-ago-2026): "cubre_deducible" (arriba) y este campo NO son lo mismo. Son dos
// preguntas en dos momentos distintos: al alta (Alejandra) se pregunta si el deducible APLICA o no,
// solo para que el equipo lo sepa desde el inicio; en la entrega se pregunta si YA QUEDÓ VALIDADO
// con la aseguradora y en firme (eso sigue siendo cubre_deducible, sin tocar). NULL = sin definir.
if(!tieneColumna('siniestros', 'deducible_aplica')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN deducible_aplica INTEGER;`);
}

/* ===================== Flujo de reparación (31-ago-2026), puntos 3 y 6 autorizados por Roberto =====================
   Punto 6: "los de GNP que se quedan en piso siempre tienen una fecha de entrega establecida por el
   supervisor de la misma compañía que se debe cumplir sí o sí" -- se marca explícitamente como compromiso
   obligatorio; una vez marcada, solo admin/jefe (Roberto) puede volver a mover esa fecha. */
if(!tieneColumna('siniestros', 'entrega_compromiso_gnp')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN entrega_compromiso_gnp INTEGER NOT NULL DEFAULT 0;`);
}
if(!tieneColumna('siniestros', 'entrega_compromiso_establecido_en')){
  db.exec(`ALTER TABLE siniestros ADD COLUMN entrega_compromiso_establecido_en TEXT;`);
}

/* ===================== Fotos obligatorias por etapa de producción (2-sep-2026, pedido de Roberto) =====================
   Las aseguradoras piden fotos del proceso de reparación para pagar las facturas, y muchas veces faltan
   porque no se tomaron durante la etapa correspondiente -- el taller termina reconstruyendo/editando algo
   al final, lo que retrasa el pago. Roberto pidió bloqueo duro: no se puede marcar una operación de
   producción (ot_operaciones) como 'terminado' sin al menos una foto real ligada a esa etapa concreta.
   Columna aditiva y nullable: no afecta ningún archivo ya subido (quedan con ot_operacion_id = NULL, tal
   como estaban, ligados solo a entidad_tipo='siniestro'). */
if(!tieneColumna('archivos', 'ot_operacion_id')){
  db.exec(`ALTER TABLE archivos ADD COLUMN ot_operacion_id INTEGER REFERENCES ot_operaciones(id);`);
}


/* ===================== WhatsApp Fase A -- modo "solo registro" (3-sep-2026, autorizado por Roberto) =====================
   Autorización explícita de Roberto: SOLO detectar y registrar internamente qué plantilla de WhatsApp
   se habría disparado, con qué expediente, fecha, hora, motivo y variables -- SIN enviar ningún mensaje
   real, SIN conectar con el número real, SIN tocar el módulo de Daniela ni exponer nada nuevo a ningún
   rol en producción. Ver server/whatsappFaseA.js para la lógica de detección/deduplicación/horario/bloqueo.
   Tabla aditiva, nueva, sin relación con ninguna tabla usada por Daniela. */
db.exec(`
CREATE TABLE IF NOT EXISTS whatsapp_eventos_registrados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siniestro_id INTEGER NOT NULL REFERENCES siniestros(id),
  plantilla_codigo TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'registrado' CHECK(estado IN ('registrado','bloqueado')),
  motivo_bloqueo TEXT,
  disparador TEXT,
  variables_json TEXT,
  programado_para TEXT,
  dedup_key TEXT NOT NULL DEFAULT '',
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(siniestro_id, plantilla_codigo, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_eventos_siniestro ON whatsapp_eventos_registrados(siniestro_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_eventos_plantilla ON whatsapp_eventos_registrados(plantilla_codigo);
`);

module.exports = db;


