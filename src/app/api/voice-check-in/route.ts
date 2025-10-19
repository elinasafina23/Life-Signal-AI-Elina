// Opt into the Node.js runtime for this route (edge is not required here)
export const runtime = "nodejs"; // ✅ Route runs on Node.js (good for larger libs)

// Force dynamic rendering so Next.js doesn't try to cache this route
export const dynamic = "force-dynamic"; // ✅ Always compute fresh results

// --- Types ---
import type { NextRequest } from "next/server"; // ✅ Type for the incoming request

// --- AI flow that evaluates the user's voice check-in content ---
import { assessVoiceCheckIn } from "@/ai/flows/voice-check-in-assessment"; // ✅ Your AI analysis function

// Handle POST /api/voice-check-in
export async function POST(req: NextRequest) {
  try {
    // Parse JSON body from the request
    const body = await req.json(); // ✅ Expecting JSON payload from client

    // Destructure inputs we expect from the client
    // - transcribedSpeech: the current utterance (string)
    // - previousVoiceMessages: a short history of prior utterances (string[])
    const { transcribedSpeech, previousVoiceMessages } = body ?? {}; // ✅ Safe destructure

    // Validate: transcribedSpeech must be a string
    if (typeof transcribedSpeech !== "string") {
      return Response.json(
        { error: "transcribedSpeech must be a string" }, // ❌ Client error message
        { status: 400 },                                  // ❌ Bad Request
      );
    }

    // Validate: previousVoiceMessages must be an array of strings
    if (
      !Array.isArray(previousVoiceMessages) ||                 // must be an array
      previousVoiceMessages.some((msg) => typeof msg !== "string") // and contain only strings
    ) {
      return Response.json(
        { error: "previousVoiceMessages must be an array of strings" }, // ❌ Client error
        { status: 400 },                                                 // ❌ Bad Request
      );
    }

    // Run the AI analysis (e.g., anomaly detection, explanation, score)
    const result = await assessVoiceCheckIn({
      transcribedSpeech,          // ✅ Current utterance
      previousVoiceMessages,      // ✅ Short history for context
    });

    // Return the AI assessment back to the client
    return Response.json(result); // ✅ 200 OK with assessment payload
  } catch (error) {
    // Log unexpected issues (helps with server debugging)
    console.error("Voice check-in assessment failed:", error); // ⚠️ Server log

    // Hide internal details from the client; return generic error
    return Response.json(
      { error: "Failed to assess voice check-in." }, // ❌ Generic server error
      { status: 500 },                               // ❌ Internal Server Error
    );
  }
}
