// app/api/telnyx-webhook/route.ts
export const runtime = "nodejs";        // ensure Node runtime
export const dynamic = "force-dynamic"; // don't cache

import type { NextRequest } from "next/server";

async function speak(callControlId: string, text: string) {
  // Optional helper: say TTS when the call is answered
  const apiKey = process.env.TELNYX_API_KEY!;
  await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      language: "en-US",
      voice: "female",
      payload: text,
    }),
  });
}

export async function POST(req: NextRequest) {
  // If you want to verify signatures later, read the raw body first:
  const raw = await req.text();
  // const sig = req.headers.get("telnyx-signature");
  // TODO: verify with process.env.TELNYX_WEBHOOK_SECRET (optional but recommended)

  try {
    const evt = JSON.parse(raw);
    const type = evt?.data?.event_type as string | undefined;
    const callControlId = evt?.data?.payload?.call_control_id as string | undefined;

    console.log("Telnyx event:", type, callControlId);

    // Example minimal behavior: when call is answered, speak a line.
    if (type === "call.answered" && callControlId) {
      // Customize this text however you like:
      await speak(callControlId, "Hello. This is Life Signal. This is a test call.");
    }

    // Always acknowledge quickly
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("Webhook parse error", e);
    // Still 200 to stop retries unless you specifically want retries
    return new Response("ok", { status: 200 });
  }
}
