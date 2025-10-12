// src/components/voice-check-in.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, Loader, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssessVoiceCheckInOutput } from "@/ai/flows/voice-check-in-assessment";
import { useToast } from "@/hooks/use-toast";

export interface VoiceCheckInContact {
  id?: string | null;
  email?: string | null;
  name: string;
}

interface NotifyContactsResponse {
  ok: boolean;
  contactCount?: number;
  anomalyPush?: {
    attempted: boolean;
    contactUidCount?: number;
    tokenCount?: number;
    successCount?: number;
    failureCount?: number;
  };
}

async function notifyEmergencyContacts(
  currentTranscript: string,
  aiAssessment: AssessVoiceCheckInOutput,
  audioDataUrl?: string | null,
  targetContact?: VoiceCheckInContact | null,
): Promise<NotifyContactsResponse> {
  const payload: Record<string, unknown> = {
    transcribedSpeech: currentTranscript,
    assessment: aiAssessment,
    audioDataUrl,
  };

  if (targetContact && (targetContact.id || targetContact.email)) {
    payload.targetContact = {
      id: targetContact.id ?? null,
      email: targetContact.email ? targetContact.email.toLowerCase() : null,
      name: targetContact.name ?? null,
    };
  }

  const response = await fetch("/api/voice-check-in/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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
  contacts?: VoiceCheckInContact[];
}

export function VoiceCheckIn({ onCheckIn, contacts }: VoiceCheckInProps) {
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
  const [selectedContactKey, setSelectedContactKey] = useState<string | null>(null);

  const contactOptions = useMemo(() => {
    if (!Array.isArray(contacts) || !contacts.length) return [];

    return contacts
      .map((contact, index) => {
        const rawName = (contact?.name ?? "").trim();
        const displayName = rawName || `Contact ${index + 1}`;
        const email = contact?.email ? String(contact.email).trim().toLowerCase() : null;
        const id = contact?.id ? String(contact.id).trim() : null;
        const key = id || email || `contact-${index}`;

        return {
          key,
          name: displayName,
          payload: {
            id,
            email,
            name: displayName,
          } as VoiceCheckInContact,
        };
      })
      .filter((option) => option.payload.email || option.payload.id);
  }, [contacts]);

  useEffect(() => {
    if (!contactOptions.length) {
      setSelectedContactKey(null);
      return;
    }

    if (!selectedContactKey || !contactOptions.some((option) => option.key === selectedContactKey)) {
      setSelectedContactKey(contactOptions[0].key);
    }
  }, [contactOptions, selectedContactKey]);

  const selectedContact = useMemo(() => {
    if (!selectedContactKey) return null;
    const match = contactOptions.find((option) => option.key === selectedContactKey);
    return match?.payload ?? null;
  }, [contactOptions, selectedContactKey]);

  /** Audio recording helpers so we can send the original clip to emergency contacts */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioPromiseRef = useRef<Promise<string | null> | null>(null);
  const audioResolveRef = useRef<((value: string | null) => void) | null>(null);
  const lastAudioUrlRef = useRef<string | null>(null);
  const selectedContactRef = useRef<VoiceCheckInContact | null>(null);

  useEffect(() => {
    selectedContactRef.current = selectedContact;
  }, [selectedContact]);

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

        const activeContact = selectedContactRef.current;
        try {
          const notifyResult = await notifyEmergencyContacts(
            currentTranscript,
            result,
            audioClip,
            activeContact,
          );
          const notifiedCount = notifyResult?.contactCount ?? 0;
          const pushInfo = notifyResult?.anomalyPush;
          const targeted = Boolean(activeContact);

          let description: string;
          if (targeted) {
            if (notifiedCount > 0) {
              const contactName = activeContact?.name || "your emergency contact";
              description = `Shared with ${contactName}.`;
            } else {
              const contactName = activeContact?.name || "that contact";
              description = `${contactName} isn't reachable yet, but we saved your analysis for quick review.`;
            }
          } else {
            description =
              notifiedCount > 0
                ? `Shared with ${
                    notifiedCount === 1 ? "1 emergency contact" : `${notifiedCount} emergency contacts`
                  }.`
                : "Saved to your emergency dashboard for quick review.";
          }

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

          toast({
            title: "Voice message sent",
            description,
          });
        } catch (notifyError: any) {
          console.error("Failed to notify emergency contacts:", notifyError);
          toast({
            title: "Voice message not delivered",
            description: activeContact
              ? `We saved your analysis but couldn't reach ${activeContact.name || "your contact"}.`
              : "We saved your analysis but couldn't reach your contacts.",
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
    const contactName = selectedContact?.name?.trim();
    if (!supported) return "Speech recognition not supported";
    if (isListening)
      return contactName ? `Listening for ${contactName}…` : "Listening…";
    if (isProcessing)
      return contactName ? `Analyzing message for ${contactName}…` : "Analyzing…";
    if (assessment)
      return assessment.anomalyDetected
        ? contactName
          ? `Anomaly detected for ${contactName}`
          : "Anomaly Detected"
        : contactName
        ? `Message ready for ${contactName}`
        : "Check-in Confirmed";
    return contactName ? `Ready to message ${contactName}` : "Ready to listen";
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 text-center">
      {contactOptions.length > 0 && (
        <div className="flex w-full max-w-xl flex-col items-center gap-3">
          <p className="text-base font-medium text-muted-foreground">Choose who to notify</p>
          <div className="flex flex-wrap justify-center gap-2">
            {contactOptions.map((option) => (
              <Button
                key={option.key}
                type="button"
                variant={option.key === selectedContactKey ? "default" : "outline"}
                onClick={() => setSelectedContactKey(option.key)}
                disabled={isListening || isProcessing}
                className="min-w-[9rem]"
              >
                {option.name}
              </Button>
            ))}
          </div>
        </div>
      )}

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