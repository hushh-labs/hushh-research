"use client";

import { ApiService } from "@/lib/services/api-service";

export type AgentTtsRequest = {
  userId: string;
  vaultOwnerToken: string;
  text: string;
  voice?: string;
  signal?: AbortSignal;
};

export type AgentTtsQueueOptions = {
  userId: string;
  vaultOwnerToken: string;
  voice?: string;
  synthesize?: (input: AgentTtsRequest) => Promise<Response>;
  playAudio?: (audio: Blob, signal: AbortSignal) => Promise<void>;
  fallbackSpeak?: (text: string, signal: AbortSignal) => Promise<void>;
  onStateChange?: (state: "idle" | "speaking") => void;
  onError?: (failure: AgentTtsFailure) => void;
  requestTimeoutMs?: number;
  maxAttempts?: number;
};

export type AgentTtsFailure = {
  stage: "synthesize" | "playback" | "fallback";
  message: string;
  status?: number;
};

export type SpeechChunks = {
  chunks: string[];
  remainder: string;
};

const MAX_TTS_CHUNK_CHARS = 220;
const MIN_TTS_CHUNK_CHARS = 12;
const EARLY_TTS_CHUNK_CHARS = 90;
const DEFAULT_TTS_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_ATTEMPTS = 2;

export function markdownToSpeechText(markdown: string): string {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/[*_~>#|]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractCompleteSpeechChunks(
  text: string,
  maxChunkChars = MAX_TTS_CHUNK_CHARS
): SpeechChunks {
  let remainder = String(text || "").trimStart();
  const chunks: string[] = [];

  while (remainder.length > 0) {
    const boundary = findSentenceBoundary(remainder, maxChunkChars);
    if (boundary <= 0) break;
    const chunk = remainder.slice(0, boundary).trim();
    remainder = remainder.slice(boundary).trimStart();
    if (chunk.length >= MIN_TTS_CHUNK_CHARS || /[.!?]$/.test(chunk)) {
      chunks.push(chunk);
    } else {
      remainder = `${chunk} ${remainder}`.trimStart();
      break;
    }
  }

  return { chunks, remainder };
}

function findSentenceBoundary(text: string, maxChunkChars: number): number {
  const searchUntil = Math.min(text.length, maxChunkChars);
  for (let index = 0; index < searchUntil; index += 1) {
    const char = text[index];
    if (!char || !/[.!?]/.test(char)) continue;
    const next = text[index + 1] || "";
    if (!next || /\s/.test(next)) return index + 1;
  }

  if (text.length < maxChunkChars) {
    if (text.length >= EARLY_TTS_CHUNK_CHARS) {
      const earlyBoundary = Math.max(
        text.lastIndexOf(",", EARLY_TTS_CHUNK_CHARS),
        text.lastIndexOf(";", EARLY_TTS_CHUNK_CHARS),
        text.lastIndexOf(":", EARLY_TTS_CHUNK_CHARS),
        text.lastIndexOf(" ", EARLY_TTS_CHUNK_CHARS)
      );
      if (earlyBoundary > MIN_TTS_CHUNK_CHARS) return earlyBoundary + 1;
    }
    return -1;
  }

  const softBoundary = Math.max(
    text.lastIndexOf(",", maxChunkChars),
    text.lastIndexOf(";", maxChunkChars),
    text.lastIndexOf(":", maxChunkChars),
    text.lastIndexOf(" ", maxChunkChars)
  );
  return softBoundary > MIN_TTS_CHUNK_CHARS ? softBoundary + 1 : maxChunkChars;
}

async function defaultSynthesize(input: AgentTtsRequest): Promise<Response> {
  return ApiService.synthesizeAgentVoice(input);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function defaultPlayAudio(audio: Blob, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const url = URL.createObjectURL(audio);
  const element = new Audio(url);
  element.preload = "auto";
  element.setAttribute("playsinline", "true");

  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        element.onended = null;
        element.onerror = null;
        signal.removeEventListener("abort", handleAbort);
      };
      const handleAbort = () => {
        element.pause();
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      element.onended = () => {
        cleanup();
        resolve();
      };
      element.onerror = () => {
        cleanup();
        reject(new Error("Agent voice audio playback failed."));
      };
      signal.addEventListener("abort", handleAbort, { once: true });
      void element.play().catch((error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error("Agent voice playback failed."));
      });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function defaultFallbackSpeak(text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (
    typeof window === "undefined" ||
    !window.speechSynthesis ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    throw new Error("Browser speech synthesis is not available.");
  }

  await new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    let settled = false;

    const cleanup = () => {
      utterance.onend = null;
      utterance.onerror = null;
      signal.removeEventListener("abort", handleAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = () => {
      window.speechSynthesis.cancel();
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    };

    utterance.onend = () => settle(resolve);
    utterance.onerror = (event) =>
      settle(() =>
        reject(
          new Error(
            event.error
              ? `Browser speech synthesis failed: ${event.error}.`
              : "Browser speech synthesis failed."
          )
        )
      );
    signal.addEventListener("abort", handleAbort, { once: true });
    window.speechSynthesis.speak(utterance);
  });
}

export class AgentTtsQueue {
  private readonly userId: string;
  private readonly vaultOwnerToken: string;
  private readonly voice?: string;
  private readonly synthesize: (input: AgentTtsRequest) => Promise<Response>;
  private readonly playAudio: (audio: Blob, signal: AbortSignal) => Promise<void>;
  private readonly fallbackSpeak: (text: string, signal: AbortSignal) => Promise<void>;
  private readonly onStateChange?: (state: "idle" | "speaking") => void;
  private readonly onError?: (failure: AgentTtsFailure) => void;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private queue: string[] = [];
  private draining = false;
  private streamMarkdown = "";
  private emittedSpeechChars = 0;
  private sentenceBuffer = "";
  private abortController: AbortController | null = null;

  constructor(options: AgentTtsQueueOptions) {
    this.userId = options.userId;
    this.vaultOwnerToken = options.vaultOwnerToken;
    this.voice = options.voice;
    this.synthesize = options.synthesize || defaultSynthesize;
    this.playAudio = options.playAudio || defaultPlayAudio;
    this.fallbackSpeak = options.fallbackSpeak || defaultFallbackSpeak;
    this.onStateChange = options.onStateChange;
    this.onError = options.onError;
    this.requestTimeoutMs = Math.max(
      1_000,
      options.requestTimeoutMs || DEFAULT_TTS_REQUEST_TIMEOUT_MS
    );
    this.maxAttempts = Math.max(1, options.maxAttempts || DEFAULT_TTS_MAX_ATTEMPTS);
  }

  resetStream(): void {
    this.streamMarkdown = "";
    this.emittedSpeechChars = 0;
    this.sentenceBuffer = "";
  }

  pushMarkdownSnapshot(markdown: string): void {
    this.streamMarkdown = markdown;
    const speechText = markdownToSpeechText(markdown);
    if (speechText.length <= this.emittedSpeechChars) return;

    const addition = speechText.slice(this.emittedSpeechChars);
    this.emittedSpeechChars = speechText.length;
    this.sentenceBuffer = `${this.sentenceBuffer}${addition}`;
    const { chunks, remainder } = extractCompleteSpeechChunks(this.sentenceBuffer);
    this.sentenceBuffer = remainder;
    for (const chunk of chunks) {
      this.enqueue(chunk);
    }
  }

  flushStream(): void {
    const chunk = this.sentenceBuffer.trim();
    this.sentenceBuffer = "";
    if (chunk) {
      this.enqueue(chunk);
      return;
    }
    if (!this.draining && this.queue.length === 0) {
      this.onStateChange?.("idle");
    }
  }

  speakNow(text: string): void {
    const cleanText = markdownToSpeechText(text);
    if (cleanText) {
      this.enqueue(cleanText);
    }
  }

  cancel(): void {
    this.queue = [];
    this.resetStream();
    this.abortController?.abort();
    this.abortController = null;
    this.draining = false;
    this.onStateChange?.("idle");
  }

  private enqueue(text: string): void {
    const cleanText = markdownToSpeechText(text);
    if (!cleanText) return;
    this.queue.push(cleanText);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift();
        if (!text) continue;
        const controller = new AbortController();
        this.abortController = controller;
        this.onStateChange?.("speaking");
        await this.speakChunk(text, controller.signal);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.onError?.({
          stage: "playback",
          message: errorMessage(error, "Agent voice playback failed."),
        });
      }
    } finally {
      this.abortController = null;
      this.draining = false;
      if (this.queue.length > 0) {
        void this.drain();
      } else {
        this.onStateChange?.("idle");
      }
    }
  }

  private async speakChunk(text: string, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.synthesizeWithRetry(text, signal);
      if (!response.ok) {
        this.onError?.({
          stage: "synthesize",
          message: `Agent voice TTS returned HTTP ${response.status}.`,
          status: response.status,
        });
        await this.speakWithFallback(text, signal);
        return;
      }

      const audio = await response.blob();
      if (audio.size <= 0) {
        this.onError?.({
          stage: "synthesize",
          message: "Agent voice TTS returned empty audio.",
        });
        await this.speakWithFallback(text, signal);
        return;
      }

      try {
        await this.playAudio(audio, signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        this.onError?.({
          stage: "playback",
          message: errorMessage(error, "Agent voice audio playback failed."),
        });
        await this.speakWithFallback(text, signal);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      this.onError?.({
        stage: "synthesize",
        message: errorMessage(error, "Agent voice TTS failed."),
      });
      await this.speakWithFallback(text, signal);
    }
  }

  private async speakWithFallback(text: string, signal: AbortSignal): Promise<void> {
    try {
      await this.fallbackSpeak(text, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      this.onError?.({
        stage: "fallback",
        message: errorMessage(error, "Agent voice fallback speech failed."),
      });
    }
  }

  private async synthesizeWithRetry(text: string, parentSignal: AbortSignal): Promise<Response> {
    let lastResponse: Response | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (parentSignal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const timeoutController = new AbortController();
      const handleParentAbort = () => timeoutController.abort();
      const timeoutId = window.setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
      parentSignal.addEventListener("abort", handleParentAbort, { once: true });

      try {
        const response = await this.synthesize({
          userId: this.userId,
          vaultOwnerToken: this.vaultOwnerToken,
          text,
          voice: this.voice,
          signal: timeoutController.signal,
        });
        if (response.ok || attempt === this.maxAttempts) {
          return response;
        }
        lastResponse = response;
      } catch (error) {
        if (parentSignal.aborted) {
          throw error;
        }
        lastError = error;
      } finally {
        window.clearTimeout(timeoutId);
        parentSignal.removeEventListener("abort", handleParentAbort);
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError instanceof Error ? lastError : new Error("Agent voice TTS failed.");
  }
}
