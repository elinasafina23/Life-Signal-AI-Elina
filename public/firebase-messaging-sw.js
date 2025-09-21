/* public/firebase-messaging-sw.js */
/* v2 – routes clicks to /push-redirect so the app can auth-gate */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Your Firebase web config (ok to expose in client/SW)
firebase.initializeApp({
  apiKey: "AIzaSyBNCJcAtvkcjGXDonftIIS7mJ8rywAijT8",
  authDomain: "life-signal-ai-9caf4.firebaseapp.com",
  projectId: "life-signal-ai-9caf4",
  storageBucket: "life-signal-ai-9caf4.appspot.com",
  messagingSenderId: "1021508781728",
  appId: "1:1021508781728:web:ec0a2e771d0ff633ff6bc5",
});

// Take over as soon as possible
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const messaging = firebase.messaging();

/** Build a neutral redirect URL the app can handle. */
function buildRedirectUrl(data) {
  const type = data?.type || "";      // "missed_checkin" | "missed_checkin_emergency"
  const userId = data?.userId || "";  // the main user who missed
  const deepLink = data?.deepLink || ""; // optional future use

  const qs = new URLSearchParams();
  if (type) qs.set("type", type);
  if (userId) qs.set("userId", userId);
  if (deepLink) qs.set("deepLink", deepLink);
  return `/push-redirect?${qs.toString()}`;
}

/** Show a notification; always keep raw data so click handler can route. */
function showNoti(title, body, data) {
  return self.registration.showNotification(title || "Notification", {
    body: body || "",
    icon: "/icon-192x192.png", // make sure this exists in /public
    data: data || {},          // preserve payload.data (contains type/userId)
  });
}

/**
 * Background handler for FCM (data-only or mixed payloads).
 * If payload has a top-level notification, some browsers auto-display it.
 */
messaging.onBackgroundMessage((payload = {}) => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || "Notification";
  const body  = n.body  || d.body  || "";
  // IMPORTANT: keep the original data; we compute redirect on click.
  showNoti(title, body, d);
});

/**
 * Generic Web Push fallback (when above doesn't fire).
 */
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data?.json?.() || {}; } catch {}
  // If browser already handled a top-level notification, do nothing.
  if (p.notification) return;

  const d = p.data || {};
  const title = d.title || "Notification";
  const body  = d.body  || "";
  event.waitUntil(showNoti(title, body, d));
});

/**
 * On click: route through /push-redirect, which will:
 *  - send to /login?next=... if not authenticated
 *  - or to the correct dashboard if authenticated (based on ?type=)
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification && event.notification.data) || {};
  const url = buildRedirectUrl(data);

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If there’s already any client from our origin, navigate it to the redirect and focus.
    for (const c of all) {
      try {
        if ('navigate' in c) {
          await c.navigate(url);
          if ('focus' in c) return c.focus();
          return;
        }
      } catch (_) {}
    }
    // Otherwise open a new tab
    return clients.openWindow(url);
  })());
});
