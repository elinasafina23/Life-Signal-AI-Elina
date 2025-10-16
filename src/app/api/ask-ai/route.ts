//src/app/api/ask-ai/route.ts//
// Ensure this route runs on the Node.js runtime (not Edge)
export const runtime = "nodejs";
// Disable caching and force dynamic execution (since we touch Firestore)
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server"; // Next.js request/response types
import { FieldValue } from "firebase-admin/firestore";   // Admin SDK sentinel values (serverTimestamp)

import { runAskAiAssistant } from "@/ai/flows/ask-ai-assistant"; // Your server flow (now with moderation)
import { adminAuth, db } from "@/lib/firebaseAdmin";             // Firebase Admin helpers (auth + Firestore)
import { isMainUserRole, normalizeRole } from "@/lib/roles";     // Role utilities (aliases kept consistent)

/** Guard: require an authenticated main_user via Firebase session cookie. */
async function requireMainUser(req: NextRequest) {
  // Read the signed session cookie set by your session endpoint
  const cookie = req.cookies.get("__session")?.value || "";
  // If missing, reject as unauthenticated
  if (!cookie) {
    throw new Error("UNAUTHENTICATED");
  }

  // Decode the cookie to a Firebase session (revocation checked)
  let decoded;
  try {
    decoded = await adminAuth.verifySessionCookie(cookie, true); // true = checkRevoked
  } catch {
    // If verification fails, treat as unauthenticated
    throw new Error("UNAUTHENTICATED");
  }

  // Fetch the user document to inspect their role
  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  // Normalize any stored role string to canonical alias ("main_user" | "emergency_contact")
  const role = normalizeRole((userSnap.data() as any)?.role);
  // Only allow main users to hit this endpoint
  if (!isMainUserRole(role || undefined)) {
    throw new Error("NOT_AUTHORIZED");
  }

  // Return the UID for downstream writes
  return { uid: decoded.uid as string };
}

/** POST /api/ask-ai — runs the assistant, stores a mood summary, returns the answer. */
export async function POST(req: NextRequest) {
  try {
    // Ensure caller is an authenticated main user
    const { uid } = await requireMainUser(req);

    // Parse JSON body; if invalid JSON, respond clearly
    const body = await req
      .json()
      .catch(() => {
        throw new Error("BAD_JSON");
      });

    // Extract question as a trimmed string
    const questionRaw =
      typeof body?.question === "string" ? body.question.trim() : "";

    // Normalize whitespace and clamp length to guard backend/model
    const question =
      questionRaw.replace(/\s+/g, " ").slice(0, 4000).trim();

    // Enforce non-empty question
    if (!question) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    // Run the moderated server flow (guarantees schema-compliant output)
    const aiResult = await runAskAiAssistant({ question });

    // Construct mood summary payload to persist to user + active contacts
    const moodSummary = {
      mood: aiResult.mood,                         // short label (e.g., "calm")
      description: aiResult.moodDescription ?? "", // optional explanation
      updatedAt: FieldValue.serverTimestamp(),     // server-side timestamp
      source: "ask-ai" as const,                   // provenance tag (alias consistent)
    };

    // Target user doc for writes
    const userRef = db.doc(`users/${uid}`);

    // Fetch ACTIVE emergency contacts linked to this main user
    const contactsSnap = await db
      .collection("emergencyContacts")
      .where("mainUserUid", "==", uid)
      .where("status", "==", "ACTIVE")
      .get();

    // Batch updates: user doc + each active contact doc
    const batch = db.batch();

    // Merge mood summary onto user doc
    batch.set(
      userRef,
      {
        latestMoodAssessment: moodSummary,            // upsert latest mood summary
        updatedAt: FieldValue.serverTimestamp(),      // bookkeeping timestamp
      },
      { merge: true },                                 // do not overwrite other fields
    );

    // Merge mood summary onto every active contact doc
    contactsSnap.forEach((docSnap) => {
      batch.set(
        docSnap.ref,
        {
          latestMoodAssessment: moodSummary,          // reflect the same summary for contacts
          updatedAt: FieldValue.serverTimestamp(),    // bookkeeping timestamp
        },
        { merge: true },                               // non-destructive update
      );
    });

    // Commit all writes atomically
    await batch.commit();

    // Return the assistant answer + a client-friendly mood summary
    return NextResponse.json({
      answer: aiResult.answer,                      // text for the client to show/play
      moodSummary: {
        mood: aiResult.mood,                        // short label
        description: aiResult.moodDescription ?? "",// optional explanation
      },
    });
  } catch (error) {
    // Map common error cases to HTTP codes/messages
    if (error instanceof Error) {
      // Bad JSON payload was sent by the client
      if (error.message === "BAD_JSON") {
        return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
      }
      // Missing/invalid session cookie
      if (error.message === "UNAUTHENTICATED") {
        return NextResponse.json({ error: "Authentication required." }, { status: 401 });
      }
      // User is not a main_user
      if (error.message === "NOT_AUTHORIZED") {
        return NextResponse.json({ error: "Not authorized." }, { status: 403 });
      }
    }

    // Log unexpected failures for diagnostics
    console.error("[ask-ai] failed:", error);
    // Generic server error for the client
    return NextResponse.json({ error: "Assistant request failed." }, { status: 500 });
  }
}
