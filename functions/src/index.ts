//functions>src>index.ts//
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

/** Read interval in MINUTES; fallback 12h if missing/invalid. */
function getIntervalMinutes(data: FirebaseFirestore.DocumentData): number {
  const raw = data?.checkinInterval;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 720;
}

/** Start of the miss window = last check-in + interval (in minutes). */
function windowStartMin(lastMin: number, intervalMin: number): number {
  return lastMin + intervalMin;
}

type NotifyPolicy = "immediate" | "delay";

interface EmergencyContactDoc {
  // display/invite
  displayName?: string;

  // timing preferences
  notifyPolicy?: NotifyPolicy; // "immediate" | "delay"
  delayMinutes?: number;

  // repeat preferences
  repeatEveryMinutes?: number | null; // >0 enables repeats
  maxRepeatsPerWindow?: number | null; // cap per window

  // token sources
  contactUserId?: string | null; // preferred (if the contact has an account)
  tokens?: string[]; // for contacts without an account

  // server-managed bookkeeping
  lastNotifiedAt?: Timestamp | null;
  lastWindowStartMin?: number | null;
  sentCountInWindow?: number | null;

  // your legacy field name for the contact’s account uid:
  uid?: string | null;
}

function getRepeatEveryMinutes(c: EmergencyContactDoc): number {
  const n = Number(c.repeatEveryMinutes);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function getMaxRepeatsPerWindow(c: EmergencyContactDoc, hasRepeat: boolean): number {
  const raw = Number(c.maxRepeatsPerWindow);
  if (hasRepeat) return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
  return 1;
}

/** Send an FCM message to a token with optional pruning callback. */
async function sendToToken(
  token: string,
  message: Omit<admin.messaging.Message, "token"> & { token: string },
  onTokenGone?: () => Promise<void>
): Promise<void> {
  try {
    await messaging.send({ ...message });
  } catch (err: unknown) {
    const e = err as { errorInfo?: { code?: string }; code?: string };
    const code = e?.errorInfo?.code || e?.code;
    logger.error("Send failed for token", err);
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-argument"
    ) {
      if (onTokenGone) await onTokenGone();
    }
  }
}

/**
 * Scheduler (every 5 minutes), optimized:
 *
 * We only read main-user docs:
 *   where("checkinEnabled","==",true)
 *   where("dueAtMin","<=", nowMin)
 *   orderBy("dueAtMin","asc")
 *
 * Make sure ONLY main users have:
 *   checkinEnabled: true
 *   lastCheckinAt: Timestamp
 *   checkinInterval: number (minutes)
 *   dueAtMin: number (minutes since epoch)
 */
export const checkMissedCheckins = onSchedule("every 5 minutes", async () => {
  const nowMin = toEpochMinutes(Date.now());
  const usersRef = db.collection("users");
  const BATCH_LIMIT = 500;

  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let hasMore = true;

  while (hasMore) {
    let q = usersRef
      .where("checkinEnabled", "==", true)
      .where("dueAtMin", "<=", nowMin)
      .orderBy("dueAtMin", "asc")
      .limit(BATCH_LIMIT);

    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) break;

    for (const userDoc of snap.docs) {
      cursor = userDoc;

      try {
        const data = userDoc.data();
        const uid = userDoc.id;

        const lastTs = data.lastCheckinAt as Timestamp | undefined;
        if (!lastTs) continue;

        const lastMin = toEpochMinutes(lastTs.toMillis());
        const intervalMin = getIntervalMinutes(data);

        const docDueAtMin = Number(data.dueAtMin);
        const expectedDue = windowStartMin(lastMin, intervalMin);
        const dueAtMin = Number.isFinite(docDueAtMin) ? docDueAtMin : expectedDue;

        if (nowMin < dueAtMin) continue;

        // --- 1) Notify the MAIN USER once per window ---
        const userNotifiedTs = data.missedNotifiedAt as Timestamp | undefined;
        const userAlreadyNotified =
          Boolean(userNotifiedTs) && toEpochMinutes(userNotifiedTs!.toMillis()) >= dueAtMin;

        if (!userAlreadyNotified) {
          const devicesSnap = await userDoc.ref.collection("devices").get();
          if (!devicesSnap.empty) {
            const payload = {
              notification: {
                title: "Missed Check-In",
                body: "You missed your last check-in. Please check in now!",
              },
              data: { userId: uid, type: "missed_checkin" },
            } as const;

            for (const dev of devicesSnap.docs) {
              const token = (dev.data() as { token?: string }).token;
              if (!token) continue;

              await sendToToken(token, { token, ...payload }, async () => {
                await dev.ref.delete();
                logger.info(`Removed dead device ${dev.id} for user ${uid}`);
              });
            }

            await userDoc.ref.set(
              { missedNotifiedAt: admin.firestore.FieldValue.serverTimestamp() },
              { merge: true }
            );
            logger.info(`Marked user ${uid} notified for window starting at ${dueAtMin}`);
          }
        }

        // --- 2) Notify EMERGENCY CONTACTS (under users/{uid}/emergency_contact/*) ---
        const contactsSnap = await userDoc.ref.collection("emergency_contact").get();
        if (!contactsSnap.empty) {
          for (const contactDoc of contactsSnap.docs) {
            const c = (contactDoc.data() || {}) as EmergencyContactDoc;

            // First-send timing for this contact
            const policy: NotifyPolicy = c.notifyPolicy ?? "immediate";
            const delayRaw = Number(c.delayMinutes);
            const delayMinutes =
              policy === "delay" && Number.isFinite(delayRaw) && delayRaw > 0 ?
                Math.floor(delayRaw) :
                0;
            const contactWindowStartMin = dueAtMin + delayMinutes;
            if (nowMin < contactWindowStartMin) continue;

            // Repeat settings
            const repeatEvery = getRepeatEveryMinutes(c);
            const hasRepeat = repeatEvery > 0;
            const maxRepeats = getMaxRepeatsPerWindow(c, hasRepeat);

            // Per-window counters
            const prevWindowStart = (c.lastWindowStartMin ?? null) as number | null;
            let sentCount = Number(c.sentCountInWindow ?? 0);
            const lastSentAt = c.lastNotifiedAt ?
              toEpochMinutes(c.lastNotifiedAt.toMillis()) :
              null;

            const isSameWindow = prevWindowStart === contactWindowStartMin;
            if (!isSameWindow) sentCount = 0;
            if (sentCount >= maxRepeats) continue;

            let nextEligibleMin = contactWindowStartMin;
            if (sentCount > 0) {
              const lastSend = lastSentAt ?? contactWindowStartMin;
              nextEligibleMin = lastSend + (hasRepeat ? repeatEvery : Number.POSITIVE_INFINITY);
            }
            if (nowMin < nextEligibleMin) continue;

            // Build the message
            const title = "Emergency Alert: Missed Check-In";
            const body = c.displayName ?
              `${c.displayName}, your contact missed their check-in.` :
              "Your contact missed their check-in.";

            const messageBase = {
              notification: { title, body },
              data: { userId: uid, type: "missed_checkin_emergency" },
            } as const;

            // ---- Resolve tokens for this contact ----
            let delivered = false;

            // Prefer account-based tokens:
            const contactUid = c.contactUserId || c.uid || null;
            if (contactUid) {
              const devs = await db
                .collection("users")
                .doc(contactUid)
                .collection("devices")
                .get();

              for (const dev of devs.docs) {
                const token = (dev.data() as { token?: string }).token;
                if (!token) continue;

                await sendToToken(token, { token, ...messageBase }, async () => {
                  await dev.ref.delete();
                  logger.info(`Removed dead device ${dev.id} for contact user ${contactUid}`);
                });
                delivered = true;
              }
            }

            // If no account or no devices, use raw tokens on the contact doc
            if (!delivered && Array.isArray(c.tokens)) {
              for (const token of c.tokens.filter(Boolean)) {
                await sendToToken(token, { token, ...messageBase });
                delivered = true;
              }
            }

            // Legacy/fallback: tokens stored under the contact doc itself (rare)
            if (!delivered) {
              const localDevs = await contactDoc.ref.collection("devices").get();
              for (const dev of localDevs.docs) {
                const token = (dev.data() as { token?: string }).token;
                if (!token) continue;
                await sendToToken(token, { token, ...messageBase }, async () => {
                  await dev.ref.delete();
                  logger.info(`Removed dead contact-device ${dev.id} under ${contactDoc.ref.path}`);
                });
                delivered = true;
              }
            }

            if (!delivered) continue;

            // Update per-window state
            const newCount = isSameWindow ? sentCount + 1 : 1;
            await contactDoc.ref.set(
              {
                lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                lastWindowStartMin: contactWindowStartMin,
                sentCountInWindow: newCount,
              },
              { merge: true }
            );

            logger.info(
              `Notified contact ${contactDoc.id} for user ${uid} (policy=${policy}, delay=${delayMinutes}m, repeatEvery=${repeatEvery}m, count=${newCount}/${maxRepeats})`
            );
          }
        }
      } catch (err) {
        logger.error(`Error processing user ${userDoc.id}`, err);
      }
    }

    hasMore = snap.size === BATCH_LIMIT;
    if (hasMore) cursor = snap.docs[snap.docs.length - 1] ?? null;
  }
});
