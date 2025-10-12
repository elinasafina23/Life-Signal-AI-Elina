"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Volume2, VolumeX, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

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

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      setSpeechSupported(true);
    }

    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speak = useCallback((text: string) => {
    if (!speechSupported || typeof window === "undefined") return;

    const synth = window.speechSynthesis;
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
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
  }, [speechSupported]);

  const stopSpeaking = useCallback(() => {
    if (!speechSupported || typeof window === "undefined") return;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setIsSpeaking(false);
  }, [speechSupported]);

  const submitQuestion = useCallback(async () => {
    const trimmed = question.trim();
    if (!trimmed) {
      setError("Ask a question to get started.");
      return;
    }

    setLoading(true);
    setError(null);
    setAnswer(null);
    setMood(null);
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
      toast({
        title: "Assistant unavailable",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [question, speak, speechSupported, stopSpeaking, toast]);

  const canSubmit = useMemo(() => question.trim().length > 0 && !loading, [question, loading]);

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div className="space-y-2">
        <label htmlFor="ask-ai-input" className="text-lg font-semibold text-left">
          Ask anything
        </label>
        <Textarea
          id="ask-ai-input"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="How can I manage my stress today?"
          className="min-h-[8rem] resize-none"
          disabled={loading}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submitQuestion} disabled={!canSubmit} size="lg" className="flex-1 sm:flex-initial">
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

        {speechSupported && answer && (
          <Button
            type="button"
            variant="outline"
            onClick={() => (isSpeaking ? stopSpeaking() : speak(answer))}
            disabled={loading}
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
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {answer && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="space-y-4 p-5 text-left">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-primary">Assistant</p>
              <p className="mt-2 text-lg leading-relaxed text-muted-foreground">{answer}</p>
            </div>

            {mood && (
              <div className="rounded-md border border-primary/20 bg-primary/10 p-4">
                <p className="text-sm font-semibold text-primary">Mood shared with contacts</p>
                <p className="text-base font-bold capitalize text-primary/90">{mood.mood}</p>
                {mood.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{mood.description}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
