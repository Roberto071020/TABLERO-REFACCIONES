// ===================== Prueba ligera y obligatoria: apertura SÍNCRONA de la pestaña de WhatsApp Web ====
// Corrección de Roberto (revisión independiente, 14-sep-2026, punto 2 -- y su comentario de portabilidad,
// segunda revisión): "window.open() se ejecuta después de un await... Agrega una prueba visual o de
// navegador que confirme que realmente se creó la pestaña" y, después, "mantener una prueba automatizada
// ligera que compruebe que window.open('', '_blank') ocurre sincrónicamente antes de cualquier await".
//
// A diferencia de whatsapp-bandeja-manual-visual.test.js (que usa un navegador Chromium/Chrome REAL y es
// opcional -- se omite limpiamente si no hay uno disponible en el sistema, p. ej. en Windows sin un
// binario compatible), ESTA prueba NUNCA depende de un navegador: carga public/app.js en un sandbox de
// Node (node:vm) con un DOM mínimo simulado, y comprueba directamente, a nivel de código, que
// enviarPorWhatsappBandeja() llama a window.open('', '_blank') de forma SÍNCRONA -- antes de que se
// dispare siquiera la petición de red del reclamo, no digamos antes de que esta responda. Corre siempre,
// en cualquier sistema operativo, como parte normal de "npm test" -- es la que hace que la corrección del
// punto 2 sea estructuralmente imposible de romper sin que la suite normal lo note, sin exigirle a nadie
// tener un navegador instalado para validarlo.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const APP_JS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Elemento de DOM falso, mínimo: soporta las pocas operaciones que tocan funciones ajenas a la que se
// está probando (el IIFE de arranque al final de app.js, showModal, etc.) sin lanzar excepciones.
function crearElementoFalso(){
  const el = {
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    style: {},
    dataset: {},
    addEventListener(){},
    removeEventListener(){},
    appendChild(child){ return child; },
    setAttribute(){},
    getAttribute(){ return null; },
    querySelector(){ return crearElementoFalso(); },
    querySelectorAll(){ return []; },
    focus(){},
    click(){},
    remove(){},
  };
  el.innerHTML = '';
  el.textContent = '';
  el.value = '';
  return el;
}

// Arma un sandbox nuevo (aislado) por prueba: contexto de vm con window/document/fetch simulados, y
// carga app.js completo dentro -- exactamente el mismo archivo que sirve el servidor real, sin copiar ni
// reescribir su lógica.
function crearSandbox({ fetchImpl }){
  const eventos = [];

  function crearPestanaFalsa(){
    return { location: { href: '' }, closed: false, close(){ this.closed = true; } };
  }
  const pestanasAbiertas = [];

  const fakeWindow = {
    open(url, target){
      eventos.push({ tipo: 'window.open', url, target });
      const tab = crearPestanaFalsa();
      pestanasAbiertas.push(tab);
      return tab;
    },
  };
  const fakeDocument = {
    getElementById(){ return crearElementoFalso(); },
    querySelector(){ return crearElementoFalso(); },
    querySelectorAll(){ return []; },
    createElement(){ return crearElementoFalso(); },
    addEventListener(){},
    body: crearElementoFalso(),
  };

  function fetchQueRegistra(url, opts){
    eventos.push({ tipo: 'fetch', url: String(url), method: (opts && opts.method) || 'GET' });
    return fetchImpl(url, opts);
  }

  const context = vm.createContext({
    window: fakeWindow,
    document: fakeDocument,
    fetch: fetchQueRegistra,
    open: fakeWindow.open, // por si algo lo referencia como global implícita, no como window.open.
    navigator: { clipboard: { writeText: async () => {} } },
    location: { href: '', reload(){} },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    encodeURIComponent, decodeURIComponent,
    Date, Promise, JSON,
  });
  context.globalThis = context;

  vm.runInContext(APP_JS_SRC, context, { filename: 'app.js (sandbox de prueba)' });

  // app.js arranca con un IIFE (init()) que, al cargar el script, ya dispara GET /api/auth/me de forma
  // síncrona (hasta su propio await interno) -- eso es ajeno a lo que esta prueba mide. Se limpia aquí
  // para que `eventos` solo refleje lo que ocurre a partir de la llamada explícita de cada prueba.
  eventos.length = 0;

  return { context, eventos, pestanasAbiertas, fakeWindow };
}

test('WB-POPUP-SYNC: enviarPorWhatsappBandeja() llama a window.open(\'\', \'_blank\') de forma SÍNCRONA -- antes de que se dispare la petición de red del reclamo', () => {
  // El fetch del reclamo NUNCA se resuelve dentro de esta prueba (deferred sin resolver) -- así, la única
  // forma de que 'window.open' aparezca en `eventos` es que haya ocurrido de verdad antes de cualquier
  // pausa asíncrona real, no como casualidad de un mock rápido.
  let sigueSinResolver = true;
  const deferred = new Promise(() => { /* nunca se resuelve durante esta prueba, a propósito */ });
  const { context, eventos } = crearSandbox({
    fetchImpl: (url) => {
      assert.ok(sigueSinResolver, 'no debería llamarse fetch después de que la prueba ya leyó `eventos`');
      return deferred;
    },
  });

  assert.equal(typeof context.enviarPorWhatsappBandeja, 'function', 'la función debe existir tal cual en app.js, sin reescribirla para la prueba');

  // Llamada SIN await, a propósito: se inspecciona `eventos` en la siguiente línea, en el mismo tick.
  context.enviarPorWhatsappBandeja(1);
  sigueSinResolver = false;

  assert.equal(eventos.length >= 1, true, 'debe haber ocurrido al menos un evento de inmediato (sin esperar ninguna respuesta de red)');
  assert.equal(eventos[0].tipo, 'window.open', 'window.open() debe ser el PRIMER evento -- antes que la propia petición de red del reclamo (si esto falla, window.open() volvió a ejecutarse después de un await, el bug original del punto 2)');
  assert.equal(eventos[0].url, '', 'debe abrir una pestaña en blanco primero (sin URL todavía) -- la navegación real ocurre después, ya con el enlace confirmado');
  assert.equal(eventos[0].target, '_blank');

  const hayFetchReclamo = eventos.some(e => e.tipo === 'fetch' && e.url.includes('/reclamar'));
  assert.ok(hayFetchReclamo, 'la petición de reclamo sí debe dispararse (de forma síncrona también, justo después de abrir la pestaña) -- solo no se ha resuelto todavía');
});

test('WB-POPUP-SYNC: una vez que el reclamo responde, la MISMA pestaña se navega al enlace (no se abre una segunda)', async () => {
  let resolverReclamo;
  const reclamoPendiente = new Promise(resolve => { resolverReclamo = resolve; });
  const { context, eventos, pestanasAbiertas } = crearSandbox({
    fetchImpl: (url) => {
      if (String(url).includes('/reclamar')) {
        return reclamoPendiente.then(() => ({
          status: 200, ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ id: 1, siniestro_numero: 'DEMO-1', plantilla_codigo: '5.1', telefono: '5215500000000', texto: 'texto de prueba', link: 'https://web.whatsapp.com/send?phone=5215500000000&text=hola', reserva_minutos: 10 }),
        }));
      }
      return Promise.reject(new Error('no simulado: ' + url));
    },
  });

  context.enviarPorWhatsappBandeja(1);
  assert.equal(pestanasAbiertas.length, 1, 'debe haberse creado exactamente una pestaña en el clic');
  assert.equal(pestanasAbiertas[0].location.href, '', 'todavía no debe tener destino -- el reclamo no ha respondido');

  resolverReclamo();
  // deja correr las promesas encoladas (el then() de reclamoPendiente, y los await internos de la app).
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  assert.equal(pestanasAbiertas.length, 1, 'sigue siendo la MISMA pestaña -- nunca se abre una segunda');
  assert.equal(pestanasAbiertas[0].location.href, 'https://web.whatsapp.com/send?phone=5215500000000&text=hola', 'la pestaña ya abierta debe navegarse al enlace directo oficial de WhatsApp Web');
  assert.equal(eventos.filter(e => e.tipo === 'window.open').length, 1, 'window.open solo debe llamarse una vez en todo el flujo');
});

test('WB-POPUP-SYNC: si el reclamo falla (ya no está disponible / ya no es vigente), la pestaña abierta se cierra sola', async () => {
  let rechazarReclamo;
  const reclamoPendiente = new Promise((resolve, reject) => { rechazarReclamo = reject; });
  const { context, pestanasAbiertas } = crearSandbox({
    fetchImpl: (url) => {
      if (String(url).includes('/reclamar')) {
        return reclamoPendiente.catch(() => ({
          status: 409, ok: false,
          headers: { get: () => 'application/json' },
          json: async () => ({ error: 'Este mensaje ya no está disponible.' }),
        }));
      }
      return Promise.reject(new Error('no simulado: ' + url));
    },
  });

  context.enviarPorWhatsappBandeja(1);
  assert.equal(pestanasAbiertas.length, 1);
  assert.equal(pestanasAbiertas[0].closed, false);

  rechazarReclamo(new Error('simulado'));
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  assert.equal(pestanasAbiertas[0].closed, true, 'la pestaña en blanco debe cerrarse sola si el reclamo termina fallando -- nunca se le deja abierta sin destino');
});
