// src/components/voice-check-in.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Loader, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssessVoiceCheckInOutput } from "@/ai/flows/voice-check-in-assessment";
import { useToast } from "@/hooks/use-toast";

async function notifyEmergencyContacts(
  currentTranscript: string,
  aiAssessment: AssessVoiceCheckInOutput,
) {
  const response = await fetch("/api/voice-check-in/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transcribedSpeech: currentTranscript,
      assessment: aiAssessment,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || (data as any)?.error) {
    throw new Error((data as any)?.error || "Failed to notify emergency contacts");
  }

  return data as { ok: boolean; contactCount?: number };
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
}

export function VoiceCheckIn({ onCheckIn }: VoiceCheckInProps) {
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
    };

    // Fired when we receive a transcript (usually one result for short utterances)
    recognition.onresult = async (event: any) => {
      const currentTranscript: string = event.results?.[0]?.[0]?.transcript || "";
      setTranscript(currentTranscript);
      pushPreviousMessage(currentTranscript);

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

        try {
          const notifyResult = await notifyEmergencyContacts(currentTranscript, result);
          const notifiedCount = notifyResult?.contactCount ?? 0;
          toast({
            title: "Voice message sent",
            description:
              notifiedCount > 0
                ? `Shared with ${
                    notifiedCount === 1 ? "1 emergency contact" : `${notifiedCount} emergency contacts`
                  }.`
                : "Saved to your emergency dashboard for quick review.",
          });
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
    };

    // Stash instance for button handlers
    recognitionRef.current = recognition;

    // Cleanup on unmount – stop if still listening
    return () => {
      try {
        recognitionRef.current?.stop?.();
      } catch {}
      recognitionRef.current = null;
    };
  }, [toast]);

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
