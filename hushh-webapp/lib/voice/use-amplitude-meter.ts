"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UseAmplitudeMeterOptions = {
  sensitivity?: number;
  smoothingFactor?: number;
  logIntervalMs?: number;
};

type UseAmplitudeMeterResult = {
  rawRms: number;
  normalizedLevel: number;
  smoothedLevel: number;
  isRunning: boolean;
  start: (stream: MediaStream) => Promise<void>;
  stop: () => void;
};

const DEFAULT_SENSITIVITY = 10;
const DEFAULT_SMOOTHING_FACTOR = 0.2;
const DEFAULT_LOG_INTERVAL_MS = 500;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function useAmplitudeMeter(
  options?: UseAmplitudeMeterOptions
): UseAmplitudeMeterResult {
  const sensitivity = options?.sensitivity ?? DEFAULT_SENSITIVITY;
  const smoothingFactor = options?.smoothingFactor ?? DEFAULT_SMOOTHING_FACTOR;
  const logIntervalMs = options?.logIntervalMs ?? DEFAULT_LOG_INTERVAL_MS;

  const [rawRms, setRawRms] = useState(0);
  const [normalizedLevel, setNormalizedLevel] = useState(0);
  const [smoothedLevel, setSmoothedLevel] = useState(0);
  const [isRunning, setIsRunning] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyzerNodeRef = useRef<AnalyserNode | null>(null);
  const frameRef = useRef<number | null>(null);
  const smoothedRef = useRef(0);
  const dataRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const lastLogAtRef = useRef(0);

  const stop = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const sourceNode = sourceNodeRef.current;
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // ignore disconnect failures
      }
      sourceNodeRef.current = null;
    }

    const analyzerNode = analyzerNodeRef.current;
    if (analyzerNode) {
      try {
        analyzerNode.disconnect();
      } catch {
        // ignore disconnect failures
      }
      analyzerNodeRef.current = null;
    }

    const audioContext = audioContextRef.current;
    if (audioContext) {
      const contextToClose = audioContext;
      audioContextRef.current = null;
      void contextToClose.close().catch(() => undefined);
    }

    dataRef.current = null;
    smoothedRef.current = 0;
    setRawRms(0);
    setNormalizedLevel(0);
    setSmoothedLevel(0);
    setIsRunning(false);
    console.info("[VOICE_AUDIO] meter_stopped");
  }, []);

  const start = useCallback(
    async (stream: MediaStream) => {
      stop();

      const AudioContextCtor =
        typeof window !== "undefined"
          ? window.AudioContext ||
            ((window as typeof window & { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext ?? null)
          : null;

      if (!AudioContextCtor) {
        throw new Error("AudioContext is not available in this browser");
      }

      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const analyzer = context.createAnalyser();
      analyzer.fftSize = 2048;
      analyzer.smoothingTimeConstant = 0;

      source.connect(analyzer);

      audioContextRef.current = context;
      sourceNodeRef.current = source;
      analyzerNodeRef.current = analyzer;
      // Use an explicit ArrayBuffer so TypeScript can satisfy
      // getFloatTimeDomainData(Float32Array<ArrayBuffer>) typing.
      dataRef.current = new Float32Array(
        new ArrayBuffer(analyzer.fftSize * Float32Array.BYTES_PER_ELEMENT)
      ) as Float32Array<ArrayBuffer>;
      smoothedRef.current = 0;
      setIsRunning(true);
      console.info("[VOICE_AUDIO] meter_started");

      const tick = () => {
        const node = analyzerNodeRef.current;
        const buffer = dataRef.current;
        if (!node || !buffer) {
          frameRef.current = null;
          return;
        }

        node.getFloatTimeDomainData(buffer);

        // RMS loudness estimate from normalized PCM samples in [-1, 1].
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const sample = buffer[i] ?? 0;
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);

        const normalized = clamp01(rms * sensitivity);

        // Exponential smoothing to avoid jittery visual output.
        const smoothed =
          (1 - smoothingFactor) * smoothedRef.current + smoothingFactor * normalized;
        smoothedRef.current = smoothed;

        setRawRms(rms);
        setNormalizedLevel(normalized);
        setSmoothedLevel(smoothed);

        const now = Date.now();
        if (now - lastLogAtRef.current >= logIntervalMs) {
          lastLogAtRef.current = now;
          console.info(
            `[VOICE_AUDIO] rms=${rms.toFixed(4)} level=${normalized.toFixed(3)} smoothed=${smoothed.toFixed(3)}`
          );
        }

        frameRef.current = requestAnimationFrame(tick);
      };

      frameRef.current = requestAnimationFrame(tick);
    },
    [logIntervalMs, sensitivity, smoothingFactor, stop]
  );

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    rawRms,
    normalizedLevel,
    smoothedLevel,
    isRunning,
    start,
    stop,
  };
}
