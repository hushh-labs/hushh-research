"use client";

import { useRef, useState, type ReactNode } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileInnerReviewIcon } from "@/components/profile/profile-inner-icons";
import { ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import { Button } from "@/lib/morphy-ux/button";
import { isNative } from "@/lib/capacitor/platform";
import { holdNextStepCopy, holdReasonCopy } from "@/lib/payouts/review-copy";
import type { HashcoinBalance, HashcoinHold } from "@/lib/services/document-payout-service";
import { reloadWindow } from "@/lib/utils/browser-navigation";

import { PayoutActivitySheet } from "./activity-sheet";
import { InStripeRow } from "./in-stripe-sheet";
import type { PayoutAccountState } from "./payout-bank-row";
import { coins, money, shortDate } from "./payout-format";
import type { HashcoinWalletResource } from "./redeem-action";
import { readyCoins, readyCoinsWait } from "./redemption-copy";

/** One short state for the coin row; the review row and the sheet it opens explain the rest. */
export function coinSummary(live: HashcoinBalance, liveRedeemEnabled: boolean, bank: PayoutAccountState | null): string {
  const holds = live.holds?.length ?? 0;
  if (live.held || holds > 0) return holds > 1 ? `Under review · ${holds} items` : "Under review";
  if (!liveRedeemEnabled) return "100 Hussh Coins = $1";
  const ready = readyCoins(live);
  // Ready coins never read as ready while the bank or Stripe can't take them.
  return ready > 0 ? `${money(ready)} ${readyCoinsWait(bank) ?? "ready to redeem"}` : "Nothing ready to redeem";
}

/** The review to explain first: a balance below zero (or an unexplained hold) has no Activity item. */
export function firstHold(live: HashcoinBalance): HashcoinHold | null {
  return live.holds?.find((hold) => hold.id === "balance") ?? live.holds?.[0] ?? null;
}

export function holdDetail(hold: HashcoinHold): string {
  const about = hold.requestLabel ?? (hold.since ? `Since ${shortDate(hold.since)}` : null);
  return [about, holdNextStepCopy(hold.nextStep)].filter(Boolean).join(" · ");
}

/**
 * "Your money": Hussh Coins (and why any are under review), money already in
 * Stripe, and the payout bank.
 * Each row reads its own source, so a wallet failure never hides the bank.
 * The coin row opens coin activity; nothing here moves money.
 */
export function YourMoneyCard({ wallet, bank, liveRedeemEnabled, bankRows, freshness }: {
  wallet: HashcoinWalletResource & { loading: boolean; error: unknown };
  /** The bank rows' last read, so ready coins never read as ready when they can't go out. */
  bank: PayoutAccountState | null;
  liveRedeemEnabled: boolean;
  /** PayoutBankRows: the one bank control, mounted by the Payouts root. */
  bankRows: ReactNode;
  /** The screen's one freshness line; the wallet's own failure line stands in for it. */
  freshness?: ReactNode;
}) {
  const { data } = wallet;
  const hold = data ? firstHold(data.live) : null;
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
  return <section ref={card} aria-label="Document and answer earnings" className="space-y-2">
    <SettingsGroup title="Document/answer earnings" density="compact" description={wallet.failed ? undefined : freshness}>
      <SettingsRow testId="payout-coins-row" icon={ProfileAccountWalletIcon} iconTone="capability"
        title={data ? coins(data.live.balanceCoins) : "Hussh Coins"}
        description={data ? coinSummary(data.live, liveRedeemEnabled, bank) : wallet.loading ? "Loading…" : undefined}
        trailing={data && data.live.amountCents !== 0 ? <span className="tabular-nums">{money(data.live.amountCents)}</span> : undefined}
        chevron onClick={() => { setCoinsSeen(true); setCoinsOpen(true); }} />
      {hold ? <SettingsRow testId="payout-hold-row" icon={ProfileInnerReviewIcon} iconTone="capability"
        title={holdReasonCopy(hold.reason)} description={holdDetail(hold)}
        trailing={hold.coins > 0 ? <span className="tabular-nums">{money(hold.coins)}</span> : undefined} /> : null}
      <InStripeRow onClosed={() => refocus("payout-in-stripe-row")} />
      {bankRows}
    </SettingsGroup>
    {wallet.failed ? <div><HelperText role="alert" className="profile-account-note">{data ? "Couldn't refresh." : "Couldn't load Hussh Coins."}{updateApp ? " Update the app." : ""}</HelperText>
      {updateApp ? null : <Button data-consent-role="compact-action" type="button" size="compact" variant="none" effect="fade" onClick={outdated ? reloadWindow : wallet.retry}>
        {outdated ? "Reload" : data ? "Retry" : "Retry balance"}
      </Button>}</div> : null}
    {coinsSeen ? <PayoutActivitySheet open={coinsOpen} initialFilter="coins" onOpenChange={(open) => {
      setCoinsOpen(open);
      if (!open) refocus("payout-coins-row");
    }} /> : null}
  </section>;
}
