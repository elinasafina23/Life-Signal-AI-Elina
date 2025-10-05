// src/lib/devices.ts
'use client'; // This file runs in the browser (not on the server)

import { messagingPromise, db } from '@/firebase';
import {
  isSupported,
  getToken,
  deleteToken, // optional: helps revoke the browser's FCM token on logout
  type Messaging,
} from 'firebase/messaging';
import {
  doc,
  setDoc,
  serverTimestamp,
  deleteDoc,
} from 'firebase/firestore';

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY as string;

/**
 * Generate (or reuse) a stable “device id” per browser install.
 * We store this in localStorage so the same browser maps to the same
 * Firestore document: users/{uid}/devices/{deviceId}
 */
function getOrCreateDeviceId(): string {
  const KEY = 'deviceId';
  // localStorage only exists in the browser (this file is 'use client' already)
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID(); // built-in UUID generator
    localStorage.setItem(KEY, id);
  }
  return id;
}

/**
 * Make sure our service worker (/firebase-messaging-sw.js) is registered
 * at the ROOT scope ("/"), active, and controlling the current page.
 * FCM needs this for background notifications.
 */
async function ensureSwRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return;

  // Try to get the root-scope registration (preferred)
  let reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) {
    // Not registered yet → register it at the root
    reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
  }

  // Wait until the SW is active and the page is controlled by some SW
  await navigator.serviceWorker.ready;

  // If this page isn’t controlled yet, wait once for controllerchange
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
  }

  return reg;
}

/**
 * Register this browser as a “device” for push notifications.
 * - Gets (or creates) the FCM token for this browser + SW
 * - Stores it under users/{uid}/devices/{deviceId}
 * - `role` can be "primary" (main user) or "emergency" (contact)
 */
export async function registerDevice(uid: string, role: 'primary' | 'emergency') {
  try {
    if (!VAPID_KEY) throw new Error('Missing NEXT_PUBLIC_FIREBASE_VAPID_KEY');
    if (!(await isSupported())) {
      console.warn('FCM is not supported in this browser.');
      return;
    }

    // Lazily get the Messaging instance created in your app init
    const messaging = (await messagingPromise) as Messaging | null;
    if (!messaging) return;

    // Ask for notification permission (shows a browser prompt)
    if (
      typeof Notification === 'undefined' ||
      typeof Notification.requestPermission !== 'function'
    ) {
      console.warn('Web Notifications API is unavailable in this environment.');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted.');
      return;
    }

    // Make sure the SW is registered & controlling this page
    const reg = await ensureSwRegistration();
    if (!reg) throw new Error('Service Worker registration not available');

    // Ask FCM for a registration token (unique for this browser/SW + project)
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: reg,
    });
    if (!token) {
      console.warn('No FCM token returned.');
      return;
    }

    // Use a stable id so we update the same device doc every time
    const deviceId = getOrCreateDeviceId();

    // Save/merge device info under the user
    await setDoc(
      doc(db, 'users', uid, 'devices', deviceId),
      {
        token,                 // the push token FCM will deliver to
        role,                  // "primary" (main user) or "emergency" (contact)
        platform: 'web',       // helpful for multi-platform apps
        ua: navigator.userAgent,
        updatedAt: serverTimestamp(),
        // (Optional) createdAt: serverTimestamp(), // you can set once if you prefer
      },
      { merge: true }
    );

    console.log('✅ device registered:', uid, deviceId);
  } catch (e) {
    console.error('registerDevice failed', e);
  }
}

/**
 * If you suspect the token changed (e.g., after SW update), call this to
 * fetch the current token again and push it to Firestore.
 * It writes to the same {deviceId} document as registerDevice().
 */
export async function refreshDeviceToken(uid: string, role: 'primary' | 'emergency') {
  try {
    if (!VAPID_KEY) return;
    if (!(await isSupported())) return;

    const messaging = (await messagingPromise) as Messaging | null;
    if (!messaging) return;

    const reg = await ensureSwRegistration();
    if (!reg) return;

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: reg,
    });
    if (!token) return;

    const deviceId = getOrCreateDeviceId();
    await setDoc(
      doc(db, 'users', uid, 'devices', deviceId),
      {
        token,
        role,
        platform: 'web',
        ua: navigator.userAgent,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    console.log('🔄 device token refreshed:', uid, deviceId);
  } catch (e) {
    console.error('refreshDeviceToken failed', e);
  }
}

/**
 * Remove this browser’s device document and (best-effort) revoke its FCM token.
 * Call on logout to stop further pushes to this browser for this user.
 */
export async function unregisterDevice(uid: string) {
  try {
    const deviceId = localStorage.getItem('deviceId');
    if (!deviceId) return;

    // Best-effort: delete from Firestore first (so server stops targeting it)
    await deleteDoc(doc(db, 'users', uid, 'devices', deviceId));

    // Optional: also revoke the FCM token from this browser
    try {
      const messaging = (await messagingPromise) as Messaging | null;
      if (messaging) {
        await deleteToken(messaging).catch(() => {
          // Some browsers / states may not allow this; ignore silently
        });
      }
    } catch {
      // Non-fatal: Firestore doc is already removed
    }

    console.log('🗑️ device unregistered:', deviceId);
  } catch (e) {
    console.error('unregisterDevice failed', e);
  }
}
