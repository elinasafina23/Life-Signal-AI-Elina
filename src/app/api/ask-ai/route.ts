export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { runAskAiAssistant } from "@/ai/flows/ask-ai-assistant";
import { adminAuth, db } from "@/lib/firebaseAdmin";
import { isMainUserRole, normalizeRole } from "@/lib/roles";

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
    const { uid } = await requireMainUser(req);
    const body = await req.json().catch(() => ({} as any));

    const questionRaw = typeof body?.question === "string" ? body.question.trim() : "";
    if (!questionRaw) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const aiResult = await runAskAiAssistant({ question: questionRaw });

    const moodSummary = {
      mood: aiResult.mood,
      description: aiResult.moodDescription ?? "",
      updatedAt: FieldValue.serverTimestamp(),
      source: "ask-ai" as const,
    };

    const userRef = db.doc(`users/${uid}`);
    const contactsSnap = await db
      .collection("emergencyContacts")
      .where("mainUserUid", "==", uid)
      .where("status", "==", "ACTIVE")
      .get();

    const batch = db.batch();
    batch.set(
      userRef,
      {
        latestMoodAssessment: moodSummary,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    contactsSnap.forEach((docSnap) => {
      batch.set(
        docSnap.ref,
        {
          latestMoodAssessment: moodSummary,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    await batch.commit();

    return NextResponse.json({
      answer: aiResult.answer,
      moodSummary: {
        mood: aiResult.mood,
        description: aiResult.moodDescription ?? "",
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "UNAUTHENTICATED") {
        return NextResponse.json({ error: "Authentication required." }, { status: 401 });
      }
      if (error.message === "NOT_AUTHORIZED") {
        return NextResponse.json({ error: "Not authorized." }, { status: 403 });
      }
    }

    console.error("[ask-ai] failed:", error);
    return NextResponse.json({ error: "Assistant request failed." }, { status: 500 });
  }
}
