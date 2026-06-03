const CACHE_NAME = 'vc-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const opts = {
    body: data.messaggio || '',
    icon: '/images/logo.png',
    badge: '/images/logo.png',
    data: { url: data.url || '/' },
    lang: 'it',
  };
  if (data.image) opts.image = data.image;
  e.waitUntil(self.registration.showNotification(data.titolo || 'Virtus Caserta', opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || '/'));
});
