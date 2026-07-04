"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/lib/morphy-ux/morphy";
import { formatCents } from "@/lib/services/slice-pricing-service";
import type { PublishableSlice } from "@/lib/one-marketplace/service";

/**
 * Agent One rendering of the Information Marketplace "publish for offers?" card
 * (the propose_publish directive delivered over A2A). Publishing itself needs the
 * vault on the marketplace surface, so the primary action hands the user off
 * there; the card is the in-conversation nudge.
 */
export function MarketplacePublishDirectiveCard(props: {
  topic?: string | null;
  slices: PublishableSlice[];
  onOpenMarketplace: () => void;
  onDismiss: () => void;
}) {
  const { topic, slices, onOpenMarketplace, onDismiss } = props;
  if (!slices || slices.length === 0) return null;
  return (
    <div className="rounded-2xl border border-emerald-300/50 bg-emerald-50/50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/15">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-900 dark:text-emerald-200">
        <Sparkles className="h-4 w-4" aria-hidden />
        {topic ? `Publish your ${topic} data for offers?` : "Publish these for offers?"}
      </div>
      <div className="flex flex-col gap-2">
        {slices.map((slice) => (
          <div
            key={`${slice.domain}:${slice.scopeHandle ?? slice.label}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-300/40 bg-background/60 px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <span className="font-medium text-foreground">{slice.label}</span>
              <span className="text-muted-foreground"> · {slice.domainTitle ?? slice.domain}</span>
              {slice.suggestedPriceCents ? (
                <span className="text-muted-foreground">
                  {" "}
                  · ~{formatCents(slice.suggestedPriceCents, slice.currency ?? "USD")}/mo
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button type="button" size="sm" variant="none" effect="fade" onClick={onOpenMarketplace}>
          Open marketplace to publish
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs font-medium text-emerald-700/80 hover:underline dark:text-emerald-300/80"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
