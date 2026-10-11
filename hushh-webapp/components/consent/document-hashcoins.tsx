"use client";

import { useRef, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import { Button } from "@/lib/morphy-ux/button";
import { isNative } from "@/lib/capacitor/platform";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { apiErrorCode } from "@/lib/services/api-client";
import { DocumentPayoutService, type HashcoinRedemption } from "@/lib/services/document-payout-service";
import { reloadWindow } from "@/lib/utils/browser-navigation";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import {
  DocumentBankPayoutStatusCard, DocumentEarningsHistory, DocumentPayoutAccountCard, usePayoutSnapshot,
  type PayoutAccountState,
} from "./document-payout-account";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const coins = (value: number) => `${value.toLocaleString()} Hussh Coins`;
function redemptionError(error: unknown, mode: "test" | "live"): string {
  if (mode === "live") {
    switch (apiErrorCode(error)) {
      case "HASHCOINS_INSUFFICIENT": return "Balance changed. Try again.";
      case "HASHCOINS_HELD": return "Balance under review.";
      case "PAYOUT_ACCOUNT_REQUIRED": return "Finish bank setup, then try again.";
      case "REDEMPTION_SOURCE_UNAVAILABLE": return "Earning changed. Refresh and try again.";
      case "REDEMPTION_CONFLICT": return "This redemption needs review.";
      case "LIVE_FUNDS_UNAVAILABLE": case "PAYOUT_FUNDS_UNAVAILABLE": return "Payment funds are settling. Try again later.";
      default: return "Couldn't confirm the transfer. Check its status before retrying.";
    }
  }
  switch (apiErrorCode(error)) {
    case "HASHCOINS_INSUFFICIENT": return "Test balance changed. Try again.";
    case "HASHCOINS_HELD": return "Test balance is under review.";
    case "PAYOUT_ACCOUNT_REQUIRED": return "Link a test bank first.";
    case "SANDBOX_FUNDS_UNAVAILABLE": return "Stripe test funds are unavailable. Try again later.";
    case "REDEMPTION_CONFLICT": return "This test redemption needs review.";
    default: return "Couldn't confirm the test redemption. Retry to check its status.";
  }
}
function redemptionCopy(item: HashcoinRedemption): string {
  if (item.stripeMode === "live") {
    // A newer server state this build can't name is never presented as a refund.
    if (item.reversalStatus === "unrecognized") return "Transfer status updating.";
    if (item.reversalStatus === "due" || item.reversalStatus === "unknown") return "Refunded payment. Transfer recovery pending.";
    if (item.reversalStatus === "reversed") return "Refunded payment. Transfer reversed.";
    if (item.reversalStatus === "manual_review") return "Refund needs review.";
    switch (item.status) {
      case "succeeded": return "Sent to Stripe. Bank deposit follows your payout settings.";
      case "failed": return "Transfer failed. Coins are available again.";
      case "pending": return "Transfer pending.";
      case "unknown": return "Checking transfer. Coins are reserved.";
    }
  }
  switch (item.status) {
    case "succeeded": return "Sent to your test Stripe balance. No real money moved.";
    case "failed": return "Test redemption failed. Your test balance was released.";
    case "pending": return "Test redemption pending.";
    case "unknown": return "Checking test redemption. Your test balance is reserved.";
  }
}
/**
 * Why a new live cash-out can't start yet; null once the bank is ready. The
 * bank card below names the bank's state, so this only points to it. The
 * server checks again.
 */
function cashOutBlock(bank: PayoutAccountState | null, openTransferUnreadable: boolean): string | null {
  // This build couldn't read the open transfer; a newer one can.
  if (openTransferUnreadable) return isNative() ? "Checking a transfer. Update the app to see it." : "Checking a transfer. Coins stay reserved.";
  if (!bank || bank.loading) return "Checking your bank…";
  if (bank.failed || bank.stripeMode === "test") return "Bank check unavailable";
  const { account } = bank;
  if (!account) return "Link a bank below to cash out";
  if (account.ready) return null;
  return account.bankStatus === "unavailable" ? "Bank check unavailable" : "Fix your bank below to cash out";
}

/** Real earnings and simulated bank withdrawals never share a balance. */
export function DocumentHashcoinPayouts() {
  const resource = usePayoutSnapshot(DocumentPayoutService.hashcoins, { ignoreReadyEvent: true });
  const { data, token, scope } = resource;
  const [bank, setBank] = useState<PayoutAccountState | null>(null);
  // A failed refresh keeps the last good wallet on screen; its actions wait.
  const sandboxEnabled = data?.payoutMode === "test" && data.testPayouts === true;
  const liveRedeemEnabled = data?.payoutMode === "live" && data.testPayouts === false && data.liveRedemptionEnabled === true;
  const mode = liveRedeemEnabled ? "live" : "test";
  // This build can't read the wallet; a newer one can, so retrying won't help.
  const outdated = resource.error instanceof Error && resource.error.name === "PayoutContractError";
  const updateApp = outdated && isNative();
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

  const redeem = async () => {
    if ((!sandboxEnabled && !liveRedeemEnabled) || !token || !data || resource.failed ||
        (mode === "live" ? data.live.held : data.sandbox.held) || inFlight.current === scope) return;
    const pending = intent.current?.scope === scope && intent.current.mode === mode ? intent.current : null;
    if (!pending && !unsettled && cashOutBlocked) return;
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
      dispatchConsentStateChanged({ source: "hashcoins_redemption" });
    } catch (cause) {
      if (current()) {
        setError({ scope, text: redemptionError(cause, next.mode) });
        if (["HASHCOINS_INSUFFICIENT", "PAYOUT_ACCOUNT_REQUIRED", "REDEMPTION_SOURCE_UNAVAILABLE", "SANDBOX_FUNDS_UNAVAILABLE", "LIVE_FUNDS_UNAVAILABLE", "PAYOUT_FUNDS_UNAVAILABLE"].includes(apiErrorCode(cause) ?? "")) {
          intent.current = null;
          resource.retry();
          // The server saw a bank that isn't ready; the bank card re-reads it too.
          if (apiErrorCode(cause) === "PAYOUT_ACCOUNT_REQUIRED") dispatchConsentStateChanged({ source: "hashcoins_redemption" });
        }
      }
    } finally {
      if (inFlight.current === scope) inFlight.current = null;
      if (current()) setBusyScope(null);
    }
  };

  if (!token) return null;
  return <div className="space-y-4">
    <section aria-label="Hussh Coins" className="space-y-2">
      <SettingsGroup title="Hussh Coins" density="compact">
        <SettingsRow icon={ProfileAccountWalletIcon} iconTone="capability" title={data ? coins(data.live.balanceCoins) : "Hussh Coins"}
          description="100 Hussh Coins = $1" trailing={data ? <span className="tabular-nums">{money(data.live.amountCents)}</span> : undefined} />
      </SettingsGroup>
      <HelperText className="profile-account-note">Net earnings after Hushh and Stripe fees.</HelperText>
      {data?.live.held ? <HelperText role="status" className="profile-account-note">Balance under review.</HelperText> : null}
      {resource.loading ? <HelperText role="status">Loading Hussh Coins…</HelperText> : null}
      {resource.failed ? <div><HelperText role="alert">{data ? "Couldn't refresh." : "Couldn't load Hussh Coins."}{updateApp ? " Update the app." : ""}</HelperText>
        {updateApp ? null : <Button type="button" size="sm" variant="none" effect="fade" onClick={outdated ? reloadWindow : resource.retry}>
          {outdated ? "Reload" : data ? "Retry" : "Retry balance"}
        </Button>}</div> : null}
    </section>
    {liveRedeemEnabled ? <section aria-label="Cash out Hussh Coins" className="space-y-2">
      <SettingsGroup title="Cash out" density="compact">
        <SettingsRow icon={ProfileAccountWalletIcon} iconTone="capability" title="Transfer to Stripe"
          description={redeemAmount > 0 ? `${coins(redeemAmount)} ready` : "No earnings ready"}
          trailing={redeemAmount > 0 ? <span className="tabular-nums">{money(redeemAmount)}</span> : undefined} />
      </SettingsGroup>
      <Button type="button" size="sm" effect="fade" variant="none" data-voice-control-id="profile_payouts_redeem"
        disabled={busy || refreshing || resource.failed || !data || data.live.held || (newRedemption && (redeemAmount < 1 || Boolean(cashOutBlocked))) || Boolean(unsettled && !unsettled.clientRequestId && !retryIntent)}
        onClick={() => void redeem()}>
        {busy ? "Sending…" : refreshing ? "Updating balance…" : !newRedemption ? "Check transfer" : redeemAmount > 0 ? `Cash out ${money(redeemAmount)}` : "Cash out"}
      </Button>
      {cashOutBlocked && (redeemAmount > 0 || openTransferUnreadable) ? <div><HelperText role={openTransferUnreadable ? "status" : undefined} className="profile-account-note">{cashOutBlocked}</HelperText>
        {openTransferUnreadable && !isNative() ? <Button type="button" size="sm" variant="none" effect="fade" onClick={reloadWindow}>Reload</Button> : null}</div> : null}
      {redeemAmount > 0 ? <HelperText className="profile-account-note">One request at a time. Bank timing follows your Stripe settings.</HelperText> : null}
      {last ? <HelperText role="status">{redemptionCopy(last)}</HelperText> : null}
      {error?.scope === scope ? <HelperText role="alert">{error.text}</HelperText> : null}
      {data?.redemptionHistory?.length ? <SettingsGroup title="Transfers" density="compact">
        {data.redemptionHistory.map((item) => <SettingsRow key={item.id} icon={ProfileAccountWalletIcon} iconTone="capability"
          title={item.reversalStatus === "unrecognized" ? "Status updating" : item.reversalStatus === "reversed" ? "Transfer reversed" : item.reversalStatus === "manual_review" ? "Refund under review"
            : item.reversalStatus === "due" || item.reversalStatus === "unknown" ? "Recovery pending"
            : item.status === "succeeded" ? "Sent to Stripe" : item.status === "failed" ? "Transfer failed" : "Transfer pending"}
          description={item.createdAt ? new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined}
          trailing={<span className="tabular-nums">{money(item.amountCoins)}</span>} />)}
      </SettingsGroup> : null}
    </section> : null}
    {/* The bank card and deposits read their own mode, so a wallet failure never hides them. */}
    <DocumentPayoutAccountCard handleReturn showHistory={false} onAccountChange={setBank} />
    <DocumentBankPayoutStatusCard refreshOnFeedChange />
    <DocumentEarningsHistory />
    {sandboxEnabled ? <section aria-label="Payout sandbox" className="space-y-3">
      <SettingsGroup title="Payout sandbox" density="compact">
        <SettingsRow icon={ProfileAccountWalletIcon} iconTone="capability" title="Test balance"
          description={data ? coins(data.sandbox.availableCoins) : "Loading…"}
          trailing={data ? <span className="tabular-nums">{money(data.sandbox.availableCoins)}</span> : undefined} />
      </SettingsGroup>
      <HelperText className="profile-account-note">Your real Hussh Coins stay unchanged.</HelperText>
      <Button type="button" size="sm" effect="fade" variant="none" data-voice-control-id="profile_payouts_test_redeem"
        disabled={busy || refreshing || resource.failed || !data || data.sandbox.held || (!retryIntent && !unsettled && data.sandbox.availableCoins < 1) || Boolean(unsettled && !unsettled.clientRequestId && !retryIntent)}
        onClick={() => void redeem()}>
        {busy ? "Checking…" : refreshing ? "Updating balance…" : retryIntent || unsettled ? "Check test redemption" : `Test redeem ${money(redeemAmount)}`}
      </Button>
      {data?.sandbox.held ? <HelperText role="status">Test balance under review.</HelperText> : null}
      {last ? <HelperText role="status">{redemptionCopy(last)}</HelperText> : null}
      {error?.scope === scope ? <HelperText role="alert">{error.text}</HelperText> : null}
      {data?.redemptionHistory?.length ? <SettingsGroup title="Test redemptions" density="compact">
        {data.redemptionHistory.map((item) => <SettingsRow key={item.id} icon={ProfileAccountWalletIcon} iconTone="capability"
          title={item.status === "succeeded" ? "Test transfer completed" : item.status === "failed" ? "Test transfer failed" : "Test transfer pending"}
          description={item.createdAt ? new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined}
          trailing={<span className="tabular-nums">{money(item.amountCoins)}</span>} />)}
      </SettingsGroup> : null}
    </section> : null}
  </div>;
}
