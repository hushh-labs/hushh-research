"use client";

import { useRef, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import { Button } from "@/lib/morphy-ux/button";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { apiErrorCode } from "@/lib/services/api-client";
import { DocumentPayoutService, type HashcoinRedemption } from "@/lib/services/document-payout-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import {
  DocumentBankPayoutStatusCard, DocumentEarningsHistory, DocumentPayoutAccountCard, usePayoutSnapshot,
} from "./document-payout-account";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const coins = (value: number) => `${value.toLocaleString()} Hussh Coins`;
function redemptionError(error: unknown): string {
  switch (apiErrorCode(error)) {
    case "HASHCOINS_INSUFFICIENT": return "Test balance changed. Try again.";
    case "HASHCOINS_HELD": return "Test balance is under review.";
    case "PAYOUT_ACCOUNT_REQUIRED": return "Link a test bank first.";
    case "SANDBOX_FUNDS_UNAVAILABLE": return "Stripe test funds are unavailable. Try again later.";
    case "REDEMPTION_CONFLICT": return "This test redemption needs review.";
    default: return "Couldn't confirm the test redemption. Retry to check its status.";
  }
}
function redemptionCopy(status: HashcoinRedemption["status"]): string {
  switch (status) {
    case "succeeded": return "Sent to your test Stripe balance. No real money moved.";
    case "failed": return "Test redemption failed. Your test balance was released.";
    case "pending": return "Test redemption pending.";
    case "unknown": return "Checking test redemption. Your test balance is reserved.";
  }
}

/** Real earnings and simulated bank withdrawals never share a balance. */
export function DocumentHashcoinPayouts() {
  const resource = usePayoutSnapshot(DocumentPayoutService.hashcoins);
  const { data, token, scope } = resource;
  const sandboxEnabled = !resource.failed && data?.payoutMode === "test" && data.testPayouts === true;
  const liveBankEnabled = !resource.failed && data?.payoutMode === "live" && data.testPayouts === false;
  const inFlight = useRef<typeof scope | null>(null);
  const intent = useRef<{ scope: typeof scope; id: string; amount: number } | null>(null);
  const [busyScope, setBusyScope] = useState<typeof scope | null>(null);
  const [result, setResult] = useState<{ scope: typeof scope; value: HashcoinRedemption; base: typeof data } | null>(null);
  const [error, setError] = useState<{ scope: typeof scope; text: string } | null>(null);
  const last = result?.scope === scope && result.base === data ? result.value : data?.latestRedemption;
  const unsettled = last && ["pending", "unknown"].includes(last.status) ? last : null;
  const retryIntent = intent.current?.scope === scope ? intent.current : null;
  const busy = busyScope === scope;
  const refreshing = result?.scope === scope && result.base === data && ["succeeded", "failed"].includes(result.value.status);
  const redeemAmount = data ? Math.min(data.sandbox.availableCoins, data.maxRedeemCoins ?? 50000) : 0;

  const redeem = async () => {
    if (!sandboxEnabled || !token || !data || data.sandbox.held || inFlight.current === scope) return;
    const pending = intent.current?.scope === scope ? intent.current : null;
    const next = pending ?? (unsettled?.clientRequestId
      ? { scope, id: unsettled.clientRequestId, amount: unsettled.amountCoins }
      : { scope, id: crypto.randomUUID(), amount: redeemAmount });
    if (next.amount < 1 || (unsettled && !unsettled.clientRequestId && !pending)) return;
    intent.current = next;
    inFlight.current = scope;
    setBusyScope(scope);
    setError(null);
    const epoch = snapshotVaultSessionEpoch();
    const current = () => resource.isCurrent() && isVaultSessionEpochCurrent(epoch);
    try {
      const response = await DocumentPayoutService.redeemTest(token, next.amount, next.id);
      if (!current()) return;
      setResult({ scope, value: response, base: data });
      if (["succeeded", "failed"].includes(response.status)) intent.current = null;
      dispatchConsentStateChanged({ source: "hashcoins_redemption" });
    } catch (cause) {
      if (current()) {
        setError({ scope, text: redemptionError(cause) });
        if (["HASHCOINS_INSUFFICIENT", "PAYOUT_ACCOUNT_REQUIRED", "SANDBOX_FUNDS_UNAVAILABLE"].includes(apiErrorCode(cause) ?? "")) {
          intent.current = null;
          resource.retry();
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
      <HelperText className="profile-account-note">Net earnings after fees. Cash redemption opens after payout verification.</HelperText>
      {data?.live.held ? <HelperText role="status" className="profile-account-note">Balance under review.</HelperText> : null}
      {resource.loading ? <HelperText role="status">Loading Hussh Coins…</HelperText> : null}
      {resource.failed ? <div><HelperText role="alert">Couldn't load Hussh Coins.</HelperText>
        <Button type="button" size="sm" variant="none" effect="fade" onClick={resource.retry}>Retry balance</Button></div> : null}
    </section>
    <DocumentEarningsHistory />
    {liveBankEnabled ? <>
      <DocumentPayoutAccountCard handleReturn showHistory={false} />
      <DocumentBankPayoutStatusCard refreshOnFeedChange />
    </> : null}
    {sandboxEnabled ? <section aria-label="Payout sandbox" className="space-y-3">
      <SettingsGroup title="Payout sandbox" density="compact">
        <SettingsRow icon={ProfileAccountWalletIcon} iconTone="capability" title="Test balance"
          description={data ? coins(data.sandbox.availableCoins) : "Loading…"}
          trailing={data ? <span className="tabular-nums">{money(data.sandbox.availableCoins)}</span> : undefined} />
      </SettingsGroup>
      <HelperText className="profile-account-note">Test bank linking and redemption. Your real Hussh Coins stay unchanged.</HelperText>
      <DocumentPayoutAccountCard handleReturn showHistory={false} />
      <Button type="button" size="sm" effect="fade" variant="none" data-voice-control-id="profile_payouts_test_redeem"
        disabled={busy || refreshing || resource.failed || !data || data.sandbox.held || (!retryIntent && !unsettled && data.sandbox.availableCoins < 1) || Boolean(unsettled && !unsettled.clientRequestId && !retryIntent)}
        onClick={() => void redeem()}>
        {busy ? "Checking…" : refreshing ? "Updating balance…" : retryIntent || unsettled ? "Check test redemption" : `Test redeem ${money(redeemAmount)}`}
      </Button>
      {data?.sandbox.held ? <HelperText role="status">Test balance under review.</HelperText> : null}
      {last ? <HelperText role="status">{redemptionCopy(last.status)}</HelperText> : null}
      {error?.scope === scope ? <HelperText role="alert">{error.text}</HelperText> : null}
      {data?.redemptionHistory?.length ? <SettingsGroup title="Test redemptions" density="compact">
        {data.redemptionHistory.map((item) => <SettingsRow key={item.id} icon={ProfileAccountWalletIcon} iconTone="capability"
          title={item.status === "succeeded" ? "Test transfer completed" : item.status === "failed" ? "Test transfer failed" : "Test transfer pending"}
          description={item.createdAt ? new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined}
          trailing={<span className="tabular-nums">{money(item.amountCoins)}</span>} />)}
      </SettingsGroup> : null}
      <DocumentBankPayoutStatusCard refreshOnFeedChange />
    </section> : null}
  </div>;
}
