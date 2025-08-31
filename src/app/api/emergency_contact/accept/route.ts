// src/app/api/emergency_contact/accept/route.ts
import { NextRequest, NextResponse } from "next/server";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";
import { db, adminAuth } from "@/lib/firebaseAdmin";
import { normalizeRole, isEmergencyContactRole } from "@/lib/roles";

// --- helpers ---
function normalizeEmail(e?: string | null) {
  const v = (e || "").trim().toLowerCase();
  const [local = "", domain = ""] = v.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const clean = local.split("+")[0].replace(/\./g, "");
    return `${clean}@gmail.com`;
  }
  return v;
}

async function requireEmergencyContact(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");

  const decoded = await adminAuth.verifySessionCookie(cookie, true);
  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const data = userSnap.data() as { role?: string; email?: string } | undefined;
  const role = normalizeRole(data?.role);

  if (!isEmergencyContactRole(role)) throw new Error("NOT_AUTHORIZED");

  const email = data?.email || (decoded as any)?.email || "";
  return { uid: decoded.uid, email: normalizeEmail(email) };
}

// --- route ---
export async function POST(req: NextRequest) {
  try {
    const { uid: emergencyUid, email: signedInEmail } = await requireEmergencyContact(req);
    const body = await req.json().catch(() => ({}));
    const token: string = String(body?.token ?? "");
    const inviteId: string = String(body?.inviteId ?? body?.invite ?? "");

    if (!token && !inviteId) {
      return NextResponse.json({ error: "token or inviteId required" }, { status: 400 });
    }

    // Load invite
    let inviteRef = inviteId ? db.collection("invites").doc(inviteId) : null;
    let inviteSnap = inviteRef ? await inviteRef.get() : null;

    if (!inviteSnap || !inviteSnap.exists) {
      // Fallback: find by token hash if only token provided
      if (!token) {
        return NextResponse.json({ error: "Invite not found" }, { status: 404 });
      }
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const q = await db
        .collection("invites")
        .where("tokenHash", "==", tokenHash)
        .limit(1)
        .get();

      if (q.empty) return NextResponse.json({ error: "Invite not found" }, { status: 404 });
      inviteSnap = q.docs[0];
      inviteRef = inviteSnap.ref;
    }

    const inv = inviteSnap!.data() as any;

    // Basic validations
    if (inv.role && normalizeRole(inv.role) !== "emergency_contact") {
      return NextResponse.json({ error: "Invite role mismatch" }, { status: 400 });
    }
    if (inv.status && inv.status !== "pending") {
      // Idempotent success if already accepted by the same user
      if (inv.status === "accepted" && inv.acceptedBy === emergencyUid) {
        return NextResponse.json({ ok: true, alreadyAccepted: true }, { status: 200 });
      }
      return NextResponse.json({ error: "Invite already used or revoked" }, { status: 409 });
    }
    if (inv.expiresAt && (inv.expiresAt as Timestamp).toMillis() < Date.now()) {
      return NextResponse.json({ error: "Invite expired" }, { status: 410 });
    }
    if (token && inv.token && inv.token !== token) {
      return NextResponse.json({ error: "Invite token mismatch" }, { status: 400 });
    }

    // Email match (normalized)
    const invitedEmail =
      normalizeEmail(inv.emergencyEmail) || normalizeEmail(inv.caregiverEmail);
    if (!invitedEmail) {
      return NextResponse.json({ error: "Invite missing recipient email" }, { status: 400 });
    }
    if (invitedEmail !== signedInEmail) {
      return NextResponse.json(
        { error: "Signed-in email does not match invite recipient" },
        { status: 409 }
      );
    }

    // Identify main user and prepare writes
    const mainUserId: string = inv.userId || inv.patientId;
    if (!mainUserId) {
      return NextResponse.json({ error: "Invite missing main user id" }, { status: 400 });
    }

    // Optional: read main user profile for display fields
    let mainUserName = inv.patientName || "";
    let mainUserAvatar = "";
    try {
      const mainRef = db.doc(`users/${mainUserId}`);
      const mainSnap = await mainRef.get();
      if (mainSnap.exists) {
        const m = mainSnap.data() as any;
        mainUserName = mainUserName || m.displayName || m.name || "";
        mainUserAvatar = m.photoURL || m.avatar || "";
      }
    } catch {
      // best-effort only
    }

    // Link doc under the main user
    const linkRef = db.doc(`users/${mainUserId}/emergency_contact/${emergencyUid}`);

    // Optional: careTeam doc (idempotency pattern used by your invite endpoint)
    const careTeamId = `${mainUserId}_${invitedEmail}`;
    const careTeamRef = db.doc(`careTeams/${careTeamId}`);

    // Commit all changes atomically
    const batch = db.batch();

    // upsert link
    batch.set(
      linkRef,
      {
        uid: emergencyUid,
        emergencyEmail: signedInEmail,
        caregiverEmail: signedInEmail, // backward-compat for older reads
        inviteId: inviteRef!.id,
        token: inv.token || token || null,
        userId: mainUserId,
        mainUserName: mainUserName || "",
        mainUserAvatar: mainUserAvatar || "",
        updatedAt: Timestamp.now(),
        createdAt: FieldValue.serverTimestamp(), // set on create; will be ignored on update
      },
      { merge: true }
    );

    // flip invite → accepted
    batch.update(inviteRef!, {
      status: "accepted",
      acceptedAt: Timestamp.now(),
      acceptedBy: emergencyUid,
    });

    // activate care team (if present)
    batch.set(
      careTeamRef,
      {
        id: careTeamId,
        patientId: mainUserId,
        caregiverEmail: invitedEmail,
        caregiverId: emergencyUid,
        status: "ACTIVE",
        acceptedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await batch.commit();

    return NextResponse.json({ ok: true, mainUserId });
  } catch (e: any) {
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
