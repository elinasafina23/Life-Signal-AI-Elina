// app/push-redirect/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { adminAuth } from "@/lib/firebaseAdmin";

export const runtime = "nodejs"; // Admin SDK requires Node runtime

type Role = "user" | "emergency_contact";

/** Only allow same-origin app paths (e.g. "/dashboard?x=1"). */
function sanitizeDeepLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    // Accept only absolute-path links like "/foo", optionally with query/hash.
    if (raw.startsWith("/")) return raw;
    return null; // reject full URLs or weird schemes
  } catch {
    return null;
  }
}

function inferRoleFromParams(params: URLSearchParams): Role {
  const explicit = (params.get("role") || "").toLowerCase();
  if (explicit === "emergency_contact") return "emergency_contact";
  if (explicit === "user") return "user";

  const type = params.get("type") || "";
  if (type === "missed_checkin_emergency") return "emergency_contact";
  return "user";
}

function buildDest(params: URLSearchParams, role: Role): string {
  // 1) Prefer deepLink if present & safe
  const deepLink = sanitizeDeepLink(params.get("deepLink"));
  if (deepLink) return deepLink;

  // 2) Otherwise default dashboards by role
  const base = role === "emergency_contact" ? "/emergency-dashboard" : "/dashboard";

  // 3) Preserve useful context for the landing screen
  const keep = new URLSearchParams();
  const userId = params.get("userId");
  const type = params.get("type");
  if (userId) keep.set("userId", userId);
  if (type) keep.set("type", type);

  return keep.toString() ? `${base}?${keep.toString()}` : base;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  // Verify Firebase session cookie (__session)
  const cookieStore = await cookies();
 const sessionCookie = cookieStore.get("__session")?.value || null;

  let uid: string | null = null;
  let roleFromClaims: Role | null = null;

  if (sessionCookie) {
    try {
      const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);
      uid = decoded.uid;

      // If you've set custom claims like { role: "emergency_contact" }
      const claimRole = String((decoded as any).role || "").toLowerCase();
      if (claimRole === "emergency_contact") roleFromClaims = "emergency_contact";
      else if (claimRole === "user") roleFromClaims = "user";
    } catch {
      uid = null; // invalid/expired/revoked -> treat as logged out
    }
  }

  const role: Role = roleFromClaims ?? inferRoleFromParams(params);
  const destPath = buildDest(params, role);

  if (!uid) {
    const login = `/login?next=${encodeURIComponent(destPath)}`;
    return NextResponse.redirect(new URL(login, url.origin), { status: 302 });
  }

  return NextResponse.redirect(new URL(destPath, url.origin), { status: 302 });
}
