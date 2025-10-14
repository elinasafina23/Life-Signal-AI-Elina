// src/components/ask-ai-assistant.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Volume2, VolumeX, Loader2, Mic, MicOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AskAiAssistantResponse {
  answer: string;
  moodSummary?: {
    mood: string;
    description?: string;
    updatedAt?: string;
  } | null;
}

export function AskAiAssistant() {
  const { toast } = useToast();

  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [mood, setMood] = useState<{ mood: string; description?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [speechSupported, setSpeechSupported] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechInputSupported, setSpeechInputSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [preferredVoice, setPreferredVoice] = useState<SpeechSynthesisVoice | null>(null);

  const [answerDialogOpen, setAnswerDialogOpen] = useState(false);
  const [lastAskedQuestion, setLastAskedQuestion] = useState<string | null>(null);

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const recognitionRef = useRef<any | null>(null);

  useEffect(() => {
    let speechCleanup: (() => void) | undefined;

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      setSpeechSupported(true);
      const synth = window.speechSynthesis;

      const resolveVoice = () => {
        const voices = synth.getVoices();
        if (!voices?.length) return;
        const normalized = voices.map((v) => ({ voice: v, name: v.name.toLowerCase() }));
        const preferred =
          normalized.find(({ name }) => name.includes("google") && name.includes("english"))?.voice ||
          normalized.find(({ name }) => name.includes("neural"))?.voice ||
          voices.find((v) => v.lang?.toLowerCase().startsWith("en")) ||
          voices[0] ||
          null;
        setPreferredVoice(preferred ?? null);
      };

      resolveVoice();
      if (typeof synth.addEventListener === "function") {
        synth.addEventListener("voiceschanged", resolveVoice);
        speechCleanup = () => synth.removeEventListener("voiceschanged", resolveVoice);
      } else if (typeof synth.onvoiceschanged !== "undefined") {
        synth.onvoiceschanged = resolveVoice;
        speechCleanup = () => {
          if (typeof synth.onvoiceschanged !== "undefined") (synth as any).onvoiceschanged = null;
        };
      }
    }

    if (typeof window !== "undefined") {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) setSpeechInputSupported(true);
    }

    return () => {
      if (speechCleanup) speechCleanup();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
        recognitionRef.current = null;
      }
    };
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!speechSupported || typeof window === "undefined") return;
      const synth = window.speechSynthesis;
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (preferredVoice) utterance.voice = preferredVoice;
      utterance.rate = preferredVoice ? 0.96 : 0.94;
      utterance.pitch = preferredVoice ? 1.04 : 1.02;
      utterance.volume = 0.95;
      utterance.onend = () => {
        setIsSpeaking(false);
        utteranceRef.current = null;
      };
      utterance.onerror = () => {
        setIsSpeaking(false);
        utteranceRef.current = null;
      };
      utteranceRef.current = utterance;
      setIsSpeaking(true);
      synth.speak(utterance);
    },
    [preferredVoice, speechSupported],
  );

  const stopSpeaking = useCallback(() => {
    if (!speechSupported || typeof window === "undefined") return;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setIsSpeaking(false);
  }, [speechSupported]);

  const submitQuestion = useCallback(
    async (input?: string) => {
      const source = typeof input === "string" ? input : question;
      const trimmed = source.trim();
      if (!trimmed) {
        setError("Ask a question to get started.");
        return;
      }

      setQuestion(source);
      setLoading(true);
      setError(null);
      setAnswer(null);
      setMood(null);
      setAnswerDialogOpen(false);
      stopSpeaking();

      try {
        const response = await fetch("/api/ask-ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed }),
        });

        const data = (await response.json().catch(() => ({}))) as AskAiAssistantResponse & {
          error?: string;
        };

        if (!response.ok || data?.error) {
          throw new Error(data?.error || "The assistant was unable to answer. Please try again.");
        }

        setAnswer(data.answer);
        setLastAskedQuestion(trimmed);
        if (data.moodSummary) {
          setMood({
            mood: data.moodSummary.mood,
            description: data.moodSummary.description ?? undefined,
          });
        }
        if (data.answer && speechSupported) {
          speak(data.answer);
        }
      } catch (err) {
        console.error("AskAiAssistant failed:", err);
        const message =
          err instanceof Error ? err.message : "The assistant encountered an unexpected error.";
        setError(message);
        toast({ title: "Assistant unavailable", description: message, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [question, speak, speechSupported, stopSpeaking, toast],
  );

  const canSubmit = useMemo(() => question.trim().length > 0 && !loading, [question, loading]);

  const stopVoiceCapture = useCallback(() => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.stop();
    } catch {}
    recognitionRef.current = null;
    setIsListening(false);
  }, []);

  const handleVoiceAsk = useCallback(() => {
    if (loading || !speechInputSupported || typeof window === "undefined") return;
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechInputSupported(false);
      toast({
        title: "Voice not supported",
        description: "Your browser doesn't support voice input. Try typing your question instead.",
        variant: "destructive",
      });
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";

      recognition.onresult = (event: any) => {
        const transcript = event?.results?.[0]?.[0]?.transcript?.trim();
        stopVoiceCapture();
        if (transcript) {
          submitQuestion(transcript);
        } else {
          setError("We couldn't hear anything. Please try again.");
        }
      };

      recognition.onerror = (event: any) => {
        console.error("Voice input failed:", event);
        stopVoiceCapture();
        setError("We couldn't process your voice message. Please try again.");
        toast({
          title: "Voice input failed",
          description: "We couldn't process your voice message. Please try again.",
          variant: "destructive",
        });
      };

      recognition.onend = () => {
        stopVoiceCapture();
      };

      recognitionRef.current = recognition;
      setError(null);
      setIsListening(true);
      recognition.start();
    } catch (err) {
      console.error("Unable to start voice input:", err);
      setError("We couldn't start listening. Please try again.");
      toast({
        title: "Voice input unavailable",
        description: "We couldn't start the microphone. Check your permissions and try again.",
        variant: "destructive",
      });
      stopVoiceCapture();
    }
  }, [loading, speechInputSupported, stopVoiceCapture, submitQuestion, toast]);

  return (
    <div className="relative overflow-hidden flex w-full flex-1 flex-col gap-6">
      <div className="space-y-2">
        <label htmlFor="ask-ai-input" className="text-lg font-semibold text-left">
          Ask anything
        </label>
        <Textarea
          id="ask-ai-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="How can I manage my stress today?"
          className="min-h-[8rem] resize-none"
          disabled={loading}
        />
      </div>

      <div className="grid w-full gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-stretch">
        <Button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => submitQuestion()}
          disabled={!canSubmit}
          size="lg"
          className="w-full"
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden />
              Thinking…
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-5 w-5" aria-hidden />
              Ask AI
            </>
          )}
        </Button>

        <div className="flex w-full justify-stretch">
          <Button
            type="button"
            variant="outline"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              answer && speechSupported ? (isSpeaking ? stopSpeaking() : speak(answer)) : undefined
            }
            disabled={loading || !speechSupported || !answer}
            className={`w-full ${!speechSupported || !answer ? "invisible" : ""}`}
            aria-hidden={!speechSupported || !answer}
          >
            {isSpeaking ? (
              <>
                <VolumeX className="mr-2 h-5 w-5" aria-hidden />
                Stop voice
              </>
            ) : (
              <>
                <Volume2 className="mr-2 h-5 w-5" aria-hidden />
                Play voice
              </>
            )}
          </Button>
        </div>

        <div className="flex w-full justify-stretch">
          {speechInputSupported ? (
            <Button
              type="button"
              variant={isListening ? "destructive" : "outline"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={isListening ? stopVoiceCapture : handleVoiceAsk}
              disabled={loading}
              className="w-full"
            >
              {isListening ? (
                <>
                  <MicOff className="mr-2 h-5 w-5" aria-hidden />
                  Stop listening
                </>
              ) : (
                <>
                  <Mic className="mr-2 h-5 w-5" aria-hidden />
                  Voice ask
                </>
              )}
            </Button>
          ) : (
            <span className="hidden sm:block" aria-hidden />
          )}
        </div>
      </div>

      {/* NEW: “Show text” lives on the main card, under the buttons */}
    {/* Show text on main card, nudged in from the right and lifted up */}
<div className="flex w-full items-center justify-end pr-4 sm:pr-6 -mt-2 sm:-mt-3">
  <button
    type="button"
    onClick={() => answer && setAnswerDialogOpen(true)}
    disabled={!answer}
    className={`text-sm font-semibold underline underline-offset-4 ${
      answer ? "text-primary hover:opacity-90" : "text-muted-foreground cursor-not-allowed"
    }`}
    aria-label="Show text"
  >
    Show text
  </button>
</div>


      {error && (
        <p className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      )}

      

      <Dialog
        open={answerDialogOpen}
        onOpenChange={(open) => {
          setAnswerDialogOpen(open);
          if (!open) {
            stopSpeaking();
          } else if (answer && speechSupported && !isSpeaking) {
            speak(answer);
          }
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Assistant response</DialogTitle>
            <DialogDescription>
              {lastAskedQuestion
                ? `Question: ${lastAskedQuestion}`
                : "Here is the latest guidance from the assistant."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-left">
            {answer ? (
              <p className="text-lg leading-relaxed text-muted-foreground">{answer}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ask a question to receive guidance from the assistant.
              </p>
            )}

            {mood && (
              <div className="rounded-md border border-primary/20 bg-primary/10 p-4">
                <p className="text-sm font-semibold text-primary">Mood shared with contacts</p>
                <p className="text-base font-bold capitalize text-primary/90">{mood.mood}</p>
                {mood.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{mood.description}</p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
