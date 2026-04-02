self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* Riceve messaggi dalla pagina per pianificare notifiche */
self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'SCHEDULE_NOTIFICATION') return;
  const { title, body, delay, tag } = event.data;
  if (delay <= 0) return;
  setTimeout(() => {
    self.registration.showNotification(title, {
      body,
      icon:  '/logo.png',
      badge: '/logo.png',
      tag,
      renotify: false,
    });
  }, delay);
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/');
    })
  );
});
