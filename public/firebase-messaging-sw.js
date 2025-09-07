/* public/firebase-messaging-sw.js */
/* v1 */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Use real values (same as your client app)
firebase.initializeApp({
  apiKey: "AIzaSyBNCJcAtvkcjGXDonftIIS7mJ8rywAijT8",
  authDomain: "life-signal-ai-9caf4.firebaseapp.com",
  projectId: "life-signal-ai-9caf4",
  storageBucket: "life-signal-ai-9caf4.appspot.com",
  messagingSenderId: "1021508781728",
  appId: "1:1021508781728:web:ec0a2e771d0ff633ff6bc5",
});

// Take over immediately so the page is controlled after next load
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const messaging = firebase.messaging();

/**
 * FCM background handler (mostly for data-only messages).
 * If your payload includes a top-level `notification`, most browsers
 * will auto-display and this may not run—that’s normal.
 */
messaging.onBackgroundMessage((payload = {}) => {
  const n = payload.notification || {};
  const d = payload.data || {};

  const title = n.title || d.title || 'New Notification';
  const options = {
    body: n.body || d.body || '',
    icon: '/icon-192x192.png',     // make sure this file exists in /public
    data: { url: d.url || '/', ...d },
  };

  self.registration.showNotification(title, options);
});

/**
 * Fallback for generic Web Push or unusual payloads.
 * Ensures a notification still shows even if the compat handler doesn't fire.
 */
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data?.json?.() || {}; } catch {}
  // Browser will auto-display top-level notification payloads.
  if (p.notification) return;

  const d = p.data || {};
  const title = d.title || 'Notification';
  const options = { body: d.body || '', icon: '/icon-192x192.png', data: { url: d.url || '/' } };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an existing tab with the same path, or open a new one
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const targetPath = new URL(urlToOpen, self.location.origin).pathname;

    for (const c of all) {
      try {
        if (new URL(c.url).pathname === targetPath) return c.focus();
      } catch {}
    }
    return clients.openWindow(urlToOpen);
  })());
});
