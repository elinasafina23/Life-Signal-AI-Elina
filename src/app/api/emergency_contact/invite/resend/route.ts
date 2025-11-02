// src/app/api/emergency_contact/resend/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import crypto from "crypto";
import { db, adminAuth } from "@/lib/firebaseAdmin";
import { normalizeRole, isMainUserRole } from "@/lib/roles";

/** ---------- Helpers ---------- **/

/** Normalize emails for consistent storage & lookup */
function normalizeEmail(raw: string) {
  if (!raw) return { email: "", emailNormalized: "" };
  const email = String(raw).trim().toLowerCase();
  const [local, domain] = email.split("@");
  if (!local || !domain) return { email, emailNormalized: email };

  // Gmail-style normalization: remove dots and +tags
  let normLocal = local;
  const isGmail =
    domain === "gmail.com" ||
    domain === "googlemail.com" ||
    domain.endsWith(".gmail"); // safety no-op

  if (isGmail) {
    const plusIdx = normLocal.indexOf("+");
    if (plusIdx >= 0) normLocal = normLocal.slice(0, plusIdx);
    normLocal = normLocal.replace(/\./g, "");
  }

  const emailNormalized = `${normLocal}@${domain}`;
  return { email, emailNormalized };
}

function looksLikeEmail(e: string) {
  return !!e && e.includes("@") && e.includes(".");
}

function getOrigin(req: NextRequest) {
  return (
    process.env.APP_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_ORIGIN ||
    new URL(req.url).origin
  );
}

/** Require authenticated main-user; returns uid */
async function requireMainUser(req: NextRequest) {
  const sessionCookie = req.cookies.get("__session")?.value || "";
  if (!sessionCookie) throw new Error("UNAUTHENTICATED");

  const decoded = await adminAuth
    .verifySessionCookie(sessionCookie, true)
    .catch(() => null);
  if (!decoded?.uid) throw new Error("UNAUTHENTICATED");

  // Optional: also support Authorization: Bearer <idToken>
  const authz = req.headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) {
    const idToken = authz.slice(7).trim();
    const decodedAlt = await adminAuth.verifyIdToken(idToken).catch(() => null);
    if (decodedAlt?.uid && decodedAlt.uid !== decoded.uid) {
      // If both exist but mismatch, reject
      throw new Error("UNAUTHENTICATED");
    }
  }

  // Ensure role
  const userSnap = await db.collection("users").doc(decoded.uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const role = normalizeRole(userData?.role);
  if (!isMainUserRole(role)) throw new Error("NOT_AUTHORIZED");

  return decoded.uid;
}

/** Fetch lightweight main-user profile fields for display */
async function getMainUserProfile(uid: string) {
  const doc = await db.collection("users").doc(uid).get();
  const d = doc.exists ? doc.data() || {} : {};
  return {
    uid,
    name: d.displayName || d.name || "",
    avatar: d.photoURL || d.avatarUrl || "",
  };
}

/** Create new token & stable hash for storage */
function makeTokenPair() {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

/** Build the accept URL sent to the recipient */
function makeAcceptUrl(origin: string, token: string) {
  const url = new URL("/emergency_contact/accept", origin);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Path to invites — keep it consistent everywhere */
function invitesCol() {
  return db.collection("emergency_invites");
}

/** ---------- POST (resend/create) ---------- **/
export async function POST(req: NextRequest) {
  try {
    const mainUserUid = await requireMainUser(req);
    const { email: rawEmail, role: rawRole } = await req.json();

    if (!looksLikeEmail(rawEmail)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const { email, emailNormalized } = normalizeEmail(rawEmail);
    const role = normalizeRole(rawRole || "emergency_contact");

    // Read main user's display info (to return to client)
    const mainUser = await getMainUserProfile(mainUserUid);

    // Upsert a pending invite (idempotent by mainUserUid + recipientEmailNormalized + role)
    const existingQ = await invitesCol()
      .where("mainUserUid", "==", mainUserUid)
      .where("recipientEmailNormalized", "==", emailNormalized)
      .where("role", "==", role)
      .where("status", "==", "pending")           // ✅ NEW: reuse only a pending invite

      .limit(1)
      .get();

    const { token, tokenHash } = makeTokenPair();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7); // 7 days

    let inviteRef = invitesCol().doc();
    let status = "pending";

    if (!existingQ.empty) {
      // Reuse the latest doc if still pending; otherwise create a new doc
      const doc = existingQ.docs[0];
      const d = doc.data() || {};
      if (d.status && d.status !== "pending") {
        // don’t overwrite accepted/revoked—issue a new pending invite
        inviteRef = invitesCol().doc();
      } else {
        inviteRef = doc.ref; // resend case
      }
    }

    await inviteRef.set(
      {
        mainUserUid,
        mainUserName: mainUser.name,
        mainUserAvatar: mainUser.avatar,
        recipientEmail: email,
        recipientEmailNormalized: emailNormalized,
        role,
        tokenHash,
        status, // 'pending'
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        // expiresAt as a JS Date is fine; Admin SDK will store as a Timestamp.
        expiresAt,
      },
      { merge: true }
    );

    // Queue email (adjust to your mailer — Firestore-triggered or HTTP call)
    const origin = getOrigin(req);
    const acceptUrl = makeAcceptUrl(origin, token);

    // Example: Firestore-triggered "mail" collection (e.g. via Firebase Extensions)
    await db.collection("mail").add({
      to: email,
      template: "emergency_invite",
      createdAt: FieldValue.serverTimestamp(),
      data: {
        acceptUrl,
        inviterName: mainUser.name || "Your contact",
        inviterAvatar: mainUser.avatar || "",
        role,
      },
    });

    // Return a rich payload so the client can immediately render
    return NextResponse.json({
      ok: true,
      inviteId: inviteRef.id,
      // If your client sends the email itself, it may need the token & URL:
      token,
      acceptUrl,
      // Always include the main user's display info for the EC page:
      mainUser,
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
