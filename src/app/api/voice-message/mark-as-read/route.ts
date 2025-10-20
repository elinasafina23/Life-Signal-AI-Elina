// ─────────────────────────────────────────────────────────────────────────────
// /src/app/api/voice-message/mark-as-read/route.ts
// API endpoint for a main user to mark a voice message from an EC as read.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, db } from "@/lib/firebaseAdmin";
import { normalizeRole } from "@/lib/roles";

async function requireMainUser(req: NextRequest): Promise<string> {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");

  const decoded = await adminAuth
    .verifySessionCookie(cookie, true)
    .catch(() => {
      throw new Error("UNAUTHENTICATED");
    });

  const snap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((snap.data() as any)?.role);
  if (role !== "main_user") throw new Error("UNAUTHORIZED");

  return decoded.uid;
}

export async function POST(req: NextRequest) {
  try {
    const mainUserUid = await requireMainUser(req);
    const body = await req.json().catch(() => ({} as any));
    const messageId = typeof body?.messageId === "string" ? body.messageId.trim() : "";

    if (!messageId) {
      return NextResponse.json({ error: "messageId is required" }, { status: 400 });
    }

    const messageRef = db.doc(`users/${mainUserUid}/contactVoiceMessages/${messageId}`);
    const messageSnap = await messageRef.get();

    if (!messageSnap.exists) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    await messageRef.update({ isRead: true, updatedAt: FieldValue.serverTimestamp() });

    return NextResponse.json({ ok: true, messageId });
  } catch (err: any) {
    if (err?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (err?.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    console.error("[voice-message/mark-as-read] failed:", err);
    return NextResponse.json({ error: err?.message || "Failed to mark as read" }, { status: 500 });
  }
}
