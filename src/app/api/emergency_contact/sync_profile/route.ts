// src/app/api/emergency_contact/sync_profile/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, db } from "@/lib/firebaseAdmin";

/** Minimal E.164 (international) validator for Telnyx. */
function isE164(phone?: string): phone is string {
  return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone.trim());
}

/** Light email check. */
function isEmail(v?: string): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** Normalize email for comparisons. */
function normalizeEmail(v?: string | null) {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** Keep + and digits only, collapse duplicate +, trim spaces. */
function sanitizePhone(raw?: string | null) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  let s = trimmed.replace(/[^\d+]/g, "");
  s = s.startsWith("+") ? "+" + s.slice(1).replace(/\+/g, "") : s.replace(/\+/g, "");
  return s;
}

/**
 * POST /api/emergency_contact/sync_profile
 * Body: { emergencyContactUid, name?, email?, phone? }
 * Auth: must be the same authenticated user as emergencyContactUid
 *
 * What it updates:
 *  - Any subcollection doc in collectionGroup("emergency_contact") where emergencyContactUid matches
 *  - Any top-level doc in collection("emergencyContacts") where emergencyContactUid matches
 *  - (NEW) Embedded summary fields on each affected main user document (contact1_* and contact2_*) if emails match
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
    const emailRaw = (body.email || "").trim();
    const phoneRaw = (body.phone || "").trim();

    const email = normalizeEmail(emailRaw);
    const phone = sanitizePhone(phoneRaw);

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
      return NextResponse.json({ ok: true, updatedLinks: 0, updatedTopLevel: 0, embeddedUpdated: 0 });
    }

    // ---- Query both locations that may store the contact ----

    // A) Link docs under various main users (subcollections named "emergency_contact")
    const linkSnap = await db
      .collectionGroup("emergency_contact")
      .where("emergencyContactUid", "==", emergencyContactUid)
      .get();

    // B) Top-level collection "emergencyContacts"
    const topSnap = await db
      .collection("emergencyContacts")
      .where("emergencyContactUid", "==", emergencyContactUid)
      .get();

    if (linkSnap.empty && topSnap.empty) {
      return NextResponse.json({ ok: true, updatedLinks: 0, updatedTopLevel: 0, embeddedUpdated: 0 });
    }

    const batch = db.batch();
    let updatedLinks = 0;
    let updatedTopLevel = 0;

    // Track main users to refresh embedded summaries, plus the "old" email per link
    const mainUsersToTouch: Array<{ mainUserUid: string; oldEmail: string }> = [];

    // ---- Update link docs + queue notifications to main user(s) ----
    linkSnap.forEach((docSnap) => {
      const linkRef = docSnap.ref;
      const linkData = docSnap.data() as any;
      const oldEmail = normalizeEmail(
        linkData?.email ||
          linkData?.emergencyContactEmail ||
          linkData?.contactEmail ||
          ""
      );

      batch.set(
        linkRef,
        {
          ...updates,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      updatedLinks++;

      const mainUserId = linkRef.parent.parent?.id;
      if (mainUserId) {
        mainUsersToTouch.push({ mainUserUid: mainUserId, oldEmail });

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
          createdAt: FieldValue.serverTimestamp(),
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
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      updatedTopLevel++;
    });

    await batch.commit();

    // ---- (NEW) Update embedded summary on each affected main user ----
    // We do this in a second pass because we need to read each main user's user doc.
    // Match by email, accepting either the "old" email from the link or the new email being saved.
    let embeddedUpdated = 0;

    // Deduplicate main users while preserving earliest oldEmail we saw
    const byMainUser = new Map<string, string>();
    for (const entry of mainUsersToTouch) {
      if (!byMainUser.has(entry.mainUserUid)) {
        byMainUser.set(entry.mainUserUid, entry.oldEmail);
      }
    }

    const batch2 = db.batch();

    for (const [mainUserUid, oldEmail] of byMainUser.entries()) {
      const muRef = db.doc(`users/${mainUserUid}`);
      const muSnap = await muRef.get();
      if (!muSnap.exists) continue;

      const mu = muSnap.data() as any;
      const ec = mu?.emergencyContacts || {};
      const c1Email = normalizeEmail(ec.contact1_email);
      const c2Email = normalizeEmail(ec.contact2_email);

      const matchesOldOrNew = (slotEmail: string) =>
        !!slotEmail && (slotEmail === oldEmail || slotEmail === email);

      const updatesEmbedded: Record<string, unknown> = {};
      let changed = false;

      if (matchesOldOrNew(c1Email)) {
        if (name) {
          const [first, ...rest] = name.split(" ");
          updatesEmbedded["emergencyContacts.contact1_firstName"] = first || "";
          updatesEmbedded["emergencyContacts.contact1_lastName"] = rest.join(" ") || "";
        }
        if (email) updatesEmbedded["emergencyContacts.contact1_email"] = email || null;
        if (phone) updatesEmbedded["emergencyContacts.contact1_phone"] = phone || null;
        changed = true;
      }

      if (matchesOldOrNew(c2Email)) {
        if (name) {
          const [first, ...rest] = name.split(" ");
          updatesEmbedded["emergencyContacts.contact2_firstName"] = first || "";
          updatesEmbedded["emergencyContacts.contact2_lastName"] = rest.join(" ") || "";
        }
        if (email) updatesEmbedded["emergencyContacts.contact2_email"] = email || null;
        if (phone) updatesEmbedded["emergencyContacts.contact2_phone"] = phone || null;
        changed = true;
      }

      if (changed) {
        updatesEmbedded["updatedAt"] = FieldValue.serverTimestamp();
        batch2.set(muRef, updatesEmbedded, { merge: true });
        embeddedUpdated++;
      }
    }

    if (embeddedUpdated > 0) {
      await batch2.commit();
    }

    return NextResponse.json({ ok: true, updatedLinks, updatedTopLevel, embeddedUpdated });
  } catch (e: any) {
    console.error("sync_profile error", e);
    const message = e?.message || "Sync failed";
    const status =
      /auth|UNAUTHENTICATED|TOKEN|session/i.test(message) ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
