export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";

import { assessVoiceCheckIn } from "@/ai/flows/voice-check-in-assessment";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { transcribedSpeech, previousVoiceMessages } = body ?? {};

    if (typeof transcribedSpeech !== "string") {
      return Response.json(
        { error: "transcribedSpeech must be a string" },
        { status: 400 },
      );
    }

    if (!Array.isArray(previousVoiceMessages) || previousVoiceMessages.some((msg) => typeof msg !== "string")) {
      return Response.json(
        { error: "previousVoiceMessages must be an array of strings" },
        { status: 400 },
      );
    }

    const result = await assessVoiceCheckIn({
      transcribedSpeech,
      previousVoiceMessages,
    });

    return Response.json(result);
  } catch (error) {
    console.error("Voice check-in assessment failed:", error);
    return Response.json({ error: "Failed to assess voice check-in." }, { status: 500 });
  }
}