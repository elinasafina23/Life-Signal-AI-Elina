export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

import { adminAuth, db } from "@/lib/firebaseAdmin";

async function requireEmergencyContact(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) {
    throw new Error("UNAUTHENTICATED");
  }

  try {
    const decoded = await adminAuth.verifySessionCookie(cookie, true);
    return { uid: decoded.uid as string };
  } catch {
    throw new Error("UNAUTHENTICATED");
  }
}

export async function GET(req: NextRequest) {
  try {
    const { uid } = await requireEmergencyContact(req);

    const snapshot = await db
      .collection("emergencyContacts")
      .where("emergencyContactUid", "==", uid)
      .get();

    const mainUserUids = new Set<string>();

    snapshot.forEach((docSnap) => {
      const data = docSnap.data() as any;
      const canonical =
        typeof data?.mainUserUid === "string" ? data.mainUserUid.trim() : "";
      const legacy =
        typeof data?.mainUserId === "string" ? data.mainUserId.trim() : "";

      if (canonical) mainUserUids.add(canonical);
      else if (legacy) mainUserUids.add(legacy);
    });

    return NextResponse.json({ mainUserUids: Array.from(mainUserUids) });
  } catch (error: any) {
    if (error?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }

    console.error("[legacy-links] Unexpected error", error);
    return NextResponse.json(
      { error: "Unable to load legacy links" },
      { status: 500 },
    );
  }
}
