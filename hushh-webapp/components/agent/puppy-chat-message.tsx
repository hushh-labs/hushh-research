"use client";

import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { CHAT_USER_BUBBLE_CLASSNAME, OneChatBubble } from "@/components/agent/chat-message-styles";
import { PuppyThinkingTrail } from "@/components/agent/puppy-thinking-trail";
import {
  puppyStageLabel,
  puppyStageShowsElapsed,
  type PuppyTurnStage,
} from "@/lib/agent/puppy-turn-copy";
import type { PuppyChatTurn } from "@/lib/agent/use-puppy-turn";
import { cn } from "@/lib/utils";

/** Three soft dots, the same "working" mark One's chat uses. */
function WorkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {["-160ms", "-80ms", "0ms"].map((delay) => (
        <span key={delay} className="size-1.5 rounded-full bg-current motion-safe:animate-bounce" style={{ animationDelay: delay }} />
      ))}
    </span>
  );
}

/** What the turn is doing before any answer text exists, in plain words. */
export function PuppyTurnStatus({ stage, elapsedSeconds, machine }: {
  stage: PuppyTurnStage;
  elapsedSeconds: number;
  machine: string;
}) {
  return (
    <span className="flex min-h-6 items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="puppy-turn-status" data-stage={stage}>
      <WorkingDots />
      <span>{puppyStageLabel(stage, elapsedSeconds, machine)}</span>
      {puppyStageShowsElapsed(stage) && elapsedSeconds >= 2 ? (
        <span className="tabular-nums text-xs text-muted-foreground/80" aria-hidden>{elapsedSeconds}s</span>
      ) : null}
    </span>
  );
}

/** One Puppy turn in One's chat grammar: accent bubble for you, soft bubble for Puppy. */
export function PuppyChatMessage({ turn, live, stage, elapsedSeconds, machine, onRetry }: {
  turn: PuppyChatTurn;
  /** This is the assistant turn currently streaming. */
  live: boolean;
  stage: PuppyTurnStage;
  elapsedSeconds: number;
  machine: string;
  onRetry?: () => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex w-full flex-col items-end gap-1">
        <div className={cn(CHAT_USER_BUBBLE_CLASSNAME, "max-w-[90%] whitespace-pre-wrap break-words text-sm leading-6 sm:max-w-[min(76%,42rem)]")}>
          {turn.text}
        </div>
        {turn.failure ? (
          <p className="flex max-w-[90%] flex-wrap items-center justify-end gap-x-2 text-right text-xs leading-5 text-muted-foreground sm:max-w-[min(76%,42rem)]" role="alert">
            <span>{turn.failure.message}</span>
            {turn.failure.retryable && onRetry ? (
              <button type="button" onClick={onRetry} className="min-h-8 font-medium text-[color:var(--app-accent)]">Try again</button>
            ) : null}
          </p>
        ) : null}
      </div>
    );
  }
  const waiting = live && !turn.text;
  return (
    <div className="flex w-full flex-col items-start gap-1" data-agent-streaming={live ? "true" : undefined}>
      <div className="min-w-0 max-w-[90%] sm:max-w-[min(82%,48rem)]">
        {turn.thinking ? <PuppyThinkingTrail text={turn.thinking} thoughtMs={turn.thoughtMs} /> : null}
        {waiting && stage !== "thinking" ? (
          <OneChatBubble tone="assistant"><PuppyTurnStatus stage={stage} elapsedSeconds={elapsedSeconds} machine={machine} /></OneChatBubble>
        ) : null}
        {turn.text ? (
          <OneChatBubble tone="assistant" aria-live={live ? "polite" : undefined}>
            <AgentMarkdown text={turn.text} />
          </OneChatBubble>
        ) : null}
      </div>
      {turn.model && !live ? (
        <p className="px-4 text-[11px] text-muted-foreground" data-testid="puppy-target">{turn.model} on {machine}</p>
      ) : null}
    </div>
  );
}
