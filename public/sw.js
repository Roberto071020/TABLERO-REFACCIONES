// Service worker mínimo (5-nov-2026): solo permite que el celular instale el tablero como aplicación
// (pantalla completa, con su ícono). NO guarda nada en caché: todas las peticiones van directo al
// servidor, para que nunca se muestre una versión vieja del tablero (problema ya visto el 2-sep-2026).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* sin caché: el navegador hace la petición normal */ });
