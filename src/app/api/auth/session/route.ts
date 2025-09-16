// src/app/api/auth/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";

/**
 * How long the Firebase session cookie should last (ms).
 * NOTE: Firebase allows up to 14 days. We're using 5 days here.
 */
const EXPIRES_IN = 60 * 60 * 24 * 5 * 1000; // 5 days

/**
 * Utility: build a JSON response with no-store cache headers,
 * so browsers/CDNs don't cache auth responses.
 */
function json(data: any, init?: ResponseInit) {
  const res = NextResponse.json(data, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * POST /api/auth/session
 * Exchange a Firebase ID token for a session cookie and set it on the response.
 * Call this from your client after sign-in (with the ID token).
 */
export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json({ error: "idToken required" }, { status: 400 });

    // Verify the client ID token first (also checks revocation when true)
    await adminAuth.verifyIdToken(idToken, true);

    // Mint a session cookie from the ID token
    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: EXPIRES_IN,
    });

    const res = json({ ok: true });

    // IMPORTANT: cookie name must be "__session" when deploying behind Firebase Hosting.
    res.cookies.set({
      name: "__session",
      value: sessionCookie,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // in dev, allow http
      sameSite: "lax",
      path: "/", // send cookie for all routes
      maxAge: EXPIRES_IN / 1000, // seconds
    });

    return res;
  } catch (err) {
    console.error("POST /api/auth/session failed:", err);
    return json({ error: "Could not create session" }, { status: 401 });
  }
}

/**
 * GET /api/auth/session
 * Read & verify the Firebase session cookie and return the user payload
 * (including any custom claims like role/emergencyContactId).
 */
export async function GET(req: NextRequest) {
  try {
    const sessionCookie = req.cookies.get("__session")?.value;
    if (!sessionCookie) {
      return json({}, { status: 401 }); // not logged in
    }

    // Verify the cookie (2nd arg=true also checks revocation)
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);

    // If you set custom claims (recommended), they'll be present here:
    // await adminAuth.setCustomUserClaims(uid, { role: "EMERGENCY_CONTACT", emergencyContactId: "..." })
    const claims = decoded as Record<string, any>;

    const user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      // Custom claims (add more if you set them)
      role: claims.role ?? null,
      emergencyContactId: claims.emergencyContactId ?? null,
    };

    return json({ user });
  } catch (err) {
    console.error("GET /api/auth/session failed:", err);
    // Cookie missing/expired/revoked, or token invalid
    return json({}, { status: 401 });
  }
}

/**
 * DELETE /api/auth/session
 * Log out by clearing the session cookie.
 */
export async function DELETE() {
  const res = json({ ok: true });
  res.cookies.set({
    name: "__session",
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
