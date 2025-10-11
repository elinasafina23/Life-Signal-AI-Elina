// src/app/api/sos/call-server/route.ts
import { NextResponse } from "next/server";

// Point to your deployed Cloud Function:
// e.g. https://us-central1-<PROJECT-ID>.cloudfunctions.net/makeCall
const FUNCTION_URL = process.env.NEXT_PUBLIC_MAKECALL_URL;

// Lightweight per-IP throttle to avoid accidental double-press storms.
// Does NOT affect your scheduled escalation job.
const lastHit = new Map<string, number>();
const THROTTLE_MS = 10_000; // 10s per IP

export async function POST(req: Request) {
  try {
    if (!FUNCTION_URL) {
      return NextResponse.json(
        { ok: false, error: "NEXT_PUBLIC_MAKECALL_URL is not set" },
        { status: 500 }
      );
    }

    // Extract caller IP (best-effort)
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";

    // Naive throttle only for SOS presses via this proxy.
    // Escalation calls are triggered server-side and bypass this route.
    const now = Date.now();
    const last = lastHit.get(ip) ?? 0;
    if (now - last < THROTTLE_MS) {
      return NextResponse.json({ ok: true, throttled: true }, { status: 200 });
    }

    // Read client payload and ensure a non-breaking default reason.
    // (Your Cloud Function ignores unknown fields; escalation logic is separate.)
    const bodyIn = await req.json().catch(() => ({} as any));
    const body = {
      reason: bodyIn?.reason ?? "sos", // default for clarity; harmless server-side
      to: bodyIn?.to,                  // optional; server may look up contact if omitted
      mainUserUid: bodyIn?.mainUserUid,
      emergencyContactUid: bodyIn?.emergencyContactUid,
    };

    // Forward auth if you verify Firebase ID tokens in the function.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    };
    const authz = req.headers.get("authorization");
    if (authz) headers["Authorization"] = authz;

    const upstream = await fetch(FUNCTION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });

    lastHit.set(ip, now);

    // Try to return JSON; fall back to text
    const text = await upstream.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: upstream.ok, status: upstream.status, body: text };
    }

    return NextResponse.json(data, { status: upstream.status });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Proxy error" },
      { status: 500 }
    );
  }
}
