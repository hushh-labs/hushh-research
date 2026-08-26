"use client";

import { X } from "lucide-react";

/**
 * The reason voice failed to start -- mic permission denied, no device, the
 * setup handshake timing out -- used to be squeezed into the status pill
 * itself: `max-w-[60%] flex-1 truncate`, ending in an ellipsis no matter how
 * short the screen was. "Microphone access is blocked. Allow the mic ..."
 * told nobody what to actually do about it.
 *
 * This is a real card instead, same glass treatment as the confirm and
 * dead-end cards above it in the stack, showing the full reason. No
 * auto-fade: unlike a nudge, this describes something that is actually
 * broken and stays up until the person reads it and closes it.
 *
 * Also the one place voice recovery from an error was purely manual: tapping
 * the mic pill again while errored first had to reset it, THEN start a new
 * session on a second tap. Try Again does both in the one tap this card
 * already has someone's attention for.
 */
export function VoiceErrorCard({
  message,
  onRetry,
  onClose,
}: {
  message: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  if (!message) return null;

  return (
    <div
      role="alert"
      aria-label="Voice couldn't start"
      className="agent-approval-glass pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
      data-testid="voice-error-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">Voice couldn&apos;t start</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{message}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1]"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 h-12 w-full rounded-full bg-primary text-[15px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        Try again
      </button>
    </div>
  );
}
