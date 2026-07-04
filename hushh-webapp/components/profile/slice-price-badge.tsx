"use client";

import { useEffect, useState } from "react";

import { Button } from "@/lib/morphy-ux/morphy";
import {
  categoryFromSensitivity,
  formatCents,
  SlicePricingService,
  type PricingMood,
  type PricingPower,
  type SlicePriceBreakdown,
} from "@/lib/services/slice-pricing-service";

interface SlicePriceBadgeProps {
  sensitivityTier?: string | null;
  scopeKind?: string | null;
  attributeCount: number;
  vaultOwnerToken?: string;
}

const POWER_OPTIONS: { value: PricingPower; label: string }[] = [
  { value: "mass", label: "Mass" },
  { value: "mid", label: "Mid" },
  { value: "affluent", label: "Affluent" },
  { value: "hnw", label: "HNW" },
  { value: "uhnw", label: "UHNW" },
];

const MOOD_OPTIONS: { value: PricingMood; label: string }[] = [
  { value: "passive", label: "Passive" },
  { value: "affinity", label: "Affinity" },
  { value: "in_market", label: "In-market" },
  { value: "hot", label: "Hot big-ticket" },
];

/**
 * Suggested-price badge for a published `default_available` slice.
 *
 * Phase 1: display only. The number is computed by the backend; the band selects
 * below just re-price the owner's own slice for illustration. No money moves and
 * nothing is shared — this sits next to the slice, it does not sell it.
 */
export function SlicePriceBadge({
  sensitivityTier,
  scopeKind,
  attributeCount,
  vaultOwnerToken,
}: SlicePriceBadgeProps) {
  const [power, setPower] = useState<PricingPower>("affluent");
  const [mood, setMood] = useState<PricingMood>("affinity");
  const [result, setResult] = useState<SlicePriceBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMath, setShowMath] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!vaultOwnerToken) {
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    SlicePricingService.getSuggestedPrice(
      {
        category: categoryFromSensitivity(sensitivityTier, scopeKind),
        attributeCount,
        power,
        mood,
      },
      vaultOwnerToken
    )
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Pricing unavailable");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sensitivityTier, scopeKind, attributeCount, power, mood, vaultOwnerToken]);

  return (
    <div className="rounded-2xl border border-amber-200/60 bg-amber-50/40 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Suggested price
          </div>
          <div className="text-lg font-semibold">
            {loading
              ? "Calculating…"
              : result
                ? `${formatCents(result.suggestedPriceCents, result.currency)} / 30 days`
                : "—"}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="none"
          effect="fade"
          onClick={() => setShowMath((value) => !value)}
          disabled={!result}
        >
          {showMath ? "Hide price math" : "Show price math"}
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-1">
          Buying power
          <select
            className="rounded-full border bg-background px-2 py-1 text-foreground"
            value={power}
            onChange={(event) => setPower(event.target.value as PricingPower)}
          >
            {POWER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Buying mood
          <select
            className="rounded-full border bg-background px-2 py-1 text-foreground"
            value={mood}
            onChange={(event) => setMood(event.target.value as PricingMood)}
          >
            {MOOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      {showMath && result ? (
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl bg-background/70 p-3 text-[11px] text-muted-foreground">
          {JSON.stringify(result.breakdown, null, 2)}
        </pre>
      ) : null}

      <p className="mt-2 text-[11px] text-muted-foreground">
        Suggested only — you set the final price. Display-only preview; no buyer, no money moves,
        nothing is shared.
      </p>
    </div>
  );
}
