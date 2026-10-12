"use client";

import { useState } from "react";
import {
  AdaptiveDetailSurface, SettingsGroup, SettingsPresentationProvider, SettingsRow,
} from "@/components/app-ui/settings-ui";
import { ProfileInnerProgressIcon } from "@/components/profile/profile-inner-icons";
import { ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import accountStyles from "@/components/profile/profile-your-account.module.css";
import { usePayoutResource } from "@/lib/payouts/payout-live-store";
import { DocumentPayoutService, type DocumentPayoutBalance } from "@/lib/services/document-payout-service";

import { money } from "./payout-format";

const loadBalance = (token: string) => DocumentPayoutService.balance(token);

// Stripe dates funds by day at midnight UTC, so the day reads the same everywhere.
const availableDay = (value: string) => new Date(value).toLocaleDateString(undefined, {
  month: "short", day: "numeric", timeZone: "UTC",
});
const updatedAt = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
  .format(new Date(value));

/** Something to show: a live account with money in Stripe that isn't in the bank yet. */
function inStripe(balance: DocumentPayoutBalance | null): balance is DocumentPayoutBalance {
  return balance?.accountLinked === true && balance.stripeMode === "live" && balance.inStripeCents > 0;
}

/**
 * Money in the owner's Stripe balance that isn't in their bank yet: settling
 * funds and funds waiting for the next bank payout. A row inside "Your money";
 * hidden with no linked live account, nothing in Stripe, or no reading.
 */
export function InStripeRow({ onClosed }: { onClosed?: () => void }) {
  const { data } = usePayoutResource("balance", loadBalance);
  const [open, setOpen] = useState(false);
  const shown = inStripe(data);
  return <>
    {shown ? <SettingsRow testId="payout-in-stripe-row" icon={ProfileInnerProgressIcon} iconTone="capability" title="In Stripe"
      description={data.pendingCents > 0 ? data.nextAvailableOn ? `Settling · available ${availableDay(data.nextAvailableOn)}` : "Settling" : "Available"}
      trailing={<span className="tabular-nums">{money(data.inStripeCents)}</span>} chevron onClick={() => setOpen(true)} /> : null}
    {/* Stays mounted while open, so a refresh that hides the row never closes it. */}
    {data && (shown || open) ? <InStripeSheet balance={data} open={open && data.accountLinked} onOpenChange={(next) => {
      setOpen(next);
      if (!next) onClosed?.();
    }} /> : null}
  </>;
}

function InStripeSheet({ balance, open, onOpenChange }: {
  balance: DocumentPayoutBalance; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { availableCents, pendingCents, nextAvailableOn, nextAvailableCents } = balance;
  // Only part of what is settling may arrive first; name that part.
  const settling = !nextAvailableOn ? undefined
    : nextAvailableCents !== null && nextAvailableCents > 0 && nextAvailableCents < pendingCents
      ? `${money(nextAvailableCents)} available ${availableDay(nextAvailableOn)}`
      : `Available ${availableDay(nextAvailableOn)}`;
  return <AdaptiveDetailSurface open={open} onOpenChange={onOpenChange} title="In Stripe"
    description={`Updated ${updatedAt(balance.asOf)}`} mobilePresentation="sheet"
    desktopMaxWidthClassName="sm:!max-w-[520px]" surfaceClassName={accountStyles.walletContent}>
    <SettingsPresentationProvider density="compact" separatorInset>
      {/* Every non-zero part is shown, a negative one too, so the parts add up to the total. */}
      <SettingsGroup description="Stripe sends it to your bank on your payout schedule.">
        {availableCents !== 0 ? <SettingsRow icon={ProfileAccountWalletIcon} iconTone="capability" title="Available"
          trailing={<span className="tabular-nums">{money(availableCents)}</span>} /> : null}
        {pendingCents !== 0 ? <SettingsRow icon={ProfileInnerProgressIcon} iconTone="capability" title="Settling"
          description={pendingCents > 0 ? settling : undefined} trailing={<span className="tabular-nums">{money(pendingCents)}</span>} /> : null}
        {availableCents === 0 && pendingCents === 0 ? <SettingsRow icon={ProfileAccountWalletIcon} iconTone="capability"
          title="Nothing in Stripe right now" /> : null}
      </SettingsGroup>
    </SettingsPresentationProvider>
  </AdaptiveDetailSurface>;
}
