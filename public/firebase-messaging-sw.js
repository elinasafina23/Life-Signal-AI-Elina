/* public/firebase-messaging-sw.js */

// Load Firebase compat libs in the SW context
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

// IMPORTANT: process.env.* is NOT available in a static SW file.
// Put your actual config values here (same as your client app).
firebase.initializeApp({
  apiKey: "AIzaSyBNCJcAtvkcjGXDonftIIS7mJ8rywAijT8",
  authDomain: "life-signal-ai-9caf4.firebaseapp.com",
  projectId: "life-signal-ai-9caf4",
  storageBucket: "life-signal-ai-9caf4.appspot.com",
  messagingSenderId: "1021508781728",
  appId: "1:1021508781728:web:ec0a2e771d0ff633ff6bc5",
  // measurementId is not required for messaging in the SW
});

const messaging = firebase.messaging();

// Background messages:
// If your server payload includes a `notification` block,
// most browsers will auto-display it and this handler may NOT run.
// This handler is mainly for data-only messages.
messaging.onBackgroundMessage((payload) => {
  // Prefer notification fields if present; otherwise fall back to data.
  const title =
    payload?.notification?.title ||
    payload?.data?.title ||
    "New Notification";

  const options = {
    body: payload?.notification?.body || payload?.data?.body || "",
    icon: "/icons/icon-192.png", // optional PWA icon path
    data: payload?.data || {},
  };

  self.registration.showNotification(title, options);
});

// Optional: bring your app to the foreground when the notif is clicked
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || "/";

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = allClients.find((c) => new URL(c.url).pathname === new URL(urlToOpen, self.location.origin).pathname);
      if (client) return client.focus();
      return clients.openWindow(urlToOpen);
    })()
  );
});
