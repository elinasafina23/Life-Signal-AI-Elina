export const runtime = "nodejs";

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Re-use admin app between hot reloads
if (!getApps().length) {
  initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS in dev/prod
}
const db = getFirestore();

export async function POST(req: Request) {
  try {
    const { mainUserUid, mode, callDelaySec = 60 } = (await req.json()) ?? {};

    if (!mainUserUid || !["push_then_call", "call_immediately"].includes(mode)) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid payload" }),
        { status: 400 }
      );
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

    return Response.json({ ok: true });
  } catch (e: any) {
    console.error("update_policy failed:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Internal error" }),
      { status: 500 }
    );
  }
}
