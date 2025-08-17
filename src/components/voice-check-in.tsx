"use client";

import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Loader, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { assessVoiceCheckIn, type AssessVoiceCheckInOutput } from '@/ai/flows/voice-check-in-assessment';
import { useToast } from "@/hooks/use-toast";

export function VoiceCheckIn() {
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [assessment, setAssessment] = useState<AssessVoiceCheckInOutput | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.lang = 'en-US';
      recognition.interimResults = false;

      recognition.onstart = () => {
        setIsListening(true);
        setAssessment(null);
        setTranscript('');
      };

      recognition.onresult = async (event) => {
        const currentTranscript = event.results[0][0].transcript;
        setTranscript(currentTranscript);
        setIsProcessing(true);
        try {
          const previousMessages = ["I'm doing fine.", "Everything is okay.", "I feel good today."];
          const result = await assessVoiceCheckIn({
            transcribedSpeech: currentTranscript,
            previousVoiceMessages: previousMessages,
          });
          setAssessment(result);
          toast({
            title: "Check-in Complete",
            description: "Your voice check-in has been successfully processed.",
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

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.onerror = (event) => {
        console.error("Speech recognition error", event.error);
        toast({
            title: "Recognition Error",
            description: `Could not recognize speech. Please try again. Error: ${event.error}`,
            variant: "destructive",
          });
        setIsListening(false);
        setIsProcessing(false);
      };

      recognitionRef.current = recognition;
    } else {
        console.error("Speech Recognition API not supported in this browser.");
    }
  }, [toast]);

  const handleToggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      recognitionRef.current?.start();
    }
  };

  const getStatusIcon = () => {
    if (isProcessing) return <Loader className="h-8 w-8 animate-spin text-primary" />;
    if (assessment) {
      return assessment.anomalyDetected ? <ShieldAlert className="h-8 w-8 text-destructive" /> : <ShieldCheck className="h-8 w-8 text-green-500" />;
    }
    return <Mic className="h-8 w-8 text-muted-foreground" />;
  };

  const getStatusText = () => {
    if (isListening) return "Listening...";
    if (isProcessing) return "Analyzing...";
    if (assessment) {
        return assessment.anomalyDetected ? "Anomaly Detected" : "Check-in Confirmed";
    }
    return "Ready to listen";
  }

  return (
    <Card className="text-center flex flex-col justify-between h-full">
      <CardHeader>
        <CardTitle className="text-3xl font-headline">Voice Check-in</CardTitle>
        <CardDescription>Press the button and say "I'm OK"</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center justify-center space-y-4 flex-grow">
        <div className="w-24 h-24 rounded-full flex items-center justify-center bg-secondary mb-4">
            {getStatusIcon()}
        </div>
        <p className="font-semibold text-lg">{getStatusText()}</p>
        
        {transcript && <p className="text-muted-foreground">You said: "{transcript}"</p>}

        {assessment?.explanation && (
             <p className={`text-sm p-2 rounded-md ${assessment.anomalyDetected ? 'bg-destructive/10' : 'bg-green-500/10'}`}>
                <strong>AI Analysis:</strong> {assessment.explanation}
            </p>
        )}
        
        <Button size="lg" onClick={handleToggleListening} disabled={isProcessing} className="w-48 py-6 text-lg">
          {isListening ? <MicOff className="mr-2 h-6 w-6" /> : <Mic className="mr-2 h-6 w-6" />}
          {isListening ? 'Stop' : 'Start'}
        </Button>
      </CardContent>
    </Card>
  );
}
