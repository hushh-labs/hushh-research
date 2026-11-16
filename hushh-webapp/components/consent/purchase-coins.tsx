"use client";

import { useId, useState } from "react";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { formatCommerceMoney as money } from "@/lib/services/scope-commerce-service";
import { COMMERCE_SANDBOX_COPY } from "@/lib/services/scope-commerce-sandbox";
import { CommerceFundingControls } from "./scope-commerce-account-controls";
import { useCommerceAccountBackLayer } from "./use-commerce-session";
import { useScopeCommerceAccount } from "./use-scope-commerce-account";

/** Spendable coins use the existing purchase ledger, separate from payout earnings. */
export function PurchaseCoins() {
  const state = useScopeCommerceAccount();
  const editorId = useId();
  const [editor, setEditor] = useState<string | null>(null);
  const expanded = Boolean(state.userId && editor === state.userId);
  const close = () => {
    if (!state.busy) setEditor(null);
    return true;
  };
  useCommerceAccountBackLayer(expanded ? 1 : 0, close);
  if (!state.user) return null;

  const balance = state.account?.balance;
  const canFund = state.account?.readiness?.capabilities.start_funding === true;
  return <SettingsGroup title="Coins to spend" className="consent-presentation-surface">
    <div className="space-y-3 px-4 py-4" data-consent-presentation="profile-payments">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p data-consent-role="row-title" className="font-semibold tabular-nums">{balance ? money(balance.available_cents) : state.loading ? "Checking balance…" : "Balance unavailable"}</p>
          <p data-consent-role="helper" className="text-sm text-muted-foreground">For paid information requests.</p>
        </div>
        <Button data-consent-role="compact-action" variant={expanded ? "ghost" : "default"}
          disabled={state.busy || (!expanded && (!balance || !canFund || state.loading))}
          aria-expanded={expanded} aria-controls={editorId} onClick={() => expanded ? close() : setEditor(state.userId)}>{expanded ? "Cancel" : "Add coins"}</Button>
      </div>
      {balance?.reserved_cents ? <p data-consent-role="body" className="text-sm tabular-nums">{money(balance.reserved_cents)} reserved for requests.</p> : null}
      {balance?.frozen_cents ? <p data-consent-role="status" className="text-sm tabular-nums">{money(balance.frozen_cents)} under payment review.</p> : null}
      {state.account?.sandboxVerified === true ? <p data-consent-role="disclosure" className="text-xs text-muted-foreground">{COMMERCE_SANDBOX_COPY}</p> : null}
      {state.message ? <p data-consent-role="status" role="status" className="text-sm">{state.message}</p> : null}
      {!state.loading && state.account && !canFund ? <p data-consent-role="status" role="status" className="text-sm">Adding coins is currently unavailable.</p> : null}
      {expanded ? <div id={editorId} className="motion-step-enter space-y-3">
        {state.hostedPending ? <>
          <p data-consent-role="status" role="status" className="text-sm">Finish checkout in Stripe. Your balance updates when you return.</p>
          <Button data-consent-role="compact-action" variant="ghost" onClick={state.cancelHosted}>Close Stripe window</Button>
        </> : <>
          <CommerceFundingControls enabled={canFund} busy={state.busy || state.loading} amount={state.amount} changeAmount={state.changeAmount} checkout={() => void state.checkout()} />
        </>}
      </div> : null}
      {!expanded ? <Button data-consent-role="compact-action" variant="ghost" disabled={state.busy || state.loading} onClick={() => void state.refresh()}>Check balance</Button> : null}
    </div>
  </SettingsGroup>;
}
