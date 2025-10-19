// /src/app/api/voice-check-in/notify/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { adminAuth, db } from "@/lib/firebaseAdmin";
import { isMainUserRole, normalizeRole } from "@/lib/roles";

/* ───────────────────────────── Helpers ───────────────────────────── */

// Normalize/compare emails in lower-case.
function normalizeEmailValue(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

// Normalize phones to a simple E.164-like string (keep + and digits).
function normalizePhoneValue(v: unknown): string {
  if (typeof v !== "string") return "";
  const trimmed = v.trim();
  if (!trimmed) return "";
  let normalized = trimmed.replace(/[^\d+]/g, "");
  if (normalized.startsWith("+")) {
    return `+${normalized.slice(1).replace(/\+/g, "")}`;
  }
  normalized = normalized.replace(/\+/g, "");
  if (normalized.startsWith("00") && normalized.length > 2) {
    return `+${normalized.slice(2)}`;
  }
  return normalized;
}

// Verify the caller is the main user (via session cookie).
async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");
  const decoded = await adminAuth.verifySessionCookie(cookie, true).catch(() => {
    throw new Error("UNAUTHENTICATED");
  });
  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((userSnap.data() as any)?.role);
  if (!isMainUserRole(role || undefined)) throw new Error("NOT_AUTHORIZED");
  return { uid: decoded.uid as string, userData: userSnap.data() as any | null };
}

// Get all FCM tokens for a user (deduped, best-effort).
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

// Send a multicast push (ignore if no tokens).
async function sendPushToTokens(
  tokens: string[],
  notif: { title: string; body: string },
  data: Record<string, string>
) {
  const uniq = Array.from(new Set(tokens.filter(Boolean)));
  if (!uniq.length) return { successCount: 0, failureCount: 0 };
  const messaging = getMessaging();
  const resp = await messaging.sendEachForMulticast({
    tokens: uniq,
    notification: notif,
    data,
    android: { priority: "high" },
    apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
  });
  return { successCount: resp.successCount, failureCount: resp.failureCount };
}

// Merge ACTIVE contacts from:
//   A) top-level  /emergencyContacts
//   B) subcol     /users/{mainUserUid}/emergency_contact
// Returns both sets so we can mirror writes to each document.
async function fetchAllActiveContacts(mainUserUid: string) {
  const [top, sub] = await Promise.all([
    db
      .collection("emergencyContacts")
      .where("mainUserUid", "==", mainUserUid)
      .where("status", "==", "ACTIVE")
      .get(),
    db
      .collection(`users/${mainUserUid}/emergency_contact`)
      .where("status", "==", "ACTIVE")
      .get(),
  ]);

  return {
    topLevelDocs: top.docs, // docs in /emergencyContacts
    subDocs: sub.docs,      // docs in /users/{uid}/emergency_contact
  };
}

/* ───────────────────────────── Handler ───────────────────────────── */

export async function POST(req: NextRequest) {
  try {
    // 1) AuthZ: only the main user can broadcast voice check-ins.
    const { uid: mainUserUid, userData } = await requireMainUser(req);

    // 2) Parse + validate payload.
    const body = await req.json().catch(() => ({} as any));
    const transcript = String(body?.transcribedSpeech || "").trim();
    const assessment = body?.assessment as
      | { anomalyDetected: boolean; explanation: string }
      | undefined;
    const audioDataUrlRaw =
      typeof body?.audioDataUrl === "string" ? body.audioDataUrl.trim() : "";

    if (!transcript) {
      return NextResponse.json(
        { error: "transcribedSpeech is required" },
        { status: 400 }
      );
    }
    if (!assessment?.explanation) {
      return NextResponse.json(
        { error: "assessment.explanation is required" },
        { status: 400 }
      );
    }

    let audioDataUrl: string | null = null;
    if (audioDataUrlRaw) {
      if (!/^data:audio\//i.test(audioDataUrlRaw)) {
        return NextResponse.json(
          { error: "audioDataUrl must be a base64 data URL (data:audio/...)" },
          { status: 400 }
        );
      }
      audioDataUrl = audioDataUrlRaw;
    }

    // 3) Load all ACTIVE contacts (top-level + subcollection).
    const { topLevelDocs, subDocs } = await fetchAllActiveContacts(mainUserUid);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 4) Build shared payload.
    const sharedVoicePayload = {
      transcript,
      explanation: assessment.explanation.trim(),
      anomalyDetected: Boolean(assessment.anomalyDetected),
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      audioDataUrl: audioDataUrl ?? null,
      audience: "broadcast" as const,
      targetEmergencyContactUid: null,
      targetEmergencyContactEmail: null,
      targetEmergencyContactPhone: null,
    };

    // 5) Write once to the main user + mirror onto every ACTIVE contact doc.
    const batch = db.batch();

    const voiceMessageRef = db
      .collection("users")
      .doc(mainUserUid)
      .collection("voiceMessages")
      .doc("latest");

    batch.set(voiceMessageRef, sharedVoicePayload);
    batch.set(
      db.doc(`users/${mainUserUid}`),
      { latestVoiceMessage: sharedVoicePayload, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    topLevelDocs.forEach((docSnap) => {
      batch.set(
        docSnap.ref,
        { lastVoiceMessage: sharedVoicePayload, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    });
    subDocs.forEach((docSnap) => {
      batch.set(
        docSnap.ref,
        { lastVoiceMessage: sharedVoicePayload, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    });

    await batch.commit();

    // 6) Optional push if anomalyDetected → notify ALL unique EC UIDs.
    const pushSummary = {
      attempted: false,
      contactUidCount: 0,
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
    };

    if (sharedVoicePayload.anomalyDetected) {
      pushSummary.attempted = true;

      const ecUids = new Set<string>();
      for (const d of [...topLevelDocs, ...subDocs]) {
        const data = d.data() as any;
        const ecUid = String(data?.emergencyContactUid || "").trim();
        if (ecUid) ecUids.add(ecUid);
      }
      pushSummary.contactUidCount = ecUids.size;

      // Collect all tokens across all EC UIDs.
      const tokens = (
        await Promise.all([...ecUids].map((id) => getFcmTokensForUser(id)))
      ).flat();
      const uniqueTokens = Array.from(new Set(tokens));
      pushSummary.tokenCount = uniqueTokens.length;

      if (uniqueTokens.length) {
        const mainUserName =
          (userData?.firstName || userData?.lastName)
            ? `${userData?.firstName || ""} ${userData?.lastName || ""}`.trim()
            : "your loved one";

        const { successCount, failureCount } = await sendPushToTokens(
          uniqueTokens,
          {
            title: "Life Signal alert",
            body: `${mainUserName}'s voice check-in sounded unusual. Tap to review.`,
          },
          {
            type: "voice_check_in_anomaly",
            mainUserUid,
            anomalyDetected: "true",
            voiceMessageId: voiceMessageRef.id,
          }
        );
        pushSummary.successCount = successCount;
        pushSummary.failureCount = failureCount;
      }
    }

    // 7) Done.
    return NextResponse.json({
      ok: true,
      contactCount: topLevelDocs.length || subDocs.length,
      anomalyPush: pushSummary,
    });
  } catch (error: any) {
    if (error?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (error?.message === "NOT_AUTHORIZED") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    console.error("[voice-check-in/notify] failed:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to send voice check-in" },
      { status: 500 }
    );
  }
}
