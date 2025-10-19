// src/components/voice-check-in.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Loader, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssessVoiceCheckInOutput } from "@/ai/flows/voice-check-in-assessment";
import { useToast } from "@/hooks/use-toast";

/* ----------------------------- Types ----------------------------- */

interface SubmitResponse {
  ok: boolean;
  // present for broadcast
  contactCount?: number;
  anomalyPush?: {
    attempted: boolean;
    contactUidCount?: number;
    tokenCount?: number;
    successCount?: number;
    failureCount?: number;
  };
  // present for targeted
  updatedDocs?: number;
  contactId?: string;
}

interface VoiceContactTargetPayload {
  email?: string | null;
  phone?: string | null;
}

/* ------------------------ Unified submitter ------------------------ */
/** Decide and call the right API based on props:
 * - EC -> MU (sendToUid provided)        => POST /api/voice-message/send { sendToUid }
 * - MU -> specific EC (targetContact)    => POST /api/voice-message/send { targetContact }
 * - MU -> all ECs (neither provided)     => POST /api/voice-check-in/notify
 */
async function submitVoice({
  transcribedSpeech,
  previousVoiceMessages,
  audioDataUrl,
  targetContact,
  sendToUid,
}: {
  transcribedSpeech: string;
  previousVoiceMessages: string[];
  audioDataUrl?: string | null;
  targetContact?: VoiceContactTargetPayload | null;
  sendToUid?: string | null;
}): Promise<SubmitResponse> {
  // 1) Get AI assessment first
  const assessRes = await fetch("/api/voice-check-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ transcribedSpeech, previousVoiceMessages }),
  });
  const assessment: AssessVoiceCheckInOutput | any = await assessRes.json();
  if (!assessRes.ok || (assessment as any)?.error) {
    throw new Error((assessment as any)?.error || "Failed to assess voice check-in");
  }

  // 2) Route selection

  // EC → MU (IMPORTANT: API expects `sendToUid`, not `targetMainUserUid`)
  if (sendToUid) {
    const r = await fetch("/api/voice-message/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        transcribedSpeech,
        assessment,
        audioDataUrl: audioDataUrl ?? null,
        sendToUid, // ✅ fixed name
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) throw new Error(j?.error || "Failed to send voice message");
    return j as SubmitResponse;
  }

  // MU → ONE EC (by email/phone)
  const hasTarget =
    !!targetContact &&
    (!!(targetContact.email && targetContact.email.trim()) ||
      !!(targetContact.phone && targetContact.phone.trim()));
  if (hasTarget) {
    const r = await fetch("/api/voice-message/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        transcribedSpeech,
        assessment,
        audioDataUrl: audioDataUrl ?? null,
        targetContact: {
          email: targetContact?.email ?? null,
          phone: targetContact?.phone ?? null,
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) throw new Error(j?.error || "Failed to send voice message");
    return j as SubmitResponse;
  }

  // MU → ALL ECs (broadcast)
  const r = await fetch("/api/voice-check-in/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      transcribedSpeech,
      assessment,
      audioDataUrl: audioDataUrl ?? null,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || "Failed to notify emergency contacts");
  return j as SubmitResponse;
}

/* --------------------------- Component --------------------------- */

export interface VoiceCheckInProps {
  /** Called after a successful submit (optional) */
  onCheckIn?: () => void | Promise<void>;
  /** Main-user path: send to a chosen EC */
  targetContact?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  onClearTarget?: () => void;

  /** Emergency-contact path: send to this main user */
  sendToUid?: string | null;
}

export function VoiceCheckIn({
  onCheckIn,
  targetContact,
  onClearTarget,
  sendToUid,
}: VoiceCheckInProps) {
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [supported, setSupported] = useState<boolean>(true);

  const [transcript, setTranscript] = useState("");
  const [assessment, setAssessment] = useState<AssessVoiceCheckInOutput | null>(null);

  const recognitionRef = useRef<any | null>(null);
  const { toast } = useToast();

  // Audio capture
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioPromiseRef = useRef<Promise<string | null> | null>(null);
  const audioResolveRef = useRef<((v: string | null) => void) | null>(null);
  const lastAudioUrlRef = useRef<string | null>(null);

  async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function startRecording() {
    if (typeof window === "undefined") return;
    if (!navigator.mediaDevices?.getUserMedia) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const preferred = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ];
      let mimeType: string | undefined;
      if (typeof MediaRecorder !== "undefined") {
        mimeType = preferred.find((t) => {
          try {
            return MediaRecorder.isTypeSupported(t);
          } catch {
            return false;
          }
        });
      }

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];
      audioPromiseRef.current = new Promise<string | null>((resolve) => {
        audioResolveRef.current = resolve;
      });
      lastAudioUrlRef.current = null;

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        audioResolveRef.current?.(null);
        audioResolveRef.current = null;
        audioPromiseRef.current = null;
      };
      recorder.onstop = async () => {
        try {
          const mime = recorder.mimeType || mimeType || "audio/webm";
          const blob = new Blob(recordedChunksRef.current, { type: mime });
          recordedChunksRef.current = [];
          if (blob.size > 0) {
            const dataUrl = await blobToDataUrl(blob);
            lastAudioUrlRef.current = dataUrl;
            audioResolveRef.current?.(dataUrl);
          } else {
            lastAudioUrlRef.current = null;
            audioResolveRef.current?.(null);
          }
        } finally {
          audioResolveRef.current = null;
          audioPromiseRef.current = null;
          mediaRecorderRef.current = null;
          if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((t) => t.stop());
            mediaStreamRef.current = null;
          }
        }
      };

      recorder.start();
    } catch {
      // ignore – no mic available etc.
    }
  }

  function stopRecording(): Promise<string | null> {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return audioPromiseRef.current ?? Promise.resolve(lastAudioUrlRef.current);
    }
    const promise =
      audioPromiseRef.current ||
      new Promise<string | null>((resolve) => (audioResolveRef.current = resolve));
    audioPromiseRef.current = promise;
    try {
      recorder.stop();
    } catch {
      audioResolveRef.current?.(lastAudioUrlRef.current ?? null);
      audioResolveRef.current = null;
      audioPromiseRef.current = null;
      mediaRecorderRef.current = null;
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      return Promise.resolve(lastAudioUrlRef.current);
    }
    return promise;
  }

  function getPreviousMessages(): string[] {
    try {
      const raw = localStorage.getItem("voiceCheckIn.previous") || "[]";
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(-3) : [];
    } catch {
      return [];
    }
  }
  function pushPreviousMessage(msg: string) {
    try {
      const prev = getPreviousMessages();
      const next = [...prev, msg].slice(-5);
      localStorage.setItem("voiceCheckIn.previous", JSON.stringify(next));
    } catch {}
  }

  /* -------------------- Speech setup -------------------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const RecognitionCtor: any =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!RecognitionCtor) {
      setSupported(false);
      return;
    }

    const recognition = new RecognitionCtor();
    recognition.continuous = false;
    recognition.lang = "en-US";
    recognition.interimResults = false;

    recognition.onstart = () => {
      setIsListening(true);
      setAssessment(null);
      setTranscript("");
      startRecording().catch(() => null);
    };

    recognition.onresult = async (event: any) => {
      const currentTranscript: string = event.results?.[0]?.[0]?.transcript || "";
      setTranscript(currentTranscript);
      pushPreviousMessage(currentTranscript);

      const audioClipPromise = stopRecording().catch(() => null);
      setIsProcessing(true);

      try {
        const previousVoiceMessages = getPreviousMessages();

        // Use the unified submitter
        const submit = await submitVoice({
          transcribedSpeech: currentTranscript,
          previousVoiceMessages,
          audioDataUrl: await audioClipPromise,
          targetContact: targetContact
            ? { email: targetContact.email ?? null, phone: targetContact.phone ?? null }
            : null,
          sendToUid, // when on EC dashboard
        });

        // Also reflect the assessment in UI (cheap re-call just for text bubble)
        try {
          const uiAssessRes = await fetch("/api/voice-check-in", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              transcribedSpeech: currentTranscript,
              previousVoiceMessages,
            }),
          });
          const uiAssess: AssessVoiceCheckInOutput = await uiAssessRes.json();
          setAssessment(uiAssess);
        } catch {
          /* optional bubble; ignore errors */
        }

        // Toast copy
        const targeted = !!(targetContact?.name || sendToUid);
        const notifiedCount = submit?.contactCount ?? 0;
        let description: string;

        if (targeted) {
          description = "Shared directly.";
        } else if (notifiedCount > 0) {
          description =
            notifiedCount === 1
              ? "Shared with 1 emergency contact."
              : `Shared with ${notifiedCount} emergency contacts.`;
        } else {
          description = "Saved for review.";
        }

        if (submit?.anomalyPush?.attempted) {
          const success = submit.anomalyPush.successCount ?? 0;
          const tokens = submit.anomalyPush.tokenCount ?? 0;
          if (success > 0) {
            description += " Push alert delivered.";
          } else if (tokens > 0) {
            description += " Push attempted but delivery failed.";
          } else {
            description += " No devices registered for push yet.";
          }
        }

        toast({ title: "Voice message sent", description });

        if (onCheckIn) {
          try {
            await onCheckIn();
          } catch {}
        }
      } catch (e) {
        console.error("Submit failed:", e);
        toast({
          title: "Voice message not delivered",
          description: (e as any)?.message || "We couldn't reach the recipient.",
          variant: "destructive",
        });
      } finally {
        setIsProcessing(false);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      stopRecording().catch(() => null);
    };

    recognition.onerror = (event: any) => {
      const code = event?.error || "unknown";
      let message = "Could not recognize speech. Please try again.";
      if (code === "not-allowed" || code === "service-not-allowed") {
        message = "Microphone permission was denied. Please allow mic access.";
      } else if (code === "no-speech") {
        message = "No speech detected. Try again and speak clearly.";
      } else if (code === "audio-capture") {
        message = "No microphone found.";
      }
      toast({ title: "Recognition Error", description: message, variant: "destructive" });
      setIsListening(false);
      setIsProcessing(false);
      stopRecording().catch(() => null);
    };

    recognitionRef.current = recognition;
    return () => {
      try {
        recognitionRef.current?.stop?.();
      } catch {}
      recognitionRef.current = null;
      stopRecording().catch(() => null);
    };
  }, [targetContact, sendToUid, toast]);

  /* --------------------------- UI --------------------------- */

  const handleToggleListening = () => {
    if (!supported) {
      toast({
        title: "Not supported",
        description:
          "Speech recognition is not available in this browser. Try Chrome, Edge, or Safari (HTTPS).",
        variant: "destructive",
      });
      return;
    }
    try {
      if (isListening) recognitionRef.current?.stop?.();
      else recognitionRef.current?.start?.();
    } catch (e) {
      console.error(e);
    }
  };

  const getStatusIcon = () => {
    if (isProcessing) return <Loader className="h-8 w-8 animate-spin text-primary" />;
    if (assessment) {
      return assessment.anomalyDetected ? (
        <ShieldAlert className="h-8 w-8 text-destructive" />
      ) : (
        <ShieldCheck className="h-8 w-8 text-green-500" />
      );
    }
    return <Mic className="h-8 w-8 text-muted-foreground" />;
  };

  const getStatusText = () => {
    if (!supported) return "Speech recognition not supported";
    if (isListening) return "Listening…";
    if (isProcessing) return "Analyzing…";
    if (assessment) return assessment.anomalyDetected ? "Anomaly Detected" : "Check-in Confirmed";
    return "Ready to listen";
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 text-center">
      <div className="flex h-32 w-32 items-center justify-center rounded-full bg-secondary shadow-inner">
        {getStatusIcon()}
      </div>

      <p className="text-2xl font-semibold text-muted-foreground" aria-live="polite">
        {getStatusText()}
      </p>

      {/* When MU targets a specific EC we show their details; EC→MU path doesn't need this */}
      {targetContact?.name && (
        <div className="flex w-full max-w-md flex-col items-center gap-2 rounded-md bg-primary/5 p-3 text-sm text-muted-foreground">
          <p>
            <strong>Sharing with:</strong> {targetContact.name}
          </p>
          <div className="flex flex-wrap justify-center gap-2 text-xs">
            {targetContact.email && (
              <span className="rounded-full bg-background px-3 py-1">{targetContact.email}</span>
            )}
            {targetContact.phone && (
              <span className="rounded-full bg-background px-3 py-1">{targetContact.phone}</span>
            )}
          </div>
          {onClearTarget && (
            <Button type="button" variant="ghost" size="sm" onClick={onClearTarget}>
              Clear recipient
            </Button>
          )}
        </div>
      )}

      {transcript && <p className="text-base text-muted-foreground">You said: “{transcript}”</p>}

      {assessment?.explanation && (
        <p
          className={`rounded-md p-3 text-base ${
            assessment.anomalyDetected ? "bg-destructive/10" : "bg-green-500/10"
          }`}
        >
          <strong>AI Analysis:</strong> {assessment.explanation}
        </p>
      )}

      <Button
        size="lg"
        onClick={handleToggleListening}
        disabled={isProcessing || !supported}
        className="w-48 py-6 text-lg font-semibold"
        data-voice-action="start"
      >
        {isListening ? <MicOff className="mr-2 h-6 w-6" /> : <Mic className="mr-2 h-6 w-6" />}
        {isListening ? "Stop" : "Start"}
      </Button>

      {!supported && (
        <p className="text-sm text-muted-foreground">Tip: Try the latest Chrome/Edge/Safari over HTTPS.</p>
      )}
    </div>
  );
}
