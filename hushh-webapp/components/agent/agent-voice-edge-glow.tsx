// components/agent/agent-voice-edge-glow.tsx
// iOS Siri-style ambient edge glow (latest iOS aesthetic).
//
// "An elegant glowing light that wraps around the edge of the screen when Siri
// is active" (Apple). This overlay reproduces that: soft, multi-hue light pools
// anchored to the screen edges that gently WAVE (drift + breathe) in place, so
// the colors shimmer along the rim without spinning around it. The pools hug the
// four edges end-to-end and feather softly inward via an edge mask, leaving the
// center clear. The whole rim breathes with the live audio level.
//
// It reacts to the shared agent voice state: the palette warms/cools with the
// conversation status (listening / thinking / speaking / error) and the reveal
// depth + intensity ride the smoothed audio level. Enter and exit are symmetric
// (both fade over the overlay motion tokens) so it glides in when a session
// opens and glides back out when it ends.

"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import { cn } from "@/lib/utils";

// Per-status color mixes. Each mix is a FULL spectrum walked once around the
// rim (12 distinct stops, no repeats) so the edge reads as a continuous
// rainbow rather than a few repeating hues. The listening mix is the iOS-style
// Siri spectrum (blue → cyan → green → gold → orange → magenta → violet →
// indigo back to blue) with our Foundation gold woven in. Thinking leans cooler,
// speaking warmer, error goes red.
const LISTENING_MIX = [
  "#4f7bff", "#38bdf8", "#22d3ee", "#34d399", "#a3e635", "#f0c890",
  "#f59e0b", "#fb7185", "#ec4899", "#c026d3", "#8b5cf6", "#6366f1",
];

const STATUS_MIX: Record<string, string[]> = {
  connecting: LISTENING_MIX,
  listening: LISTENING_MIX,
  transcribing: LISTENING_MIX,
  thinking: [
    "#4f46e5", "#4361ff", "#4f7bff", "#38bdf8", "#22d3ee", "#38bdf8",
    "#6366f1", "#7c3aed", "#8b5cf6", "#a855f7", "#7c3aed", "#4f46e5",
  ],
  speaking: [
    "#f0c890", "#f6d365", "#f59e0b", "#fb923c", "#fb7185", "#ec4899",
    "#d4af6a", "#f0c890", "#f59e0b", "#fb7185", "#c026d3", "#f0c890",
  ],
  muted: [
    "#94a3b8", "#a5b4cb", "#cbd5e1", "#b8c2d0", "#94a3b8", "#aab6c6",
    "#cbd5e1", "#94a3b8", "#a5b4cb", "#b8c2d0", "#94a3b8", "#a5b4cb",
  ],
  error: [
    "#ef4444", "#f43f5e", "#f97316", "#fb7185", "#ec4899", "#ef4444",
    "#f97316", "#f43f5e", "#ef4444", "#fb7185", "#f97316", "#ef4444",
  ],
};

const DEFAULT_MIX = LISTENING_MIX;

// The edge pools: each one hugs a side (or corner) of the screen. Positions are
// anchored to the true screen edges (0% / 100%) so the glow reaches end-to-end.
// `axis` picks the drift keyframe (top/bottom wave sideways, left/right wave
// vertically, corners just breathe). `w`/`h` are viewport-relative footprints so
// the pools stay proportional across screen sizes.
type PoolDef = {
  key: string;
  colorIndex: number;
  style: CSSProperties;
  anim: "x" | "y" | "breathe";
  duration: number;
  delay: number;
};

// Pools are thin and pinned OFF-screen just past each edge, so only their soft
// inner falloff bleeds into a narrow rim. Long along the edge, shallow across it
// - the color stays a tight luminous band, never a full-screen wash.
// Each pool takes a UNIQUE spectrum stop, ordered so the colours walk once
// around the perimeter (top-left corner → across the top → down the right →
// across the bottom → up the left), giving a continuous non-repeating rainbow.
const POOLS: PoolDef[] = [
  // Top-left corner start.
  { key: "c-tl", colorIndex: 0, anim: "breathe", duration: 6.5, delay: 0, style: { top: "-16vh", left: "-16vw", width: "26vw", height: "26vh" } },
  // Top edge (drift sideways).
  { key: "top-a", colorIndex: 1, anim: "x", duration: 7.5, delay: 0, style: { top: "-13vh", left: "-8vw", width: "62vw", height: "16vh" } },
  { key: "top-b", colorIndex: 2, anim: "x", duration: 9, delay: -3, style: { top: "-13vh", right: "-8vw", width: "62vw", height: "16vh" } },
  // Top-right corner.
  { key: "c-tr", colorIndex: 3, anim: "breathe", duration: 7.2, delay: -2, style: { top: "-16vh", right: "-16vw", width: "26vw", height: "26vh" } },
  // Right edge (drift vertically).
  { key: "right-a", colorIndex: 4, anim: "y", duration: 8.8, delay: -2.5, style: { right: "-13vw", top: "-6vh", width: "16vw", height: "62vh" } },
  { key: "right-b", colorIndex: 5, anim: "y", duration: 10.5, delay: -6, style: { right: "-13vw", bottom: "-6vh", width: "16vw", height: "64vh" } },
  // Bottom-right corner.
  { key: "c-br", colorIndex: 6, anim: "breathe", duration: 6.9, delay: -1.5, style: { bottom: "-16vh", right: "-16vw", width: "28vw", height: "28vh" } },
  // Bottom edge.
  { key: "bot-b", colorIndex: 7, anim: "x", duration: 10, delay: -5, style: { bottom: "-13vh", right: "-8vw", width: "64vw", height: "16vh" } },
  { key: "bot-a", colorIndex: 8, anim: "x", duration: 8.5, delay: -2, style: { bottom: "-13vh", left: "-8vw", width: "64vw", height: "16vh" } },
  // Bottom-left corner.
  { key: "c-bl", colorIndex: 9, anim: "breathe", duration: 7.8, delay: -3.5, style: { bottom: "-16vh", left: "-16vw", width: "28vw", height: "28vh" } },
  // Left edge (drift vertically).
  { key: "left-b", colorIndex: 10, anim: "y", duration: 11, delay: -4, style: { left: "-13vw", bottom: "-6vh", width: "16vw", height: "62vh" } },
  { key: "left-a", colorIndex: 11, anim: "y", duration: 9.5, delay: -1, style: { left: "-13vw", top: "-6vh", width: "16vw", height: "62vh" } },
];

const ANIM_NAME: Record<PoolDef["anim"], string> = {
  x: "one-siri-drift-x",
  y: "one-siri-drift-y",
  breathe: "one-siri-breathe",
};

export function AgentVoiceEdgeGlow() {
  const runtime = useAgentRuntimeStateOptional();
  const active = useAgentVoiceState((s) => s.active);
  const status = useAgentVoiceState((s) => s.status);
  const level = useAgentVoiceState((s) => s.level);

  // Smooth the raw audio level so the glow breathes instead of jittering. A
  // light exponential follower (fast attack, slower release) tracks speech
  // energy the way Siri's glow does.
  const [smoothLevel, setSmoothLevel] = useState(0);
  const smoothRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const targetRef = useRef(0);

  useEffect(() => {
    targetRef.current = active ? Math.min(1, Math.max(0, level)) : 0;
  }, [level, active]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const tick = () => {
      const target = targetRef.current;
      const current = smoothRef.current;
      const factor = target > current ? 0.3 : 0.09;
      const next = current + (target - current) * factor;
      smoothRef.current = Math.abs(next - current) < 0.001 ? target : next;
      setSmoothLevel(smoothRef.current);
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const showEdgeGlow = active;
  const mix = STATUS_MIX[status] ?? DEFAULT_MIX;

  // Presence: subtle and vivid. Kept restrained so the rim never competes with
  // on-screen content; energy adds a little lift, not a wash.
  const poolsAlpha = showEdgeGlow ? Math.min(0.9, 0.6 + smoothLevel * 0.3) : 0;
  const poolBlur = 30 - smoothLevel * 8; // px
  // Saturation keeps the colours vivid so even a thin rim reads as a spectrum.
  const poolPunch = "saturate(1.55) brightness(1.15)";

  // Edge mask: reveal the pools only in a NARROW band at the perimeter and
  // feather quickly to transparent, so only a tight rim shows and the whole body
  // stays clear. Two linear masks (top/bottom + left/right) unioned so all four
  // edges show; the band grows only slightly with energy. Anchored to the true
  // edges (0%), so the rim reaches end-to-end.
  const depth = 5 + smoothLevel * 3; // % of the screen the rim reaches in
  const maskStyle = useMemo<CSSProperties>(() => {
    const vert = `linear-gradient(to bottom, #000 0%, transparent ${depth}%, transparent ${100 - depth}%, #000 100%)`;
    const horiz = `linear-gradient(to right, #000 0%, transparent ${depth}%, transparent ${100 - depth}%, #000 100%)`;
    return {
      WebkitMaskImage: `${vert}, ${horiz}`,
      maskImage: `${vert}, ${horiz}`,
      WebkitMaskComposite: "source-over",
      maskComposite: "add",
    };
  }, [depth]);

  return (
    <div
      aria-hidden
      data-voice-status={status}
      data-morphy-ax-presentation={runtime?.morphyAxPresentation ?? "idle"}
      data-testid="one-voice-edge-glow"
      className={cn(
        "pointer-events-none fixed inset-0 z-[117] overflow-hidden",
        "transition-opacity ease-[var(--motion-overlay-enter-ease)]",
        showEdgeGlow
          ? "opacity-100 duration-[var(--motion-overlay-enter-duration)]"
          : "opacity-0 duration-[var(--motion-overlay-exit-duration)]",
      )}
    >
      {/* Edge-masked layer: the pools live here and are shown only along the
          four edges (center feathers to clear). Full-bleed to the true screen
          edges - no inset, no rounded band - so the glow spans end-to-end. */}
      <div
        className="absolute inset-0 transition-opacity duration-[var(--motion-duration-lg)]"
        style={{ opacity: poolsAlpha, ...maskStyle }}
      >
        {POOLS.map((pool) => (
          <span
            key={pool.key}
            className="one-siri-edge-pool"
            style={
              {
                ...pool.style,
                background: `radial-gradient(closest-side, ${mix[pool.colorIndex] ?? mix[0]} 0%, ${mix[pool.colorIndex] ?? mix[0]} 34%, transparent 74%)`,
                animationName: ANIM_NAME[pool.anim],
                animationDuration: `${pool.duration}s`,
                animationDelay: `${pool.delay}s`,
                animationTimingFunction: "ease-in-out",
                animationIterationCount: "infinite",
                ["--one-siri-pool-blur" as string]: `${poolBlur}px`,
                filter: `blur(${poolBlur}px) ${poolPunch}`,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
