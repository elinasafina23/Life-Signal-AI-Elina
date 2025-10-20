// ─────────────────────────────────────────────────────────────────────────────
// /src/app/api/voice-message/send/route.ts
// Direct voice message endpoint.
// Supports TWO flows in one place:
//
//   A) MAIN USER  -> send to ONE emergency contact (targetContact: {email|phone})
//   B) EMERGENCY CONTACT -> send to ONE main user (sendToUid: string)
//
// We intentionally DO NOT broadcast here. For broadcast, use
// /api/voice-check-in/notify.
// ─────────────────────────────────────────────────────────────────────────────

// (1) Force Node runtime so firebase-admin works.
export const runtime = "nodejs";

// (2) Always dynamic — no static caching of API responses.
export const dynamic = "force-dynamic";

// (3) Next server types
import { NextRequest, NextResponse } from "next/server";

// (4) Firestore server helpers (timestamps etc.)
import { FieldValue } from "firebase-admin/firestore";

// (5) FCM (optional push notifications)
import { getMessaging } from "firebase-admin/messaging";

// (6) Admin SDK (already initialized in your project lib)
import { adminAuth, db } from "@/lib/firebaseAdmin";

// (7) Role normalization helper
import { normalizeRole } from "@/lib/roles";

// ─────────────────────────────────────────────────────────────────────────────
// Normalizers
// ─────────────────────────────────────────────────────────────────────────────

// (8) Lowercase + trim email for consistent matching.
function normalizeEmail(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

// (9) Keep + and digits only; coerce "00" prefix to "+"; collapse extra "+".
function normalizePhone(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (!t) return "";
  let n = t.replace(/[^\d+]/g, "");
  if (n.startsWith("+")) return `+${n.slice(1).replace(/\+/g, "")}`;
  n = n.replace(/\+/g, "");
  if (n.startsWith("00") && n.length > 2) return `+${n.slice(2)}`;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

// (10) Verify Firebase session cookie and return uid + normalized role + userData.
//      We allow both "main_user" and "emergency_contact" to call this route,
//      and branch behavior inside POST.
async function requireUser(req: NextRequest): Promise<{
  uid: string;
  role: "main_user" | "emergency_contact" | "admin" | "unknown";
  userData: any | null;
}> {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");

  const decoded = await adminAuth
    .verifySessionCookie(cookie, true)
    .catch(() => {
      throw new Error("UNAUTHENTICATED");
    });

  const snap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((snap.data() as any)?.role) || "unknown";
  return {
    uid: decoded.uid as string,
    role: role as any,
    userData: (snap.data() as any) || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

// (11) Gather FCM tokens under users/{uid}/devices; dedupe; ignore disabled.
async function getFcmTokensForUser(uid: string): Promise<string[]> {
  try {
    const snap = await db.collection(`users/${uid}/devices`).get();
    const tokens = new Set<string>();
    snap.forEach((d) => {
      const x = d.data() as any;
      const t = String(x?.fcmToken || x?.token || "").trim();
      if (!x?.disabled && t) tokens.add(t);
    });
    return Array.from(tokens);
  } catch {
    return [];
  }
}

// (12) Send a single-recipient push (multicast API used for convenience).
async function sendPushToOne(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, string>
) {
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

// (13) Check that an EC is actively linked to a main user.
async function verifyLink(mainUserUid: string, emergencyContactUid: string): Promise<boolean> {
  const snap = await db
    .collection(`users/${mainUserUid}/emergency_contact`)
    .where("emergencyContactUid", "==", emergencyContactUid)
    .where("status", "==", "ACTIVE")
    .limit(1)
    .get();
  return !snap.empty;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // (14) Who is calling? (main_user or emergency_contact)
    const { uid: callerUid, role, userData } = await requireUser(req);

    // (15) Parse payload
    const body = await req.json().catch(() => ({} as any));

    // (16) Required transcript
    const transcript = String(body?.transcribedSpeech || "").trim();

    // (17) Required AI assessment (from /api/voice-check-in)
    const assessment = body?.assessment as
      | { anomalyDetected: boolean; explanation: string }
      | undefined;

    // (18) Optional audio clip as data URL
    const audioDataUrlRaw =
      typeof body?.audioDataUrl === "string" ? body.audioDataUrl.trim() : "";

    // (19) MAIN USER path: contact selector
    const targetRaw = (body?.targetContact ?? null) as null | {
      email?: unknown;
      phone?: unknown;
    };
    const targetEmail = normalizeEmail(targetRaw?.email);
    const targetPhone = normalizePhone(targetRaw?.phone);

    // (20) EMERGENCY CONTACT path: main user to send to
    const sendToUid = typeof body?.sendToUid === "string" ? body.sendToUid.trim() : "";

    // (21) Validate transcript + assessment
    if (!transcript)
      return NextResponse.json({ error: "transcribedSpeech is required" }, { status: 400 });
    if (!assessment?.explanation?.trim())
      return NextResponse.json({ error: "assessment.explanation is required" }, { status: 400 });

    // (22) Validate audio format if present
    let audioDataUrl: string | null = null;
    if (audioDataUrlRaw) {
      if (!/^data:audio\//i.test(audioDataUrlRaw)) {
        return NextResponse.json(
          { error: "audioDataUrl must be a base64-encoded data URL (data:audio/...)" },
          { status: 400 }
        );
      }
      audioDataUrl = audioDataUrlRaw;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // A) MAIN USER  → send to ONE EC
    // ─────────────────────────────────────────────────────────────────────────
    if (role === "main_user") {
      const mainUserUid = callerUid;

      // (23) Require some target
      if (!targetEmail && !targetPhone) {
        return NextResponse.json(
          { error: "targetContact (email or phone) is required" },
          { status: 400 }
        );
      }

      // (24) Load both mirrors of EC links (top-level + subcollection)
      const [topSnap, subSnap] = await Promise.all([
        db.collection("emergencyContacts").where("mainUserUid", "==", mainUserUid).get(),
        db.collection(`users/${mainUserUid}/emergency_contact`).get(),
      ]);

      // (25) Helper: pull all potential keys from a doc
      type LinkDoc = {
        ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
        data: any;
        scope: "top" | "sub";
      };
      const extract = (d: any) => {
        const emails = [
          normalizeEmail(d?.email),
          normalizeEmail(d?.emergencyContactEmail),
          normalizeEmail(d?.contactEmail),
        ].filter(Boolean);
        const phones = [normalizePhone(d?.phone), normalizePhone(d?.contactPhone)].filter(Boolean);
        const ecUid =
          typeof d?.emergencyContactUid === "string" ? d.emergencyContactUid.trim() : "";
        return { emails, phones, ecUid };
      };

      // (26) Find matches by email/phone across BOTH sets
      const matches: LinkDoc[] = [];
      topSnap.docs.forEach((docSnap) => {
        const d = docSnap.data();
        const { emails, phones } = extract(d);
        const emailOk = targetEmail ? emails.includes(targetEmail) : false;
        const phoneOk = targetPhone ? phones.includes(targetPhone) : false;
        if ((targetEmail && emailOk) || (targetPhone && phoneOk)) {
          matches.push({ ref: docSnap.ref, data: d, scope: "top" });
        }
      });
      subSnap.docs.forEach((docSnap) => {
        const d = docSnap.data();
        const { emails, phones } = extract(d);
        const emailOk = targetEmail ? emails.includes(targetEmail) : false;
        const phoneOk = targetPhone ? phones.includes(targetPhone) : false;
        if ((targetEmail && emailOk) || (targetPhone && phoneOk)) {
          matches.push({ ref: docSnap.ref, data: d, scope: "sub" });
        }
      });

      // (27) Group by emergencyContactUid so we only touch THAT contact’s mirror docs
      const byEcUid = new Map<string, LinkDoc[]>();
      for (const row of matches) {
        const key =
          (typeof row.data?.emergencyContactUid === "string" &&
            row.data.emergencyContactUid.trim()) ||
          `__unknown__:${row.ref.path}`;
        const list = byEcUid.get(key) || [];
        list.push(row);
        byEcUid.set(key, list);
      }

      // (28) Ensure exactly one contact matched
      if (byEcUid.size === 0) {
        return NextResponse.json(
          { error: "Target emergency contact not found for this user" },
          { status: 404 }
        );
      }
      if (byEcUid.size > 1) {
        return NextResponse.json(
          {
            error:
              "Multiple contacts matched the provided email/phone. Please disambiguate (use a unique email or phone).",
          },
          { status: 409 }
        );
      }

      // (29) Single “winner” and its mirror docs
      const [[targetEcUid, mirrorDocs]] = Array.from(byEcUid.entries());

      // (30) Build the direct payload
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const payload = {
        transcript,
        explanation: assessment.explanation.trim(),
        anomalyDetected: Boolean(assessment.anomalyDetected),
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        audioUrl: audioDataUrl ?? null,
        audience: "direct" as const,
        targetEmergencyContactUid: targetEcUid.startsWith("__unknown__") ? null : targetEcUid,
        targetEmergencyContactEmail: targetEmail || null,
        targetEmergencyContactPhone: targetPhone || null,
      };

      // (31) IMPORTANT: only write to the matched contact’s mirror docs.
      //      Do NOT overwrite users/{mainUserUid}.latestVoiceMessage (that’s for broadcast).
      const batch = db.batch();
      for (const { ref } of mirrorDocs) {
        batch.set(
          ref,
          { lastVoiceMessage: payload, updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
      await batch.commit();

      // (32) Optional push to JUST that EC
      let pushResult: { successCount: number; failureCount: number } | null = null;
      const ecUidForPush = targetEcUid.startsWith("__unknown__") ? "" : targetEcUid;
      if (ecUidForPush) {
        const tokens = await getFcmTokensForUser(ecUidForPush);
        if (tokens.length) {
          const mainUserName =
            (userData?.firstName || userData?.lastName)
              ? `${userData?.firstName || ""} ${userData?.lastName || ""}`.trim()
              : "your contact";
          pushResult = await sendPushToOne(
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

      return NextResponse.json({
        ok: true,
        updatedDocs: mirrorDocs.length,
        mirrors: mirrorDocs.map((m) => ({ scope: m.scope, path: m.ref.path })),
        pushed: Boolean(pushResult),
        pushSuccess: pushResult?.successCount ?? 0,
        pushFailure: pushResult?.failureCount ?? 0,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // B) EMERGENCY CONTACT  → send to ONE MAIN USER
    // ─────────────────────────────────────────────────────────────────────────
    if (role === "emergency_contact") {
      // (33) Require the main user UID to send to
      if (!sendToUid) {
        return NextResponse.json(
          { error: "sendToUid is required when an emergency contact sends a message" },
          { status: 400 }
        );
      }

      // (34) Ensure this EC is actively linked to that main user
      const linked = await verifyLink(sendToUid, callerUid);
      if (!linked) {
        return NextResponse.json({ error: "Not authorized to message this user" }, { status: 403 });
      }

      // (35) Build payload intended for the MAIN USER dashboard
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const payloadForMain = {
        transcript,
        explanation: assessment.explanation.trim(),
        anomalyDetected: Boolean(assessment.anomalyDetected),
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        audioUrl: audioDataUrl ?? null,
        audience: "from_emergency_contact" as const,
        fromEmergencyContactUid: callerUid,
        fromEmail: userData?.email ? normalizeEmail(userData.email) : null,
        isRead: false,
      };

      // (36) Persist the full message to users/{sendToUid}/contactVoiceMessages/{AUTO_ID}
      const newMessageRef = db.collection(`users/${sendToUid}/contactVoiceMessages`).doc();
      await newMessageRef.set(payloadForMain);

      // (37) Optionally: push to the main user here (omitted for now).

      return NextResponse.json({ ok: true, messageId: newMessageRef.id, mainUserUid: sendToUid });
    }


    // (38) Any other role: not allowed
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  } catch (err: any) {
    // (39) Map UNAUTHENTICATED -> 401; else 500
    if (err?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    console.error("[voice-message/send] failed:", err);
    return NextResponse.json({ error: err?.message || "Failed to send" }, { status: 500 });
  }
}
