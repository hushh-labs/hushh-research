"use client";

import { Bot, Check } from "lucide-react";

export function BotAvatar(props: { size?: number }) {
  const size = props.size ?? 32;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-[#d4a574]/15 text-[#b8894d]"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Bot style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

export function TypingIndicator() {
  return (
    <span
      data-testid="location-chat-typing"
      className="inline-flex items-center gap-1"
      aria-label="One Location is typing"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 motion-reduce:animate-none"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}

export function StateChangedNote() {
  return (
    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
      <Check className="h-3.5 w-3.5 shrink-0" />
      Updated — your sharing list refreshed.
    </p>
  );
}
