// src/app/api/auth/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";

/**
 * How long the Firebase session cookie should last (ms).
 * Firebase allows up to 14 days; we choose 5 days here.
 */
const EXPIRES_IN = 60 * 60 * 24 * 5 * 1000; // 5 days

/**
 * OPTIONAL: lock CORS to specific origins in dev/prod.
 * - You can set ALLOWED_ORIGINS as a comma-separated list.
 * - If not set, we fallback to reflecting the incoming Origin for same-site dev.
 */
const ALLOWED = (process.env.ALLOWED_ORIGENS ?? process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

/** Compute safe CORS headers for this request. */
function makeCorsHeaders(req: NextRequest): HeadersInit {
  const origin = req.headers.get("origin") ?? "";
  // If you configured ALLOWED_ORIGINS, only allow those; otherwise reflect origin.
  const allowOrigin = ALLOWED.length > 0
    ? (ALLOWED.includes(origin) ? origin : "")
    : origin;

  // If we don't recognize the origin, return minimal headers (no ACAO) to let the browser block it.
  if (!allowOrigin) {
    return {
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "Cache-Control": "no-store",
    };
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "true", // required when sending cookies
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

/** JSON helper that also injects CORS + no-store */
function json(req: NextRequest, data: any, init?: ResponseInit) {
  const res = NextResponse.json(data, init);
  const headers = makeCorsHeaders(req);
  Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

/**
 * Handle preflight: browser sends OPTIONS before POST/DELETE with credentials.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: makeCorsHeaders(req),
  });
}

/**
 * POST /api/auth/session
 *
 * Client:
 * 1) Sign in with Firebase Client SDK to get an ID token.
 * 2) POST { idToken } here with fetch(..., { method: "POST", credentials: "include" }).
 *
 * Server:
 * 1) Verify ID token.
 * 2) Create session cookie.
 * 3) Set httpOnly cookie.
 */
export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return json(req, { error: "idToken required" }, { status: 400 });

    // Verify the ID token (2nd arg=true also checks revocation)
    await adminAuth.verifyIdToken(idToken, true);

    // Create a session cookie valid for EXPIRES_IN ms
    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: EXPIRES_IN,
    });

    const res = json(req, { ok: true });

    /**
     * IMPORTANT:
     * - When deployed behind Firebase Hosting rewrites, the cookie name must be "__session".
     * - httpOnly prevents JS from reading it.
     * - If your frontend runs on a different origin and you need the cookie on XHR/fetch,
     *   use SameSite=None + Secure (required by browsers). If the app is same-site in your env,
     *   Lax is fine. You can toggle via env if needed.
     */
    const sameSite =
      process.env.CROSS_SITE_COOKIES === "true" ? ("none" as const) : ("lax" as const);

    res.cookies.set({
      name: "__session",
      value: sessionCookie,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" || sameSite === "none",
      sameSite, // "lax" (default) or "none" when cross-site
      path: "/",
      maxAge: EXPIRES_IN / 1000,
    });

    return res;
  } catch (err) {
    console.error("POST /api/auth/session failed:", err);
    return json(req, { error: "Could not create session" }, { status: 401 });
  }
}

/**
 * GET /api/auth/session
 * Verifies the "__session" cookie and returns a minimal user payload.
 */
export async function GET(req: NextRequest) {
  try {
    const sessionCookie = req.cookies.get("__session")?.value;
    if (!sessionCookie) return json(req, {}, { status: 401 });

    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);
    const claims = decoded as Record<string, any>;

    const user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      role: claims.role ?? null, // e.g. "main_user" | "emergency_contact"
      emergencyContactUid: claims.emergencyContactUid ?? null,
    };

    return json(req, { user });
  } catch (err) {
    console.error("GET /api/auth/session failed:", err);
    return json(req, {}, { status: 401 });
  }
}

/**
 * DELETE /api/auth/session
 * Clears the session cookie (server-side logout).
 */
export async function DELETE(req: NextRequest) {
  const res = json(req, { ok: true });

  res.cookies.set({
    name: "__session",
    value: "",
    httpOnly: true,
    secure:
      process.env.NODE_ENV === "production" ||
      process.env.CROSS_SITE_COOKIES === "true",
    sameSite:
      process.env.CROSS_SITE_COOKIES === "true" ? ("none" as const) : ("lax" as const),
    path: "/",
    maxAge: 0,
  });

  return res;
}
