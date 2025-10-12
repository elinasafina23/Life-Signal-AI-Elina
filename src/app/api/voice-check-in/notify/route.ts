export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

import { adminAuth, db } from "@/lib/firebaseAdmin";
import { isMainUserRole, normalizeRole } from "@/lib/roles";

interface AssessVoiceCheckInOutput {
  anomalyDetected: boolean;
  explanation: string;
}

async function requireMainUser(req: NextRequest) {
  const cookie = req.cookies.get("__session")?.value || "";
  if (!cookie) {
    throw new Error("UNAUTHENTICATED");
  }

  let decoded;
  try {
    decoded = await adminAuth.verifySessionCookie(cookie, true);
  } catch {
    throw new Error("UNAUTHENTICATED");
  }

  const userSnap = await db.doc(`users/${decoded.uid}`).get();
  const role = normalizeRole((userSnap.data() as any)?.role);
  if (!isMainUserRole(role || undefined)) {
    throw new Error("NOT_AUTHORIZED");
  }

  return { uid: decoded.uid as string };
}

function buildDisplayName(data: any | undefined | null): string {
  if (!data || typeof data !== "object") return "";
  const direct =
    typeof data.displayName === "string" && data.displayName.trim().length > 0
      ? data.displayName.trim()
      : "";
  if (direct) return direct;

  const first = typeof data.firstName === "string" ? data.firstName.trim() : "";
  const last = typeof data.lastName === "string" ? data.lastName.trim() : "";
  const combined = `${first} ${last}`.trim();
  if (combined) return combined;

  const fallback = typeof data.name === "string" ? data.name.trim() : "";
  return fallback;
}

async function getFcmTokensForUser(uid: string): Promise<string[]> {
  try {
    const snap = await db.collection(`users/${uid}/devices`).get();
    const tokens = new Set<string>();
    snap.forEach((doc) => {
      const data = doc.data() as any;
      const token = String(data?.fcmToken || data?.token || "").trim();
      const disabled = Boolean(data?.disabled);
      if (!disabled && token) {
        tokens.add(token);
      }
    });
    return Array.from(tokens);
  } catch (error) {
    console.error(`[voice-check-in notify] failed to load device tokens for ${uid}:`, error);
    return [];
  }
}

async function sendPushToTokens(
  tokens: string[],
  notif: { title: string; body: string },
  data: Record<string, string>,
): Promise<{ successCount: number; failureCount: number } | null> {
  const uniqueTokens = Array.from(new Set(tokens.filter((token) => typeof token === "string" && token.trim())));
  if (!uniqueTokens.length) return null;

  try {
    const messaging = getMessaging();
    const response = await messaging.sendEachForMulticast({
      tokens: uniqueTokens,
      notification: {
        title: notif.title,
        body: notif.body,
      },
      data,
      android: { priority: "high" },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "default" } },
      },
    });

    return { successCount: response.successCount, failureCount: response.failureCount };
  } catch (error) {
    console.error("[voice-check-in notify] push delivery failed:", error);
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { uid: mainUserUid } = await requireMainUser(req);
    const body = await req.json().catch(() => ({} as any));

    const transcriptRaw = body?.transcribedSpeech;
    const assessment = body?.assessment as AssessVoiceCheckInOutput | undefined;
    const audioDataUrlRaw = typeof body?.audioDataUrl === "string" ? body.audioDataUrl.trim() : "";
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    let audioDataUrl: string | null = null;
    if (audioDataUrlRaw) {
      if (/^data:audio\//i.test(audioDataUrlRaw)) {
        audioDataUrl = audioDataUrlRaw;
      } else {
        return NextResponse.json(
          { error: "audioDataUrl must be a base64-encoded data URL" },
          { status: 400 },
        );
      }
    }

    const transcript = typeof transcriptRaw === "string" ? transcriptRaw.trim() : "";
    if (!transcript) {
      return NextResponse.json({ error: "transcribedSpeech is required" }, { status: 400 });
    }

    if (!assessment || typeof assessment !== "object") {
      return NextResponse.json({ error: "assessment is required" }, { status: 400 });
    }

    const explanation = typeof assessment.explanation === "string" ? assessment.explanation.trim() : "";
    if (!explanation) {
      return NextResponse.json({ error: "assessment.explanation is required" }, { status: 400 });
    }

    const anomalyDetected = Boolean(assessment.anomalyDetected);

    const userRef = db.doc(`users/${mainUserUid}`);
    const [contactsSnap, userSnap] = await Promise.all([
      db
        .collection("emergencyContacts")
        .where("mainUserUid", "==", mainUserUid)
        .where("status", "==", "ACTIVE")
        .get(),
      userRef.get().catch(() => null),
    ]);

    const userData = userSnap?.exists ? (userSnap.data() as any) : null;
    const mainUserName = buildDisplayName(userData);

    const batch = db.batch();

    const voiceMessageRef = db
      .collection("users")
      .doc(mainUserUid)
      .collection("voiceMessages")
      .doc();

    const voicePayload: Record<string, any> = {
      transcript,
      explanation,
      anomalyDetected,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
    };
    if (audioDataUrl) {
      voicePayload.audioDataUrl = audioDataUrl;
    }

    batch.set(voiceMessageRef, voicePayload);

    batch.set(
      userRef,
      {
        latestVoiceMessage: {
          transcript,
          explanation,
          anomalyDetected,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt,
          ...(audioDataUrl ? { audioDataUrl } : {}),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    contactsSnap.forEach((docSnap) => {
      batch.set(
        docSnap.ref,
        {
          lastVoiceMessage: {
            transcript,
            explanation,
            anomalyDetected,
            createdAt: FieldValue.serverTimestamp(),
            expiresAt,
            ...(audioDataUrl ? { audioDataUrl } : {}),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    await batch.commit();

    const pushSummary = {
      attempted: false,
      contactUidCount: 0,
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
    };

    if (anomalyDetected) {
      pushSummary.attempted = true;

      const contactUids = new Set<string>();
      contactsSnap.forEach((docSnap) => {
        const data = docSnap.data() as any;
        const contactUid = typeof data?.emergencyContactUid === "string" ? data.emergencyContactUid.trim() : "";
        if (contactUid) {
          contactUids.add(contactUid);
        }
      });

      pushSummary.contactUidCount = contactUids.size;

      if (contactUids.size) {
        const tokenArrays = await Promise.all(Array.from(contactUids).map((uid) => getFcmTokensForUser(uid)));
        const tokens = Array.from(new Set(tokenArrays.flat()));
        pushSummary.tokenCount = tokens.length;

        const nameForAlert = mainUserName || "your loved one";
        const notifBody = mainUserName
          ? `${mainUserName}'s voice check-in sounded unusual. Tap to review the AI summary.`
          : "A voice check-in sounded unusual. Tap to review the AI summary.";

        const pushResult = await sendPushToTokens(tokens, { title: "Life Signal alert", body: notifBody }, {
          type: "voice_check_in_anomaly",
          mainUserUid,
          anomalyDetected: "true",
          voiceMessageId: voiceMessageRef.id,
          name: nameForAlert,
        });

        if (pushResult) {
          pushSummary.successCount = pushResult.successCount;
          pushSummary.failureCount = pushResult.failureCount;
        }
      }
    }

    return NextResponse.json({ ok: true, contactCount: contactsSnap.size, anomalyPush: pushSummary });
  } catch (error: any) {
    if (error?.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (error?.message === "NOT_AUTHORIZED") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    console.error("[voice-check-in notify] failed:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to send voice message" },
      { status: 500 }
    );
  }
}
