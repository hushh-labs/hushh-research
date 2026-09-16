"use client";

/**
 * The running conversation: what you said, what One said.
 *
 * A polite live region so a screen reader hears each finished line once;
 * partial lines are `aria-busy` so they are not read mid-word. Text here is
 * display only — the reducer never derives state from it, and neither does
 * this component.
 */

import { useEffect, useRef } from "react";

import type { TranscriptItem } from "@/lib/one-voice/session-types";
import { cn } from "@/lib/utils";

export type VoiceTranscriptProps = {
  items: TranscriptItem[];
  /** Show only the latest line, on one line. */
  collapsed?: boolean;
  className?: string;
};

const ROLE_LABEL: Record<TranscriptItem["role"], string> = {
  you: "You",
  one: "One",
};

/** The one-line status for the pill while the panel is collapsed. */
export function transcriptStatusLine(items: TranscriptItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    const clean = item.text.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    return item.role === "you" ? `You said: ${clean}` : `One: ${clean}`;
  }
  return null;
}

export function VoiceTranscript({
  items,
  collapsed = false,
  className,
}: VoiceTranscriptProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const visible = items.filter((item) => item.text.trim().length > 0);
  const shown = collapsed ? visible.slice(-1) : visible;
  const lastId = shown[shown.length - 1]?.id ?? null;
  const lastText = shown[shown.length - 1]?.text ?? "";

  useEffect(() => {
    if (collapsed) return;
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [collapsed, lastId, lastText]);

  return (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Conversation with One"
      data-testid="one-voice-transcript"
      data-collapsed={collapsed || undefined}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {shown.length === 0 ? (
        <p
          className="text-[13px] text-[color:var(--app-tertiary-label)]"
          data-testid="one-voice-transcript-empty"
        >
          Say what you need. One is listening.
        </p>
      ) : null}
      {shown.map((item) => (
        <p
          key={item.id}
          data-testid="one-voice-transcript-line"
          data-role={item.role}
          data-final={item.final || undefined}
          aria-busy={!item.final}
          className={cn(
            "text-[15px] leading-5",
            collapsed && "line-clamp-1",
            item.role === "you"
              ? "text-[color:var(--app-secondary-label)]"
              : "text-[color:var(--app-label)]",
            !item.final && "one-voice-transcript-partial",
          )}
        >
          <span className="mr-1.5 text-[12px] font-semibold text-[color:var(--app-section-label)]">
            {ROLE_LABEL[item.role]}
          </span>
          {item.text}
          {!item.final ? (
            <span className="sr-only"> (still speaking)</span>
          ) : null}
        </p>
      ))}
      <div ref={endRef} aria-hidden />
    </div>
  );
}
