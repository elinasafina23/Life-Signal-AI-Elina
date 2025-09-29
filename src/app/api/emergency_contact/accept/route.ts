// src/app/api/emergency_contact/accept/route.ts

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";
import { db, adminAuth } from "@/lib/firebaseAdmin";
import { normalizeRole, isEmergencyContactRole } from "@/lib/roles";

/**
 * Normalize an email for safe comparison:
 * - lowercase
 * - gmail: strip dots and plus-tags
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
 * Ensure the caller is signed in AND has an emergency-contact role.
 * Returns their uid (→ emergencyContactUid) and normalized email.
 */
async function requireEmergencyContact(req: NextRequest) {
  // Read the server session cookie set by /api/auth/session
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");

  // Verify the session cookie
  let decoded;
  try {
    decoded = await adminAuth.verifySessionCookie(cookie, true);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  // Check role (from Firestore user doc — you can move to custom claims later)
  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const data = userSnap.data() as { role?: string; email?: string } | undefined;
  const role = normalizeRole(data?.role);
  if (!isEmergencyContactRole(role)) throw new Error("NOT_AUTHORIZED");

  // Prefer Firestore email, fallback to token email
  const email = data?.email || (decoded as any)?.email || "";
  return { uid: decoded.uid as string, email: normalizeEmail(email) };
}

/**
 * POST /api/emergency_contact/accept
 * Accept an invite linking the signed-in emergency contact to a main user.
 *
 * Body:
 * - token?: string       // invite token (or)
 * - inviteId?: string    // invite doc id
 *
 * Effects:
 * - Upserts link doc at: users/{mainUserUid}/emergency_contact/{emergencyContactUid}
 * - Marks invite accepted
 * - Upserts a top-level summary doc (optional analytics): emergencyContacts/{mainUserUid_email}
 */
export async function POST(req: NextRequest) {
  try {
    // Ensure caller is an emergency contact; get their identity
    const { uid: emergencyContactUid, email: signedInEmail } = await requireEmergencyContact(req);

    // Parse request payload; support token OR inviteId
    const body = await req.json().catch(() => ({}));
    const token: string = String(body?.token ?? "");
    const inviteId: string = String(body?.inviteId ?? body?.invite ?? "");

    if (!token && !inviteId) {
      return NextResponse.json({ error: "token or invite/inviteId required" }, { status: 400 });
    }

    // --- Load the invite document ---
    let inviteRef = inviteId ? db.collection("invites").doc(inviteId) : null;
    let inviteSnap = inviteRef ? await inviteRef.get() : null;

    // If not found by id, try finding by hashed token
    if (!inviteSnap || !inviteSnap.exists) {
      if (!token) return NextResponse.json({ error: "Invite not found" }, { status: 404 });
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const q = await db.collection("invites").where("tokenHash", "==", tokenHash).limit(1).get();
      if (q.empty) return NextResponse.json({ error: "Invite not found" }, { status: 404 });
      inviteSnap = q.docs[0];
      inviteRef = inviteSnap.ref;
    }

    const inv = inviteSnap.data() as any;

    // --- Validate the invite matches an emergency-contact role ---
    if (inv.role && normalizeRole(inv.role) !== "emergency_contact") {
      return NextResponse.json({ error: "Invite role mismatch" }, { status: 400 });
    }

    // If already accepted by this same user, we’ll behave idempotently
    const alreadyAcceptedByThisUser =
      inv.status === "accepted" && inv.acceptedBy === emergencyContactUid;

    // Expiration check (unless it was already accepted by this user)
    if (inv.expiresAt?.toMillis && inv.expiresAt.toMillis() < Date.now() && !alreadyAcceptedByThisUser) {
      return NextResponse.json({ error: "Invite expired" }, { status: 410 });
    }

    // Token check (only if provided and invite carries a token)
    if (!alreadyAcceptedByThisUser && token && inv.token && inv.token !== token) {
      return NextResponse.json({ error: "Invite token mismatch" }, { status: 400 });
    }

    // --- Validate recipient email matches the signed-in contact ---
    const invitedEmail = normalizeEmail(inv.emergencyContactEmail);
    if (!invitedEmail) {
      return NextResponse.json({ error: "Invite missing recipient email" }, { status: 400 });
    }
    if (invitedEmail !== signedInEmail) {
      return NextResponse.json(
        { error: "Signed-in email does not match invite recipient" },
        { status: 409 }
      );
    }

    // --- Identify the main user being linked to ---
    const mainUserUid: string = inv.mainUserId; // invite schema used mainUserUid previously
    if (!mainUserUid) {
      return NextResponse.json({ error: "Invite missing main user id" }, { status: 400 });
    }

    // --- Optional display fields (for dashboard cards) ---
    let mainUserName = inv.mainUserName || "";
    let mainUserAvatar = inv.mainUserAvatar || "";
    try {
      const mainSnap = await db.doc(`users/${mainUserUid}`).get();
      if (mainSnap.exists) {
        const m = mainSnap.data() as any;
        mainUserName = mainUserName || m.displayName || "";
        mainUserAvatar = mainUserAvatar || m.photoURL || "";
      }
    } catch {
      /* best-effort enrichment only */
    }

    // --- Prepare references we will write ---
    // Link doc lives under the main user's doc; id = emergencyContactUid (simple & unique)
    const linkRef = db.doc(`users/${mainUserUid}/emergency_contact/${emergencyContactUid}`);

    // Optional top-level join/analytics doc (handy for admin/queries)
    const emergencyContactId = `${mainUserUid}_${invitedEmail}`;
    const emergencyContactRef = db.doc(`emergencyContacts/${emergencyContactId}`);

    // Read existing docs once so we can set createdAt only on first create
    const [linkSnap, ecSnap] = await Promise.all([linkRef.get(), emergencyContactRef.get()]);

    // --- Batch all writes for atomicity ---
    const batch = db.batch();

    // Upsert the link doc used by your dashboards and listeners
    const linkPayload: any = {
      // 🔑 canonical field used by collectionGroup queries:
      //    where("emergencyContactUid", "==", <user.uid>)
      emergencyContactUid,
      // Helpful denormalized info
      mainUserUid,
      emergencyContactEmail: signedInEmail,
      mainUserName: mainUserName || "",
      mainUserAvatar: mainUserAvatar || "",
      status: "ACTIVE",
      updatedAt: FieldValue.serverTimestamp(),
      inviteId: inviteRef!.id, // pointer only, no secrets
    };
    if (!linkSnap.exists) linkPayload.createdAt = FieldValue.serverTimestamp();
    batch.set(linkRef, linkPayload, { merge: true });

    // Mark invite accepted (idempotent if already accepted)
    if (!alreadyAcceptedByThisUser) {
      batch.update(inviteRef!, {
        status: "accepted",
        acceptedAt: FieldValue.serverTimestamp(),
        acceptedBy: emergencyContactUid,
      });
    }

    // Upsert optional top-level summary/join doc
    const ecPayload: any = {
      id: emergencyContactId,
      mainUserUid,                // 🔁 standardized naming
      emergencyContactUid,        // 🔁 standardized naming
      emergencyContactEmail: invitedEmail,
      status: "ACTIVE",
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!ecSnap.exists) ecPayload.createdAt = FieldValue.serverTimestamp();
    if (!alreadyAcceptedByThisUser) ecPayload.acceptedAt = FieldValue.serverTimestamp();
    batch.set(emergencyContactRef, ecPayload, { merge: true });

    // Commit all writes
    await batch.commit();

    // Respond with ok + who you got linked to
    return NextResponse.json({ ok: true, mainUserUid, alreadyAccepted: alreadyAcceptedByThisUser });
  } catch (e: any) {
    // Map common auth errors to HTTP status codes
    if (e?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (e?.message === "NOT_AUTHORIZED") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    console.error(e);
    return NextResponse.json({ error: e?.message ?? "Accept failed" }, { status: 400 });
  }
}
