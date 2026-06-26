"use client";

import { useEffect, useRef } from "react";

import { prefersReducedMotion } from "@/lib/morphy-ux/gsap";
import { cn } from "@/lib/utils";
import type { AgentVoiceStatus } from "@/lib/agent/agent-voice-state";

type AgentVoiceWaveformProps = {
  /** Live audio amplitude in [0, 1], sampled from the voice client meter. */
  level: number;
  status: AgentVoiceStatus;
  muted?: boolean;
  /** Number of bars to render. Defaults to a dense, smooth-looking 24. */
  barCount?: number;
  className?: string;
};

const DEFAULT_BAR_COUNT = 24;
const MIN_BAR_SCALE = 0.06;
// How fast a bar rises toward its target vs. how slowly it falls back. Asymmetry
// (fast attack, slow release) reads as a lively, musical wave rather than a flat
// pulse.
const ATTACK = 0.45;
const RELEASE = 0.12;
// Speed the traveling phase advances per second. Low enough to look smooth.
const PHASE_SPEED = 2.1;

function bellWindow(index: number, count: number): number {
  // Center bars taller than the edges so the wave has a natural envelope.
  if (count <= 1) return 1;
  const t = index / (count - 1);
  const centered = Math.sin(Math.PI * t);
  return 0.4 + 0.6 * centered;
}

export function AgentVoiceWaveform({
  level,
  status,
  muted = false,
  barCount = DEFAULT_BAR_COUNT,
  className,
}: AgentVoiceWaveformProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<HTMLSpanElement[]>([]);
  const valuesRef = useRef<number[]>(Array.from({ length: barCount }, () => 0));
  const targetLevelRef = useRef(0);
  const statusRef = useRef(status);
  const mutedRef = useRef(muted);
  const frameRef = useRef<number | null>(null);
  const phaseRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);

  // Keep the latest level/status/muted available to the animation loop without
  // restarting it on every render.
  useEffect(() => {
    targetLevelRef.current = Number.isFinite(level)
      ? Math.min(1, Math.max(0, level))
      : 0;
  }, [level]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    const reduced = prefersReducedMotion();

    const render = (ts: number) => {
      const bars = barsRef.current;
      const values = valuesRef.current;
      const count = values.length;

      const last = lastTsRef.current ?? ts;
      const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000));
      lastTsRef.current = ts;

      const activeStatus = statusRef.current;
      const isAudible =
        !mutedRef.current &&
        (activeStatus === "listening" || activeStatus === "speaking");
      const isBusy =
        activeStatus === "transcribing" || activeStatus === "thinking";

      phaseRef.current += dt * PHASE_SPEED;
      const phase = phaseRef.current;

      const baseLevel = mutedRef.current
        ? MIN_BAR_SCALE
        : Math.max(MIN_BAR_SCALE, targetLevelRef.current);

      for (let i = 0; i < count; i += 1) {
        let target: number;
        if (reduced) {
          // Reduced motion: a calm, static-ish bar driven only by level.
          target = mutedRef.current ? MIN_BAR_SCALE : baseLevel * bellWindow(i, count);
        } else if (isBusy) {
          // Gentle idle shimmer while the model is working.
          const shimmer = 0.18 + 0.1 * (0.5 + 0.5 * Math.sin(phase * 1.5 + i * 0.6));
          target = shimmer;
        } else if (isAudible) {
          // Traveling wave: a moving sine modulated by the live amplitude and a
          // bell envelope so the center is tallest.
          const travel = 0.5 + 0.5 * Math.sin(phase * 2 + i * 0.55);
          target = baseLevel * bellWindow(i, count) * (0.55 + 0.45 * travel);
        } else {
          target = MIN_BAR_SCALE;
        }

        const current = values[i] ?? 0;
        const rate = target > current ? ATTACK : RELEASE;
        const next = current + (target - current) * (reduced ? 1 : rate);
        values[i] = next;

        const node = bars[i];
        if (node) {
          const scale = Math.max(MIN_BAR_SCALE, Math.min(1, next));
          node.style.transform = `scaleY(${scale.toFixed(3)})`;
          node.style.opacity = (0.45 + 0.55 * scale).toFixed(3);
        }
      }

      if (!reduced) {
        frameRef.current = requestAnimationFrame(render);
      }
    };

    frameRef.current = requestAnimationFrame(render);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      lastTsRef.current = null;
    };
  }, [barCount]);

  const bars = Array.from({ length: barCount }, (_, index) => index);
  const isError = status === "error";

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-8 items-center justify-center gap-[3px] overflow-hidden",
        className
      )}
      role="img"
      aria-label="Voice activity"
    >
      {bars.map((index) => (
        <span
          key={index}
          ref={(node) => {
            if (node) barsRef.current[index] = node;
          }}
          className={cn(
            "block h-7 w-[3px] origin-center rounded-full will-change-transform",
            isError ? "bg-destructive/70" : "bg-primary/70"
          )}
          style={{ transform: "scaleY(0.06)", opacity: 0.45 }}
        />
      ))}
    </div>
  );
}
