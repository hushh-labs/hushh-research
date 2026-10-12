"use client";

import { useEffect } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileAccountBankIcon } from "@/components/profile/profile-your-account-icons";
import { DocumentPayoutService } from "@/lib/services/document-payout-service";

import { bankPayoutCopy } from "./payout-copy";
import { shortDate } from "./payout-format";
import { usePayoutSnapshot } from "./use-payout-snapshot";

/** Stripe's aggregate bank payout is separate from a document transfer. */
export function DocumentBankPayoutStatusCard({ compact = false, refreshOnFeedChange = false, onVisibleChange }: {
  compact?: boolean; refreshOnFeedChange?: boolean; onVisibleChange?: (visible: boolean) => void;
}) {
  const resource = usePayoutSnapshot(DocumentPayoutService.bankPayouts, { bankOnly: true, refreshOnFeedChange, ignoreReadyEvent: true });
  const payouts = resource.data?.payouts;
  const test = resource.data?.stripeMode === "test";
  const latest = payouts?.[0] ?? null;
  useEffect(() => { onVisibleChange?.(Boolean(latest)); }, [latest, onVisibleChange]);
  if (!resource.token || (compact && !latest)) return null;
  return (
    <section aria-label="Bank payout status" className={compact ? "rounded-xl border border-border/60 px-4 py-3" : "space-y-2"}>
      {compact ? <><p className="text-sm font-semibold">Bank payout</p>
        <HelperText className="mt-1">{test ? "Test · " : ""}{bankPayoutCopy(latest!)}</HelperText></> :
        <SettingsGroup title={test ? "Test bank deposits" : "Bank deposits"} density="compact">
          {payouts?.map((payout) => <SettingsRow key={payout.id} icon={ProfileAccountBankIcon} iconTone="capability"
            title={`${test ? "Test · " : ""}${bankPayoutCopy(payout)}`}
            description={payout.expectedArrivalAt && ["pending", "in_transit"].includes(payout.status)
              ? `Expected ${shortDate(payout.expectedArrivalAt)}` : undefined} />)}
          {resource.loading ? <HelperText role="status" className="p-4">Loading deposits…</HelperText> : null}
          {payouts?.length === 0 ? <HelperText className="p-4">No bank deposits yet.</HelperText> : null}
        </SettingsGroup>}
      {resource.failed ? <HelperText role="alert">Couldn't check bank payouts right now.</HelperText> : null}
      {test ? <HelperText className="profile-account-note">Simulated deposits. No real money moves.</HelperText> : null}
      {latest ? <HelperText className="profile-account-note">Bank payouts may combine earnings from multiple requests.</HelperText> : null}
    </section>
  );
}
