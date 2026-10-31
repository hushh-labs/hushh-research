"use client";

import { useEffect, useRef, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ChevronDown } from "@/components/icons";
import { ProfileSecondaryReceiptIcon } from "@/components/profile/profile-secondary-icons";
import { Button } from "@/lib/morphy-ux/button";
import { DocumentPayoutService, type DocumentEarningsResponse } from "@/lib/services/document-payout-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

import { earningStatus } from "./payout-copy";
import { money, shortDate } from "./payout-format";
import { usePayoutSnapshot } from "./use-payout-snapshot";

export function DocumentEarningsHistory() {
  const resource = usePayoutSnapshot(DocumentPayoutService.earnings);
  const { data, token, scope } = resource;
  const [pages, setPages] = useState<{ base: DocumentEarningsResponse; value: DocumentEarningsResponse } | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const base = useRef(data);
  const inFlight = useRef(false);
  useEffect(() => { base.current = data; inFlight.current = false; setMoreBusy(false); setMoreError(false); }, [data, scope]);
  const history = pages?.base === data ? pages.value : data;
  const more = async () => {
    if (!data || !token || !history?.nextCursor || inFlight.current) return;
    const first = data;
    const epoch = snapshotVaultSessionEpoch();
    inFlight.current = true;
    setMoreBusy(true);
    setMoreError(false);
    try {
      const next = await DocumentPayoutService.earnings(token, history.nextCursor);
      if (!resource.isCurrent() || !isVaultSessionEpochCurrent(epoch) || base.current !== first) return;
      const transactions = [...new Map([...history.transactions, ...next.transactions].map((item) => [item.requestId, item])).values()];
      setPages({ base: first, value: { ...next, transactions } });
    } catch {
      if (resource.isCurrent() && isVaultSessionEpochCurrent(epoch) && base.current === first) setMoreError(true);
    } finally {
      if (base.current === first) { inFlight.current = false; setMoreBusy(false); }
    }
  };
  if (!token) return null;
  return (
    <section aria-label="Document transactions" className="space-y-2">
      <SettingsGroup title="Transactions" density="compact">
        {history?.transactions.map((item) => (
          <details key={item.requestId} className="group">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
              <SettingsRow icon={ProfileSecondaryReceiptIcon} iconTone="capability" title={item.description}
                description={[item.stripeMode === "test" ? "Test payment" : item.stripeMode === "legacy" ? "Payment mode unconfirmed" : null,
                  earningStatus(item, history.stripeMode), shortDate(item.createdAt)].filter(Boolean).join(" · ")}
                trailing={<span className="flex shrink-0 items-center gap-2 tabular-nums">{item.status === "hashcoins_credited" && item.creditedCoins != null ? `${item.creditedCoins.toLocaleString()} coins` : money(item.netAmountCents)}<ChevronDown aria-hidden="true" className="size-4 text-muted-foreground group-open:rotate-180" /></span>} />
            </summary>
            <dl className="profile-account-details space-y-1 px-4 pb-3 text-sm">
              {([ ["Paid", item.grossAmountCents], ["Refund", item.refundAmountCents],
                ["Hushh (3%)", item.platformFeeCents], ["Stripe fees", item.processingFeeCents],
                ["Your earnings", item.netAmountCents],
                ...(item.reversedAmountCents ? [["Reversed", item.reversedAmountCents]] : []),
              ] as Array<[string, number | null]>).map(([label, cents]) => (
                <div key={label} className="flex justify-between gap-3"><dt data-consent-role="fact-label" className="text-muted-foreground">{label}</dt><dd data-consent-role="fact-value" className="tabular-nums">{money(cents)}</dd></div>
              ))}
              {item.expectedFiles !== null && item.confirmedFiles !== null ?
                <div className="flex justify-between gap-3"><dt data-consent-role="fact-label" className="text-muted-foreground">Files delivered</dt><dd data-consent-role="fact-value">{item.confirmedFiles} of {item.expectedFiles}</dd></div> : null}
            </dl>
          </details>
        ))}
        {resource.loading ? <HelperText role="status" className="p-4">Loading transactions…</HelperText> : null}
        {history?.transactions.length === 0 ? <HelperText className="p-4">No earnings yet.</HelperText> : null}
      </SettingsGroup>
      {resource.failed ? <div><HelperText role="alert">Couldn't load transactions.</HelperText>
        <Button data-consent-quiet-action="true" data-consent-role="compact-action" type="button" size="sm" effect="fade" variant="none" onClick={resource.retry}>Retry</Button></div> : null}
      {history?.nextCursor ? <Button data-consent-role="compact-action" type="button" size="sm" effect="fade" variant="none" disabled={moreBusy} onClick={() => void more()}>{moreBusy ? "Loading…" : "More transactions"}</Button> : null}
      {moreError ? <HelperText role="alert">Couldn't load more. Try again.</HelperText> : null}
      <HelperText className="profile-account-note">Stripe transfers and bank deposits update separately.</HelperText>
    </section>
  );
}
