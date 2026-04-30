"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type DictationStatus = "idle" | "listening" | "unsupported";

export type UseDictationOptions = {
  onResult: (transcript: string) => void;
  lang?: string;
};

interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

export function useVoiceDictation({ onResult, lang = "en-US" }: UseDictationOptions): {
  status: DictationStatus;
  start: () => void;
  stop: () => void;
  supported: boolean;
} {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const onResultRef = useRef(onResult);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const SpeechRecognitionAPI =
    typeof window !== "undefined"
      ? (((window as unknown as Record<string, unknown>)["SpeechRecognition"] ??
          (window as unknown as Record<string, unknown>)["webkitSpeechRecognition"]) as
          | SpeechRecognitionConstructor
          | undefined)
      : undefined;
  const supported = typeof SpeechRecognitionAPI === "function";

  const stop = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // Browser speech engines can throw when already stopped or permission state changes.
    }
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
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setStatus("idle");
    }
  }, [SpeechRecognitionAPI, lang, status, stop, supported]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // Ignore cleanup failures from browser speech engines during unmount.
      }
    };
  }, []);

  return { status, start, stop, supported };
}
