/* public/firebase-messaging-sw.js */
/* v2 – service worker for Firebase Cloud Messaging (FCM)
   Handles background push messages + click redirects. */

/* Load Firebase in the service worker context (Compat build is SW-friendly). */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

/* Initialize Firebase using your web config (safe to expose). */
firebase.initializeApp({
  apiKey: "AIzaSyBNCJcAtvkcjGXDonftIIS7mJ8rywAijT8",
  authDomain: "life-signal-ai-9caf4.firebaseapp.com",
  projectId: "life-signal-ai-9caf4",
  storageBucket: "life-signal-ai-9caf4.appspot.com",
  messagingSenderId: "1021508781728",
  appId: "1:1021508781728:web:ec0a2e771d0ff633ff6bc5",
});

/* Make this SW control existing tabs immediately (no waiting). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/* Get the Messaging instance (lets us handle background push). */
const messaging = firebase.messaging();

/**
 * Build a URL inside your app that /push-redirect can understand.
 * We keep naming consistent across the stack:
 *  - type: "missed_checkin" | "missed_checkin_emergency" | future types
 *  - mainUserUid: the main user who missed a check-in / the subject user
 *  - emergencyContactUid: (optional) the contact being notified
 *  - deepLink: optional in case you want a direct in-app path
 */
function buildRedirectUrl(data) {
  const type = data?.type || "";
  const mainUserUid = data?.mainUserUid || "";
  const emergencyContactUid = data?.emergencyContactUid || "";
  const deepLink = data?.deepLink || ""; // optional future use

  const qs = new URLSearchParams();
  if (type) qs.set("type", type);
  if (mainUserUid) qs.set("mainUserUid", mainUserUid);
  if (emergencyContactUid) qs.set("emergencyContactUid", emergencyContactUid);
  if (deepLink) qs.set("deepLink", deepLink);

  return `/push-redirect?${qs.toString()}`;
}

/**
 * Show a notification and attach the original data so we can route on click.
 * NOTE: Ensure /public/icon-192x192.png exists (you can add a 512 as well).
 */
function showNoti(title, body, data) {
  return self.registration.showNotification(title || "Notification", {
    body: body || "",
    icon: "/icon-192x192.png",
    data: data || {}, // we keep payload.data intact
  });
}

/**
 * FCM background handler: runs when a push arrives and your app
 * is not focused (or is closed). Some browsers auto-display
 * `payload.notification`. We still show our own to guarantee the
 * click handler gets the data we need.
 */
messaging.onBackgroundMessage((payload = {}) => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || "Notification";
  const body  = n.body  || d.body  || "";
  // Keep the original payload data so click routing works.
  showNoti(title, body, d);
});

/**
 * Raw Web Push fallback: some browsers may fire this instead.
 * If the browser already showed a notification (because a top-level
 * "notification" was in the payload), we skip.
 */
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data?.json?.() || {}; } catch {}
  if (p.notification) return; // browser already displayed one

  const d = p.data || {};
  const title = d.title || "Notification";
  const body  = d.body  || "";
  event.waitUntil(showNoti(title, body, d));
});

/**
 * When the user clicks the notification:
 *  - We compute a safe in-app URL (via buildRedirectUrl)
 *  - If a tab from our origin exists, navigate + focus it
 *  - Otherwise, open a new tab
 * Your /push-redirect route will handle auth-gating and final routing.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Pull out the original push data we attached in showNoti().
  const data = (event.notification && event.notification.data) || {};
  const url = buildRedirectUrl(data);

  event.waitUntil((async () => {
    // Reuse an existing tab if possible for a smoother UX.
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try {
        // Some browsers support navigate(); others may not.
        if ('navigate' in c) {
          await c.navigate(url);
          if ('focus' in c) return c.focus();
          return;
        }
      } catch (_) {
        // Ignore navigation errors and fall back to opening a new window.
      }
    }
    // No existing app tab → open a new one.
    return clients.openWindow(url);
  })());
});
