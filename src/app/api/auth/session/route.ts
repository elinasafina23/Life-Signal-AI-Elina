// src/app/api/auth/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";

const EXPIRES_IN = 60 * 60 * 24 * 5 * 1000; // 5 days

export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return NextResponse.json({ error: "idToken required" }, { status: 400 });

    // Verify the client ID token and mint a session cookie
    await adminAuth.verifyIdToken(idToken, true);
    const sessionCookie = await adminAuth.createSessionCookie(idToken, { expiresIn: EXPIRES_IN });

    const res = NextResponse.json({ ok: true });
    res.cookies.set({
      name: "__session",
      value: sessionCookie,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: EXPIRES_IN / 1000,
    });
    return res;
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Could not create session" }, { status: 401 });
  }
}

export async function DELETE() {
  // Clear the cookie on logout
  const res = NextResponse.json({ ok: true });
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
