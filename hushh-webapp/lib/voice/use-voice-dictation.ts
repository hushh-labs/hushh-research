"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DictationStatus =
  | "idle"
  | "listening"
  | "unsupported";

export type UseDictationOptions = {
  onResult: (transcript: string) => void;
  lang?: string;
};

export function useVoiceDictation({ onResult, lang = "en-US" }: UseDictationOptions): {
  status: DictationStatus;
  start: () => void;
  stop: () => void;
  supported: boolean;
} {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const onResultRef = useRef(onResult);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const supported =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setStatus("idle");
  }, []);

  const start = useCallback(() => {
    if (!supported) {
      setStatus("unsupported");
      return;
    }

    if (status === "listening") {
      stop();
      return;
    }

    const SpeechRecognitionAPI =
      (window as unknown as Record<string, unknown>).SpeechRecognition as typeof SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition as typeof SpeechRecognition;

    const recognition = new SpeechRecognitionAPI();
    recognition.lang = lang;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onstart = () => {
      setStatus("listening");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript.trim()) {
        onResultRef.current(transcript.trim());
      }
      setStatus("idle");
    };

    recognition.onerror = () => {
      setStatus("idle");
    };

    recognition.onend = () => {
      setStatus("idle");
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [lang, status, stop, supported]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  return { status, start, stop, supported };
}