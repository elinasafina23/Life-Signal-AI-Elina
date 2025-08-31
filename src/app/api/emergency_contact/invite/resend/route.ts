import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { db, adminAuth } from "@/lib/firebaseAdmin";
import { normalizeRole, isMainUserRole, Role } from "@/lib/roles";

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

async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) throw new Error("UNAUTHENTICATED");

  const decoded = await adminAuth.verifySessionCookie(cookie, true);
  const snap = await db.doc(`users/${decoded.uid}`).get();
  const data = snap.data() as { role?: string } | undefined;

  const role = normalizeRole(data?.role);
  if (!isMainUserRole(role)) throw new Error("NOT_AUTHORIZED");

  return { uid: decoded.uid as string };
}

// --- route ---
export async function POST(req: NextRequest) {
  try {
    const { uid: mainUserId } = await requireMainUser(req);
    const body = await req.json().catch(() => ({}));
    const targetEmail = normalizeEmail(String(body?.email ?? ""));
    const name = (body?.name as string | undefined) || null;
    const relation = (body?.relation as string | undefined) || null;

    if (!targetEmail) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    // Create a brand-new invite (no queries -> no composite index needed)
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromDate(
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    );

    const inviteRef = db.collection("invites").doc();
    await inviteRef.set({
      userId: mainUserId,
      role: "emergency_contact" as Role,
      emergencyEmail: targetEmail,      // canonical field
      caregiverEmail: targetEmail,      // backward-compat for older code
      token,
      tokenHash,
      status: "pending",
      createdAt: now,
      acceptedAt: null,
      expiresAt,
      name,
      relation,
    });

    // Keep a simple careTeam record up to date (optional, useful for UI)
    const careTeamId = `${mainUserId}_${targetEmail}`;
    await db.doc(`careTeams/${careTeamId}`).set(
      {
        id: careTeamId,
        patientId: mainUserId,
        caregiverEmail: targetEmail,
        caregiverId: null,
        status: "PENDING",
        updatedAt: now,
        createdAt: now,
      },
      { merge: true }
    );

    // Build accept link
    const origin =
      process.env.APP_ORIGIN ??
      process.env.NEXT_PUBLIC_APP_ORIGIN ??
      "http://localhost:3000";
    const acceptUrl = `${origin}/emergency_contact/accept?invite=${inviteRef.id}&token=${token}`;

    // Send email using the Firebase Trigger Email extension
    await db.collection("mail").add({
      to: [targetEmail],
      message: {
        subject: "Your LifeSignal emergency contact invite",
        html: `
          <p>Hello${name ? " " + name : ""},</p>
          <p>You’ve been invited to be an <strong>emergency contact</strong>.</p>
          <p><a href="${acceptUrl}">Accept invitation</a></p>
          <p>If the button doesn't work, copy this URL:<br>${acceptUrl}</p>
          <p>This link expires in 7 days.</p>
        `,
      },
    });

    return NextResponse.json({ ok: true, inviteId: inviteRef.id });
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
