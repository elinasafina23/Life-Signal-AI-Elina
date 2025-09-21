// src/app/api/auth/session/route.ts

import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";

/**
 * How long the Firebase session cookie should last (ms).
 * Firebase allows up to 14 days; we choose 5 days here.
 */
const EXPIRES_IN = 60 * 60 * 24 * 5 * 1000; // 5 days

/**
 * Small helper to return JSON responses with "no-store" caching,
 * so auth responses are never cached by the browser/CDN.
 */
function json(data: any, init?: ResponseInit) {
  const res = NextResponse.json(data, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * POST /api/auth/session
 *
 * Client flow:
 * 1) The client signs in with Firebase Client SDK and gets an ID token.
 * 2) The client POSTs that ID token here.
 *
 * Server flow:
 * 1) Verify the ID token (checks signature + revocation).
 * 2) Exchange it for a Firebase "session cookie".
 * 3) Set the session cookie on the response (httpOnly).
 *
 * Result:
 * - Your Next.js app can trust the cookie on subsequent requests
 *   without sending the ID token again.
 */
export async function POST(req: NextRequest) {
  try {
    // Parse JSON body and extract idToken from the client
    const { idToken } = await req.json();
    if (!idToken) return json({ error: "idToken required" }, { status: 400 });

    // Verify the ID token (2nd arg=true also checks revocation)
    await adminAuth.verifyIdToken(idToken, true);

    // Create a session cookie valid for EXPIRES_IN ms
    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: EXPIRES_IN,
    });

    // Build OK response
    const res = json({ ok: true });

    /**
     * IMPORTANT:
     * - When deployed behind Firebase Hosting rewrites, the cookie name
     *   must be "__session" (Firebase enforces this).
     * - httpOnly prevents JS from reading it (safer).
     * - secure only on production (allow http in dev).
     * - sameSite=lax is a good default for app navigation.
     */
    res.cookies.set({
      name: "__session",
      value: sessionCookie,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/", // send cookie on all routes
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
 *
 * Server flow:
 * 1) Read the "__session" cookie from the request.
 * 2) Verify it with Admin SDK.
 * 3) Return a "user" object your client can consume.
 *
 * Custom Claims:
 * - If you set custom claims on users (recommended), they'll be present
 *   on the decoded token. For your app, you may set:
 *     { role: "emergency_contact" | "main_user", emergencyContactUid?: string }
 * - Note: the main user's uid is always available as decoded.uid.
 */
export async function GET(req: NextRequest) {
  try {
    // Pull the session cookie from request
    const sessionCookie = req.cookies.get("__session")?.value;
    if (!sessionCookie) {
      // Not logged in / missing cookie
      return json({}, { status: 401 });
    }

    // Verify the cookie (2nd arg=true also checks revocation)
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);

    // All custom claims you set will be on 'decoded'
    const claims = decoded as Record<string, any>;

    // Build a minimal user payload for the client.
    // - uid: this user's Auth UID (main user or emergency contact).
    // - role: your app role if you set it in custom claims.
    // - emergencyContactUid: present only for contacts (if you use it).
    const user = {
      uid: decoded.uid, // this is the authenticated user's UID
      email: decoded.email ?? null,
      role: claims.role ?? null, // e.g., "main_user" | "emergency_contact"
      emergencyContactUid: claims.emergencyContactUid ?? null, // your new naming
    };

    return json({ user });
  } catch (err) {
    console.error("GET /api/auth/session failed:", err);
    // Cookie missing/expired/revoked, or invalid token
    return json({}, { status: 401 });
  }
}

/**
 * DELETE /api/auth/session
 *
 * Clears the session cookie to "log out" on the server side.
 */
export async function DELETE() {
  const res = json({ ok: true });

  // Overwrite with empty value + maxAge=0 to remove the cookie
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
