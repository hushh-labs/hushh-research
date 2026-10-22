"use client";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import { Button } from "@/lib/morphy-ux/button";

import { coins, money } from "./payout-format";
import type { HashcoinRedeem, HashcoinWalletResource } from "./redeem-action";
import { redemptionCopy } from "./redemption-copy";

/** Test mode only: simulated redemptions that never touch real Hussh Coins. */
export function PayoutSandbox({ wallet, redeem, "data-voice-control-id": voiceControlId }: {
  wallet: HashcoinWalletResource;
  redeem: HashcoinRedeem;
  /** The literal id stays where the root mounts the sandbox (Search reads it there). */
  "data-voice-control-id": string;
}) {
  const { data } = wallet;
  const { busy, refreshing, unsettled, retryIntent, redeemAmount, last } = redeem;
  const available = data?.sandbox.availableCoins ?? 0;
  // Like Redeem: shown only with something to redeem or a test transfer to check.
  const shown = redeemAmount >= 1 || Boolean(retryIntent || unsettled) || busy || refreshing;
  return <section aria-label="Payout sandbox" className="space-y-3">
    <SettingsGroup title="Payout sandbox" description="Your real Hussh Coins stay unchanged." density="compact">
      <SettingsRow icon={ProfileAccountWalletIcon} iconTone="capability" title="Test balance"
        description={data ? coins(available) : "Loading…"}
        trailing={available > 0 ? <span className="tabular-nums">{money(available)}</span> : undefined} />
    </SettingsGroup>
    {shown ? <Button type="button" size="compact" effect="fade" variant="none" data-voice-control-id={voiceControlId}
      disabled={busy || refreshing || wallet.failed || !data || data.sandbox.held || (!retryIntent && !unsettled && data.sandbox.availableCoins < 1) || Boolean(unsettled && !unsettled.clientRequestId && !retryIntent)}
      onClick={() => void redeem.redeem()}>
      {busy ? "Checking…" : refreshing ? "Updating balance…" : retryIntent || unsettled ? "Check test redemption" : `Test redeem ${money(redeemAmount)}`}
    </Button> : null}
    {data?.sandbox.held ? <HelperText role="status" className="profile-account-note">Test balance under review.</HelperText> : null}
    {last ? <HelperText role="status" className="profile-account-note">{redemptionCopy(last)}</HelperText> : null}
    {redeem.error ? <HelperText role="alert" className="profile-account-note">{redeem.error}</HelperText> : null}
    {data?.redemptionHistory?.length ? <SettingsGroup title="Test redemptions" density="compact">
      {data.redemptionHistory.map((item) => <SettingsRow key={item.id} icon={ProfileAccountWalletIcon} iconTone="capability"
        title={item.status === "succeeded" ? "Test transfer completed" : item.status === "failed" ? "Test transfer failed" : "Test transfer pending"}
        description={item.createdAt ? new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined}
        trailing={<span className="tabular-nums">{money(item.amountCoins)}</span>} />)}
    </SettingsGroup> : null}
  </section>;
}
