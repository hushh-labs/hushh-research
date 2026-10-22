"use client";

import { useEffect, useRef, useState } from "react";
import { HelperText } from "@/components/app-ui/typography";
import { CaretRightIcon } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import { isNative } from "@/lib/capacitor/platform";
import { dispatchPayoutStateChanged } from "@/lib/payouts/payout-events";
import type { PayoutResource } from "@/lib/payouts/payout-live-store";
import { apiErrorCode } from "@/lib/services/api-client";
import { DocumentPayoutService, type HashcoinRedemption, type HashcoinWallet } from "@/lib/services/document-payout-service";
import { reloadWindow } from "@/lib/utils/browser-navigation";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

import type { PayoutAccountState } from "./payout-bank-row";
import { money } from "./payout-format";
import { PayoutReceiptSheet } from "./receipts/payout-receipt-sheet";
import { cashOutBlock, readyCoins, redemptionCopy, redemptionError } from "./redemption-copy";

/** The wallet read the redeem flow acts on and fences every reply against. */
export type HashcoinWalletResource = Pick<PayoutResource<HashcoinWallet>,
  "data" | "token" | "scope" | "failed" | "isCurrent" | "retry" | "lastSuccessAt" | "stale">;

export type HashcoinRedeem = ReturnType<typeof useHashcoinRedeem>;

/** A new live redemption acts only on a wallet read in the last minute. */
export const WALLET_FRESH_MS = 60_000;
// While Redeem is offered, the wallet re-reads before it ages out; after the
// store's own 45 s fallback read, so a polling store is never read twice.
const WALLET_REREAD_MS = 50_000;

function walletReadWithin(resource: HashcoinWalletResource, now: number): boolean {
  return !resource.stale && resource.lastSuccessAt !== null && now - resource.lastSuccessAt < WALLET_FRESH_MS;
}

/**
 * True while the last wallet read succeeded under a minute ago and no payout
 * change is unread. Each read sets its own timers, so there is no polling
 * loop; while a redemption is offered the wallet re-reads before then. A
 * return to the page is the store's: it reads the wallet once.
 */
function useFreshWallet(resource: HashcoinWalletResource, offered: boolean): boolean {
  const { lastSuccessAt, stale } = resource;
  const retry = useRef(resource.retry);
  useEffect(() => { retry.current = resource.retry; });
  const [agedOut, setAgedOut] = useState<number | null>(null);
  useEffect(() => {
    if (lastSuccessAt === null) return;
    const age = () => Date.now() - lastSuccessAt;
    const timers = [window.setTimeout(() => setAgedOut(lastSuccessAt), Math.max(0, WALLET_FRESH_MS - age()))];
    // A hidden page skips this; the store's read on return replaces it.
    if (offered) timers.push(window.setTimeout(() => { if (!document.hidden) retry.current(); }, Math.max(0, WALLET_REREAD_MS - age())));
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [lastSuccessAt, offered]);
  return lastSuccessAt !== null && agedOut !== lastSuccessAt && !stale;
}

/**
 * The one cash-out state machine. A retry reuses the original
 * clientRequestId, and every response is fenced to its vault session.
 */
export function useHashcoinRedeem(resource: HashcoinWalletResource, bank: PayoutAccountState | null) {
  const { data, token } = resource;
  // One stable object per vault session; every reply is fenced to the scope it was sent under.
  const scope = resource.scope as object;
  // A failed refresh keeps the last good wallet on screen; its actions wait.
  const sandboxEnabled = data?.payoutMode === "test" && data.testPayouts === true;
  const liveRedeemEnabled = data?.payoutMode === "live" && data.testPayouts === false && data.liveRedemptionEnabled === true;
  const mode = liveRedeemEnabled ? "live" : "test";
  const inFlight = useRef<typeof scope | null>(null);
  const intent = useRef<{ scope: typeof scope; id: string; amount: number; mode: "test" | "live" } | null>(null);
  const [busyScope, setBusyScope] = useState<typeof scope | null>(null);
  const [result, setResult] = useState<{ scope: typeof scope; value: HashcoinRedemption; base: typeof data } | null>(null);
  const [error, setError] = useState<{ scope: typeof scope; text: string } | null>(null);
  const last = result?.scope === scope && result.base === data ? result.value : data?.latestRedemption;
  const unsettled = last && ["pending", "unknown"].includes(last.status) ? last : null;
  const retryIntent = intent.current?.scope === scope && intent.current.mode === mode ? intent.current : null;
  const busy = busyScope === scope;
  const refreshing = result?.scope === scope && result.base === data && ["succeeded", "failed"].includes(result.value.status);
  const redeemAmount = data ? mode === "live" ? data.live.nextRedeemCoins ?? 0
    : Math.min(data.sandbox.availableCoins, data.maxRedeemCoins ?? 50000) : 0;
  // Only a new cash-out waits on the bank. Checking a sent transfer never does.
  const newRedemption = !retryIntent && !unsettled;
  const openTransferUnreadable = liveRedeemEnabled && data?.redeemBlocked === true;
  const cashOutBlocked = liveRedeemEnabled && newRedemption ? cashOutBlock(bank, openTransferUnreadable) : null;
  const held = data ? (mode === "live" ? data.live.held : data.sandbox.held) : false;
  // A new live redemption also waits for a wallet read under a minute old.
  const offered = liveRedeemEnabled && newRedemption && redeemAmount >= 1 && !cashOutBlocked && !held && !resource.failed;
  const fresh = useFreshWallet(resource, offered);

  const redeem = async () => {
    if ((!sandboxEnabled && !liveRedeemEnabled) || !token || !data || resource.failed ||
        (mode === "live" ? data.live.held : data.sandbox.held) || inFlight.current === scope) return;
    const pending = intent.current?.scope === scope && intent.current.mode === mode ? intent.current : null;
    if (!pending && !unsettled && cashOutBlocked) return;
    // An old balance is never redeemed; it is read again first.
    if (mode === "live" && !pending && !unsettled && !walletReadWithin(resource, Date.now())) {
      resource.retry();
      return;
    }
    const next = pending ?? (unsettled?.clientRequestId
      ? { scope, id: unsettled.clientRequestId, amount: unsettled.amountCoins, mode }
      : { scope, id: crypto.randomUUID(), amount: redeemAmount, mode });
    if (next.amount < 1 || (unsettled && !unsettled.clientRequestId && !pending)) return;
    intent.current = next;
    inFlight.current = scope;
    setBusyScope(scope);
    setError(null);
    const epoch = snapshotVaultSessionEpoch();
    const current = () => resource.isCurrent() && isVaultSessionEpochCurrent(epoch);
    try {
      const response = await (next.mode === "live" ? DocumentPayoutService.redeemLive(token, next.amount, next.id)
        : DocumentPayoutService.redeemTest(token, next.amount, next.id));
      if (!current()) return;
      setResult({ scope, value: response, base: data });
      if (["succeeded", "failed"].includes(response.status)) intent.current = null;
      // Payout readers only: the wallet, Activity and the Stripe balance.
      dispatchPayoutStateChanged({ kinds: ["wallet", "balance"], source: "local_redeem" });
    } catch (cause) {
      if (current()) {
        setError({ scope, text: redemptionError(cause, next.mode) });
        if (["HASHCOINS_INSUFFICIENT", "PAYOUT_ACCOUNT_REQUIRED", "REDEMPTION_SOURCE_UNAVAILABLE", "SANDBOX_FUNDS_UNAVAILABLE", "LIVE_FUNDS_UNAVAILABLE", "PAYOUT_FUNDS_UNAVAILABLE"].includes(apiErrorCode(cause) ?? "")) {
          intent.current = null;
          resource.retry();
          // The server saw a bank that isn't ready; the bank row re-reads it too.
          if (apiErrorCode(cause) === "PAYOUT_ACCOUNT_REQUIRED") dispatchPayoutStateChanged({ kinds: ["account"], source: "local_redeem" });
        }
      }
    } finally {
      if (inFlight.current === scope) inFlight.current = null;
      if (current()) setBusyScope(null);
    }
  };

  return {
    sandboxEnabled, liveRedeemEnabled, mode, last, unsettled, retryIntent, busy, refreshing, redeemAmount,
    newRedemption, openTransferUnreadable, cashOutBlocked, held, fresh,
    // Offered, and waiting only on the wallet read already asked for.
    awaitingWallet: offered && !fresh,
    error: error?.scope === scope ? error.text : null, redeem,
  };
}

/**
 * The one primary action on Payouts: the next ready earning, one paid request
 * at a time. Shown only when coins are ready or a sent transfer needs
 * checking; when blocked it keeps its place with one reason. Live mode only.
 */
export function RedeemAction({ wallet, redeem, "data-voice-control-id": voiceControlId }: {
  wallet: HashcoinWalletResource;
  redeem: HashcoinRedeem;
  /** The literal id stays where the root mounts this action (Search reads it there). */
  "data-voice-control-id": string;
}) {
  const { data } = wallet;
  const {
    busy, refreshing, newRedemption, redeemAmount, cashOutBlocked, unsettled, retryIntent, openTransferUnreadable,
    last, held, fresh, awaitingWallet,
  } = redeem;
  const [receipt, setReceipt] = useState<{ scope: unknown; id: string } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const shown = redeemAmount >= 1 || !newRedemption || busy || refreshing;
  const ready = data ? readyCoins(data.live) : 0;
  const reason = openTransferUnreadable ? cashOutBlocked
    : shown ? cashOutBlocked ?? (held ? "Balance under review." : null) : null;
  const scopeLine = !reason && newRedemption && redeemAmount >= 1 && ready > redeemAmount
    ? `${money(redeemAmount)} of ${money(ready)} ready · one paid request at a time` : null;
  const receiptId = receipt && receipt.scope === wallet.scope ? receipt.id : null;
  return <>
    {shown || reason || last || redeem.error ? <section aria-label="Redeem Hussh Coins" className="space-y-2">
      {shown ? <Button type="button" size="standard" data-voice-control-id={voiceControlId}
        disabled={busy || refreshing || wallet.failed || !data || data.live.held || (newRedemption && (redeemAmount < 1 || Boolean(cashOutBlocked) || !fresh)) || Boolean(unsettled && !unsettled.clientRequestId && !retryIntent)}
        onClick={() => void redeem.redeem()}>
        {busy ? "Sending…" : refreshing || awaitingWallet ? "Updating balance…" : !newRedemption ? "Check transfer" : `Redeem ${money(redeemAmount)}`}
      </Button> : null}
      {scopeLine ? <HelperText className="profile-account-note tabular-nums">{scopeLine}</HelperText> : null}
      {reason ? <div><HelperText role={openTransferUnreadable ? "status" : undefined} className="profile-account-note">{reason}</HelperText>
        {openTransferUnreadable && !isNative() ? <Button type="button" size="compact" variant="none" effect="fade" onClick={reloadWindow}>Reload</Button> : null}</div> : null}
      {last ? <div role="status">
        <button type="button" className="flex min-h-11 w-full items-center gap-1 text-left"
          onClick={(event) => { opener.current = event.currentTarget; setReceipt({ scope: wallet.scope, id: `redemption:${last.id}` }); }}>
          <HelperText as="span" className="profile-account-note min-w-0">{redemptionCopy(last)}</HelperText>
          <CaretRightIcon aria-hidden className="size-4 shrink-0 text-[color:var(--app-tertiary-label)]" />
        </button>
      </div> : null}
      {redeem.error ? <HelperText role="alert" className="profile-account-note">{redeem.error}</HelperText> : null}
    </section> : null}
    {/* Mounted while open, so a refresh that clears the status line never closes its receipt. */}
    <PayoutReceiptSheet itemId={receiptId} onOpenChange={(open) => {
      if (open) return;
      setReceipt(null);
      window.requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
    }} />
  </>;
}
