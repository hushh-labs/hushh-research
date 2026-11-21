"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Grounded in Hussh One's canonical ontology (Listens, Remembers, Decides, Acts,
 * Personal Wiki & fiduciary duty of care — docs/product/principles/agent-ontology.md).
 */
export const ONE_PERSONA_THINKING_PHRASES = [
  "Listening closely…",
  "Consulting your wiki…",
  "Recalling context…",
  "Weighing signal…",
  "Cross-referencing notes…",
  "Tracing provenance…",
  "Distilling context…",
  "Aligning details…",
  "Synthesizing…",
] as const;

const ROTATION_INTERVAL_MS = 2_200;
const FADE_DURATION_MS = 140;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function OneThinkingIndicator({ className }: { className?: string }) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    let fadeTimer = 0;
    const interval = window.setInterval(() => {
      setVisible(false);
      fadeTimer = window.setTimeout(() => {
        setIndex((prev) => (prev + 1) % ONE_PERSONA_THINKING_PHRASES.length);
        setVisible(true);
      }, FADE_DURATION_MS);
    }, ROTATION_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      if (fadeTimer) window.clearTimeout(fadeTimer);
    };
  }, []);

  return (
    <span
      data-testid="one-thinking-indicator"
      className={cn(
        "inline-flex items-center gap-2.5 py-0.5 text-[13.5px] leading-6 text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 rounded-full bg-foreground/45 motion-safe:animate-pulse" />
        <span className="size-1.5 rounded-full bg-foreground/35 motion-safe:animate-pulse [animation-delay:220ms]" />
        <span className="size-1.5 rounded-full bg-foreground/25 motion-safe:animate-pulse [animation-delay:440ms]" />
      </span>
      <span
        className={cn(
          "transition-opacity duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
          visible ? "opacity-100" : "opacity-0",
        )}
      >
        {ONE_PERSONA_THINKING_PHRASES[index]}
      </span>
    </span>
  );
}
