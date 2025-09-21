// src/lib/useFcmToken.ts
'use client';

import { messagingPromise, db } from '@/firebase';
import { getToken, isSupported, type Messaging } from 'firebase/messaging';
import { doc, setDoc, serverTimestamp, deleteDoc } from 'firebase/firestore';
import type { User } from 'firebase/auth';

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY as string;

/** Stable per-browser id we store in localStorage (always returns a string). */
function getOrCreateDeviceId(): string {
  const KEY = 'deviceId';
  try {
    const existing = localStorage.getItem(KEY); // string | null
    if (existing) return existing;              // <- guards null

    // Prefer crypto.randomUUID when available; fallback to a readable id.
    const newId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dev_${Math.random().toString(36).slice(2)}_${Date.now()}`;

    localStorage.setItem(KEY, newId);
    return newId;
  } catch {
    // If localStorage is blocked, create an ephemeral id that won’t persist.
    return `ephemeral_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }
}

/** Ensure the root-scope SW is active & controlling this page. */
async function ensureSwRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return;

  // Prefer an existing registration at root scope; otherwise register it.
  let reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) {
    reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
  }

  // Wait until it’s ready …
  await navigator.serviceWorker.ready;

  // …and wait until this page is controlled (first load after register).
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      const onChange = () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onChange);
        resolve();
      };
      navigator.serviceWorker.addEventListener('controllerchange', onChange, { once: true });
    });
  }
  return reg;
}

/**
 * Save/refresh this browser’s FCM token under users/{uid}/devices/{deviceId}.
 * `role` is optional: 'primary' (main user) | 'emergency' (contact).
 */
export async function registerDevice(uid: string, role?: 'primary' | 'emergency') {
  try {
    if (!VAPID_KEY) throw new Error('Missing NEXT_PUBLIC_FIREBASE_VAPID_KEY');

    if (!(await isSupported())) {
      console.warn('Messaging not supported in this browser.');
      return;
    }

    const messaging = (await messagingPromise) as Messaging | null;
    if (!messaging) return;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted.');
      return;
    }

    const registration = await ensureSwRegistration();
    if (!registration) {
      console.warn('No Service Worker registration available.');
      return;
    }

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) {
      console.warn('No FCM token returned.');
      return;
    }

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

    console.log('✅ device registered:', uid, deviceId, 'role:', role);
  } catch (e) {
    console.error('registerDevice failed', e);
  }
}

/** Optional convenience if you already have a Firebase `User` object. */
export async function saveFcmToken(user: User, role?: 'primary' | 'emergency') {
  return registerDevice(user.uid, role);
}

/** Remove this device doc on sign-out (optional hygiene). */
export async function unregisterDevice(uid: string) {
  try {
    const deviceId = localStorage.getItem('deviceId');
    if (!deviceId) return;
    await deleteDoc(doc(db, 'users', uid, 'devices', deviceId));
    console.log('🗑️ device unregistered:', deviceId);
  } catch (e) {
    console.error('unregisterDevice failed', e);
  }
}
