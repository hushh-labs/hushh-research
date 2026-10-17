"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Brain, ChevronDown } from "@/components/icons";
import { puppyThoughtLabel } from "@/lib/agent/puppy-turn-copy";
import { cn } from "@/lib/utils";

/**
 * The local model's reasoning, as it wrote it. Rendered only from reasoning the
 * device actually forwarded; there is no placeholder trail.
 *
 * Open while the model reasons, so the owner sees work instead of a blank
 * bubble, and folded the moment the answer starts. A trail the owner opened or
 * closed themselves stays the way they left it. The toggle names its region
 * only while it exists, since a folded trail removes it.
 */
export function PuppyThinkingTrail({ text, thoughtMs }: { text: string; thoughtMs: number | null | undefined }) {
  const live = thoughtMs === null;
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const open = userChoice ?? live;
  const regionId = useId();
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Follow the newest line while it is being written.
    if (live && open && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [live, open, text]);

  return (
    <div className="mb-2" data-testid="puppy-thinking-trail" data-live={live ? "true" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        onClick={() => setUserChoice(!open)}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <Brain className={cn("size-4", live && "motion-safe:animate-pulse")} aria-hidden />
        {puppyThoughtLabel(live ? null : thoughtMs ?? 0)}
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div
          id={regionId}
          ref={scroller}
          className="mt-1 max-h-40 overflow-y-auto border-l-2 border-border/70 pl-3 text-xs leading-5 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {text.trim()}
        </div>
      ) : null}
    </div>
  );
}
