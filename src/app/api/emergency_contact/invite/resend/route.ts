// src/app/api/emergency_contact/resend/route.ts

// Next 13/14: ensure this API route runs on the Node.js runtime
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";
import { db, adminAuth } from "@/lib/firebaseAdmin";
import { normalizeRole, isMainUserRole } from "@/lib/roles";

/**
 * Normalize emails for comparison:
 * - lowercase
 * - for Gmail: strip dots and +tags (so a.b+c@gmail.com == ab@gmail.com)
 */
function normalizeEmail(e?: string | null) {
  const v = (e || "").trim().toLowerCase();
  const [local = "", domain = ""] = v.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const clean = local.split("+")[0].replace(/\./g, "");
    return `${clean}@gmail.com`;
  }
  return v;
}

/**
 * Require that the caller is:
 *  - authenticated (via our server session cookie)
 *  - AND has a "main user" role
 *
 * Returns the caller's uid as mainUserUid.
 */
async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");

  let decoded;
  try {
    decoded = await adminAuth.verifySessionCookie(cookie, true);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  const snap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((snap.data() as any)?.role);
  if (!isMainUserRole(role)) throw new Error("NOT_AUTHORIZED");

  return { uid: decoded.uid as string }; // ← we’ll call this mainUserUid below
}

/** Resolve the deployed origin so we can build absolute links. */
function getOrigin(req: NextRequest) {
  return (
    process.env.APP_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_ORIGIN ||
    new URL(req.url).origin
  );
}

/**
 * POST /api/emergency_contact/resend
 *
 * Body:
 *  {
 *    email: string,          // required – who we’re re-inviting
 *    name?: string | null,   // optional – for email greeting
 *    relation?: string       // optional – e.g. "primary", "secondary"
 *  }
 *
 * Effects:
 *  - Creates a new invite in /invites (fresh token, 7-day expiry)
 *  - Upserts tracker /emergencyContacts/{mainUserUid_email}
 *  - Sends an email with the new link
 *  - Preserves ACTIVE status if the contact already accepted before
 */
export async function POST(req: NextRequest) {
  try {
    // Ensure the caller is a main user
    const { uid: mainUserUid } = await requireMainUser(req);

    // Parse body (safe fallback to empty object)
    const body = await req.json().catch(() => ({} as any));

    // Extract/normalize inputs
    const email = body?.email as string | undefined;
    const name = (body?.name as string | undefined) || null;
    const relation = (body?.relation as string | undefined) ?? "primary";
    const emergencyContactEmail = normalizeEmail(String(email ?? ""));

    // Validate email
    if (!emergencyContactEmail) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    /**
     * Deterministic tracker doc ID to group all invites/links for
     * (mainUserUid, emergencyContactEmail). Handy for status/resends.
     */
    const emergencyContactId = `${mainUserUid}_${emergencyContactEmail}`;
    const emergencyContactRef = db.doc(`emergencyContacts/${emergencyContactId}`);
    const ecSnap = await emergencyContactRef.get();

    // Best-effort enrichment for email content
    let mainUserName = "";
    let mainUserAvatar = "";
    try {
      const mu = await db.doc(`users/${mainUserUid}`).get();
      const m = mu.data() as any;
      mainUserName = m?.displayName || m?.name || "";
      mainUserAvatar = m?.photoURL || m?.avatar || "";
    } catch {
      /* ignore */
    }

    // Create a fresh invite token (random), and store its hash too
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Batch writes for atomicity
    const batch = db.batch();

    /**
     * Create a NEW invite doc.
     * Write BOTH mainUserUid (canonical) and mainUserId (legacy mirror)
     * to avoid breaking any older code that still reads "mainUserId".
     * Once everything reads "mainUserUid", you can remove mainUserId safely.
     */
    const inviteRef = db.collection("invites").doc();
    batch.set(inviteRef, {
      mainUserUid,                // ✅ canonical, new
      mainUserId: mainUserUid,    // 🧰 legacy mirror (safe to drop later)
      role: "emergency_contact",
      emergencyContactEmail,
      relation,
      status: "PENDING",
      token,                      // (kept for convenience; hash is what we trust)
      tokenHash,
      name,
      mainUserName,
      mainUserAvatar,
      createdAt: FieldValue.serverTimestamp(),
      acceptedAt: null,
      expiresAt,                  // JS Date is fine with Admin SDK
    });

    /**
     * Upsert/refresh the top-level tracker doc.
     * If it was previously ACTIVE (already accepted), KEEP it ACTIVE.
     * Otherwise ensure it's PENDING.
     */
    let nextStatus: "ACTIVE" | "PENDING" = "PENDING";
    if (ecSnap.exists && ecSnap.get("status") === "ACTIVE") nextStatus = "ACTIVE";

    const ecPayload: any = {
      id: emergencyContactId,
      mainUserUid,                 // ✅ standardized naming
      emergencyContactEmail,
      status: nextStatus,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!ecSnap.exists) {
      ecPayload.createdAt = FieldValue.serverTimestamp();
      ecPayload.emergencyContactUid = null; // will be set by /accept on success
    }
    batch.set(emergencyContactRef, ecPayload, { merge: true });

    // Commit our writes
    await batch.commit();

    // Build the acceptance URL
    const origin = getOrigin(req);
    const acceptUrl = `${origin}/emergency_contact/accept?invite=${inviteRef.id}&token=${token}`;

    /**
     * Optional: If you enforce verified email before acceptance,
     * send them to /verify-email first, then continue to acceptUrl.
     */
    const verifyContinue = `${origin}/verify-email?next=${encodeURIComponent(acceptUrl)}`;

    // Send the email using your /mail collection (Firebase Ext or your mail worker)
    await db.collection("mail").add({
      to: [emergencyContactEmail],
      message: {
        subject: "You’ve been added as an emergency contact",
        html: `
          <p>Hello${name ? " " + name : ""},</p>
          <p>You’ve been invited to be an <strong>emergency contact</strong>.</p>
          <p><a href="${acceptUrl}">Accept invitation</a> (link expires in 7 days).</p>
          <p>If the link doesn't work, copy this URL:<br>${acceptUrl}</p>
        `,
      },
    });

    // Respond with useful info for the client UI
    return NextResponse.json({
      ok: true,
      inviteId: inviteRef.id,
      acceptUrl,
      verifyContinue,
      emergencyContactId,
    });
  } catch (e: any) {
    if (e?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (e?.message === "NOT_AUTHORIZED") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    console.error(e);
    return NextResponse.json(
      { error: e?.message ?? "Resend failed" },
      { status: 400 }
    );
  }
}
