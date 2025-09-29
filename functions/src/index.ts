/* eslint-disable @typescript-eslint/no-explicit-any */

import { initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  FieldValue,
  WriteBatch,
} from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import axios from "axios";

initializeApp();
const db = getFirestore();

/** ---------------------------
 *  Secrets (v2 Functions)
 *  --------------------------- */
// NOTE: TELNYX_APPLICATION_ID holds your Voice API App ID (used as connection_id in /v2/calls)
const S_TELNYX_API_KEY = defineSecret("TELNYX_API_KEY");
const S_TELNYX_APPLICATION_ID = defineSecret("TELNYX_APPLICATION_ID");
const S_TELNYX_FROM_NUMBER = defineSecret("TELNYX_FROM_NUMBER");

/** Read secrets with optional process.env fallback for local emulator/dev. */
function getTelnyx() {
  return {
    apiKey: S_TELNYX_API_KEY.value() || process.env.TELNYX_API_KEY,
    appId: S_TELNYX_APPLICATION_ID.value() || process.env.TELNYX_APPLICATION_ID,
    from: S_TELNYX_FROM_NUMBER.value() || process.env.TELNYX_FROM_NUMBER,
  };
}

const TELNYX_API = "https://api.telnyx.com/v2";

/** Telnyx-friendly E.164: + and 7–14 more digits (8–15 total) */
function isE164(v?: string): v is string {
  return typeof v === "string" && /^\+[1-9]\d{7,14}$/.test(v.trim());
}

/** Batch helper to avoid the 500-writes limit. */
async function commitOrRotate(batch: WriteBatch, ops: { count: number }) {
  if (ops.count >= 450) {
    await batch.commit();
    ops.count = 0;
    return db.batch();
  }
  return batch;
}

/** ---------------------------
 *  Sync EC profile to linked docs
 *  --------------------------- */
export const syncEmergencyContactProfile = onDocumentWritten(
  "users/{ecUid}",
  async (event) => {
    const emergencyContactUid = String(event.params.ecUid);

    let before: any = {};
    if (event.data?.before.exists) before = event.data.before.data() as any;
    let after: any = null;
    if (event.data?.after.exists) after = event.data.after.data() as any;
    if (!after) return; // ignore deletes

    const watched = [
      "firstName",
      "lastName",
      "email",
      "phone",
      "defaultChannel",
      "avatar",
      "quietStart",
      "quietEnd",
    ];
    const changed = watched.some((k) => (before as any)[k] !== (after as any)[k]);
    if (!changed) return;

    const fullName = `${(after.firstName || "").trim()} ${(after.lastName || "")
      .trim()}`.trim();
    const newEmail = String(after.email || "");
    const oldEmail = String(before.email || newEmail);
    const nowTs = FieldValue.serverTimestamp();

    // 1) Update all /users/{mainUserUid}/emergency_contact/* links for this EC
    const linksSnap = await db
      .collectionGroup("emergency_contact")
      .where("emergencyContactUid", "==", emergencyContactUid)
      .get();

    const mainUserUids = new Set<string>();
    let batch = db.batch();
    const ops = { count: 0 };

    for (const link of linksSnap.docs) {
      const mainUserUid = link.ref.parent.parent?.id;
      if (mainUserUid) mainUserUids.add(mainUserUid);

      batch.set(
        link.ref,
        {
          name: fullName,
          email: newEmail || null,
          phone: after.phone || null,
          emergencyContactUid,
          updatedAt: nowTs,
        },
        { merge: true }
      );
      ops.count++;
      batch = await commitOrRotate(batch, ops);
    }
    if (ops.count) await batch.commit();

    // 2) Optional mirror top-level collection
    const topSnap = await db
      .collection("emergencyContacts")
      .where("emergencyContactUid", "==", emergencyContactUid)
      .get();

    if (!topSnap.empty) {
      let b = db.batch();
      const o = { count: 0 };
      for (const d of topSnap.docs) {
        b.set(
          d.ref,
          {
            emergencyContactEmail: newEmail || null,
            name: fullName,
            phone: after.phone || null,
            updatedAt: nowTs,
          },
          { merge: true }
        );
        o.count++;
        b = await commitOrRotate(b, o);
      }
      if (o.count) await b.commit();
    }

    // 3) Update embedded summary on each main user (for UI)
    for (const mainUserUid of Array.from(mainUserUids)) {
      const userRef = db.doc(`users/${mainUserUid}`);
      const userSnap = await userRef.get();
      if (!userSnap.exists) continue;

      const u = userSnap.data() || {};
      const ec = (u as any).emergencyContacts || {};
      const updates: Record<string, any> = {};

      if (
        ec.contact1_email &&
        (ec.contact1_email === oldEmail || ec.contact1_email === newEmail)
      ) {
        updates["emergencyContacts.contact1_firstName"] = after.firstName || "";
        updates["emergencyContacts.contact1_lastName"] = after.lastName || "";
        updates["emergencyContacts.contact1_phone"] = after.phone || "";
        updates["emergencyContacts.contact1_email"] = newEmail;
      }
      if (
        ec.contact2_email &&
        (ec.contact2_email === oldEmail || ec.contact2_email === newEmail)
      ) {
        updates["emergencyContacts.contact2_firstName"] = after.firstName || "";
        updates["emergencyContacts.contact2_lastName"] = after.lastName || "";
        updates["emergencyContacts.contact2_phone"] = after.phone || "";
        updates["emergencyContacts.contact2_email"] = newEmail;
      }

      if (Object.keys(updates).length) {
        updates["updatedAt"] = nowTs;
        await userRef.set(updates, { merge: true });
      }
    }
  }
);

/** ---------------------------
 *  Utilities for escalation
 *  --------------------------- */

function toMillis(ts?: any): number {
  try {
    if (ts == null) return 0;

    // Firestore Timestamp-like
    if (typeof ts?.toMillis === "function") return ts.toMillis();
    if (typeof ts?.toDate === "function") return ts.toDate().getTime();

    // Already a Date
    if (ts instanceof Date) return ts.getTime();

    // Number (assumed ms)
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;

    // String: numeric or ISO
    if (typeof ts === "string") {
      const n = Number(ts);
      if (Number.isFinite(n)) return n;
      const d = new Date(ts);
      const t = d.getTime();
      if (!Number.isNaN(t)) return t;
    }
  } catch (err) {
    logger.warn("toMillis parse error", (err as any)?.message);
  }
  return 0;
}

/** ACTIVE ECs sorted by sentCountInWindow -> lastNotifiedAt -> createdAt */
async function getActiveEmergencyContacts(mainUserUid: string) {
  const snap = await db
    .collection(`users/${mainUserUid}/emergency_contact`)
    .where("status", "==", "ACTIVE")
    .get();

  const contacts = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as any) }))
    .filter((c) => isE164((c as any).phone)); // only valid E.164 phones

  contacts.sort((a: any, b: any) => {
    const aCount = Number(a.sentCountInWindow || 0);
    const bCount = Number(b.sentCountInWindow || 0);
    if (aCount !== bCount) return aCount - bCount;

    const aLast = toMillis(a.lastNotifiedAt);
    const bLast = toMillis(b.lastNotifiedAt);
    if (aLast !== bLast) return aLast - bLast;

    const aCreated = toMillis(a.createdAt);
    const bCreated = toMillis(b.createdAt);
    return aCreated - bCreated;
  });

  return contacts as Array<{
    id: string;
    phone: string;
    emergencyContactUid?: string;
    sentCountInWindow?: number;
    lastNotifiedAt?: any;
    createdAt?: any;
  }>;
}

/** Collect ACTIVE EC UIDs for push targeting */
async function getActiveEmergencyContactUids(mainUserUid: string): Promise<string[]> {
  const snap = await db
    .collection(`users/${mainUserUid}/emergency_contact`)
    .where("status", "==", "ACTIVE")
    .get();

  const uids = snap.docs
    .map((d) => (d.data() as any).emergencyContactUid)
    .filter((x) => typeof x === "string" && x.trim().length > 0);

  return Array.from(new Set(uids));
}

/** Return all non-empty FCM tokens under users/{uid}/devices */
async function getFcmTokensForUser(uid: string): Promise<string[]> {
  try {
    const snap = await db.collection(`users/${uid}/devices`).get();
    const tokens = snap.docs
      .map((d) => {
        const data = d.data() as any;
        // support either "fcmToken" or "token" field
        const t = String(data?.fcmToken || data?.token || "").trim();
        const disabled = Boolean(data?.disabled);
        return !disabled && t ? t : null;
      })
      .filter(Boolean) as string[];
    return Array.from(new Set(tokens));
  } catch (e: any) {
    logger.error("getFcmTokensForUser failed", e?.message);
    return [];
  }
}

/** Multicast push to many tokens (silently ignores empty list) */
async function sendPushToTokens(tokens: string[], notif: {
  title: string;
  body: string;
}, data: Record<string, string> = {}) {
  if (!tokens.length) return;
  try {
    const messaging = getMessaging();
    await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: notif.title,
        body: notif.body,
      },
      data, // key/value strings
      android: { priority: "high" },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "default" } },
      },
    });
  } catch (e: any) {
    logger.error("sendPushToTokens failed", e?.message);
  }
}

/** ---------------------------
 *  Policy setter (UI can call)
 *  --------------------------- */
export const updateEscalationPolicy = onRequest(async (req, res) => {
  try {
    const { mainUserUid, mode, callDelaySec = 60 } = req.body || {};
    if (!mainUserUid || !["push_then_call", "call_immediately"].includes(mode)) {
      res.status(400).json({ ok: false, error: "Invalid payload: mainUserUid/mode" });
      return;
    }

    await db.doc(`users/${mainUserUid}`).set(
      {
        escalationPolicy: {
          version: 1,
          mode,
          callDelaySec: Number(callDelaySec) || 60,
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );

    res.json({ ok: true });
  } catch (e: any) {
    logger.error("updateEscalationPolicy", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/** ---------------------------
 *  Place a call (backend/HTTP)
 *  --------------------------- */
export const makeCall = onRequest(
  { secrets: [S_TELNYX_API_KEY, S_TELNYX_APPLICATION_ID, S_TELNYX_FROM_NUMBER] },
  async (req, res) => {
    try {
      const { apiKey, appId, from } = getTelnyx(); // appId is the Voice API App ID
      if (!apiKey) {
        res.status(500).json({ ok: false, error: "TELNYX_API_KEY is not set" });
        return;
      }

      const to = String(req.body?.to || "").trim();
      const mainUserUid = req.body?.mainUserUid ? String(req.body.mainUserUid) : undefined;
      const emergencyContactUid = req.body?.emergencyContactUid ? String(req.body.emergencyContactUid) : undefined;

      if (!to) {
        res.status(400).json({ ok: false, error: "Missing 'to' number" });
        return;
      }
      if (!isE164(to)) {
        res.status(400).json({ ok: false, error: "Destination must be E.164 (e.g. +15551234567)" });
        return;
      }
      if (from && !isE164(String(from))) {
        res.status(400).json({ ok: false, error: "Configured TELNYX_FROM_NUMBER must be E.164" });
        return;
      }
      if (!appId) {
        res.status(500).json({ ok: false, error: "TELNYX_APPLICATION_ID (Voice API App ID) is not set" });
        return;
      }

      const clientState = Buffer
        .from(JSON.stringify({ mainUserUid, emergencyContactUid, reason: "escalation" }))
        .toString("base64");

      const payload = {
        connection_id: appId,
        to,
        from,
        client_state: clientState,
      };

      const { data } = await axios.post(`${TELNYX_API}/calls`, payload, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      res.status(200).json({ ok: true, call: data?.data });
    } catch (err: any) {
      logger.error("makeCall error", err?.response?.data || err?.message);
      res.status(500).json({ ok: false, error: err?.response?.data || err?.message });
    }
  }
);

/** ---------------------------------------
 *  Telnyx webhook (set this URL in Telnyx)
 *  --------------------------------------- */
export const telnyxWebhook = onRequest(
  { secrets: [S_TELNYX_API_KEY, S_TELNYX_APPLICATION_ID, S_TELNYX_FROM_NUMBER] },
  async (req, res) => {
    // ACK immediately
    res.status(200).send("ok");

    try {
      const { apiKey } = getTelnyx();
      const evt = req.body?.data;
      if (!evt) return;

      const eventType: string = evt.event_type;
      const callControlId: string | undefined = evt.payload?.call_control_id;
      const callSessionId: string | undefined = evt.payload?.call_session_id;

      logger.info(`Telnyx event: ${eventType}`, { callSessionId, callControlId });

      if (callSessionId) {
        await db.collection("telnyxCalls").doc(callSessionId).set(
          {
            lastEvent: eventType,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      // When the call is answered, speak a short message
      if (eventType === "call.answered" && callControlId && apiKey) {
        await axios.post(
          `${TELNYX_API}/calls/${callControlId}/actions/speak`,
          {
            language: "en-US",
            voice: "female",
            payload:
              "This is an automated Life Signal alert. Please check on the user and press 1 to acknowledge.",
          },
          {
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
          }
        );
      }
    } catch (e: any) {
      logger.error("telnyxWebhook error", e?.response?.data || e?.message);
    }
  }
);

/** ------------------------------------------------------
 *  Core Escalation Job (shared by HTTP + Scheduler)
 *  ------------------------------------------------------ */
async function runEscalationScanJob(input: { cooldownMin?: number } = {}) {
  const { apiKey, appId, from } = getTelnyx();
  if (!apiKey) throw new Error("TELNYX_API_KEY is not set");

  const now = Date.now();
  const cooldownMin = Number(input.cooldownMin ?? 10); // minutes

  const usersSnap = await db
    .collection("users")
    .where("checkinEnabled", "==", true)
    .limit(200)
    .get();

  const processed: string[] = [];
  let escalationsQueued = 0;

  for (const doc of usersSnap.docs) {
    const mainUserUid = doc.id;
    const u: any = doc.data() || {};

    // Overdue?
    const lastCheckinAtMs =
      (u.lastCheckinAt?.toDate?.()?.getTime?.() as number | undefined) ?? 0;
    const intervalMin = Number(u.checkinInterval ?? 60);
    const dueAtMs = lastCheckinAtMs + intervalMin * 60_000;

    // Throttle how often we notify
    const lastNotifiedMs =
      (u.missedNotifiedAt?.toDate?.()?.getTime?.() as number | undefined) ?? 0;

    if (now < dueAtMs) continue;
    if (lastNotifiedMs && now - lastNotifiedMs < cooldownMin * 60_000) continue;

    // Policy (UI-set or default)
    const policy: { mode: "push_then_call" | "call_immediately"; callDelaySec: number } =
      u.escalationPolicy || { mode: "push_then_call", callDelaySec: 60 };

    // Prefer ACTIVE contact in subcollection; fall back to embedded
    const activeContacts = await getActiveEmergencyContacts(mainUserUid);
    const top = activeContacts[0];
    const fallbackPhone = u.emergencyContacts?.contact1_phone || null;

    const contactPhone = (top?.phone || fallbackPhone) as string | null;
    const emergencyContactUid = top?.emergencyContactUid || null;
    const ecDocId = top?.id || null;

    if (!contactPhone) {
      logger.warn("No contact phone found for user", { mainUserUid });
      continue;
    }

    // Mark that we started escalation to prevent duplicate scans
    await db.doc(`users/${mainUserUid}`).set(
      { missedNotifiedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    // If we used a subcollection doc, bump its counters (best-effort)
    if (ecDocId) {
      const ecRef = db.doc(`users/${mainUserUid}/emergency_contact/${ecDocId}`);
      await ecRef.set(
        {
          lastNotifiedAt: FieldValue.serverTimestamp(),
          sentCountInWindow: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // Best-effort "display" name
    const mainUserName =
      (u.firstName || u.lastName) ?
        `${u.firstName || ""} ${u.lastName || ""}`.trim() :
        "a user";

    if (policy.mode === "call_immediately") {
      // (Optional) Push to ECs informing a call is being placed now
      try {
        const ecUids = await getActiveEmergencyContactUids(mainUserUid);
        if (ecUids.length) {
          const tokens = (await Promise.all(ecUids.map(getFcmTokensForUser))).flat();
          await sendPushToTokens(
            tokens,
            {
              title: "Life Signal: calling now",
              body: `${mainUserName} missed a check-in. We are calling you now.`,
            },
            { type: "missed_checkin_calling", mainUserUid }
          );
        }
      } catch (e) {
        logger.warn("call_immediately push failed (non-fatal)", (e as any)?.message);
      }

      // Call now (guard E.164)
      if (!isE164(String(contactPhone))) {
        logger.warn("Immediate call skipped: non-E.164 phone", { mainUserUid, contactPhone });
      } else {
        const clientState = Buffer
          .from(JSON.stringify({ mainUserUid, emergencyContactUid, reason: "escalation" }))
          .toString("base64");

        await axios.post(
          `${TELNYX_API}/calls`,
          {
            connection_id: appId, // Voice API App ID
            to: String(contactPhone),
            from,
            client_state: clientState,
          },
          {
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
          }
        );
        escalationsQueued++;
      }
    } else {
      // Real push to ALL active ECs, then schedule Telnyx call
      try {
        const ecUids = await getActiveEmergencyContactUids(mainUserUid);
        if (ecUids.length) {
          const allTokens = (await Promise.all(ecUids.map((id) => getFcmTokensForUser(id)))).flat();
          await sendPushToTokens(
            allTokens,
            {
              title: "Life Signal: missed check-in",
              body: `${mainUserName} missed a check-in. We’ll place a call shortly.`,
            },
            { type: "missed_checkin", mainUserUid }
          );
        } else {
          logger.warn("No ACTIVE EC UIDs found for push", { mainUserUid });
        }
      } catch (e) {
        logger.warn("push_then_call push failed (non-fatal)", (e as any)?.message);
      }

      // Then schedule the call (store as Timestamp/Date)
      const nextActionAt = new Date(Date.now() + Number(policy.callDelaySec || 60) * 1000);
      await db.collection("escalations").add({
        mainUserUid,
        emergencyContactUid,
        contactPhone: String(contactPhone),
        stage: "waiting_for_call",
        nextActionAt, // Firestore Timestamp/Date
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    processed.push(mainUserUid);
  }

  // Perform scheduled call stage
  const dueEsc = await db
    .collection("escalations")
    .where("stage", "==", "waiting_for_call")
    .where("nextActionAt", "<=", new Date())
    .limit(50)
    .get();

  for (const eDoc of dueEsc.docs) {
    const e = eDoc.data() as any;

    const to = String(e.contactPhone || "");
    const from = S_TELNYX_FROM_NUMBER.value() || process.env.TELNYX_FROM_NUMBER;
    const connectionId = S_TELNYX_APPLICATION_ID.value() || process.env.TELNYX_APPLICATION_ID;
    const apiKey = S_TELNYX_API_KEY.value() || process.env.TELNYX_API_KEY;

    if (!isE164(to)) {
      logger.warn("Skipping escalation with non-E.164 phone", { to, id: eDoc.id });
      await eDoc.ref.set(
        { stage: "error", lastError: "Invalid E.164 phone", updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      continue;
    }
    if (!connectionId || !apiKey) {
      logger.error("Missing Telnyx config; cannot place call");
      continue;
    }

    const clientState = Buffer
      .from(JSON.stringify({
        mainUserUid: e.mainUserUid,
        emergencyContactUid: e.emergencyContactUid || null,
        reason: "escalation",
      }))
      .toString("base64");

    await axios.post(
      `${TELNYX_API}/calls`,
      {
        connection_id: connectionId,
        to,
        from,
        client_state: clientState,
      },
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    await eDoc.ref.set(
      { stage: "called", updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  return {
    processed,
    escalationsQueued,
    dueEscProcessed: dueEsc.size,
  };
}

/** ------------------------------------------------------
 *  HTTP endpoint — manual/automation trigger of the job
 *  ------------------------------------------------------ */
export const runEscalationScan = onRequest(
  { secrets: [S_TELNYX_API_KEY, S_TELNYX_APPLICATION_ID, S_TELNYX_FROM_NUMBER] },
  async (req, res) => {
    try {
      const out = await runEscalationScanJob(req.body || {});
      res.json({ ok: true, ...out });
    } catch (err: any) {
      logger.error("runEscalationScan HTTP error", err?.message);
      res.status(500).json({ ok: false, error: err?.message });
    }
  }
);

/** ------------------------------------------------------
 *  SCHEDULED function — KEEP THE ORIGINAL NAME
 *  ------------------------------------------------------ */
export const checkMissedCheckins = onSchedule(
  {
    region: "us-central1",
    schedule: "every 5 minutes",
    timeZone: "Etc/UTC",
    secrets: [S_TELNYX_API_KEY, S_TELNYX_APPLICATION_ID, S_TELNYX_FROM_NUMBER],
  },
  async () => {
    try {
      const out = await runEscalationScanJob({});
      logger.info("checkMissedCheckins summary", out);
    } catch (err: any) {
      logger.error("checkMissedCheckins failed", err?.message);
    }
  }
);
