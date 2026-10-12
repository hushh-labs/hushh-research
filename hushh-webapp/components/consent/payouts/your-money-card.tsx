"use client";

import { useRef, useState, type ReactNode } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import { Button } from "@/lib/morphy-ux/button";
import { isNative } from "@/lib/capacitor/platform";
import type { HashcoinBalance } from "@/lib/services/document-payout-service";
import { reloadWindow } from "@/lib/utils/browser-navigation";

import { PayoutActivitySheet } from "./activity-sheet";
import { InStripeRow } from "./in-stripe-sheet";
import { coins, money } from "./payout-format";
import type { HashcoinWalletResource } from "./redeem-action";
import { readyCoins } from "./redemption-copy";

/** One short state for the coin row; the sheet it opens explains the rest. */
function coinSummary(live: HashcoinBalance, liveRedeemEnabled: boolean): string {
  if (live.held || (live.holds?.length ?? 0) > 0) return "Under review";
  if (!liveRedeemEnabled) return "100 Hussh Coins = $1";
  const ready = readyCoins(live);
  return ready > 0 ? `${money(ready)} ready to redeem` : "Nothing ready to redeem";
}

/**
 * "Your money": Hussh Coins, money already in Stripe, and the payout bank.
 * Each row reads its own source, so a wallet failure never hides the bank.
 * The coin row opens coin activity; nothing here moves money.
 */
export function YourMoneyCard({ wallet, liveRedeemEnabled, bankRows }: {
  wallet: HashcoinWalletResource & { loading: boolean; error: unknown };
  liveRedeemEnabled: boolean;
  /** PayoutBankRows: the one bank control, mounted by the Payouts root. */
  bankRows: ReactNode;
}) {
  const { data } = wallet;
  const card = useRef<HTMLElement>(null);
  const [coinsOpen, setCoinsOpen] = useState(false);
  // Mounted on first open, so coin activity is never read before the owner asks.
  const [coinsSeen, setCoinsSeen] = useState(false);
  // This build can't read the wallet; a newer one can, so retrying won't help.
  const outdated = wallet.error instanceof Error && wallet.error.name === "PayoutContractError";
  const updateApp = outdated && isNative();
  // Safari never focuses a tapped row, so focus goes back to it by hand.
  const refocus = (row: string) => window.requestAnimationFrame(() => {
    card.current?.querySelector<HTMLElement>(`[data-testid="${row}"] button`)?.focus({ preventScroll: true });
  });
  return <section ref={card} aria-label="Your money" className="space-y-2">
    <SettingsGroup title="Your money" density="compact">
      <SettingsRow testId="payout-coins-row" icon={ProfileAccountWalletIcon} iconTone="capability"
        title={data ? coins(data.live.balanceCoins) : "Hussh Coins"}
        description={data ? coinSummary(data.live, liveRedeemEnabled) : wallet.loading ? "Loading…" : undefined}
        trailing={data && data.live.amountCents !== 0 ? <span className="tabular-nums">{money(data.live.amountCents)}</span> : undefined}
        chevron onClick={() => { setCoinsSeen(true); setCoinsOpen(true); }} />
      <InStripeRow onClosed={() => refocus("payout-in-stripe-row")} />
      {bankRows}
    </SettingsGroup>
    {wallet.failed ? <div><HelperText role="alert" className="profile-account-note">{data ? "Couldn't refresh." : "Couldn't load Hussh Coins."}{updateApp ? " Update the app." : ""}</HelperText>
      {updateApp ? null : <Button type="button" size="compact" variant="none" effect="fade" onClick={outdated ? reloadWindow : wallet.retry}>
        {outdated ? "Reload" : data ? "Retry" : "Retry balance"}
      </Button>}</div> : null}
    {coinsSeen ? <PayoutActivitySheet open={coinsOpen} initialFilter="coins" onOpenChange={(open) => {
      setCoinsOpen(open);
      if (!open) refocus("payout-coins-row");
    }} /> : null}
  </section>;
}
