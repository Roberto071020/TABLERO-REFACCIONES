// Service worker mínimo (5-nov-2026; avisos push agregados el 11-nov-2026, ver abajo): permite que el celular instale el tablero como aplicación
// (pantalla completa, con su ícono). NO guarda nada en caché: todas las peticiones van directo al
// servidor, para que nunca se muestre una versión vieja del tablero (problema ya visto el 2-sep-2026).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* sin caché: el navegador hace la petición normal */ });

// Avisos push (11-nov-2026). Roberto: "para que al tener algo por hacer en automático le avise" (Orlando).
// El servidor manda {titulo, cuerpo, tag, url}; al tocar el aviso se abre (o se enfoca) el tablero.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch(_) { d = { cuerpo: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'SC Control', {
    body: d.cuerpo || '', icon: '/img/icono-192.png', badge: '/img/icono-192.png',
    tag: d.tag || 'sc', renotify: true, data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for(const w of ws){ if('focus' in w) return w.focus().then(f => f && f.navigate ? f.navigate(url).catch(() => f) : f); }
    return self.clients.openWindow(url);
  }));
});
