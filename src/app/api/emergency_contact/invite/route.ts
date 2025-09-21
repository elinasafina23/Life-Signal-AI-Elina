// at top of route.ts files
export const runtime = "nodejs"; // Next 13/14

// src/app/api/emergency_contact/invite/route.ts
import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";
import { db, adminAuth } from "@/lib/firebaseAdmin";
import { normalizeRole, isMainUserRole } from "@/lib/roles";

function normalizeEmail(e?: string | null) {
  const v = (e || "").trim().toLowerCase();
  const [local = "", domain = ""] = v.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const clean = local.split("+")[0].replace(/\./g, "");
    return `${clean}@gmail.com`;
  }
  return v;
}

async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");
  let decoded;
  try {
    decoded = await adminAuth.verifySessionCookie(cookie, true);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((userSnap.data() as any)?.role);
  if (!isMainUserRole(role)) throw new Error("NOT_AUTHORIZED");

  return { uid: decoded.uid as string };
}

function getOrigin(req: NextRequest) {
  return (
    process.env.APP_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_ORIGIN ||
    new URL(req.url).origin
  );
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function POST(req: NextRequest) {
  try {
    const { uid: mainUserId } = await requireMainUser(req);
    const body = await req.json().catch(() => ({} as any));

    const email = body?.email as string | undefined;
    const name = (body?.name as string | undefined) || null;
    const relation = (body?.relation as string | undefined) ?? "primary";

    const emergencyContactEmail = normalizeEmail(String(email ?? ""));
    if (!emergencyContactEmail) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    // Deterministic per (mainUserId, email) doc to track status
    const emergencyContactId = `${mainUserId}_${emergencyContactEmail}`;
    const emergencyContactRef = db.doc(`emergencyContacts/${emergencyContactId}`);
    const ecSnap = await emergencyContactRef.get();
    const ecStatus = ecSnap.exists ? (ecSnap.get("status") as string) : undefined;

    // If already linked/active, do not send another invite
    if (ecStatus === "ACTIVE") {
      return NextResponse.json({
        ok: true,
        alreadyLinked: true,
        emergencyContactId,
      });
    }

    // We now ALWAYS issue a fresh invite for PENDING (or missing) contacts.
    // (Old code returned early and never sent a new link.)
    let mainUserName = "";
    let mainUserAvatar = "";
    try {
      const mu = await db.doc(`users/${mainUserId}`).get();
      const m = mu.data() as any;
      mainUserName = m?.displayName || "";
      mainUserAvatar = m?.photoURL || "";
    } catch {
      // ignore
    }

    // Fresh token + 7-day expiry
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const batch = db.batch();

    // Create a NEW invite doc every time (distinct ID)
    const inviteRef = db.collection("invites").doc();
    batch.set(inviteRef, {
      mainUserId: mainUserId,
      role: "emergency_contact",
      emergencyContactEmail,
      relation,
      status: "pending",
      token,
      tokenHash,
      name,
      mainUserName,
      mainUserAvatar,
      createdAt: FieldValue.serverTimestamp(),
      acceptedAt: null,
      expiresAt, // storing Date is fine in admin SDK
    });

    // Upsert/refresh the emergencyContact tracker doc
    const resendCount = (ecSnap.exists ? ecSnap.get("resendCount") : 0) || 0;
    const ecPayload: any = {
      id: emergencyContactId,
      mainUserId,
      emergencyContactEmail,
      status: "PENDING", // remains pending until accept route finalizes
      lastInviteAt: FieldValue.serverTimestamp(),
      resendCount: resendCount + 1,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!ecSnap.exists) {
      ecPayload.createdAt = FieldValue.serverTimestamp();
      ecPayload.emergencyContactUid = null;
    }
    batch.set(emergencyContactRef, ecPayload, { merge: true });

    await batch.commit();

    const origin = getOrigin(req);
    const acceptUrl = `${origin}/emergency_contact/accept?invite=${inviteRef.id}&token=${token}`;
    // Optional: if you want to force email verification before accept, keep this:
    const verifyContinue = `${origin}/verify-email?next=${encodeURIComponent(acceptUrl)}`;

    // Send email via your Mail collection (kept from your original code)
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

    return NextResponse.json({
      ok: true,
      inviteId: inviteRef.id,
      acceptUrl,
      verifyContinue,
      emergencyContactId,
      wasResent: ecStatus === "PENDING" || !ecSnap.exists ? true : false,
    });
  } catch (e: any) {
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
