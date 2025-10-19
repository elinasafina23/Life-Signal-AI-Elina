export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, db } from "@/lib/firebaseAdmin";
import { isMainUserRole, normalizeRole } from "@/lib/roles";

/** -------- helpers ---------- */
function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function normalizePhone(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // keep + and digits; collapse extra +
  let n = trimmed.replace(/[^\d+]/g, "");
  if (n.startsWith("+")) return `+${n.slice(1).replace(/\+/g, "")}`;
  n = n.replace(/\+/g, "");
  if (n.startsWith("00") && n.length > 2) return `+${n.slice(2)}`;
  return n;
}

async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");
  const decoded = await adminAuth.verifySessionCookie(cookie, true).catch(() => {
    throw new Error("UNAUTHENTICATED");
  });
  const snap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((snap.data() as any)?.role);
  if (!isMainUserRole(role || undefined)) throw new Error("NOT_AUTHORIZED");
  return { uid: decoded.uid as string };
}

/** -------- POST (targeted send) ---------- */
export async function POST(req: NextRequest) {
  try {
    const { uid: mainUserUid } = await requireMainUser(req);
    const body = await req.json().catch(() => ({} as any));

    const transcript = String(body?.transcribedSpeech || "").trim();
    const assessment = body?.assessment as { anomalyDetected: boolean; explanation: string } | undefined;
    const audioDataUrlRaw = typeof body?.audioDataUrl === "string" ? body.audioDataUrl.trim() : "";

    const targetRaw = (body?.targetContact ?? null) as null | { email?: unknown; phone?: unknown };
    const targetEmail = normalizeEmail(targetRaw?.email);
    const targetPhone = normalizePhone(targetRaw?.phone);

    if (!transcript) {
      return NextResponse.json({ error: "transcribedSpeech is required" }, { status: 400 });
    }
    if (!assessment?.explanation?.trim()) {
      return NextResponse.json({ error: "assessment.explanation is required" }, { status: 400 });
    }
    if (!targetEmail && !targetPhone) {
      return NextResponse.json({ error: "targetContact (email or phone) is required" }, { status: 400 });
    }

    let audioDataUrl: string | null = null;
    if (audioDataUrlRaw) {
      if (!/^data:audio\//i.test(audioDataUrlRaw)) {
        return NextResponse.json(
          { error: "audioDataUrl must be a base64-encoded data URL" },
          { status: 400 },
        );
      }
      audioDataUrl = audioDataUrlRaw;
    }

    // Load ACTIVE contacts for this main user (top-level mirror)
    const allSnap = await db
      .collection("emergencyContacts")
      .where("mainUserUid", "==", mainUserUid)
      .where("status", "==", "ACTIVE")
      .get();

    // Strict matching: email and/or phone
    const candidates = allSnap.docs.filter((docSnap) => {
      const d = docSnap.data() as any;
      const emails = [
        normalizeEmail(d?.email),
        normalizeEmail(d?.emergencyContactEmail),
        normalizeEmail(d?.contactEmail),
      ];
      const phones = [normalizePhone(d?.phone)];
      const emailOk = targetEmail ? emails.includes(targetEmail) : false;
      const phoneOk = targetPhone ? phones.includes(targetPhone) : false;
      // If both provided -> require at least one to match, but prefer both
      if (targetEmail && targetPhone) {
        return emailOk || phoneOk;
      }
      return emailOk || phoneOk;
    });

    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "Target emergency contact not found for this user" },
        { status: 404 },
      );
    }
    if (candidates.length > 1) {
      // Safety: avoid accidental fan-out if bad data makes duplicates.
      return NextResponse.json(
        {
          error:
            "Multiple contacts matched the provided email/phone. Please disambiguate (use a unique email or phone).",
          matchedCount: candidates.length,
        },
        { status: 409 },
      );
    }

    const contactDoc = candidates[0]; // exactly one
    const contactData = contactDoc.data() as any;
    const targetEmergencyContactUidRaw = contactData?.emergencyContactUid;
    const targetEmergencyContactUid =
      typeof targetEmergencyContactUidRaw === "string"
        ? targetEmergencyContactUidRaw.trim()
        : "";
    const contactEmailFallback =
      normalizeEmail(contactData?.email) ||
      normalizeEmail(contactData?.emergencyContactEmail) ||
      normalizeEmail(contactData?.contactEmail);
    const contactPhoneFallback = normalizePhone(contactData?.phone);

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const userRef = db.doc(`users/${mainUserUid}`);

    const payload = {
      transcript,
      explanation: assessment.explanation.trim(),
      anomalyDetected: Boolean(assessment.anomalyDetected),
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      audioDataUrl: audioDataUrl ?? null,
      audience: "targeted" as const,
      targetEmergencyContactUid: targetEmergencyContactUid || null,
      targetEmergencyContactEmail: targetEmail || contactEmailFallback || null,
      targetEmergencyContactPhone: targetPhone || contactPhoneFallback || null,
    };

    // Write:
    // 1) latest voice (for the main user's dashboard history)
    // 2) ONLY the matched contact's lastVoiceMessage (no fan-out!)
    const batch = db.batch();
    let updatedDocs = 0;
    const latestRef = db
      .collection("users").doc(mainUserUid)
      .collection("voiceMessages").doc("latest");

    batch.set(latestRef, payload);
    updatedDocs++;
    batch.set(
      userRef,
      { latestVoiceMessage: payload, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    updatedDocs++;
    batch.set(
      contactDoc.ref,
      { lastVoiceMessage: payload, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    updatedDocs++;

    if (targetEmergencyContactUid) {
      const linkDocRef = db.doc(
        `users/${mainUserUid}/emergency_contact/${targetEmergencyContactUid}`,
      );
      batch.set(
        linkDocRef,
        { lastVoiceMessage: payload, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      updatedDocs++;
    }

    await batch.commit();

    // No broadcast push here. (If you later want *optional* push to that ONE EC, do it here.)
    return NextResponse.json({
      ok: true,
      updatedDocs,
      contactId: contactDoc.id,
    });
  } catch (error: any) {
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
