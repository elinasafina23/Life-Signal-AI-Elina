// at top of route.ts files
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminAuth, db } from "@/lib/firebaseAdmin";

/**
 * POST /api/emergency_contact/sync_profile
 * Body: { emergencyContactUid, name, email, phone }
 * Auth: must be the same authenticated user as emergencyContactUid
 */
export async function POST(req: NextRequest) {
  try {
    // Verify session cookie
    const cookie = req.cookies.get("__session")?.value || "";
    if (!cookie) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    const decoded = await adminAuth.verifySessionCookie(cookie, true);

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

    const name = (body.name || "").trim();
    const email = (body.email || "").trim();
    const phone = (body.phone || "").trim();

    // Find all link docs that point to this emergency contact
    const linksSnap = await db
      .collectionGroup("emergency_contact")
      .where("emergencyContactUid", "==", emergencyContactUid)
      .get();

    if (linksSnap.empty) {
      return NextResponse.json({ ok: true, updated: 0 });
    }

    const batch = db.batch();
    let updated = 0;

    linksSnap.forEach((docSnap) => {
      const linkRef = docSnap.ref;
      batch.set(
        linkRef,
        {
          name,
          email,
          phone,
          updatedAt: new Date(),
        },
        { merge: true }
      );

      // Optional: create a notification under the main user
      const mainUserId = linkRef.parent.parent?.id;
      if (mainUserId) {
        const notifRef = db.collection("users").doc(mainUserId).collection("notifications").doc();
        batch.set(notifRef, {
          type: "contact_updated",
          title: "Emergency contact updated",
          body: `${name || "Your contact"} updated their info.`,
          data: { emergencyContactUid, name, email, phone },
          createdAt: new Date(),
          read: false,
        });
      }
      updated++;
    });

    await batch.commit();
    return NextResponse.json({ ok: true, updated });
  } catch (e: any) {
    console.error("sync_profile error", e);
    const msg = e?.message || "Sync failed";
    const code = msg.includes("UNAUTHENTICATED") ? 401 : 400;
    return NextResponse.json({ error: msg }, { status: code });
  }
}
