// src/components/voice-check-in.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Loader, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  assessVoiceCheckIn,
  type AssessVoiceCheckInOutput,
} from "@/ai/flows/voice-check-in-assessment";
import { useToast } from "@/hooks/use-toast";

/**
 * VoiceCheckIn
 * - Uses the browser Web Speech API (SpeechRecognition / webkitSpeechRecognition)
 * - Records a short utterance like “I’m OK”
 * - Sends the transcript to your AI function to assess anomalies
 * - Presents a simple status + explanation
 */
export function VoiceCheckIn() {
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
        const previousMessages = getPreviousMessages();
        const result = await assessVoiceCheckIn({
          transcribedSpeech: currentTranscript,
          previousVoiceMessages: previousMessages,
        });
        setAssessment(result);

        toast({
          title: "Check-in Complete",
          description: "Your voice check-in has been processed.",
        });
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
    <Card className="text-center flex flex-col justify-between h-full">
      <CardHeader>
        <CardTitle className="text-3xl font-headline">Voice Check-in</CardTitle>
        <CardDescription>Press the button and say “I’m OK”.</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col items-center justify-center space-y-4 flex-grow">
        {/* Visual status circle */}
        <div className="w-24 h-24 rounded-full flex items-center justify-center bg-secondary mb-4">
          {getStatusIcon()}
        </div>

        {/* ARIA live region so screen readers announce changes */}
        <p className="font-semibold text-lg" aria-live="polite">
          {getStatusText()}
        </p>

        {/* Show transcript once we have one */}
        {transcript && <p className="text-muted-foreground">You said: “{transcript}”</p>}

        {/* AI explanation (green for OK, red for anomaly) */}
        {assessment?.explanation && (
          <p
            className={`text-sm p-2 rounded-md ${
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
          className="w-48 py-6 text-lg"
        >
          {isListening ? <MicOff className="mr-2 h-6 w-6" /> : <Mic className="mr-2 h-6 w-6" />}
          {isListening ? "Stop" : "Start"}
        </Button>

        {/* Tiny hint when unsupported */}
        {!supported && (
          <p className="text-xs text-muted-foreground">
            Tip: Try the latest Chrome/Edge/Safari over HTTPS.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
