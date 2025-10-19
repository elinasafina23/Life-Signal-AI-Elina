// src/components/voice-check-in.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Loader, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssessVoiceCheckInOutput } from "@/ai/flows/voice-check-in-assessment";
import { useToast } from "@/hooks/use-toast";

interface NotifyContactsResponse {
  ok: boolean;
  contactCount?: number; // broadcast response
  updatedDocs?: number;  // targeted response
  anomalyPush?: {
    attempted: boolean;
    contactUidCount?: number;
    tokenCount?: number;
    successCount?: number;
    failureCount?: number;
  };
}

interface VoiceContactTargetPayload {
  email?: string | null;
  phone?: string | null;
}

/**
 * Send the voice payload either:
 * - to ALL emergency contacts (broadcast) via /api/voice-check-in/notify
 * - to ONE selected contact (targeted) via /api/voice-message/send
 *
 * We switch endpoints based on whether a targetContact with (email|phone) is supplied.
 */
async function notifyEmergencyContacts(
  currentTranscript: string,
  aiAssessment: AssessVoiceCheckInOutput,
  audioDataUrl?: string | null,
  targetContact?: VoiceContactTargetPayload | null,
): Promise<NotifyContactsResponse> {
  // Decide the endpoint: targeted vs broadcast
  const isTargeted =
    !!targetContact &&
    (!!(targetContact.email && targetContact.email.trim()) ||
      !!(targetContact.phone && targetContact.phone.trim()));

  const endpoint = isTargeted
    ? "/api/voice-message/send"      // send to ONE selected EC
    : "/api/voice-check-in/notify";  // broadcast to ALL ACTIVE ECs

  // Build request body; include target only for targeted route
  const body: any = {
    transcribedSpeech: currentTranscript,
    assessment: aiAssessment,
    audioDataUrl,
  };
  if (isTargeted) {
    body.targetContact = {
      email: targetContact?.email ?? null,
      phone: targetContact?.phone ?? null,
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || (data as any)?.error) {
    throw new Error((data as any)?.error || "Failed to notify emergency contacts");
  }

  return data as NotifyContactsResponse;
}

/**
 * VoiceCheckIn
 * - Uses the browser Web Speech API (SpeechRecognition / webkitSpeechRecognition)
 * - Records a short utterance like “I’m OK”
 * - Sends the transcript to your AI function to assess anomalies
 * - Presents a simple status + explanation
 */
export interface VoiceCheckInProps {
  onCheckIn?: () => void | Promise<void>;
  targetContact?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  onClearTarget?: () => void;
}

export function VoiceCheckIn({ onCheckIn, targetContact, onClearTarget }: VoiceCheckInProps) {
  /** UI/state flags */
  const [isListening, setIsListening] = useState(false);       // mic actively capturing speech
  const [isProcessing, setIsProcessing] = useState(false);     // AI is running
  const [supported, setSupported] = useState<boolean>(true);   // browser support for speech API

  /** Latest transcript + AI assessment */
  const [transcript, setTranscript] = useState("");
  const [assessment, setAssessment] = useState<AssessVoiceCheckInOutput | null>(null);

  /** We keep the recognition instance in a ref so it persists between renders */
  const recognitionRef = useRef<any | null>(null); // use `any` to avoid TS issues with webkit prefix
  const { toast } = useToast();

  /** Audio recording helpers so we can send the original clip to emergency contacts */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioPromiseRef = useRef<Promise<string | null> | null>(null);
  const audioResolveRef = useRef<((value: string | null) => void) | null>(null);
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
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn("MediaDevices API unavailable; voice clip will not be captured.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const preferredTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ];
      let mimeType: string | undefined;
      if (typeof MediaRecorder !== "undefined") {
        mimeType = preferredTypes.find((type) => {
          try {
            return MediaRecorder.isTypeSupported(type);
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

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error("MediaRecorder error:", event);
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
        } catch (error) {
          console.error("Failed to finalize audio clip:", error);
          lastAudioUrlRef.current = null;
          audioResolveRef.current?.(null);
        } finally {
          audioResolveRef.current = null;
          audioPromiseRef.current = null;
          mediaRecorderRef.current = null;

          if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((track) => track.stop());
            mediaStreamRef.current = null;
          }
        }
      };

      recorder.start();
    } catch (error) {
      console.error("Unable to start audio recording:", error);
      audioPromiseRef.current = null;
      audioResolveRef.current = null;
      mediaRecorderRef.current = null;
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
    }
  }

  function stopRecording(): Promise<string | null> {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return audioPromiseRef.current ?? Promise.resolve(lastAudioUrlRef.current);
    }

    if (recorder.state === "inactive") {
      return audioPromiseRef.current ?? Promise.resolve(lastAudioUrlRef.current);
    }

    const promise =
      audioPromiseRef.current ||
      new Promise<string | null>((resolve) => {
        audioResolveRef.current = resolve;
      });

    audioPromiseRef.current = promise;

    try {
      recorder.stop();
    } catch (error) {
      console.error("Failed to stop MediaRecorder:", error);
      audioResolveRef.current?.(lastAudioUrlRef.current ?? null);
      audioResolveRef.current = null;
      audioPromiseRef.current = null;
      mediaRecorderRef.current = null;
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
      return Promise.resolve(lastAudioUrlRef.current);
    }

    return promise;
  }

  /**
   * Pull a few most-recent utterances from localStorage.
   * (This is a simple stand-in for “previous messages” history.)
   */
  function getPreviousMessages(): string[] {
    try {
      const raw = localStorage.getItem("voiceCheckIn.previous") || "[]";
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(-3) : [];
    } catch {
      return [];
    }
  }

  /**
   * Save the latest to localStorage, cap to last 5 utterances.
   */
  function pushPreviousMessage(msg: string) {
    try {
      const prev = getPreviousMessages();
      const next = [...prev, msg].slice(-5);
      localStorage.setItem("voiceCheckIn.previous", JSON.stringify(next));
    } catch {
      /* ignore storage errors */
    }
  }

  /** One-time setup for SpeechRecognition */
  useEffect(() => {
    // Guard SSR (Next.js) – only run in the browser
    if (typeof window === "undefined") return;

    // Vendor-prefixed constructor (Safari uses webkitSpeechRecognition)
    const RecognitionCtor: any =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    // If not available, remember that and bail (we’ll show a friendly message in UI)
    if (!RecognitionCtor) {
      setSupported(false);
      console.error("Speech Recognition API not supported in this browser.");
      return;
    }

    // Create a recognition instance
    const recognition = new RecognitionCtor();
    recognition.continuous = false;        // stop automatically after a result
    recognition.lang = "en-US";            // language to listen for
    recognition.interimResults = false;    // only final results

    // Fired when the mic actually starts listening
    recognition.onstart = () => {
      setIsListening(true);
      setAssessment(null); // clear any old AI result
      setTranscript("");   // clear prior text
      startRecording().catch((error) => {
        console.error("Failed to start recording for voice clip:", error);
      });
    };

    // Fired when we receive a transcript (usually one result for short utterances)
    recognition.onresult = async (event: any) => {
      const currentTranscript: string = event.results?.[0]?.[0]?.transcript || "";
      setTranscript(currentTranscript);
      pushPreviousMessage(currentTranscript);

      const audioClipPromise = stopRecording().catch((error) => {
        console.error("Stopping recorder failed:", error);
        return null;
      });

      setIsProcessing(true);
      try {
        // Send to your AI function
        const previousVoiceMessages = getPreviousMessages();
        const response = await fetch("/api/voice-check-in", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            transcribedSpeech: currentTranscript,
            previousVoiceMessages,
          }),
        });

        if (!response.ok) {
          throw new Error(`Voice assessment failed with status ${response.status}`);
        }

        const result: AssessVoiceCheckInOutput = await response.json();
        setAssessment(result);

        const audioClip = await audioClipPromise;

        // 🔁 NEW: route selection (targeted vs broadcast)
        try {
          const notifyResult = await notifyEmergencyContacts(
            currentTranscript,
            result,
            audioClip,
            targetContact
              ? {
                  email: targetContact.email ?? null,
                  phone: targetContact.phone ?? null,
                }
              : null,
          );

          // Friendly toast copy for both cases
          const targeted = !!targetContact?.name;
          const notifiedCount = notifyResult?.contactCount ?? 0;
          let description: string;

          if (targeted) {
            description = `Shared directly with ${targetContact!.name}.`;
          } else if (notifiedCount > 0) {
            description = `Shared with ${
              notifiedCount === 1 ? "1 emergency contact" : `${notifiedCount} emergency contacts`
            }.`;
          } else {
            description = "Saved to your emergency dashboard for quick review.";
          }

          const pushInfo = notifyResult?.anomalyPush;
          if (result.anomalyDetected && pushInfo?.attempted) {
            const success = pushInfo.successCount ?? 0;
            const tokens = pushInfo.tokenCount ?? 0;
            if (success > 0) {
              description += " Emergency contacts received a push alert about the anomaly.";
            } else if (tokens > 0) {
              description += " We attempted push alerts, but delivery failed. Check contact device registrations.";
            } else {
              description += " None of your emergency contacts have push notifications enabled yet.";
            }
          }

          toast({ title: "Voice message sent", description });
        } catch (notifyError: any) {
          console.error("Failed to notify emergency contacts:", notifyError);
          toast({
            title: "Voice message not delivered",
            description: "We saved your analysis but couldn't reach your contacts.",
            variant: "destructive",
          });
        }

        if (onCheckIn) {
          try {
            await onCheckIn();
          } catch (callbackError) {
            console.error("Voice check-in callback failed:", callbackError);
          }
        }
      } catch (error) {
        console.error("AI assessment failed:", error);
        toast({
          title: "AI Error",
          description: "Could not assess the voice message.",
          variant: "destructive",
        });
      } finally {
        setIsProcessing(false);
      }
    };

    // Fired when recognition stops (either user stopped or it auto-stopped)
    recognition.onend = () => {
      setIsListening(false);
      stopRecording().catch(() => null);
    };

    // Fired for recognition errors (permissions, network, no-speech, etc.)
    recognition.onerror = (event: any) => {
      const code = event?.error || "unknown";
      console.error("Speech recognition error:", code);

      // Make errors more friendly
      let message = "Could not recognize speech. Please try again.";
      if (code === "not-allowed" || code === "service-not-allowed") {
        message = "Microphone permission was denied. Please allow mic access in your browser.";
      } else if (code === "no-speech") {
        message = "No speech detected. Try again and speak clearly into the microphone.";
      } else if (code === "audio-capture") {
        message = "No microphone found. Please check your audio device.";
      }

      toast({ title: "Recognition Error", description: message, variant: "destructive" });
      setIsListening(false);
      setIsProcessing(false);
      stopRecording().catch(() => null);
    };

    // Stash instance for button handlers
    recognitionRef.current = recognition;

    // Cleanup on unmount – stop if still listening
    return () => {
      try {
        recognitionRef.current?.stop?.();
      } catch {}
      recognitionRef.current = null;
      stopRecording().catch(() => null);
    };
  }, [targetContact, toast]);

  /** Start/stop listening button handler */
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
      if (isListening) {
        recognitionRef.current?.stop?.();
      } else {
        // Starting may trigger a permission prompt the first time
        recognitionRef.current?.start?.();
      }
    } catch (e) {
      console.error(e);
    }
  };

  /** Small helpers for UI state */
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
      {/* Visual status circle */}
      <div className="flex h-32 w-32 items-center justify-center rounded-full bg-secondary shadow-inner">
        {getStatusIcon()}
      </div>

      {/* ARIA live region so screen readers announce changes */}
      <p className="text-2xl font-semibold text-muted-foreground" aria-live="polite">
        {getStatusText()}
      </p>

      {targetContact?.name && (
        <div className="flex w-full max-w-md flex-col items-center gap-2 rounded-md bg-primary/5 p-3 text-sm text-muted-foreground">
          <p>
            <strong>Sharing with:</strong> {targetContact.name}
          </p>
          <div className="flex flex-wrap justify-center gap-2 text-xs">
            {targetContact.email && (
              <span className="rounded-full bg-background px-3 py-1">
                {targetContact.email}
              </span>
            )}
            {targetContact.phone && (
              <span className="rounded-full bg-background px-3 py-1">
                {targetContact.phone}
              </span>
            )}
          </div>
          {onClearTarget && (
            <Button type="button" variant="ghost" size="sm" onClick={onClearTarget}>
              Clear recipient
            </Button>
          )}
        </div>
      )}

      {/* Show transcript once we have one */}
      {transcript && <p className="text-base text-muted-foreground">You said: “{transcript}”</p>}

      {/* AI explanation (green for OK, red for anomaly) */}
      {assessment?.explanation && (
        <p
          className={`rounded-md p-3 text-base ${
            assessment.anomalyDetected ? "bg-destructive/10" : "bg-green-500/10"
          }`}
        >
          <strong>AI Analysis:</strong> {assessment.explanation}
        </p>
      )}

      {/* Start/Stop button */}
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

      {/* Tiny hint when unsupported */}
      {!supported && (
        <p className="text-sm text-muted-foreground">
          Tip: Try the latest Chrome/Edge/Safari over HTTPS.
        </p>
      )}
    </div>
  );
}
