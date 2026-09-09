// ===================== Fase 1, punto 10 PORTAL SC (Orlando, 8-sep-2026): integración con Google Drive
// ===================== =====================================================================
// Diseño confirmado por Orlando (Respuesta_Punto10_GoogleDrive.docx, 8-sep-2026):
//   1. Estructura real: Aseguradora > Mes > Siniestro (carpeta "VEHÍCULO COLOR AÑO N.SINIESTRO ESTATUS",
//      con subcarpeta FOTOS; el Excel de revisión vehicular queda al mismo nivel que FOTOS, no adentro).
//   2. Roberto necesita DESCARGAR el contenido completo de la carpeta desde el tablero, no solo ver una
//      liga o miniaturas -- por eso este archivo hace de "proxy": el token que autoriza es el de Orlando
//      (la única cuenta de Google involucrada), pero cualquiera con permiso en el tablero puede listar y
//      descargar a través del backend, sin tener su propia cuenta de Google.
//   3. Fase 1 confirmada: selector oficial de Google (Picker), alcance drive.file -- Orlando elige la
//      carpeta correcta con 2-3 clics; drive.file es "no sensible" (no exige verificación de Google ni la
//      auditoría de seguridad CASA que sí exigiría un alcance más amplio como drive.readonly). Ver el
//      documento de diseño para el detalle completo de esta decisión.
//
// TODO ESTE ARCHIVO ESTÁ ESCRITO PARA FUNCIONAR EN CUANTO EXISTAN CREDENCIALES REALES, PERO HOY NO LAS
// HAY: sin GOOGLE_DRIVE_CLIENT_ID/GOOGLE_DRIVE_CLIENT_SECRET/GOOGLE_DRIVE_API_KEY configuradas como
// variables de entorno, estaConfigurado() da false y las rutas que hablarían con Google devuelven 501 con
// un mensaje claro -- nunca simulan una respuesta falsa. Vincular una carpeta (guardar su id/nombre/liga)
// SÍ funciona hoy sin credenciales, porque esa parte no habla con la API de Google -- solo guarda lo que
// el Picker le devuelva al frontend una vez que sí esté configurado.
'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { registrarAuditoria } = require('../utils');
const router = express.Router();

// Quién puede vincular/desvincular la carpeta de un expediente: mismo grupo que "captura y envío"
// (Orlando absorbe temporalmente la captura de Vanessa, ver server/routes/siniestros.js).
const ROLES_VINCULACION = ['orlando', 'vanessa', 'admin', 'jefe'];
// Quién puede autorizar el conector (solo la cuenta real de Google, orlando.svcristian@gmail.com).
const ROLES_AUTORIZACION = ['orlando', 'admin', 'jefe'];

const GOOGLE_OAUTH_AUTORIZAR_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function estaConfigurado() {
  return !!(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET && process.env.GOOGLE_DRIVE_API_KEY);
}

function motivoNoConfigurado() {
  const faltan = [];
  if (!process.env.GOOGLE_DRIVE_CLIENT_ID) faltan.push('GOOGLE_DRIVE_CLIENT_ID');
  if (!process.env.GOOGLE_DRIVE_CLIENT_SECRET) faltan.push('GOOGLE_DRIVE_CLIENT_SECRET');
  if (!process.env.GOOGLE_DRIVE_API_KEY) faltan.push('GOOGLE_DRIVE_API_KEY');
  return `Integración de Google Drive no configurada. Falta(n) definir en el servidor: ${faltan.join(', ')}. Ver Integracion_Google_Drive_Punto10.docx (sección 6) para lo que se necesita generar en Google Cloud.`;
}

function urlRedireccionCallback(req) {
  // Se calcula a partir del host real de la petición (funciona tanto en localhost como en Render) salvo
  // que se fije GOOGLE_DRIVE_REDIRECT_URI explícitamente -- necesario si el proyecto de Google Cloud exige
  // un URI de redirección exacto y fijo, distinto del host que Express detecta.
  if (process.env.GOOGLE_DRIVE_REDIRECT_URI) return process.env.GOOGLE_DRIVE_REDIRECT_URI;
  return `${req.protocol}://${req.get('host')}/api/google-drive/oauth/callback`;
}

// Refresca el access_token si ya venció (Google los da con vida corta, ~1h) usando el refresh_token
// guardado. Lanza un error legible si nadie ha autorizado el conector todavía -- las rutas que llaman a
// esto deben responder 501 con ese mismo mensaje, nunca inventar una lista de archivos vacía como si
// estuviera "conectado pero sin archivos".
async function obtenerAccessTokenValido() {
  const fila = db.prepare('SELECT * FROM google_drive_tokens ORDER BY actualizado_en DESC LIMIT 1').get();
  if (!fila || !fila.refresh_token) {
    throw new Error('Nadie ha autorizado todavía el conector de Google Drive (falta que Orlando inicie sesión con su cuenta desde "Conectar Google Drive").');
  }
  const vigente = fila.expiry_en && new Date(fila.expiry_en).getTime() > Date.now() + 60000;
  if (vigente) return fila.access_token;

  const resp = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      refresh_token: fila.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error(`No se pudo refrescar el acceso a Google Drive (${resp.status}). ${detalle.slice(0, 300)}`);
  }
  const datos = await resp.json();
  const expiryEn = new Date(Date.now() + (datos.expires_in || 3600) * 1000).toISOString();
  db.prepare(`UPDATE google_drive_tokens SET access_token=?, expiry_en=?, actualizado_en=datetime('now') WHERE id=?`)
    .run(datos.access_token, expiryEn, fila.id);
  return datos.access_token;
}

// ===================== Estado / configuración pública (para que el frontend sepa qué mostrar) =====

// Cualquier usuario autenticado puede consultar si el conector está listo -- es lo que decide si la ficha
// del expediente muestra el botón real o el aviso de "todavía no configurado".
router.get('/estado', requireAuth, (req, res) => {
  const configurado = estaConfigurado();
  const autorizado = configurado && !!db.prepare('SELECT id FROM google_drive_tokens LIMIT 1').get();
  res.json({
    configurado,
    autorizado,
    motivo: configurado ? (autorizado ? null : 'Configurado, pero nadie ha autorizado el conector todavía.') : motivoNoConfigurado(),
  });
});

// Datos NO secretos que el frontend necesita para inicializar el selector de Google (Picker). El
// client_secret JAMÁS se expone aquí ni en ninguna otra ruta -- ese solo lo usa el backend, en el
// intercambio de código por token (ver /oauth/callback) y al refrescar (obtenerAccessTokenValido).
router.get('/config-publica', requireAuth, (req, res) => {
  if (!estaConfigurado()) return res.status(501).json({ error: motivoNoConfigurado() });
  res.json({
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID,
    apiKey: process.env.GOOGLE_DRIVE_API_KEY,
    appId: process.env.GOOGLE_DRIVE_APP_ID || '',
  });
});

// ===================== Autorización (una sola vez, la cuenta real de Orlando) =====================

router.get('/oauth/iniciar', requireAuth, requireRole(...ROLES_AUTORIZACION), (req, res) => {
  if (!estaConfigurado()) return res.status(501).json({ error: motivoNoConfigurado() });
  // El "state" liga la respuesta de Google de vuelta a esta sesión -- evita que alguien complete el flujo
  // de otra persona (protección CSRF estándar de OAuth2, mismo patrón que cualquier login social).
  const state = require('crypto').randomBytes(24).toString('hex');
  req.session.googleDriveOauthState = state;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
    redirect_uri: urlRedireccionCallback(req),
    response_type: 'code',
    scope: GOOGLE_DRIVE_SCOPE,
    access_type: 'offline', // necesario para recibir refresh_token, no solo access_token
    prompt: 'consent',
    state,
  });
  res.redirect(`${GOOGLE_OAUTH_AUTORIZAR_URL}?${params.toString()}`);
});

router.get('/oauth/callback', requireAuth, async (req, res) => {
  if (!estaConfigurado()) return res.status(501).json({ error: motivoNoConfigurado() });
  const { code, state, error: errorGoogle } = req.query;
  if (errorGoogle) return res.status(400).json({ error: `Google rechazó la autorización: ${errorGoogle}` });
  if (!state || state !== req.session.googleDriveOauthState) {
    return res.status(400).json({ error: 'La autorización no corresponde a esta sesión (state inválido). Vuelve a intentarlo desde "Conectar Google Drive".' });
  }
  delete req.session.googleDriveOauthState;
  if (!code) return res.status(400).json({ error: 'Google no envió un código de autorización.' });

  try {
    const resp = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
        client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: urlRedireccionCallback(req),
      }),
    });
    if (!resp.ok) {
      const detalle = await resp.text().catch(() => '');
      return res.status(502).json({ error: `Google rechazó el intercambio de código por token (${resp.status}). ${detalle.slice(0, 300)}` });
    }
    const datos = await resp.json();
    const expiryEn = new Date(Date.now() + (datos.expires_in || 3600) * 1000).toISOString();
    // Un solo registro global -- ver comentario en server/db.js: en la práctica, solo Orlando autoriza.
    // Si en el futuro más de una persona necesitara autorizar carpetas propias, esto tendría que volverse
    // una fila por usuario_id real en vez de "el último que autorizó gana".
    const existente = db.prepare('SELECT id FROM google_drive_tokens WHERE usuario_id = ?').get(req.session.user.id);
    if (existente) {
      db.prepare(`UPDATE google_drive_tokens SET access_token=?, refresh_token=COALESCE(?, refresh_token), expiry_en=?, scope=?, actualizado_en=datetime('now') WHERE id=?`)
        .run(datos.access_token, datos.refresh_token || null, expiryEn, datos.scope || GOOGLE_DRIVE_SCOPE, existente.id);
    } else {
      db.prepare(`INSERT INTO google_drive_tokens (usuario_id, access_token, refresh_token, expiry_en, scope) VALUES (?,?,?,?,?)`)
        .run(req.session.user.id, datos.access_token, datos.refresh_token || null, expiryEn, datos.scope || GOOGLE_DRIVE_SCOPE);
    }
    registrarAuditoria(db, { entidad_tipo: 'google_drive', entidad_id: req.session.user.id, accion: 'autorizacion', usuario: req.session.user, valor_nuevo: 'Conector de Google Drive autorizado.' });
    res.redirect('/?google_drive=autorizado');
  } catch (e) {
    res.status(502).json({ error: 'No se pudo completar la autorización con Google: ' + (e && e.message ? e.message : String(e)) });
  }
});

// ===================== Vincular / desvincular la carpeta de un expediente =====================
// Esto SÍ funciona sin credenciales reales -- solo guarda lo que el Picker le devuelva al frontend
// (id, nombre y liga de la carpeta que Orlando ya seleccionó visualmente en su Drive).

router.post('/siniestros/:id/carpeta', requireAuth, requireRole(...ROLES_VINCULACION), (req, res) => {
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Expediente no encontrado.' });
  const { carpeta_id, carpeta_nombre, carpeta_link } = req.body;
  if (!carpeta_id || !String(carpeta_id).trim()) return res.status(400).json({ error: 'Falta el identificador de la carpeta seleccionada.' });
  db.prepare(`UPDATE siniestros SET drive_carpeta_id=?, drive_carpeta_nombre=?, drive_carpeta_link=?, drive_carpeta_vinculada_en=datetime('now'), drive_carpeta_vinculada_por=? WHERE id=?`)
    .run(String(carpeta_id).trim(), carpeta_nombre || null, carpeta_link || null, req.session.user.id, s.id);
  registrarAuditoria(db, { entidad_tipo: 'siniestro', entidad_id: s.id, accion: 'vincular_drive', usuario: req.session.user, valor_nuevo: carpeta_nombre || carpeta_id });
  res.json({ ok: true });
});

router.delete('/siniestros/:id/carpeta', requireAuth, requireRole(...ROLES_VINCULACION), (req, res) => {
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Expediente no encontrado.' });
  db.prepare(`UPDATE siniestros SET drive_carpeta_id=NULL, drive_carpeta_nombre=NULL, drive_carpeta_link=NULL, drive_carpeta_vinculada_en=NULL, drive_carpeta_vinculada_por=NULL WHERE id=?`).run(s.id);
  registrarAuditoria(db, { entidad_tipo: 'siniestro', entidad_id: s.id, accion: 'desvincular_drive', usuario: req.session.user, valor_anterior: s.drive_carpeta_nombre || s.drive_carpeta_id });
  res.json({ ok: true });
});

// ===================== Listar y descargar el contenido (proxy vía backend, para Roberto) ==========

router.get('/siniestros/:id/archivos', requireAuth, async (req, res) => {
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Expediente no encontrado.' });
  if (!s.drive_carpeta_id) return res.status(404).json({ error: 'Este expediente todavía no tiene una carpeta de Google Drive vinculada.' });
  if (!estaConfigurado()) return res.status(501).json({ error: motivoNoConfigurado() });

  try {
    const token = await obtenerAccessTokenValido();
    const params = new URLSearchParams({
      q: `'${s.drive_carpeta_id}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size,webViewLink,modifiedTime)',
      pageSize: '200',
    });
    const resp = await fetch(`${GOOGLE_DRIVE_API_URL}/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const detalle = await resp.text().catch(() => '');
      return res.status(502).json({ error: `Google Drive respondió con error (${resp.status}). ${detalle.slice(0, 300)}` });
    }
    const datos = await resp.json();
    res.json(datos.files || []);
  } catch (e) {
    res.status(501).json({ error: e && e.message ? e.message : String(e) });
  }
});

router.get('/siniestros/:id/archivos/:fileId/descargar', requireAuth, async (req, res) => {
  const s = db.prepare('SELECT * FROM siniestros WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Expediente no encontrado.' });
  if (!s.drive_carpeta_id) return res.status(404).json({ error: 'Este expediente todavía no tiene una carpeta de Google Drive vinculada.' });
  if (!estaConfigurado()) return res.status(501).json({ error: motivoNoConfigurado() });

  try {
    const token = await obtenerAccessTokenValido();
    // Se confirma primero que el archivo en verdad está dentro de la carpeta vinculada de ESTE expediente
    // -- sin esto, cualquier usuario autenticado podría pedir el proxy-descarga de cualquier fileId de
    // Google Drive al que Orlando tenga acceso, con solo adivinar o ver el id en la red -- no solo lo que
    // corresponde al expediente que está viendo.
    const metaResp = await fetch(`${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(req.params.fileId)}?fields=id,name,mimeType,parents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaResp.ok) return res.status(404).json({ error: 'El archivo no existe o ya no es accesible.' });
    const meta = await metaResp.json();
    if (!meta.parents || !meta.parents.includes(s.drive_carpeta_id)) {
      return res.status(403).json({ error: 'Ese archivo no pertenece a la carpeta vinculada de este expediente.' });
    }

    const fileResp = await fetch(`${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(req.params.fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!fileResp.ok || !fileResp.body) {
      const detalle = await fileResp.text().catch(() => '');
      return res.status(502).json({ error: `No se pudo descargar el archivo desde Google Drive (${fileResp.status}). ${detalle.slice(0, 300)}` });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${(meta.name || 'archivo').replace(/"/g, '')}"`);
    if (meta.mimeType) res.setHeader('Content-Type', meta.mimeType);
    const { Readable } = require('node:stream');
    Readable.fromWeb(fileResp.body).pipe(res);
  } catch (e) {
    res.status(501).json({ error: e && e.message ? e.message : String(e) });
  }
});

module.exports = router;
