// src/app/api/emergency_contact/accept/route.ts
import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
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

  let decoded;
  try {
    decoded = await adminAuth.verifySessionCookie(cookie, true);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  // role check (can move to custom claims later)
  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const data = userSnap.data() as { role?: string; email?: string } | undefined;
  const role = normalizeRole(data?.role);
  if (!isEmergencyContactRole(role)) throw new Error("NOT_AUTHORIZED");

  const email = data?.email || (decoded as any)?.email || "";
  return { uid: decoded.uid as string, email: normalizeEmail(email) };
}

// --- route ---
export async function POST(req: NextRequest) {
  try {
    const { uid: emergencyContactUid, email: signedInEmail } = await requireEmergencyContact(req);
    const body = await req.json().catch(() => ({}));
    const token: string = String(body?.token ?? "");
    const inviteId: string = String(body?.inviteId ?? body?.invite ?? "");

    if (!token && !inviteId) {
      return NextResponse.json({ error: "token or invite/inviteId required" }, { status: 400 });
    }

    // Load invite
    let inviteRef = inviteId ? db.collection("invites").doc(inviteId) : null;
    let inviteSnap = inviteRef ? await inviteRef.get() : null;

    if (!inviteSnap || !inviteSnap.exists) {
      if (!token) return NextResponse.json({ error: "Invite not found" }, { status: 404 });
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const q = await db.collection("invites").where("tokenHash", "==", tokenHash).limit(1).get();
      if (q.empty) return NextResponse.json({ error: "Invite not found" }, { status: 404 });
      inviteSnap = q.docs[0];
      inviteRef = inviteSnap.ref;
    }

    const inv = inviteSnap.data() as any;

    // Validations
    if (inv.role && normalizeRole(inv.role) !== "emergency_contact") {
      return NextResponse.json({ error: "Invite role mismatch" }, { status: 400 });
    }

    const alreadyAcceptedByThisUser =
      inv.status === "accepted" && inv.acceptedBy === emergencyContactUid;

    if (inv.expiresAt?.toMillis && inv.expiresAt.toMillis() < Date.now() && !alreadyAcceptedByThisUser) {
      return NextResponse.json({ error: "Invite expired" }, { status: 410 });
    }
    if (!alreadyAcceptedByThisUser && token && inv.token && inv.token !== token) {
      return NextResponse.json({ error: "Invite token mismatch" }, { status: 400 });
    }

    // Email match
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

    // Main user
    const mainUserId: string = inv.mainUserId;
    if (!mainUserId) {
      return NextResponse.json({ error: "Invite missing main user id" }, { status: 400 });
    }

    // Optional display fields
    let mainUserName = inv.mainUserName || "";
    let mainUserAvatar = inv.mainUserAvatar || "";
    try {
      const mainSnap = await db.doc(`users/${mainUserId}`).get();
      if (mainSnap.exists) {
        const m = mainSnap.data() as any;
        mainUserName = mainUserName || m.displayName || "";
        mainUserAvatar = mainUserAvatar || m.photoURL || "";
      }
    } catch {
      /* best effort only */
    }

    // Refs
    const linkRef = db.doc(`users/${mainUserId}/emergency_contact/${emergencyContactUid}`);
    const emergencyContactId = `${mainUserId}_${invitedEmail}`;
    const emergencyContactRef = db.doc(`emergencyContacts/${emergencyContactId}`);

    // Read once so we can set createdAt only on first create
    const [linkSnap, ecSnap] = await Promise.all([linkRef.get(), emergencyContactRef.get()]);

    // Batch writes
    const batch = db.batch();

    // Upsert link doc (dashboard consumes this via collectionGroup)
    const linkPayload: any = {
      uid: emergencyContactUid, // required for where("uid","==", user.uid)
      mainUserId: mainUserId,
      emergencyContactEmail: signedInEmail,
      mainUserName: mainUserName || "",
      mainUserAvatar: mainUserAvatar || "",
      status: "ACTIVE",
      updatedAt: FieldValue.serverTimestamp(),
      inviteId: inviteRef!.id, // pointer only (no secrets)
    };
    if (!linkSnap.exists) linkPayload.createdAt = FieldValue.serverTimestamp();
    batch.set(linkRef, linkPayload, { merge: true });

    // Mark invite accepted (idempotent repair if it was already accepted)
    if (!alreadyAcceptedByThisUser) {
      batch.update(inviteRef!, {
        status: "accepted",
        acceptedAt: FieldValue.serverTimestamp(),
        acceptedBy: emergencyContactUid,
      });
    }

    // Upsert top-level summary/join doc
    const ecPayload: any = {
      id: emergencyContactId,
      mainUserId,
      emergencyContactUid,
      emergencyContactEmail: invitedEmail,
      status: "ACTIVE",
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!ecSnap.exists) ecPayload.createdAt = FieldValue.serverTimestamp();
    if (!alreadyAcceptedByThisUser) ecPayload.acceptedAt = FieldValue.serverTimestamp();
    batch.set(emergencyContactRef, ecPayload, { merge: true });

    await batch.commit();

    return NextResponse.json({ ok: true, mainUserId, alreadyAccepted: alreadyAcceptedByThisUser });
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
