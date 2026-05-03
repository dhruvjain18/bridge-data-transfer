const CACHE_NAME = 'bridge-v1';
const ASSETS = ['/', '/index.html', '/style.css', '/script.js'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Only cache GET requests for static assets
    if (event.request.method !== 'GET') return;
    
    event.respondWith(
        fetch(event.request)
            .then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

// Push Notifications
self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : { title: 'Bridge', body: 'New notification' };
    const options = {
        body: data.body,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        data: data.url || '/'
    };
    event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(clients.openWindow(event.notification.data));
});
