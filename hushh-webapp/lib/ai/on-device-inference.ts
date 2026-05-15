"use client";

import { emitLocalRuntimeEvent } from "@/lib/ai/local-runtime-events";
import {
  localRuntimeService,
  type LocalRuntimeTask,
} from "@/lib/ai/local-runtime-service";

type LocalAIPlugin = {
  runOCR(options: { imageBase64: string }): Promise<{ text?: string }>;
  runSTT(options: { audioBase64: string; mimeType?: string }): Promise<{ transcript?: string }>;
  runTTS(options: { text: string }): Promise<{ audioBase64?: string; mimeType?: string }>;
  runSLM(options: { prompt: string; maxTokens: number }): Promise<{ text?: string }>;
};

declare global {
  interface Window {
    Capacitor?: {
      Plugins?: {
        HushhLocalAI?: LocalAIPlugin;
      };
    };
  }
}

function getPlugin(): LocalAIPlugin {
  const plugin = window.Capacitor?.Plugins?.HushhLocalAI;
  if (!plugin) {
    throw new Error("HUSHH_LOCAL_AI_PLUGIN_UNAVAILABLE");
  }
  return plugin;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

async function emitStarted(task: LocalRuntimeTask): Promise<"cloud" | "hybrid" | "on_device"> {
  const processingMode = await localRuntimeService.getProcessingMode();
  emitLocalRuntimeEvent("local_inference_started", {
    task,
    processing_mode: processingMode,
    pack_id: "hussh-b-pack-v1",
  });
  return processingMode;
}

function emitCompleted(task: LocalRuntimeTask, processingMode: "cloud" | "hybrid" | "on_device"): void {
  emitLocalRuntimeEvent("local_inference_completed", {
    task,
    processing_mode: processingMode,
    result: "success",
    pack_id: "hussh-b-pack-v1",
  });
}

function emitFailed(task: LocalRuntimeTask, processingMode: "cloud" | "hybrid" | "on_device"): void {
  emitLocalRuntimeEvent("local_inference_failed", {
    task,
    processing_mode: processingMode,
    reason_code: "local_exception",
    pack_id: "hussh-b-pack-v1",
  });
  localRuntimeService.triggerFallback("local_exception");
}

export async function runLocalOCR(imageBase64: string): Promise<string | null> {
  const processingMode = await emitStarted("ocr");
  try {
    if (!(await localRuntimeService.canRunLocallyAsync("ocr"))) {
      throw new Error("LOCAL_OCR_UNSUPPORTED");
    }
    // PERF_BUDGET OCR p95 < 2.0s / page on U1.
    const result = await getPlugin().runOCR({ imageBase64 });
    const text = String(result.text || "").trim();
    if (!text) throw new Error("LOCAL_OCR_EMPTY_RESULT");
    emitCompleted("ocr", processingMode);
    return text;
  } catch {
    emitFailed("ocr", processingMode);
    return null;
  }
}

export async function runLocalSTT(audioBlob: Blob): Promise<string | null> {
  const processingMode = await emitStarted("stt");
  try {
    if (!(await localRuntimeService.canRunLocallyAsync("stt"))) {
      throw new Error("LOCAL_STT_UNSUPPORTED");
    }
    // PERF_BUDGET STT latency 10-25s for 30s audio on U1.
    const result = await getPlugin().runSTT({
      audioBase64: await blobToBase64(audioBlob),
      mimeType: audioBlob.type || "audio/webm",
    });
    const transcript = String(result.transcript || "").trim();
    if (!transcript) throw new Error("LOCAL_STT_EMPTY_RESULT");
    emitCompleted("stt", processingMode);
    return transcript;
  } catch {
    emitFailed("stt", processingMode);
    return null;
  }
}

export async function runLocalTTS(text: string): Promise<Blob | null> {
  const processingMode = await emitStarted("tts");
  try {
    if (!(await localRuntimeService.canRunLocallyAsync("tts"))) {
      throw new Error("LOCAL_TTS_UNSUPPORTED");
    }
    // PERF_BUDGET Peak RAM under mixed load 2.0-3.0 GB on U1.
    const result = await getPlugin().runTTS({ text });
    const audioBase64 = String(result.audioBase64 || "").trim();
    if (!audioBase64) throw new Error("LOCAL_TTS_EMPTY_RESULT");
    emitCompleted("tts", processingMode);
    return base64ToBlob(audioBase64, result.mimeType || "audio/wav");
  } catch {
    emitFailed("tts", processingMode);
    return null;
  }
}

export async function runLocalSLM(prompt: string, maxTokens: number = 128): Promise<string | null> {
  const processingMode = await emitStarted("slm");
  try {
    if (!(await localRuntimeService.canRunLocallyAsync("slm"))) {
      throw new Error("LOCAL_SLM_UNSUPPORTED");
    }
    // PERF_BUDGET SLM 128-token response 6-15s on U1.
    const result = await getPlugin().runSLM({
      prompt,
      maxTokens,
    });
    const text = String(result.text || "").trim();
    if (!text) throw new Error("LOCAL_SLM_EMPTY_RESULT");
    emitCompleted("slm", processingMode);
    return text;
  } catch {
    emitFailed("slm", processingMode);
    return null;
  }
}
