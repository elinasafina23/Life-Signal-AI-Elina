// app/push-redirect/route.ts

import { NextResponse } from "next/server"; // Used to send redirects in Next.js API routes
import { cookies } from "next/headers"; // To read the "__session" cookie set by Firebase
import { adminAuth } from "@/lib/firebaseAdmin"; // Firebase Admin SDK (server-side)

// Firebase Admin SDK requires Node.js runtime (not "edge").
export const runtime = "nodejs"; 

// Our two possible roles in this app.
type Role = "main_user" | "emergency_contact";

/** 
 * Utility: only allow safe same-origin paths for deep links.
 * Example: "/dashboard?x=1" is allowed.
 * Full URLs like "http://evil.com" are rejected.
 */
function sanitizeDeepLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    if (raw.startsWith("/")) return raw; // Accept paths starting with "/"
    return null; // Reject anything else
  } catch {
    return null;
  }
}

/**
 * Utility: figure out role from query parameters if possible.
 * We check ?role=... or fallback based on the notification type.
 */
function inferRoleFromParams(params: URLSearchParams): Role {
  const explicit = (params.get("role") || "").toLowerCase();
  if (explicit === "emergency_contact") return "emergency_contact";
  if (explicit === "main_user") return "main_user";

  // Fallback: if push type indicates emergency, assume emergency_contact
  const type = params.get("type") || "";
  if (type === "missed_checkin_emergency") return "emergency_contact";

  return "main_user";
}

/**
 * Utility: decide where the user should be redirected.
 */
function buildDest(params: URLSearchParams, role: Role): string {
  // 1. Prefer a deepLink if explicitly provided & safe
  const deepLink = sanitizeDeepLink(params.get("deepLink"));
  if (deepLink) return deepLink;

  // 2. Otherwise default dashboards by role
  const base = role === "emergency_contact" ? "/emergency-dashboard" : "/dashboard";

  // 3. Preserve context in query string (so dashboard knows what to show)
  const keep = new URLSearchParams();

  // 🔑 Rename params consistently
  const mainUserUid = params.get("mainUserUid");
  const emergencyContactUid = params.get("emergencyContactUid");
  const type = params.get("type");

  if (mainUserUid) keep.set("mainUserUid", mainUserUid);
  if (emergencyContactUid) keep.set("emergencyContactUid", emergencyContactUid);
  if (type) keep.set("type", type);

  // Return base path with context if available
  return keep.toString() ? `${base}?${keep.toString()}` : base;
}

/**
 * GET handler — runs whenever this route is called.
 * We verify the session cookie, decide the role, and redirect.
 */
export async function GET(req: Request) {
  const url = new URL(req.url); // Parse the incoming request URL
  const params = url.searchParams; // Extract ?query parameters

  // Check Firebase session cookie (__session) for authentication
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("__session")?.value || null;

  let uid: string | null = null; // Will hold the logged-in Firebase uid
  let roleFromClaims: Role | null = null; // Role extracted from Firebase custom claims

  if (sessionCookie) {
    try {
      // Verify cookie with Firebase Admin SDK
      const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);
      uid = decoded.uid;

      // If we’ve set custom claims like { role: "emergency_contact" }
      const claimRole = String((decoded as any).role || "").toLowerCase();
      if (claimRole === "emergency_contact") roleFromClaims = "emergency_contact";
      else if (claimRole === "main_user") roleFromClaims = "main_user";
    } catch {
      uid = null; // Invalid/expired cookie → treat as logged out
    }
  }

  // Final role: prefer role from claims, otherwise infer from query params
  const role: Role = roleFromClaims ?? inferRoleFromParams(params);

  // Build the destination path with context (mainUserUid / emergencyContactUid / type)
  const destPath = buildDest(params, role);

  // If user is not logged in → send them to login page first
  if (!uid) {
    const login = `/login?next=${encodeURIComponent(destPath)}`;
    return NextResponse.redirect(new URL(login, url.origin), { status: 302 });
  }

  // Otherwise, redirect them to their dashboard (with preserved context)
  return NextResponse.redirect(new URL(destPath, url.origin), { status: 302 });
}
