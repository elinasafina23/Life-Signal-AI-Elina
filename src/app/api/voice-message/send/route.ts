// src/app/api/voice-message/send/route.ts
// ① Ensure this route runs on the Node runtime (so we can use firebase-admin etc.)
export const runtime = "nodejs";
// ② Always render dynamically (no static caching) so each request is processed fresh.
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";           // ③ Next.js request/response types
import { FieldValue } from "firebase-admin/firestore";              // ④ Server-side Firestore helpers (timestamps, etc.)
import { getMessaging } from "firebase-admin/messaging";            // ⑤ FCM multicast (optional push to ONE EC)
import { adminAuth, db } from "@/lib/firebaseAdmin";                // ⑥ Admin SDK (server) — initialized in your lib
import { isMainUserRole, normalizeRole } from "@/lib/roles";        // ⑦ Role helpers

/* ───────────────────────────── Normalizers ───────────────────────────── */

// ⑧ Normalize emails to lower-case and trim whitespace for consistent matching.
function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// ⑨ Normalize phones to a simple E.164-like string (keep + and digits only; collapse extra +).
function normalizePhone(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  let n = trimmed.replace(/[^\d+]/g, "");      // keep only + and digits
  if (n.startsWith("+")) return `+${n.slice(1).replace(/\+/g, "")}`; // ensure at most one leading '+'
  n = n.replace(/\+/g, "");                    // no '+': remove all others
  if (n.startsWith("00") && n.length > 2) return `+${n.slice(2)}`;   // convert "00" intl prefix to '+'
  return n;
}

/* ───────────────────────────── AuthZ ───────────────────────────── */

// ⑩ Verify the caller is an authenticated MAIN USER via the Firebase Session Cookie.
//    - This prevents an EC (or anonymous client) from sending targeted messages as the main user.
async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";     // ⑪ Read Firebase session cookie set by your auth flow
  if (!cookie) throw new Error("UNAUTHENTICATED");               // ⑫ No cookie → reject
  const decoded = await adminAuth
    .verifySessionCookie(cookie, true)                           // ⑬ Verify & refresh check
    .catch(() => {
      throw new Error("UNAUTHENTICATED");                        // ⑭ Invalid/expired cookie → reject
    });

  const snap = await db.doc(`users/${decoded.uid}`).get();       // ⑮ Load caller user doc
  const role = normalizeRole((snap.data() as any)?.role);        // ⑯ Normalize role
  if (!isMainUserRole(role || undefined))                        // ⑰ Only main user can call this route
    throw new Error("NOT_AUTHORIZED");
  return { uid: decoded.uid as string, userData: (snap.data() as any) || null };
}

/* ───────────────────────────── Utilities ───────────────────────────── */

// ⑱ Collect all FCM tokens for a given user (best-effort, deduped).
async function getFcmTokensForUser(uid: string): Promise<string[]> {
  try {
    const snap = await db.collection(`users/${uid}/devices`).get();
    const tokens = new Set<string>();
    snap.forEach((doc) => {
      const d = doc.data() as any;
      const t = String(d?.fcmToken || d?.token || "").trim();
      if (!d?.disabled && t) tokens.add(t);
    });
    return Array.from(tokens);
  } catch {
    return [];
  }
}

// ⑲ Send a *single-recipient* push (we still use multicast API for simplicity).
async function sendPushToOneEc(tokens: string[], title: string, body: string, data: Record<string,string>) {
  const uniq = Array.from(new Set(tokens.filter(Boolean)));
  if (!uniq.length) return { successCount: 0, failureCount: 0 };
  const messaging = getMessaging();
  const resp = await messaging.sendEachForMulticast({
    tokens: uniq,
    notification: { title, body },
    data,
    android: { priority: "high" },
    apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
  });
  return { successCount: resp.successCount, failureCount: resp.failureCount };
}

/* ───────────────────────────── Handler ───────────────────────────── */

// ⑳ Handle targeted voice message sends (to exactly ONE emergency contact).
export async function POST(req: NextRequest) {
  try {
    // ㉑ Authorization: must be a main user
    const { uid: mainUserUid, userData } = await requireMainUser(req);

    // ㉒ Parse payload from client
    const body = await req.json().catch(() => ({} as any));

    // ㉓ Required: transcript (the user's message text)
    const transcript = String(body?.transcribedSpeech || "").trim();

    // ㉔ Required: assessment (AI explanation + anomaly flag) from /api/voice-check-in step
    const assessment = body?.assessment as
      | { anomalyDetected: boolean; explanation: string }
      | undefined;

    // ㉕ Optional: audio recording as a base64 data URL ("data:audio/…;base64,…")
    const audioDataUrlRaw = typeof body?.audioDataUrl === "string" ? body.audioDataUrl.trim() : "";

    // ㉖ Required: target contact info { email?, phone? } – at least one must be provided
    const targetRaw = (body?.targetContact ?? null) as null | { email?: unknown; phone?: unknown };
    const targetEmail = normalizeEmail(targetRaw?.email);
    const targetPhone = normalizePhone(targetRaw?.phone);

    // ㉗ Validate: transcript present
    if (!transcript) {
      return NextResponse.json({ error: "transcribedSpeech is required" }, { status: 400 });
    }
    // ㉘ Validate: assessment explanation present
    if (!assessment?.explanation?.trim()) {
      return NextResponse.json({ error: "assessment.explanation is required" }, { status: 400 });
    }
    // ㉙ Validate: target present (email or phone)
    if (!targetEmail && !targetPhone) {
      return NextResponse.json({ error: "targetContact (email or phone) is required" }, { status: 400 });
    }

    // ㉚ Validate audio data URL format if provided
    let audioDataUrl: string | null = null;
    if (audioDataUrlRaw) {
      if (!/^data:audio\//i.test(audioDataUrlRaw)) {
        return NextResponse.json(
          { error: "audioDataUrl must be a base64-encoded data URL (data:audio/...)" },
          { status: 400 },
        );
      }
      audioDataUrl = audioDataUrlRaw;
    }

    // ㉛ Fetch TWO mirrors of EC links:
    //     A) Top-level `/emergencyContacts` (often used by admin/push flows; some installs mark ACTIVE there)
    //     B) Per-main-user subcollection `/users/{mainUserUid}/emergency_contact/*` (what EC dashboard usually reads)
    const [topSnap, subSnap] = await Promise.all([
      db
        .collection("emergencyContacts")
        .where("mainUserUid", "==", mainUserUid)
        .get(), // ← no status filter here; we’ll filter by match next
      db.collection(`users/${mainUserUid}/emergency_contact`).get(),
    ]);

    // ㉜ Find the *single* intended contact by email/phone across BOTH sets.
    //     We match using normalized email/phone, and then dedupe by emergencyContactUid if available.
    type LinkDoc = {
      ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
      data: any;
      scope: "top" | "sub";
    };

    // ㉝ Helper to normalize potential email/phone fields from a doc
    const extractKeys = (d: any) => {
      const emails = [
        normalizeEmail(d?.email),
        normalizeEmail(d?.emergencyContactEmail),
        normalizeEmail(d?.contactEmail),
      ].filter(Boolean);
      const phones = [
        normalizePhone(d?.phone),
        normalizePhone(d?.contactPhone),
      ].filter(Boolean);
      const ecUid = typeof d?.emergencyContactUid === "string" ? d.emergencyContactUid.trim() : "";
      return { emails, phones, ecUid };
    };

    const topMatches: LinkDoc[] = [];
    topSnap.docs.forEach((docSnap) => {
      const d = docSnap.data();
      const { emails, phones } = extractKeys(d);
      const emailOk = targetEmail ? emails.includes(targetEmail) : false;
      const phoneOk = targetPhone ? phones.includes(targetPhone) : false;
      if ((targetEmail && emailOk) || (targetPhone && phoneOk)) {
        topMatches.push({ ref: docSnap.ref, data: d, scope: "top" });
      }
    });

    const subMatches: LinkDoc[] = [];
    subSnap.docs.forEach((docSnap) => {
      const d = docSnap.data();
      const { emails, phones } = extractKeys(d);
      const emailOk = targetEmail ? emails.includes(targetEmail) : false;
      const phoneOk = targetPhone ? phones.includes(targetPhone) : false;
      if ((targetEmail && emailOk) || (targetPhone && phoneOk)) {
        subMatches.push({ ref: docSnap.ref, data: d, scope: "sub" });
      }
    });

    // ㉞ Combine & dedupe by emergencyContactUid (so we can update both mirror docs for the SAME EC).
    const byEcUid = new Map<string, LinkDoc[]>();
    const pushInto = (arr: LinkDoc[]) => {
      arr.forEach((row) => {
        const ecUid =
          (typeof row.data?.emergencyContactUid === "string" && row.data.emergencyContactUid.trim()) ||
          `__unknown__:${row.ref.path}`; // fallback key if uid missing (rare)
        const list = byEcUid.get(ecUid) || [];
        list.push(row);
        byEcUid.set(ecUid, list);
      });
    };
    pushInto(topMatches);
    pushInto(subMatches);

    // ㉟ We expect EXACTLY ONE emergencyContactUid group to match.
    if (byEcUid.size === 0) {
      return NextResponse.json(
        { error: "Target emergency contact not found for this user" },
        { status: 404 },
      );
    }
    if (byEcUid.size > 1) {
      // ㊱ Safety: two (or more) different EC UIDs matched the query → ambiguous; ask client to disambiguate.
      return NextResponse.json(
        {
          error:
            "Multiple contacts matched the provided email/phone. Please disambiguate (use a unique email or phone).",
          matchedGroups: Array.from(byEcUid.keys()),
        },
        { status: 409 },
      );
    }

    // ㊲ Extract the single winning group (and its mirror docs)
    const [[targetEcUid, mirrorDocs]] = Array.from(byEcUid.entries());

    // ㊳ Prepare the payload to write (DIRECT message — NOT a broadcast).
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h TTL for UI
    const payload = {
      transcript,
      explanation: assessment.explanation.trim(),
      anomalyDetected: Boolean(assessment.anomalyDetected),
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      audioDataUrl: audioDataUrl ?? null,

      // ㊴ Direct-target metadata so dashboards can filter correctly.
      audience: "direct" as const,
      targetEmergencyContactUid: targetEcUid.startsWith("__unknown__") ? null : targetEcUid,
      targetEmergencyContactEmail: targetEmail || null,
      targetEmergencyContactPhone: targetPhone || null,
    };

    // ㊵ IMPORTANT: For a *direct* message we DO NOT overwrite the main user’s
    //     `users/{mainUserUid}.latestVoiceMessage` (that would make *all* ECs see it).
    //     Instead, we only write to the matched mirror docs (top + sub) for THIS EC.
    const batch = db.batch();

    // ㊶ Update *each* mirror doc for the same EC (both layers, if they exist)
    for (const { ref } of mirrorDocs) {
      batch.set(
        ref,
        { lastVoiceMessage: payload, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }

    // ㊷ (Optional) If you still want to persist the user's "latest" history document,
    //     you can write to a *separate* history collection (NOT the dashboard mirror).
    //     Example (commented out):
    // const historyRef = db
    //   .collection("users").doc(mainUserUid)
    //   .collection("voiceMessagesHistory").doc(); // auto-id
    // batch.set(historyRef, { ...payload, mainUserUid });

    await batch.commit();

    // ㊸ OPTIONAL: Push only to the ONE targeted EC (best-effort; ignore failures).
    //     If we know the EC uid, we can load their device tokens.
    let pushResult: { successCount: number; failureCount: number } | null = null;
    const ecUidForPush = targetEcUid.startsWith("__unknown__") ? "" : targetEcUid;
    if (ecUidForPush) {
      const tokens = await getFcmTokensForUser(ecUidForPush);
      if (tokens.length) {
        const mainUserName =
          (userData?.firstName || userData?.lastName)
            ? `${userData?.firstName || ""} ${userData?.lastName || ""}`.trim()
            : "your contact";

        pushResult = await sendPushToOneEc(
          tokens,
          "New voice message",
          `${mainUserName} sent you a private voice update.`,
          {
            type: "voice_message_direct",
            mainUserUid,
            targetEmergencyContactUid: ecUidForPush,
          }
        );
      }
    }

    // ㊹ Respond with details: counts & which doc paths were updated (useful for debugging).
    return NextResponse.json({
      ok: true,
      updatedDocs: mirrorDocs.length,                           // number of mirror docs updated
      mirrors: mirrorDocs.map((m) => ({ scope: m.scope, path: m.ref.path })), // which docs
      pushed: Boolean(pushResult),
      pushSuccess: pushResult?.successCount ?? 0,
      pushFailure: pushResult?.failureCount ?? 0,
    });
  } catch (error: any) {
    // ㊺ Map auth errors to 401/403; everything else is 500 with a generic message.
    if (error?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (error?.message === "NOT_AUTHORIZED") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    console.error("[voice-message/send] failed:", error);
    return NextResponse.json({ error: error?.message || "Failed to send" }, { status: 500 });
  }
}
