"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Volume2, VolumeX, Loader2, Mic, MicOff } from "lucide-react";

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
  const [speechSynthesisSupported, setSpeechSynthesisSupported] = useState(false);
  const [speechRecognitionSupported, setSpeechRecognitionSupported] = useState(false);
  const [voiceSupportChecked, setVoiceSupportChecked] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const recognitionRef = useRef<any | null>(null);

  const speak = useCallback(
    (text: string) => {
      if (!speechSynthesisSupported || typeof window === "undefined") return;

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
    },
    [speechSynthesisSupported],
  );

  const stopSpeaking = useCallback(() => {
    if (!speechSynthesisSupported || typeof window === "undefined") return;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setIsSpeaking(false);
  }, [speechSynthesisSupported]);

  const submitQuestion = useCallback(
    async (rawQuestion: string) => {
      const trimmed = rawQuestion.trim();
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

        if (data.answer && speechSynthesisSupported) {
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
    },
    [speak, speechSynthesisSupported, stopSpeaking, toast],
  );

  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      setSpeechSynthesisSupported(true);
      return () => {
        window.speechSynthesis.cancel();
      };
    }

    setSpeechSynthesisSupported(false);
    return undefined;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const RecognitionCtor: any =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!RecognitionCtor) {
      setSpeechRecognitionSupported(false);
      recognitionRef.current = null;
      setVoiceSupportChecked(true);
      return;
    }

    const recognition = new RecognitionCtor();
    recognition.continuous = false;
    recognition.lang = "en-US";
    recognition.interimResults = false;

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
      stopSpeaking();
    };

    recognition.onresult = (event: any) => {
      const transcript: string = event.results?.[0]?.[0]?.transcript || "";
      const trimmed = transcript.trim();
      if (!trimmed) {
        toast({
          title: "No speech detected",
          description: "We couldn't hear your question. Try speaking again.",
          variant: "destructive",
        });
        return;
      }
      setQuestion(trimmed);
      void submitQuestion(trimmed);
      try {
        recognition.stop();
      } catch {}
    };

    recognition.onerror = (event: any) => {
      const code = event?.error || "unknown";
      let message = "We couldn't understand the speech input. Please try again.";
      if (code === "not-allowed" || code === "service-not-allowed") {
        message = "Microphone access was denied. Enable it in your browser settings.";
      } else if (code === "no-speech") {
        message = "No speech detected. Please speak clearly into the microphone.";
      } else if (code === "audio-capture") {
        message = "No microphone was found. Check your audio device.";
      }

      toast({ title: "Voice capture error", description: message, variant: "destructive" });
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    setSpeechRecognitionSupported(true);
    setVoiceSupportChecked(true);

    return () => {
      try {
        recognition.stop();
      } catch {}
      recognitionRef.current = null;
    };
  }, [stopSpeaking, submitQuestion, toast]);

  const toggleListening = useCallback(() => {
    if (!speechRecognitionSupported) {
      toast({
        title: "Voice input unavailable",
        description: "Your browser does not support speech recognition.",
        variant: "destructive",
      });
      return;
    }

    const recognition = recognitionRef.current;
    if (!recognition) {
      toast({
        title: "Voice input unavailable",
        description: "We couldn't start voice recognition. Try refreshing the page.",
        variant: "destructive",
      });
      return;
    }

    try {
      if (isListening) {
        recognition.stop();
      } else {
        stopSpeaking();
        recognition.start();
      }
    } catch (err) {
      console.error("Failed to toggle speech recognition", err);
      toast({
        title: "Voice input unavailable",
        description: "We couldn't access your microphone. Check your browser permissions.",
        variant: "destructive",
      });
    }
  }, [speechRecognitionSupported, isListening, stopSpeaking, toast]);

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
        {speechRecognitionSupported && (
          <Button
            type="button"
            variant={isListening ? "destructive" : "outline"}
            onClick={toggleListening}
            disabled={loading}
            className="flex-1 sm:flex-initial"
          >
            {isListening ? (
              <>
                <MicOff className="mr-2 h-5 w-5" aria-hidden />
                Stop listening
              </>
            ) : (
              <>
                <Mic className="mr-2 h-5 w-5" aria-hidden />
                Ask with voice
              </>
            )}
          </Button>
        )}

        <Button
          onClick={() => submitQuestion(question)}
          disabled={!canSubmit}
          size="lg"
          className="flex-1 sm:flex-initial"
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

        {speechSynthesisSupported && answer && (
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

      {isListening && (
        <p className="text-sm font-medium text-primary" aria-live="assertive">
          Listening… ask your question now.
        </p>
      )}

      {voiceSupportChecked && !speechRecognitionSupported && (
        <p className="text-xs text-muted-foreground">
          Voice questions require a browser with Speech Recognition support (Chrome, Edge, or Safari).
        </p>
      )}

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