// ===================== Prueba visual/de navegador: apertura SÍNCRONA de la pestaña de WhatsApp Web =====
// Corrección de Roberto (revisión independiente, 14-sep-2026, punto 2): "window.open() se ejecuta después
// de un await, por lo que Chrome puede considerarlo una ventana emergente y bloquearlo... Agrega una
// prueba visual o de navegador que confirme que realmente se creó la pestaña."
//
// Esta prueba corre un navegador Chromium REAL (headless, vía puppeteer-core + @sparticuz/chromium -- el
// binario de Chromium viaja empaquetado dentro del paquete npm, así que se instala desde el registro de
// npm, sin depender de la CDN de descargas de Google), inicia sesión de verdad en la pantalla de login,
// crea un expediente con teléfono válido (así el motor de detección genera un 5.1 accionable), entra a la
// pantalla "WhatsApp" y hace clic real (evento de mouse sintético de Chromium, no una llamada de JS a
// .click()) en el botón "Enviar por WhatsApp".
//
// La prueba intercepta la petición POST /reclamar y RETRASA su respuesta a propósito varios cientos de
// milisegundos -- si abrirPorWhatsappBandeja() todavía llamara a window.open() DESPUÉS de ese await (el
// bug original), la pestaña nueva aparecería recién cuando el servidor responde. Con la corrección, la
// pestaña debe aparecer de inmediato, mucho antes de que se cumpla el retraso artificial -- es la prueba
// directa, en un navegador real, de que la apertura es síncrona.
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

test('WB-VISUAL: en un navegador real, la pestaña de WhatsApp Web se crea de inmediato al hacer clic -- ANTES de que el servidor responda al reclamo (nunca depende de un await previo)', async (t) => {
  let puppeteer, chromium;
  try {
    puppeteer = require('puppeteer-core');
    chromium = require('@sparticuz/chromium').default;
  } catch (e) {
    t.skip('puppeteer-core / @sparticuz/chromium no están instalados (ejecuta "npm install" para incluir las devDependencies) -- se omite la verificación visual, el resto de la suite no depende de esto.');
    return;
  }

  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({ executablePath, args: chromium.args, headless: chromium.headless });
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
