// functions/src/index.ts
import * as admin from "firebase-admin";
import { setGlobalOptions } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";

setGlobalOptions({ maxInstances: 10 });
if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

/** Convert ms epoch to whole minutes since epoch (drops seconds). */
function toEpochMinutes(ms: number): number {
  return Math.floor(ms / 60000);
}

/**
 * Read interval in MINUTES and return a valid number.
 * 
 */
function getIntervalMinutes(data: FirebaseFirestore.DocumentData): number {
  // Expect checkinInterval to be stored directly on the user doc
  const raw = data?.checkinInterval;
  const minutes = Number(raw);

  // If valid positive number → use it
  // Else fallback to 12 hours (720 minutes)
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 720;
}

/**
 * Every 15 minutes:
 * If now >= lastCheckinAt + interval (in minutes), send push once,
 * and record missedNotifiedAt to avoid repeats.
 */
export const checkMissedCheckins = onSchedule(
  "every 15 minutes",
  async () => {
    const nowMin = toEpochMinutes(Date.now());
    const usersSnap = await db.collection("users").get();

    for (const userDoc of usersSnap.docs) {
      const data = userDoc.data();
      const uid = userDoc.id;

      const lastTs = data.lastCheckinAt as Timestamp | undefined;
      if (!lastTs) continue;

      const lastMin = toEpochMinutes(lastTs.toMillis());
      const intervalMin = getIntervalMinutes(data);
      const dueAtMin = lastMin + intervalMin;

      // Not due yet?
      if (nowMin < dueAtMin) continue;

      // Already notified for this due window?
      const notifiedTs = data.missedNotifiedAt as Timestamp | undefined;
      if (
        notifiedTs &&
        toEpochMinutes(notifiedTs.toMillis()) >= dueAtMin
      ) {
        continue;
      }

      // Send to all devices (filter by role if desired)
      const devicesSnap =
        await userDoc.ref.collection("devices").get();
      if (devicesSnap.empty) continue;

      const payload = {
        notification: {
          title: "Missed Check-In",
          body:
            "You missed your last check-in. Please check in now!",
        },
        data: { userId: uid, type: "missed_checkin" },
      };

      for (const dev of devicesSnap.docs) {
        const token = (dev.data() as {token?: string}).token;
        if (!token) continue;

        try {
          await messaging.send({ token, ...payload });
          logger.info(
            `Sent missed-checkin to user ${uid} ` +
            `on device ${dev.id}`,
          );
        } catch (err: unknown) {
          const e = err as {
            errorInfo?: {code?: string};
            code?: string;
          };
          const code = e?.errorInfo?.code || e?.code;

          logger.error(
            `Send failed to user ${uid} device ${dev.id}`,
            err,
          );

          // Clean up dead tokens
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-argument"
          ) {
            await dev.ref.delete();
            logger.info(
              `Removed dead device ${dev.id} for user ${uid}`,
            );
          }
        }
      }

      // Mark this due window as notified (prevents repeats)
      await userDoc.ref.set(
        {
          missedNotifiedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  },
);
