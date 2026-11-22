"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { Button } from "@/components/ui/button";
import { PersonProfileService, type InformationRequestPrice } from "@/lib/services/person-profile-service";
import { COMMERCE_SANDBOX_COPY } from "@/lib/services/scope-commerce-sandbox";
import { formatCommerceMoney } from "@/lib/services/scope-commerce-service";
import { CommerceFundingControls } from "./scope-commerce-account-controls";
import { useScopeCommerceAccount } from "./use-scope-commerce-account";

const PRICE_PREVIEW_TTL_MS = 60_000;
const pricePreviewCache = new Map<string, { price: InformationRequestPrice; cachedAt: number }>();

function peekPricePreview(cacheKey: string): InformationRequestPrice | null {
  const hit = pricePreviewCache.get(cacheKey);
  if (!hit || Date.now() - hit.cachedAt > PRICE_PREVIEW_TTL_MS) {
    if (hit) pricePreviewCache.delete(cacheKey);
    return null;
  }
  return hit.price;
}

function AddRequestCoins({
  suggestedCents,
  refresh,
}: {
  suggestedCents: number;
  refresh: () => void;
}) {
  const state = useScopeCommerceAccount({ suggestedCents });
  return <div className="motion-step-enter space-y-2.5 border-t border-border/60 pt-2.5">
    {state.account?.sandboxVerified === true ? <p data-consent-role="disclosure" className="text-xs text-muted-foreground">{COMMERCE_SANDBOX_COPY}</p> : null}
    <CommerceFundingControls enabled={state.account?.readiness?.capabilities.start_funding === true}
      busy={state.busy || state.loading} amount={state.amount} changeAmount={state.changeAmount}
      maxCents={state.account?.sandboxRemainingCents ?? null}
      checkout={() => { void state.checkout()?.then(refresh); }}
      secondaryAction={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-consent-role="compact-action"
          data-consent-quiet-action="true"
          className="whitespace-nowrap"
          disabled={state.busy}
          onClick={() => { void state.refresh().then(refresh); }}
        >
          Check balance
        </Button>
      } />
    {state.hostedPending ? <p role="status" data-consent-role="status" className="text-sm">Finish checkout in Stripe, then return here.</p> : null}
    {state.message ? <p role="alert" data-consent-role="status" className="text-sm text-destructive">{state.message}</p> : null}
  </div>;
}

/** The same server-priced selection in Profile and both Chat review paths, backed by L1 SWR cache. */
export function InformationRequestPriceReview({ personRef, scopeRefs, durationHours, onChange }: {
  personRef: string; scopeRefs: string[]; durationHours: number;
  onChange: (price: InformationRequestPrice | null) => void;
}) {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const selection = JSON.stringify([...new Set(scopeRefs)].sort());
  const cacheKey = JSON.stringify([userId, personRef, selection, durationHours]);
  const key = JSON.stringify([userId, personRef, selection, durationHours, vaultOwnerToken]);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const [reading, setReading] = useState<{ key: string; price: InformationRequestPrice } | null>(() => {
    const warm = userId && isVaultUnlocked ? peekPricePreview(cacheKey) : null;
    return warm ? { key, price: warm } : null;
  });
  const [failed, setFailed] = useState(false);
  const [funding, setFunding] = useState(false);
  const [revision, setRevision] = useState(0);

  const price = isVaultUnlocked && (reading?.key === key ? reading.price : peekPricePreview(cacheKey));
  const refresh = useCallback(() => {
    pricePreviewCache.delete(cacheKey);
    setRevision(value => value + 1);
  }, [cacheKey]);

  useEffect(() => {
    const clearOnMutation = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown> | undefined>).detail;
      const source = typeof detail?.source === "string" ? detail.source : "";
      // Only invalidate cached price quotes when tariffs or coin balances change;
      // unrelated consent reads/approvals otherwise trigger redundant 5-15s preview storms.
      if (
        source &&
        !source.startsWith("scope_payment_") &&
        !source.startsWith("tariff") &&
        !source.startsWith("funding") &&
        !source.includes("commerce")
      ) {
        return;
      }
      pricePreviewCache.clear();
      setRevision(value => value + 1);
    };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, clearOnMutation);
    return () => window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, clearOnMutation);
  }, []);

  useEffect(() => {
    setFailed(false);
    if (!userId || !isVaultUnlocked || !vaultOwnerToken || !personRef || selection === "[]") {
      setReading(null);
      onChangeRef.current(null);
      return;
    }
    const warm = peekPricePreview(cacheKey);
    if (warm) {
      setReading({ key, price: warm });
      onChangeRef.current(warm);
    } else {
      setReading(null);
      onChangeRef.current(null);
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { if (!warm) setFailed(true); controller.abort(); }, 15_000);
    void PersonProfileService.informationRequestPrice({
      personRef, scopeRefs: JSON.parse(selection), durationSeconds: durationHours * 3600,
      vaultOwnerToken, signal: controller.signal,
    }).then(value => {
      if (!controller.signal.aborted) {
        pricePreviewCache.set(cacheKey, { price: value, cachedAt: Date.now() });
        setReading({ key, price: value });
        onChangeRef.current(value);
        setFunding(value.shortfallCoins > 0);
      }
    }).catch(() => { if (!controller.signal.aborted && !warm) setFailed(true); })
      .finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [key, cacheKey, userId, personRef, selection, durationHours, isVaultUnlocked, vaultOwnerToken, revision]);

  return <div className="space-y-2.5 rounded-[var(--app-card-radius-compact)] bg-muted/45 px-3.5 py-2.5" aria-live="polite" data-testid="information-request-price">
    {!price ? <>
      <div className="flex items-center justify-between gap-2">
        <p data-consent-role="status" className="text-xs font-medium text-muted-foreground">{failed ? "Couldn’t check the price." : "Checking price…"}</p>
        {failed ? <Button type="button" variant="ghost" size="sm" onClick={refresh}>Check again</Button> : null}
      </div>
    </> : <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-1.5">
          <span data-consent-role="fact-label" className="text-muted-foreground">Total ·</span>
          <strong data-consent-role="fact-value" className="font-semibold tabular-nums">{price.totalCoins ? formatCommerceMoney(price.totalCoins) : "Free"}</strong>
        </div>
        {price.totalCoins > 0 ? (
          <div className="flex items-center gap-2.5">
            <span data-consent-role="body" className="text-xs text-muted-foreground tabular-nums">
              Balance: {formatCommerceMoney(price.availableCoins)}
            </span>
            <button
              type="button"
              onClick={() => setFunding(value => !value)}
              className="inline-flex min-h-8 items-center rounded-full px-2.5 text-xs font-medium text-[color:var(--app-accent)] transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {funding ? "Hide" : "Add coins"}
            </button>
          </div>
        ) : null}
      </div>
      {price.totalCoins > 0 ? <>
        {price.shortfallCoins > 0 ? (
          <p data-consent-role="status" className="text-xs font-medium text-foreground">
            Add {formatCommerceMoney(price.shortfallCoins)} or choose a shorter duration above.
          </p>
        ) : (
          <p data-consent-role="disclosure" className="text-xs text-muted-foreground">
            Covered by your balance. Reserved on send; refunded if declined or unused.
          </p>
        )}
        {funding ? <AddRequestCoins suggestedCents={price.shortfallCoins} refresh={refresh} /> : null}
      </> : null}
    </>}
  </div>;
}
