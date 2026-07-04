"use client";

import { Store } from "lucide-react";

/** Shared card surface + muted-copy tokens (same app-card design system the
 *  Location chat uses, inlined here so the marketplace chat is self-contained). */
export const MARKET_CARD_SURFACE =
  "rounded-[var(--app-card-radius-standard)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]";
export const MARKET_MUTED_TEXT = "text-sm leading-snug text-muted-foreground";

export function MarketBotAvatar(props: { size?: number }) {
  const size = props.size ?? 32;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Store style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

export function MarketTypingIndicator() {
  return (
    <span
      data-testid="marketplace-chat-typing"
      className="inline-flex items-center gap-1"
      aria-label="The marketplace assistant is typing"
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
