// src/lib/useFcmToken.ts
import { messagingPromise, db } from "@/firebase";
import { getToken, isSupported, type Messaging } from "firebase/messaging";
import { doc, setDoc, serverTimestamp, deleteDoc } from "firebase/firestore";
// (Optional) only needed if you keep the user-based wrapper:
import type { User } from "firebase/auth";

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY as string;

// Persist a stable id per browser/app install
function getOrCreateDeviceId(): string {
  const KEY = "deviceId";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

// Ensure the SW is registered so getToken can bind to it
async function ensureSwRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return;
  const path = "/firebase-messaging-sw.js";
  return (
    (await navigator.serviceWorker.getRegistration(path)) ||
    (await navigator.serviceWorker.register(path))
  );
}

/** Register/refresh this device's token under users/{uid}/devices/{deviceId} */
export async function registerDevice(
  uid: string,
  role?: "primary" | "emergency"
) {
  try {
    if (!(await isSupported())) {
      console.warn("Messaging not supported in this browser.");
      return;
    }

    const messaging = (await messagingPromise) as Messaging | null;
    if (!messaging) return;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.warn("Notification permission not granted.");
      return;
    }

    const registration = await ensureSwRegistration();

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) {
      console.warn("Failed to get FCM token.");
      return;
    }

    const deviceId = getOrCreateDeviceId();

    await setDoc(
      doc(db, "users", uid, "devices", deviceId),
      {
        token,
        platform: "web",
        role, // <-- stored for escalation targeting
        ua: navigator.userAgent,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    console.log("✅ Saved FCM token for", uid, "device", deviceId, "role:", role);
  } catch (error) {
    console.error("Error registering device:", error);
  }
}

/** Optional: convenience wrapper if you sometimes have a User object */
export async function saveFcmToken(user: User, role?: "primary" | "emergency") {
  return registerDevice(user.uid, role);
}

/** Optional: call on sign-out to remove this device doc */
export async function unregisterDevice(uid: string) {
  try {
    const deviceId = localStorage.getItem("deviceId");
    if (!deviceId) return;
    await deleteDoc(doc(db, "users", uid, "devices", deviceId));
    console.log("🗑️ Removed device", deviceId, "for", uid);
  } catch (error) {
    console.error("Error unregistering device:", error);
  }
}
