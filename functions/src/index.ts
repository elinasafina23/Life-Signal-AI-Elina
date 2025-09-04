// functions/src/index.ts
import * as admin from "firebase-admin";
import { setGlobalOptions } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

setGlobalOptions({ maxInstances: 10 });
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

function toMillis(raw: unknown): number {
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  if (raw && typeof (raw as admin.firestore.Timestamp).toMillis === "function") {
    return (raw as admin.firestore.Timestamp).toMillis();
  }
  return 0;
}

function normalizeIntervalMs(v: unknown): number | null {
  if (typeof v !== "number" || !isFinite(v) || v <= 0) return null;
  if (v >= 3_600_000) return v;
  if (v <= 48) return v * 60 * 60 * 1000;
  return v * 60 * 1000;
}
function resolveIntervalMs(d: any): number {
  return (
    normalizeIntervalMs(d?.settings?.checkinInterval) ??
    normalizeIntervalMs(d?.checkinInterval) ??
    2 * 60 * 60 * 1000
  );
}

export const checkMissedCheckins = onSchedule("every 15 minutes", async () => {
  const now = Date.now();
  const users = await db.collection("users").get();

  for (const userDoc of users.docs) {
    const data = userDoc.data();
    const uid = userDoc.id;

    const lastMs = toMillis(data.lastCheckinAt);
    if (!lastMs) continue;

    const intervalMs = resolveIntervalMs(data);
    const due = now - lastMs > intervalMs;
    if (!due) continue;

    // Send to all device tokens
    const devicesSnap = await userDoc.ref.collection("devices").get();
    if (devicesSnap.empty) continue;

    for (const dev of devicesSnap.docs) {
      const { token } = dev.data() as { token?: string };
      if (!token) continue;

      try {
        await messaging.send({
          token,
          notification: {
            title: "Missed Check-In",
            body: "You missed your last check-in. Please check in now!",
          },
          data: { userId: uid, type: "missed_checkin" },
        });
        logger.info(`✅ Sent to ${uid} device ${dev.id}`);
      } catch (err: any) {
        const code = err?.errorInfo?.code || err?.code;
        logger.error(`❌ Send failed to ${uid}/${dev.id}`, err);

        // Clean up invalid tokens
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-argument"
        ) {
          await dev.ref.delete();
          logger.info(`🔧 Removed dead device ${dev.id} for ${uid}`);
        }
      }
    }
  }
});
