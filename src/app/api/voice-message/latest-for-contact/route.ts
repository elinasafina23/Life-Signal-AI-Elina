// ─────────────────────────────────────────────────────────────────────────────
// /src/app/api/voice-message/latest-for-contact/route.ts
// Returns the most recent voice message sent by a specific emergency contact
// to the authenticated main user. The data is fetched with admin privileges so
// client-side Firestore permissions don't block the dashboard dialog.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

import { adminAuth, db } from "@/lib/firebaseAdmin";
import { normalizeRole } from "@/lib/roles";

function normalizeUid(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function requireMainUser(req: NextRequest): Promise<{ uid: string }> {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) {
    throw new Error("UNAUTHENTICATED");
  }

  const decoded = await adminAuth
    .verifySessionCookie(cookie, true)
    .catch(() => {
      throw new Error("UNAUTHENTICATED");
    });

  const snap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((snap.data() as any)?.role) || "unknown";
  if (role !== "main_user" && role !== "admin") {
    throw new Error("FORBIDDEN");
  }

  return { uid: decoded.uid as string };
}

export async function GET(req: NextRequest) {
  try {
    const contactUidParam = req.nextUrl.searchParams.get("contactUid");
    const contactUid = normalizeUid(contactUidParam);
    if (!contactUid) {
      return NextResponse.json(
        { error: "contactUid is required" },
        { status: 400 },
      );
    }

    const { uid } = await requireMainUser(req);

    const snapshot = await db
      .collection(`users/${uid}/contactVoiceMessages`)
      .where("fromEmergencyContactUid", "==", contactUid)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snapshot.empty) {
      return NextResponse.json({ latest: null });
    }

    const data = snapshot.docs[0].data() as any;

    const createdAtIso =
      data?.createdAt && typeof data.createdAt.toDate === "function"
        ? data.createdAt.toDate().toISOString()
        : null;

    const audioUrlRaw =
      typeof data?.audioUrl === "string" ? data.audioUrl.trim() : "";
    const audioDataUrlRaw =
      typeof data?.audioDataUrl === "string" ? data.audioDataUrl.trim() : "";

    return NextResponse.json({
      latest: {
        audioUrl: audioUrlRaw || audioDataUrlRaw || null,
        transcript:
          typeof data?.transcript === "string" && data.transcript.trim()
            ? data.transcript
            : null,
        createdAt: createdAtIso,
      },
    });
  } catch (error: any) {
    if (error?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (error?.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("[voice-message/latest-for-contact] failed:", error);
    return NextResponse.json(
      { error: "Failed to load latest voice message" },
      { status: 500 },
    );
  }
}
