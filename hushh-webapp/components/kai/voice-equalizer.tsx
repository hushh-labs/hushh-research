"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

type VoiceEqualizerProps = {
  state: "listening" | "processing";
  level: number;
  bars?: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function VoiceEqualizer({ state, level, bars = 14 }: VoiceEqualizerProps) {
  const [animationTick, setAnimationTick] = useState(0);

  useEffect(() => {
    let frame = 0;
    let lastUpdate = 0;
    const tick = (now: number) => {
      if (now - lastUpdate > 80) {
        lastUpdate = now;
        setAnimationTick((value) => value + 1);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const heights = useMemo(() => {
    const now = animationTick * 80;
    const phase = now / 170;
    const minHeight = 6;
    const maxHeight = state === "processing" ? 24 : 34;

    const effectiveLevel = clamp01(
      state === "processing" ? Math.max(0.18, level * 0.45) : Math.max(0.1, level)
    );

    return Array.from({ length: bars }, (_, index) => {
      const wave = 0.6 + 0.4 * Math.sin(phase + index * 0.7);
      const jitter = 0.9 + 0.1 * Math.sin(phase * 0.5 + index * 1.13);
      const barNorm = clamp01(effectiveLevel * wave * jitter + 0.03);
      return Math.round(minHeight + barNorm * (maxHeight - minHeight));
    });
  }, [animationTick, bars, level, state]);

  return (
    <div className="flex h-full w-full items-center justify-center gap-1.5 px-4">
      {heights.map((height, index) => (
        <span
          key={`${index}-${height}`}
          className={cn(
            "w-1 rounded-full bg-foreground/85 transition-[height,opacity] duration-100",
            state === "processing" ? "opacity-70" : "opacity-90"
          )}
          style={{ height }}
        />
      ))}
    </div>
  );
}
