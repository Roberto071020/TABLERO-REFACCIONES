# Tablero de Seguimiento de Refacciones — Servicio Cristian

Aplicación web con base de datos real (backend + frontend), construida a partir de:
- La especificación funcional original (`Especificacion_Tablero_Seguimiento_Refacciones.docx`).
- El reporte de pruebas de Daniela Sosa (`Reporte_Pruebas_Tablero_Refacciones.docx`), que encontró 23 fallas sobre
  el primer MVP (solo-navegador). Esta versión corrige las fallas críticas y altas del reporte.

## Qué cambió respecto al MVP anterior

El MVP anterior era un solo archivo HTML que guardaba todo en el navegador (localStorage). Esta versión es una
aplicación cliente-servidor real:

- **Base de datos SQLite** (archivo `data/tablero.db`) con las tablas de siniestros, pedidos, piezas, proveedores,
  incidencias, comunicaciones, archivos, auditoría y usuarios — portátil a Postgres si el volumen crece.
- **Backend Node/Express** con autenticación por sesión (login real, roles operativo/jefe/consulta/admin).
- **Corrección de las 12 fallas críticas y altas** del reporte de Daniela (ver tabla abajo).
- **Pruebas automatizadas reales** (`tests/api.test.js`, 16 pruebas) que ejecutan el flujo exacto del caso real
  (siniestro 4264105314000171 / pedido 337196 / espejo incorrecto) y fallan de verdad si una regla se rompe.

### Correcciones incluidas (numeración del reporte de Daniela)

| Falla | Corrección implementada |
|---|---|
| F-01 Crítica | Alta real de piezas desde la ficha del siniestro. |
| F-02 Crítica | Alta de incidencias (incorrecta/dañada/incompleta/devolución/cancelación/fecha incumplida) sin marcar la pieza como recibida. |
| F-03 Crítica | El Kanban tiene columna para los 10 estatus — ningún pedido desaparece. Además hay una pestaña "Incidencias" dedicada. |
| F-04 Alta | Se eliminaron `alert`/`confirm`/`prompt` nativos; se reemplazaron por toasts y modales propios de la interfaz. |
| F-05 Alta | La Lista maestra parte de los pedidos, no de las piezas: un pedido sin piezas capturadas se sigue viendo. |
| F-06 Alta | Edición real de siniestros, pedidos y piezas, con bitácora de valor anterior/nuevo. |
| F-08 Alta | Persistencia en base de datos real del lado del servidor, no en el navegador. |
| F-09 Alta | Los casos de aceptación ahora son pruebas automatizadas reales (`npm test`), no un panel con `pass:true` fijo. |
| F-10 Alta | "Marcar recibida" queda ligado al usuario que inició sesión, no a un texto libre. |
| F-11 Alta | Una pieza con incidencia abierta no puede marcarse como recibida hasta resolver la incidencia con una resolución explícita. |
| F-12 Alta | Se puede registrar la respuesta real de un proveedor a un correo. |
| F-14 Media | Se eliminó el bloqueo permanente de correos por proveedor; solo existen exclusiones temporales por envío con motivo (regla R-07). |
| F-15 Media | Cada comunicación queda ligada al `proveedor_id` correcto, sin cruces cuando un pedido tiene varios proveedores. |
| F-16 / F-17 Media | La exportación CSV respeta todos los filtros visibles (incluida la búsqueda de texto) y neutraliza fórmulas/inyección CSV. |
| F-18 Media | Fechas guardadas en UTC, listas para mostrarse en horario de México (`server/utils.js`). |
| F-19 Media | Los archivos se suben y guardan de verdad en disco (`uploads/`), con metadatos en base de datos. |
| F-20 Media | La búsqueda global muestra una lista de resultados agrupados, no abre automáticamente la primera coincidencia. |
| F-21 Media | Todo el texto capturado por el usuario se escapa antes de insertarse en HTML (función `esc()` en `public/app.js`). |
| F-22 Media | Bitácora de solo lectura (sin rutas de edición/borrado), con entidad, campo, valor anterior/nuevo y usuario. |
| F-23 Baja | Un siniestro con datos genéricos/incompletos se marca "Pendiente de completar" en vez de aceptarse silenciosamente. |

### Lo que queda pendiente (requiere decisiones o credenciales de Roberto/Daniela)

- **F-07 / Fase 3 y 5:** Integración real con Gmail (OAuth) e InPart. Necesitan credenciales oficiales que ustedes
  deben tramitar; el sistema queda preparado para conectarlas (los correos hoy quedan en modo borrador/sandbox).
- **F-13:** Las plantillas de correo ya distinguen "estatus" vs "incidencia"; se pueden afinar más tipos (retraso,
  garantía, devolución) cuando tengan ejemplos reales de cada caso.
- Notificaciones push al iPhone de Daniela (pendiente de decidir el mecanismo, sección 17 de la especificación).
- Migrar de SQLite a Postgres si el volumen de siniestros crece mucho o se necesita alta disponibilidad.

## Requisitos

- Node.js 18 o superior.

## Instalación local

```bash
npm install
npm run seed     # crea usuarios, proveedores de ejemplo y el caso real de prueba (solo la primera vez)
npm start        # http://localhost:3000
```

Usuarios creados por `npm run seed` (cambiar la contraseña en el primer ingreso, desde el candado 🔒 en la barra superior):

- **daniela@serviciocristian.mx** — rol operativo
- **admin@serviciocristian.mx** — rol admin
- Contraseña temporal para ambos: `ServicioCristian2026!`

## Pruebas automatizadas

```bash
npm test
```

Corre 16 pruebas reales contra la API (usa una base de datos aislada, `data/test.db`, no toca los datos reales).
Incluye el flujo completo del caso real de Daniela: crear el siniestro sin duplicarlo, agregar la pieza, registrar
la incidencia sin marcarla como recibida, verificar que sigue visible en Inicio/Kanban/Lista/Incidencias, generar
el borrador correcto sin enviarlo automáticamente, registrar la respuesta del proveedor, y cerrar solo después de
resolver la incidencia.

## Desplegar para que Daniela lo use desde su navegador (no un archivo local)

Cualquiera de estas opciones aloja el backend + base de datos y les da una URL fija:

1. **Railway** o **Render**: conectan este proyecto (subiéndolo a un repositorio Git), configuran la variable de
   entorno `SESSION_SECRET`, y el servicio queda con una URL pública. Ambos ofrecen un volumen persistente para
   que `data/tablero.db` y `uploads/` no se borren en cada despliegue — hay que activarlo explícitamente.
2. **Fly.io**: similar, con un volumen persistente (`fly volumes create`).

Pasos generales:

1. Subir el proyecto a un repositorio (GitHub/GitLab).
2. Crear el servicio en la plataforma elegida, apuntando a este repositorio.
3. Configurar variable de entorno `SESSION_SECRET` (una cadena larga y aleatoria — no usar la de `.env.example`).
4. Adjuntar un volumen persistente montado en `/data` (o donde corresponda) y ajustar `TEST_DB_PATH`/ruta de
   `data/tablero.db` si la plataforma requiere una ruta distinta.
5. Ejecutar `npm run seed` una sola vez contra la base de datos de producción (por consola de la plataforma).
6. Compartir la URL resultante con Daniela, junto con su usuario y la contraseña temporal — pedirle que la
   cambie en su primer ingreso.

## Respaldo de la base de datos

`data/tablero.db` es un solo archivo SQLite. Para respaldar: copiarlo periódicamente (cron, o el respaldo
automático que ofrezca la plataforma de hosting). Para restaurar: reemplazar el archivo con la copia y reiniciar
el servicio.

## Estructura del proyecto

```
server/         Backend (Express, rutas, autenticación, base de datos, utilidades)
  routes/       Un archivo por recurso (siniestros, pedidos, piezas, incidencias, proveedores, comunicaciones, archivos, auditoria, reportes)
public/         Frontend (HTML/CSS/JS, sin frameworks, habla con la API vía fetch)
tests/          Pruebas automatizadas reales (node --test)
data/           Base de datos SQLite (no se sube al repositorio)
uploads/        Archivos subidos (evidencias, valuaciones, etc.)
```
