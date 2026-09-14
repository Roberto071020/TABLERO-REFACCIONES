// ===================== Prueba visual/de navegador (OPCIONAL): apertura SÍNCRONA de la pestaña =========
// Corrección de Roberto (revisión independiente, 14-sep-2026, punto 2): "window.open() se ejecuta después
// de un await... Agrega una prueba visual o de navegador que confirme que realmente se creó la pestaña."
//
// Segunda corrección de Roberto (revisión del bundle v2, portabilidad): en Windows, @sparticuz/chromium
// (binario Linux empaquetado) falla al arrancar -- ENOENT al intentar ejecutar un binario que no corre en
// ese sistema operativo. Esta prueba NUNCA debe ser obligatoria para correr la suite normal ni para
// desplegar SC Control: puppeteer-core y @sparticuz/chromium son devDependencies (nunca se instalan en un
// despliegue de producción -- ver package.json), y esta prueba misma detecta en tiempo de ejecución si hay
// un navegador Chromium/Chrome REALMENTE utilizable (ruta explícita por variable de entorno, o el binario
// que trae @sparticuz/chromium SI arranca de verdad en este sistema operativo) y, si no lo hay, se OMITE
// limpiamente (t.skip) -- nunca falla la suite por esto. La verificación ligera y multiplataforma de la
// misma corrección (que window.open() ocurre de forma síncrona) vive aparte, sin necesidad de navegador
// real, en whatsapp-bandeja-manual-popup-sync.test.js -- ESA sí es obligatoria y corre siempre.
//
// Para forzar el uso de un navegador específico (por ejemplo, un Chrome/Edge real instalado en Windows),
// define la variable de entorno PUPPETEER_EXECUTABLE_PATH con la ruta al ejecutable antes de "npm test".
//
// Cuando SÍ hay navegador disponible, la prueba corre un Chromium/Chrome real (headless), inicia sesión de
// verdad en la pantalla de login, crea un expediente con teléfono válido (así el motor de detección genera
// un 5.1 accionable), entra a la pantalla "WhatsApp" y hace clic real (evento de mouse sintético, no una
// llamada de JS a .click()) en el botón "Enviar por WhatsApp". Intercepta la petición POST /reclamar y
// RETRASA su respuesta a propósito varios cientos de milisegundos -- si abrirPorWhatsappBandeja() todavía
// llamara a window.open() DESPUÉS de ese await (el bug original), la pestaña nueva aparecería recién
// cuando el servidor responde. Con la corrección, la pestaña debe aparecer de inmediato.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-whatsapp-bandeja-manual-visual.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.TEST_DB_PATH = TEST_DB;

const app = require('../server/index');
const db = require('../server/db');
const activacion = require('../server/whatsappFaseAActivacion');

const PORT = 3997;
const BASE = 'http://localhost:' + PORT;
let server;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(PORT, resolve); });
  activacion.establecerConfig(db, 'activo', '1');
  activacion.establecerConfig(db, 'piloto_todos', '1');
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

// Intenta encontrar un navegador REALMENTE utilizable en esta máquina, en este orden:
//   1) PUPPETEER_EXECUTABLE_PATH / CHROMIUM_EXECUTABLE_PATH (ruta explícita, cualquier sistema operativo).
//   2) El binario que trae @sparticuz/chromium, SOLO si además de existir en disco logra arrancar de
//      verdad (un lanzamiento de prueba, cerrado enseguida) -- en Windows este binario es Linux-only y
//      falla (ENOENT), así que ahí este paso nunca "pasa".
// Nunca lanza: cualquier error en el camino se captura y se traduce en "no disponible" -- la prueba que
// llama a esto decide entonces omitirse limpiamente, nunca fallar por esto.
async function obtenerNavegadorDisponible(){
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch (e) { return { disponible: false, motivo: 'puppeteer-core no está instalado (es una devDependency opcional; no se instala en producción).' }; }

  const rutaExplicita = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
  const candidatos = [];
  if (rutaExplicita) candidatos.push({ executablePath: rutaExplicita, args: [], headless: true, origen: 'ruta explícita (' + rutaExplicita + ')' });

  try {
    const chromium = require('@sparticuz/chromium').default;
    const executablePath = await chromium.executablePath();
    candidatos.push({ executablePath, args: chromium.args, headless: chromium.headless, origen: '@sparticuz/chromium' });
  } catch (e) { /* no disponible en este sistema operativo -- se sigue sin este candidato. */ }

  for (const candidato of candidatos) {
    try {
      if (!fs.existsSync(candidato.executablePath)) continue; // p. ej. Windows: el binario Linux nunca llega a extraerse -- ENOENT.
      const browserPrueba = await puppeteer.launch({ executablePath: candidato.executablePath, args: candidato.args, headless: candidato.headless });
      await browserPrueba.close();
      return { disponible: true, puppeteer, executablePath: candidato.executablePath, args: candidato.args, headless: candidato.headless, origen: candidato.origen };
    } catch (e) { /* este candidato no arrancó de verdad en este sistema operativo -- se prueba el siguiente. */ }
  }
  return { disponible: false, motivo: 'no se encontró ningún navegador Chromium/Chrome que arranque en este sistema operativo (define PUPPETEER_EXECUTABLE_PATH para forzar uno específico).' };
}

test('WB-VISUAL (opcional): en un navegador real, la pestaña de WhatsApp Web se crea de inmediato al hacer clic -- ANTES de que el servidor responda al reclamo (nunca depende de un await previo)', async (t) => {
  const nav = await obtenerNavegadorDisponible();
  if (!nav.disponible) {
    t.skip('Sin navegador Chromium/Chrome utilizable en este sistema (' + nav.motivo + '). La verificación equivalente, sin necesidad de navegador, está en whatsapp-bandeja-manual-popup-sync.test.js (esa SÍ es obligatoria).');
    return;
  }
  const { puppeteer, executablePath, args, headless } = nav;
  const browser = await puppeteer.launch({ executablePath, args, headless });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // ----- 1) Login real de Alejandra (atencion_cliente) por la pantalla de login -----
    await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#loginEmail', { timeout: 15000 });
    await page.type('#loginEmail', 'alejandra@serviciocristian.mx');
    await page.type('#loginPass', 'ServicioCristian2026!');
    await page.click('.login-card button.btn');
    await page.waitForSelector('#userChip', { timeout: 15000 });

    // ----- 2) Crear, vía la sesión ya autenticada del propio navegador, un expediente con teléfono válido
    // (la API de creación de siniestros ya está probada en el resto de la suite -- aquí solo se usa como
    // preparación para tener algo que reclamar en pantalla). -----
    const creado = await page.evaluate(async () => {
      const res = await fetch('/api/siniestros', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numero: 'WBVISUAL1', aseguradora: 'GNP', cliente_nombre: 'Cliente Visual', vehiculo: 'Nissan Versa 2022',
          cliente_correo: 'wbvisual1@test.mx', cliente_telefono: '5519998877', ingreso_tipo: 'grua',
        }),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    });
    assert.equal(creado.status, 201, 'debe crearse el expediente de prueba: ' + JSON.stringify(creado.data));

    // ----- 3) Ir a la pantalla "WhatsApp" (misma SPA, sin recargar) -----
    await page.evaluate(() => { goTo('whatsapp'); });
    await page.waitForFunction(
      () => document.body.innerText.includes('Enviar por WhatsApp'),
      { timeout: 15000 }
    );

    // ----- 4) Interceptar la petición de reclamo y retrasar su respuesta a propósito -----
    const RETRASO_MS = 1500;
    await page.setRequestInterception(true);
    let interceptado = false;
    page.on('request', (req) => {
      if (!interceptado && req.method() === 'POST' && req.url().includes('/api/whatsapp-manual/envios/') && req.url().endsWith('/reclamar')) {
        interceptado = true;
        setTimeout(() => { req.continue().catch(() => {}); }, RETRASO_MS);
      } else {
        req.continue().catch(() => {});
      }
    });

    // ----- 5) Clic real (sintético de Chromium, con coordenadas -- cuenta como gesto de usuario) sobre el
    // botón "Enviar por WhatsApp", y medir cuándo aparece la pestaña nueva. -----
    const paginasAntes = await browser.pages();
    const inicioClic = Date.now();
    const [boton] = await page.$$('xpath/.//button[contains(text(),"Enviar por WhatsApp")]');
    assert.ok(boton, 'debe existir el botón "Enviar por WhatsApp" en la lista de Pendientes');
    await boton.click();

    let nuevaPagina = null;
    let tiempoDeteccion = null;
    for (let i = 0; i < 40 && !nuevaPagina; i++) {
      const paginas = await browser.pages();
      nuevaPagina = paginas.find(p => !paginasAntes.includes(p));
      if (nuevaPagina) { tiempoDeteccion = Date.now(); break; }
      await new Promise(r => setTimeout(r, 25));
    }

    assert.ok(nuevaPagina, 'debe haberse creado una pestaña nueva del navegador al hacer clic en "Enviar por WhatsApp"');
    const transcurrido = tiempoDeteccion - inicioClic;
    assert.ok(
      transcurrido < RETRASO_MS - 300,
      `la pestaña debe crearse de inmediato (síncrona con el clic), mucho antes de que el servidor responda -- tardó ${transcurrido}ms en aparecer, pero el servidor tardó a propósito ${RETRASO_MS}ms en contestar (si esto falla, window.open() volvió a ejecutarse después de un await)`
    );

    // ----- 6) Verificar que, ya con la respuesta del servidor (retrasada) resuelta, esa MISMA pestaña
    // termina navegada al enlace directo oficial de WhatsApp Web (no a una pestaña en blanco huérfana). -----
    await new Promise(resolve => {
      const check = async () => {
        try {
          const url = nuevaPagina.url();
          if (url.startsWith('https://web.whatsapp.com/send')) return resolve();
        } catch (e) { /* la página pudo no estar lista aún */ }
        setTimeout(check, 100);
      };
      check();
    });
    assert.match(nuevaPagina.url(), /^https:\/\/web\.whatsapp\.com\/send\?phone=52/, 'la pestaña debe terminar navegada al enlace directo oficial de WhatsApp Web, con el teléfono correcto');

    // ----- 7) Limpieza: confirmar "No" para no dejar el mensaje reservado colgado en la BD de prueba. -----
    await page.bringToFront();
    await page.evaluate(async () => {
      const r = await fetch('/api/whatsapp-manual/pendientes');
      // ya no estará en pendientes (quedó reservado) -- solo se documenta el estado final, sin fallar la prueba por esto.
      return r.status;
    });
  } finally {
    await browser.close();
  }
});
