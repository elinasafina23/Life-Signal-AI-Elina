// src/app/api/emergency_contact/sync_profile/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminAuth, db } from "@/lib/firebaseAdmin";

/** Minimal E.164 (international) validator for Telnyx. */
function isE164(phone?: string): phone is string {
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone.trim());
}

/** Light email check. */
function isEmail(v?: string): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/**
 * POST /api/emergency_contact/sync_profile
 * Body: { emergencyContactUid, name?, email?, phone? }
 * Auth: must be the same authenticated user as emergencyContactUid
 *
 * What it updates:
 *  - Any subcollection doc in collectionGroup("emergency_contact") where emergencyContactUid matches
 *  - Any top-level doc in collection("emergencyContacts") where emergencyContactUid matches
 * Validations:
 *  - phone must be E.164 (e.g., +15551234567) if provided
 *  - email must be valid if provided
 */
export async function POST(req: NextRequest) {
  try {
    // ---- Auth: verify Firebase session cookie ----
    const cookie = req.cookies.get("__session")?.value || "";
    if (!cookie) {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    const decoded = await adminAuth.verifySessionCookie(cookie, true);

    // ---- Parse body ----
    const body = (await req.json()) as {
      emergencyContactUid?: string;
      name?: string;
      email?: string;
      phone?: string;
    };

    const emergencyContactUid = (body.emergencyContactUid || "").trim();
    if (!emergencyContactUid) {
      return NextResponse.json({ error: "Missing emergencyContactUid" }, { status: 400 });
    }

    // Caller can only sync their own profile
    if (decoded.uid !== emergencyContactUid) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Prepare validated updates
    const updates: Record<string, unknown> = {};
    const name = (body.name || "").trim();
    const email = (body.email || "").trim();
    const phone = (body.phone || "").trim();

    if (name) updates.name = name;
    if (email) {
      if (!isEmail(email)) {
        return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
      }
      updates.email = email;
    }
    if (phone) {
      if (!isE164(phone)) {
        return NextResponse.json(
          { error: "Phone must be in E.164 format, e.g. +15551234567" },
          { status: 400 }
        );
      }
      updates.phone = phone;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ ok: true, updatedLinks: 0, updatedTopLevel: 0 });
    }

    // ---- Query both locations that may store the contact ----

    // A) Link docs under various main users (subcollections named "emergency_contact")
    const linkSnap = await db
      .collectionGroup("emergency_contact")
      .where("emergencyContactUid", "==", emergencyContactUid)
      .get();

    // B) Top-level collection "emergencyContacts" (your screenshot)
    const topSnap = await db
      .collection("emergencyContacts")
      .where("emergencyContactUid", "==", emergencyContactUid)
      .get();

    if (linkSnap.empty && topSnap.empty) {
      return NextResponse.json({ ok: true, updatedLinks: 0, updatedTopLevel: 0 });
    }

    const batch = db.batch();
    let updatedLinks = 0;
    let updatedTopLevel = 0;

    // ---- Update link docs + send notifications to main user(s) ----
    linkSnap.forEach((docSnap) => {
      const linkRef = docSnap.ref;

      batch.set(
        linkRef,
        {
          ...updates,
          updatedAt: new Date(),
        },
        { merge: true }
      );
      updatedLinks++;

      const mainUserId = linkRef.parent.parent?.id;
      if (mainUserId) {
        const notifRef = db
          .collection("users")
          .doc(mainUserId)
          .collection("notifications")
          .doc();

        const title = "Emergency contact updated";
        const bodyText = `${name || "Your contact"} updated their info.`;

        batch.set(notifRef, {
          type: "contact_updated",
          title,
          body: bodyText,
          data: {
            emergencyContactUid,
            ...(name ? { name } : {}),
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
          },
          createdAt: new Date(),
          read: false,
        });
      }
    });

    // ---- Update top-level emergencyContacts docs ----
    topSnap.forEach((docSnap) => {
      const topRef = docSnap.ref;
      batch.set(
        topRef,
        {
          ...updates,
          updatedAt: new Date(),
        },
        { merge: true }
      );
      updatedTopLevel++;
    });

    await batch.commit();

    return NextResponse.json({ ok: true, updatedLinks, updatedTopLevel });
  } catch (e: any) {
    console.error("sync_profile error", e);
    const message = e?.message || "Sync failed";
    const status =
      /auth|UNAUTHENTICATED|TOKEN|session/i.test(message) ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
