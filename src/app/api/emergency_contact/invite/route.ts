// at top of route.ts files
export const runtime = "nodejs"; // Next 13/14 SSR runtime

// src/app/api/emergency_contact/invite/route.ts
import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";
import { db, adminAuth } from "@/lib/firebaseAdmin";
import { normalizeRole, isMainUserRole } from "@/lib/roles";

/**
 * Normalize emails for comparison:
 * - lowercases
 * - for Gmail: strips dots and +tags (so a.b+c@gmail.com == ab@gmail.com)
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
  // Read the secure session cookie set by /api/auth/session
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");

  // Verify cookie → get decoded Firebase token
  let decoded;
  try {
    decoded = await adminAuth.verifySessionCookie(cookie, true);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  // Check role from Firestore (you can move this to custom claims later)
  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((userSnap.data() as any)?.role);
  if (!isMainUserRole(role)) throw new Error("NOT_AUTHORIZED");

  // Standardize the name we use everywhere for the main user's UID
  return { uid: decoded.uid as string }; // ← mainUserUid
}

/**
 * Resolve the app origin to build absolute links
 * (env overrides, else use the request origin).
 */
function getOrigin(req: NextRequest) {
  return (
    process.env.APP_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_ORIGIN ||
    new URL(req.url).origin
  );
}

// Invite links expire after 7 days
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * POST /api/emergency_contact/invite
 *
 * Body:
 *  {
 *    email: string,          // required – who we’re inviting
 *    name?: string | null,   // optional – for email greeting
 *    relation?: string       // optional – e.g. "primary", "secondary"
 *  }
 *
 * Effects:
 *  - Creates a fresh invite doc in /invites
 *  - Upserts a tracker doc in /emergencyContacts (PENDING)
 *  - Sends an email with an accept link
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

    // Validate required email
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
    const ecStatus = ecSnap.exists ? (ecSnap.get("status") as string) : undefined;

    // If already linked and ACTIVE, don't re-invite
    if (ecStatus === "ACTIVE") {
      return NextResponse.json({
        ok: true,
        alreadyLinked: true,
        emergencyContactId,
      });
    }

    // Best-effort enrichment for email content
    let mainUserName = "";
    let mainUserAvatar = "";
    try {
      const mu = await db.doc(`users/${mainUserUid}`).get();
      const m = mu.data() as any;
      mainUserName = m?.displayName || "";
      mainUserAvatar = m?.photoURL || "";
    } catch {
      /* ignore */
    }

    // Create a fresh invite token (random), and store its hash too
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS); // Date is OK in Admin SDK

    // Batch writes for atomicity
    const batch = db.batch();

    /**
     * Create a NEW invite doc.
     * We write BOTH mainUserUid (canonical) and mainUserUid (legacy) so that
     * older readers that still expect "mainUserId" keep working.
     * Once everything reads "mainUserUid", you can drop mainUserUid.
     */
    const inviteRef = db.collection("invites").doc();
    batch.set(inviteRef, {
      mainUserUid,                // ✅ canonical, new
      mainUserId: mainUserUid,    // 🧰 legacy mirror (safe to remove later)
      role: "emergency_contact",
      emergencyContactEmail,
      relation,
      status: "PENDING",
      token,                      // (stored for convenience – can be omitted if you prefer ONLY hash)
      tokenHash,                  // used for lookup without exposing token
      name,
      mainUserName,
      mainUserAvatar,
      createdAt: FieldValue.serverTimestamp(),
      acceptedAt: null,
      expiresAt,                  // JS Date stored by Admin SDK
    });

    /**
     * Upsert/refresh the top-level tracker doc
     * - Keeps resend count and lastInviteAt timestamp
     * - Will be flipped to ACTIVE by the /accept route on success
     */
    const resendCount = (ecSnap.exists ? ecSnap.get("resendCount") : 0) || 0;
    const ecPayload: any = {
      id: emergencyContactId,
      mainUserUid,                 // ✅ standardized naming
      emergencyContactEmail,
      status: "PENDING",
      lastInviteAt: FieldValue.serverTimestamp(),
      resendCount: resendCount + 1,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!ecSnap.exists) {
      ecPayload.createdAt = FieldValue.serverTimestamp();
      ecPayload.emergencyContactUid = null; // will be set after accept
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
          <p>If the link doesn\'t work, copy this URL:<br>${acceptUrl}</p>
        `,
      },
    });

    // Respond with useful info for the client (e.g., to show a "sent" screen)
    return NextResponse.json({
      ok: true,
      inviteId: inviteRef.id,
      acceptUrl,
      verifyContinue,
      emergencyContactId,
      wasResent: ecStatus === "PENDING" || !ecSnap.exists ? true : false,
    });
  } catch (e: any) {
    // Auth/role guards → HTTP codes
    if (e?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (e?.message === "NOT_AUTHORIZED") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    console.error(e);
    return NextResponse.json({ error: e?.message ?? "Invite failed" }, { status: 400 });
  }
}
