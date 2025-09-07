'use client';

import { messagingPromise, db } from '@/firebase';
import { isSupported, getToken, type Messaging } from 'firebase/messaging';
import { doc, setDoc, serverTimestamp, deleteDoc } from 'firebase/firestore';

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY as string;

// Stable id per browser install
function getOrCreateDeviceId(): string {
  const KEY = 'deviceId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

// Ensure the SW is registered at root scope and is ACTIVE & controlling
async function ensureSwRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return;

  // Prefer the registration that controls the page (root scope)
  let reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) {
    reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
  }

  // Wait for ACTIVATE + control
  await navigator.serviceWorker.ready;

  // Extra safety: wait until this page is controlled
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
    );
  }
  return reg;
}

export async function registerDevice(uid: string, role: 'primary' | 'emergency') {
  try {
    if (!VAPID_KEY) throw new Error('Missing NEXT_PUBLIC_FIREBASE_VAPID_KEY');
    if (!(await isSupported())) {
      console.warn('FCM not supported in this browser.');
      return;
    }

    const messaging = (await messagingPromise) as Messaging | null;
    if (!messaging) return;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted.');
      return;
    }

    const reg = await ensureSwRegistration();
    if (!reg) throw new Error('Service Worker registration not available');

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: reg,
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

    console.log('✅ device registered:', uid, deviceId);
  } catch (e) {
    console.error('registerDevice failed', e);
  }
}

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
