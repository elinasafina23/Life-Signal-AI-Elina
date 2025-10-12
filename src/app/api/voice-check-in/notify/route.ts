export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { adminAuth, db } from "@/lib/firebaseAdmin";
import { isMainUserRole, normalizeRole } from "@/lib/roles";

interface AssessVoiceCheckInOutput {
  anomalyDetected: boolean;
  explanation: string;
}

async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) {
    throw new Error("UNAUTHENTICATED");
  }

  let decoded;
  try {
    decoded = await adminAuth.verifySessionCookie(cookie, true);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((userSnap.data() as any)?.role);
  if (!isMainUserRole(role || undefined)) {
    throw new Error("NOT_AUTHORIZED");
  }

  return { uid: decoded.uid as string };
}

export async function POST(req: NextRequest) {
  try {
    const { uid: mainUserUid } = await requireMainUser(req);
    const body = await req.json().catch(() => ({} as any));

    const transcriptRaw = body?.transcribedSpeech;
    const assessment = body?.assessment as AssessVoiceCheckInOutput | undefined;

    const transcript = typeof transcriptRaw === "string" ? transcriptRaw.trim() : "";
    if (!transcript) {
      return NextResponse.json({ error: "transcribedSpeech is required" }, { status: 400 });
    }

    if (!assessment || typeof assessment !== "object") {
      return NextResponse.json({ error: "assessment is required" }, { status: 400 });
    }

    const explanation = typeof assessment.explanation === "string" ? assessment.explanation.trim() : "";
    if (!explanation) {
      return NextResponse.json({ error: "assessment.explanation is required" }, { status: 400 });
    }

    const anomalyDetected = Boolean(assessment.anomalyDetected);

    const contactsSnap = await db
      .collection("emergencyContacts")
      .where("mainUserUid", "==", mainUserUid)
      .where("status", "==", "ACTIVE")
      .get();

    const batch = db.batch();

    const voiceMessageRef = db
      .collection("users")
      .doc(mainUserUid)
      .collection("voiceMessages")
      .doc();

    batch.set(voiceMessageRef, {
      transcript,
      explanation,
      anomalyDetected,
      createdAt: FieldValue.serverTimestamp(),
    });

    const userRef = db.doc(`users/${mainUserUid}`);
    batch.set(
      userRef,
      {
        latestVoiceMessage: {
          transcript,
          explanation,
          anomalyDetected,
          createdAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    contactsSnap.forEach((docSnap) => {
      batch.set(
        docSnap.ref,
        {
          lastVoiceMessage: {
            transcript,
            explanation,
            anomalyDetected,
            createdAt: FieldValue.serverTimestamp(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    await batch.commit();

    return NextResponse.json({ ok: true, contactCount: contactsSnap.size });
  } catch (error: any) {
    if (error?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (error?.message === "NOT_AUTHORIZED") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    console.error("[voice-check-in notify] failed:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to send voice message" },
      { status: 500 }
    );
  }
}
