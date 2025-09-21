// functions/src/index.ts

// Import Firebase Admin SDK (server-side) to read/write Firestore and send FCM
import * as admin from "firebase-admin";

// V2 Cloud Functions utilities: global options + a scheduler trigger
import { setGlobalOptions } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";

// Lightweight logger for Cloud Functions (shows up in GCP logs)
import * as logger from "firebase-functions/logger";

// Firestore Timestamp type (from Admin SDK)
import { Timestamp } from "firebase-admin/firestore";

/**
 * Configure global options for ALL functions in this file.
 * - maxInstances: limit concurrent instances to control cost/thrashing.
 */
setGlobalOptions({ maxInstances: 10 });

/**
 * Initialize the Admin app once. In Cloud Functions, code can be loaded multiple
 * times, so we guard with `!admin.apps.length` to avoid double init.
 */
if (!admin.apps.length) admin.initializeApp();

/**
 * Create Firestore and Messaging handles from the Admin SDK.
 * - `db` lets us read/write any document (rules are bypassed on the server).
 * - `messaging` is used to send push notifications (FCM).
 */
const db = admin.firestore();
const messaging = admin.messaging();

/**
 * Utility: Convert a JS epoch (milliseconds) to a whole minute count.
 * We drop seconds so that "time windows" are easier to compare.
 */
function toEpochMinutes(ms: number): number {
  return Math.floor(ms / 60000);
}

/**
 * Utility: Read the user's check-in interval (in minutes).
 * If it's missing or invalid, default to 12 hours (720 minutes).
 */
function getIntervalMinutes(data: FirebaseFirestore.DocumentData): number {
  const raw = data?.checkinInterval; // could be number or string
  const minutes = Number(raw); // normalize to number
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 720;
}

/**
 * Utility: Compute the start of a "missed" window.
 * It's simply last check-in time (in minutes) + the interval (in minutes).
 */
function windowStartMin(lastMin: number, intervalMin: number): number {
  return lastMin + intervalMin;
}

/** Notification policy for a contact: send immediately, or after some delay. */
type NotifyPolicy = "immediate" | "delay";

/**
 * The shape of each document under:
 *   users/{mainUserUid}/emergency_contact/{docId}
 *
 * Important:
 * - `emergencyContactUid` is the contact’s Auth UID (canonical link).
 * - `tokens` lets you notify contacts who don’t have an account (optional).
 * - The `last*` fields are server-maintained to rate-limit notifications.
 */
interface EmergencyContactDoc {
  // A friendly name (e.g., the person who will receive alerts)
  displayName?: string;

  // When to notify: right away or after `delayMinutes`.
  notifyPolicy?: NotifyPolicy; // "immediate" | "delay"
  delayMinutes?: number;

  // Repeat settings within one "miss window"
  repeatEveryMinutes?: number | null; // >0 enables repeats
  maxRepeatsPerWindow?: number | null; // cap per window

  // Contact identity (canonical) — the contact’s Firebase Auth UID
  emergencyContactUid?: string | null;

  // Raw device tokens (for contacts without accounts)
  tokens?: string[];

  // Server-managed bookkeeping (do not edit from clients)
  lastNotifiedAt?: Timestamp | null; // when we last notified this contact
  lastWindowStartMin?: number | null; // which "miss window" those sends belong to
  sentCountInWindow?: number | null; // how many times we notified in that window
}

/** Normalize: turn repeatEveryMinutes into a safe integer (0 = disabled). */
function getRepeatEveryMinutes(c: EmergencyContactDoc): number {
  const n = Number(c.repeatEveryMinutes);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Normalize: how many repeated sends are allowed within one window. */
function getMaxRepeatsPerWindow(c: EmergencyContactDoc, hasRepeat: boolean): number {
  const raw = Number(c.maxRepeatsPerWindow);
  if (hasRepeat) return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3; // default cap = 3
  return 1; // if no repeat, allow exactly one send
}

/**
 * Send an FCM message to a device token.
 * If the token is invalid/not-registered, we optionally run `onTokenGone`
 * to clean up where that token came from (e.g. delete stale device doc).
 */
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

    // Two common errors that mean the token is dead or malformed
    const isDead =
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-argument";

    if (isDead && onTokenGone) {
      await onTokenGone(); // e.g., delete that device doc
    }
  }
}

/**
 * Scheduled Cloud Function:
 * - Runs every 5 minutes.
 * - Scans "main users" who are overdue for a check-in (by dueAtMin).
 * - Notifies (1) the main user and (2) their emergency contacts.
 *
 * Pre-requisites on each main user document (users/{mainUserUid}):
 *   checkinEnabled: true
 *   lastCheckinAt: Timestamp
 *   checkinInterval: number (minutes)
 *   dueAtMin: number (minutes since epoch)
 */
export const checkMissedCheckins = onSchedule("every 5 minutes", async () => {
  const nowMin = toEpochMinutes(Date.now()); // current time, in minutes
  const usersRef = db.collection("users"); // root users collection
  const BATCH_LIMIT = 500; // process users in pages

  // For paginating through user results
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let hasMore = true;

  while (hasMore) {
    // Query only main users who are due (or overdue) right now
    let q = usersRef
      .where("checkinEnabled", "==", true) // only users with check-ins enabled
      .where("dueAtMin", "<=", nowMin) // due time is now or in the past
      .orderBy("dueAtMin", "asc") // oldest first
      .limit(BATCH_LIMIT); // page size

    // If we already processed a page, continue after last doc
    if (cursor) q = q.startAfter(cursor);

    // Run the query
    const snap = await q.get();
    if (snap.empty) break; // nothing left to process

    // Iterate each main user in this page
    for (const userDoc of snap.docs) {
      // Move the cursor forward
      cursor = userDoc;

      try {
        const data = userDoc.data(); // main user fields
        const mainUserUid = userDoc.id; // the main user's UID (doc id)

        // We need a last check-in time; if missing, skip this user
        const lastTs = data.lastCheckinAt as Timestamp | undefined;
        if (!lastTs) continue;

        // Convert last check-in time to minute epoch
        const lastMin = toEpochMinutes(lastTs.toMillis());

        // Determine how often this user must check in (minutes)
        const intervalMin = getIntervalMinutes(data);

        // Use precomputed dueAtMin if present, else compute expected due
        const docDueAtMin = Number(data.dueAtMin);
        const expectedDue = windowStartMin(lastMin, intervalMin);
        const dueAtMin = Number.isFinite(docDueAtMin) ? docDueAtMin : expectedDue;

        // If they're not due yet (somehow), skip
        if (nowMin < dueAtMin) continue;

        // ---------- (1) NOTIFY THE MAIN USER (only once per window) ----------
        const userNotifiedTs = data.missedNotifiedAt as Timestamp | undefined;

        // If we have a timestamp and it's already within/after this window, skip
        const userAlreadyNotified =
          Boolean(userNotifiedTs) && toEpochMinutes(userNotifiedTs!.toMillis()) >= dueAtMin;

        if (!userAlreadyNotified) {
          // Get all device tokens registered under this main user
          const devicesSnap = await userDoc.ref.collection("devices").get();

          if (!devicesSnap.empty) {
            // Construct a simple push notification payload
            const payload = {
              notification: {
                title: "Missed Check-In",
                body: "You missed your last check-in. Please check in now!",
              },
              // Custom data for the client app to route/handle
              data: { mainUserUid, type: "missed_checkin" },
            } as const;

            // Send to each device; delete token docs that are dead
            for (const dev of devicesSnap.docs) {
              const token = (dev.data() as { token?: string }).token;
              if (!token) continue;

              await sendToToken(token, { token, ...payload }, async () => {
                await dev.ref.delete();
                logger.info(`Removed dead device ${dev.id} for main user ${mainUserUid}`);
              });
            }

            // Mark the main user as notified for this window
            await userDoc.ref.set(
              { missedNotifiedAt: admin.firestore.FieldValue.serverTimestamp() },
              { merge: true }
            );

            logger.info(
              `Marked main user ${mainUserUid} notified for window starting at ${dueAtMin}`
            );
          }
        }

        // ---------- (2) NOTIFY EMERGENCY CONTACTS ----------
        // We look at subcollection: users/{mainUserUid}/emergency_contact/*
        const contactsSnap = await userDoc.ref.collection("emergency_contact").get();
        if (!contactsSnap.empty) {
          // For each emergency contact configured under this main user
          for (const contactDoc of contactsSnap.docs) {
            const c = (contactDoc.data() || {}) as EmergencyContactDoc;

            // Determine when to send the FIRST notification for this contact
            const policy: NotifyPolicy = c.notifyPolicy ?? "immediate";
            const delayRaw = Number(c.delayMinutes);
            const delayMinutes =
              policy === "delay" && Number.isFinite(delayRaw) && delayRaw > 0 ?
                Math.floor(delayRaw) :
                0;

            // This contact’s "window start" (main user due + contact delay)
            const contactWindowStartMin = dueAtMin + delayMinutes;

            // If we’re not past that moment yet, skip for now
            if (nowMin < contactWindowStartMin) continue;

            // Repeat logic: how often can we re-notify, and the cap per window
            const repeatEvery = getRepeatEveryMinutes(c); // 0 means no repeats
            const hasRepeat = repeatEvery > 0;
            const maxRepeats = getMaxRepeatsPerWindow(c, hasRepeat);

            // State to ensure we don't spam within a single window
            const prevWindowStart = (c.lastWindowStartMin ?? null) as number | null;
            let sentCount = Number(c.sentCountInWindow ?? 0);
            const lastSentAt = c.lastNotifiedAt ?
              toEpochMinutes(c.lastNotifiedAt.toMillis()) :
              null;

            // If this is a new window, reset sent count
            const isSameWindow = prevWindowStart === contactWindowStartMin;
            if (!isSameWindow) sentCount = 0;

            // If we already hit the cap for this window, skip
            if (sentCount >= maxRepeats) continue;

            // Determine when we're next allowed to send in this window
            let nextEligibleMin = contactWindowStartMin;
            if (sentCount > 0) {
              const lastSend = lastSentAt ?? contactWindowStartMin;
              nextEligibleMin = lastSend + (hasRepeat ? repeatEvery : Number.POSITIVE_INFINITY);
            }

            // Not yet eligible for the next send? Skip
            if (nowMin < nextEligibleMin) continue;

            // Build the notification for the emergency contact
            const title = "Emergency Alert: Missed Check-In";
            const body = c.displayName ?
              `${c.displayName}, your contact missed their check-in.` :
              "Your contact missed their check-in.";

            // Common payload parts (we’ll add device token at send-time)
            const messageBase = {
              notification: { title, body },
              data: { mainUserUid, type: "missed_checkin_emergency" },
            } as const;

            // ------- Resolve WHERE to send the notification -------
            let delivered = false;

            // Preferred: if the contact has an account, use their devices
            const emergencyContactUid = c.emergencyContactUid || null;
            if (emergencyContactUid) {
              const devs = await db
                .collection("users")
                .doc(emergencyContactUid)
                .collection("devices")
                .get();

              for (const dev of devs.docs) {
                const token = (dev.data() as { token?: string }).token;
                if (!token) continue;

                await sendToToken(token, { token, ...messageBase }, async () => {
                  await dev.ref.delete();
                  logger.info(
                    `Removed dead device ${dev.id} for emergency contact user ${emergencyContactUid}`
                  );
                });

                delivered = true; // we sent at least once
              }
            }

            // Fallback: if no account or no devices, use raw tokens on the contact doc
            if (!delivered && Array.isArray(c.tokens)) {
              for (const token of c.tokens.filter(Boolean)) {
                await sendToToken(token, { token, ...messageBase });
                delivered = true;
              }
            }

            // Rare legacy fallback: tokens stored under the contact subdoc itself
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

            // If we couldn’t deliver anywhere, do not update the counters
            if (!delivered) continue;

            // Update per-window counters so we don’t spam
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
              `Notified emergency contact ${contactDoc.id} for main user ${mainUserUid} ` +
                `(policy=${policy}, delay=${delayMinutes}m, repeatEvery=${repeatEvery}m, ` +
                `count=${newCount}/${maxRepeats})`
            );
          }
        }
      } catch (err) {
        // If anything throws for this user, log and keep going with the next one
        logger.error(`Error processing main user ${userDoc.id}`, err);
      }
    }

    // If we got a full page, there might be more users to process
    hasMore = snap.size === BATCH_LIMIT;

    // Move the cursor to the last doc from this page (for pagination)
    if (hasMore) cursor = snap.docs[snap.docs.length - 1] ?? null;
  }
});
