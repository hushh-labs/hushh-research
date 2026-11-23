"use client";

import { ConsentAgentIcon, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { formatCommerceMoney } from "@/lib/services/scope-commerce-service";

export type IncomingConsentBannerItem = {
  requestId: string;
  bundleId?: string | null;
  requesterLabel: string;
  scopeLabel: string;
  priceCoins?: number;
};

export function IncomingConsentChatBanner({
  item,
  onReviewInChat,
  onDismiss,
}: {
  item: IncomingConsentBannerItem | null;
  onReviewInChat: (item: IncomingConsentBannerItem) => void;
  onDismiss: () => void;
}) {
  if (!item) return null;
  const priceTag =
    typeof item.priceCoins === "number" && item.priceCoins > 0
      ? `${formatCommerceMoney(item.priceCoins)} reserved`
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="incoming-consent-chat-banner"
      className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3 sm:px-4"
    >
      <div className="pointer-events-auto flex w-full max-w-lg items-center gap-3 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]/95 px-3.5 py-2.5 shadow-[0_14px_40px_-20px_rgba(0,0,0,0.35)] backdrop-blur-xl">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center">
          <ConsentAgentIcon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-5 text-foreground">
            {item.requesterLabel} wants your {item.scopeLabel}
          </p>
          {priceTag ? (
            <p className="truncate text-xs font-medium text-muted-foreground tabular-nums">
              {priceTag}
            </p>
          ) : (
            <p className="truncate text-xs text-muted-foreground">
              Waiting for your decision
            </p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          className="h-9 shrink-0 rounded-full px-3.5 text-xs font-medium"
          data-testid="incoming-consent-review-in-chat"
          onClick={() => onReviewInChat(item)}
        >
          Review in Chat
        </Button>
        <button
          type="button"
          aria-label="Dismiss request banner"
          onClick={onDismiss}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
