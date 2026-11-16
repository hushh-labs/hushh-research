"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { Button } from "@/components/ui/button";
import { PersonProfileService, type InformationRequestPrice } from "@/lib/services/person-profile-service";
import { COMMERCE_SANDBOX_COPY } from "@/lib/services/scope-commerce-sandbox";
import { formatCommerceMoney } from "@/lib/services/scope-commerce-service";
import { CommerceFundingControls } from "./scope-commerce-account-controls";
import { useScopeCommerceAccount } from "./use-scope-commerce-account";

function AddRequestCoins({ refresh }: { refresh: () => void }) {
  const state = useScopeCommerceAccount();
  return <div className="motion-step-enter space-y-3">
    {state.account?.sandboxVerified === true ? <p data-consent-role="disclosure" className="text-xs text-muted-foreground">{COMMERCE_SANDBOX_COPY}</p> : null}
    <CommerceFundingControls enabled={state.account?.readiness?.capabilities.start_funding === true}
      busy={state.busy || state.loading} amount={state.amount} changeAmount={state.changeAmount}
      checkout={() => { void state.checkout()?.then(refresh); }} />
    {state.hostedPending ? <p role="status" data-consent-role="status" className="text-sm">Finish checkout in Stripe, then return here.</p> : null}
    {state.message ? <p role="status" data-consent-role="status" className="text-sm">{state.message}</p> : null}
    <Button type="button" variant="ghost" size="sm" disabled={state.busy} onClick={() => { void state.refresh().then(refresh); }}>Check balance</Button>
  </div>;
}

/** The same server-priced selection in Profile and both Chat review paths. */
export function InformationRequestPriceReview({ personRef, scopeRefs, durationHours, onChange }: {
  personRef: string; scopeRefs: string[]; durationHours: number;
  onChange: (price: InformationRequestPrice | null) => void;
}) {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const [reading, setReading] = useState<{ key: string; price: InformationRequestPrice } | null>(null);
  const [failed, setFailed] = useState(false);
  const [funding, setFunding] = useState(false);
  const [revision, setRevision] = useState(0);
  const selection = JSON.stringify([...new Set(scopeRefs)].sort());
  const key = JSON.stringify([userId, personRef, selection, durationHours, vaultOwnerToken]);
  const price = isVaultUnlocked && reading?.key === key ? reading.price : null;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    onChange(null);
    setReading(null);
    setFailed(false);
    if (!userId || !isVaultUnlocked || !vaultOwnerToken || !personRef || selection === "[]") return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { setFailed(true); controller.abort(); }, 15_000);
    void PersonProfileService.informationRequestPrice({
      personRef, scopeRefs: JSON.parse(selection), durationSeconds: durationHours * 3600,
      vaultOwnerToken, signal: controller.signal,
    }).then(value => {
      if (!controller.signal.aborted) { setReading({ key, price: value }); onChange(value); }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [key, userId, personRef, selection, durationHours, isVaultUnlocked, vaultOwnerToken, revision, onChange]);
  return <div className="space-y-3 rounded-[var(--app-card-radius-compact)] bg-muted/50 p-3" aria-live="polite" data-testid="information-request-price">
    {!price ? <>
      <p data-consent-role="status" className="text-sm">{failed ? "Couldn’t check the price." : "Checking price…"}</p>
      {failed ? <Button type="button" variant="ghost" size="sm" onClick={refresh}>Check again</Button> : null}
    </> : <>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span data-consent-role="fact-label">Total</span>
        <strong data-consent-role="fact-value" className="tabular-nums">{price.totalCoins ? formatCommerceMoney(price.totalCoins) : "Free"}</strong>
      </div>
      {price.totalCoins > 0 ? <>
        <p data-consent-role="body" className="text-sm text-muted-foreground">Balance: {formatCommerceMoney(price.availableCoins)}</p>
        <p data-consent-role="disclosure" className="text-xs text-muted-foreground">Coins are reserved when you send and spent when sharing starts. Returned if declined, cancelled or not shared in time.</p>
        {price.shortfallCoins > 0 ? <p data-consent-role="status" className="text-sm">Add {formatCommerceMoney(price.shortfallCoins)} to send.</p> : null}
        <Button type="button" variant="ghost" size="sm" onClick={() => setFunding(value => !value)}>{funding ? "Close" : "Add coins"}</Button>
        {funding ? <AddRequestCoins refresh={refresh} /> : null}
      </> : null}
      <Button type="button" variant="ghost" size="sm" onClick={refresh}>Check price</Button>
    </>}
  </div>;
}
