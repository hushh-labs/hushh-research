"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ChevronDown } from "@/components/icons";
import { ProfileAccountBankIcon } from "@/components/profile/profile-your-account-icons";
import { ProfileInnerReviewIcon } from "@/components/profile/profile-inner-icons";
import { ProfileSecondaryReceiptIcon } from "@/components/profile/profile-secondary-icons";
import { Button } from "@/lib/morphy-ux/button";
import { CONSENT_STATE_CHANGED_EVENT, dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { apiErrorCode } from "@/lib/services/api-client";
import {
  DocumentPayoutService,
  documentPayoutLinkUrl,
  type DocumentBankPayout,
  type DocumentEarning,
  type DocumentEarningsResponse,
} from "@/lib/services/document-payout-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

const PAYOUT_READY_SOURCE = "document_payout_ready";
const money = (cents: number | null) => cents === null ? "Calculating" : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(cents / 100);
const shortDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function payoutErrorCopy(error: unknown, fallback: string): string {
  switch (apiErrorCode(error)) {
    case "PAYOUT_PLATFORM_SETUP_REQUIRED": return "Bank setup is unavailable. Hushh needs to activate payouts.";
    case "PAYOUT_ACCOUNT_DISABLED": return "Your payout account needs support.";
    default: return fallback;
  }
}

/** Coalesces live invalidations and fences every response to its vault session. */
function usePayoutSnapshot<T>(load: (token: string) => Promise<T>, {
  active = true, refreshKey = "", bankOnly = false, refreshOnFeedChange = true, ignoreReadyEvent = false,
}: { active?: boolean; refreshKey?: string; bankOnly?: boolean; refreshOnFeedChange?: boolean; ignoreReadyEvent?: boolean } = {}) {
  const { vaultOwnerToken } = useVault();
  const scope = useMemo(() => ({ token: vaultOwnerToken, active }), [vaultOwnerToken, active]);
  const liveScope = useRef<typeof scope | null>(null);
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; value: T } | null>(null);
  const [error, setError] = useState<{ scope: typeof scope; cause: unknown } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    liveScope.current = scope;
    if (!active || !vaultOwnerToken) return;
    const epoch = snapshotVaultSessionEpoch();
    let cancelled = false;
    let pending = false;
    let queued = false;
    const current = () => !cancelled && isVaultSessionEpochCurrent(epoch);
    const refresh = async () => {
      if (!current()) return;
      if (pending) { queued = true; return; }
      pending = true;
      try {
        const value = await load(vaultOwnerToken);
        if (current()) { setSnapshot({ scope, value }); setError(null); }
      } catch (cause) {
        if (current()) setError({ scope, cause });
      } finally {
        pending = false;
        if (queued && current()) { queued = false; void refresh(); }
      }
    };
    void refresh();
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; requestId?: string }>).detail;
      if ((ignoreReadyEvent && detail?.source === PAYOUT_READY_SOURCE) || (bankOnly && detail?.requestId)) return;
      void refresh();
    };
    const onFocus = () => { if (!document.hidden) void refresh(); };
    if (refreshOnFeedChange) window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onChange);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      liveScope.current = null;
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onChange);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [active, vaultOwnerToken, scope, load, refreshKey, retry, bankOnly, refreshOnFeedChange, ignoreReadyEvent]);
  const data = snapshot?.scope === scope ? snapshot.value : null;
  return { data, failed: error?.scope === scope, loading: data === null && error?.scope !== scope,
    error: error?.scope === scope ? error.cause : null,
    token: vaultOwnerToken, scope,
    isCurrent: () => liveScope.current === scope,
    retry: () => setRetry((value) => value + 1) };
}

/** One Connect account serves packet and document earnings; each keeps its ledger. */
export function DocumentPayoutAccountCard({ active = true, compact = false, handleReturn = false, disabled = false }: {
  active?: boolean; compact?: boolean; handleReturn?: boolean; disabled?: boolean;
}) {
  const searchParams = useSearchParams();
  const returnState = handleReturn ? searchParams.get("documentPayouts") : null;
  const resource = usePayoutSnapshot(DocumentPayoutService.account, {
    active, refreshKey: returnState ?? "", bankOnly: true, ignoreReadyEvent: true,
  });
  const { data, token, scope } = resource;
  const account = data?.account ?? null;
  const ready = account?.ready === true;
  const [busyScope, setBusyScope] = useState<typeof scope | null>(null);
  const [actionError, setActionError] = useState<{ scope: typeof scope; text: string } | null>(null);
  const inFlight = useRef<typeof scope | null>(null);
  const refreshed = useRef<typeof scope | null>(null);
  const announced = useRef<{ scope: typeof scope; ready: boolean } | null>(null);
  const currentScope = useRef<typeof scope | null>(null);
  useEffect(() => {
    currentScope.current = scope;
    return () => { currentScope.current = null; };
  }, [scope]);
  useEffect(() => {
    if (!data) return;
    const wasReady = announced.current?.scope === scope && announced.current.ready;
    announced.current = { scope, ready };
    if (ready && !wasReady) dispatchConsentStateChanged({ source: PAYOUT_READY_SOURCE });
  }, [data, scope, ready]);
  const start = useCallback(async (manage = false) => {
    if (!token || !active || disabled || inFlight.current === scope) return;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => currentScope.current === scope && isVaultSessionEpochCurrent(epoch);
    inFlight.current = scope;
    setBusyScope(scope);
    setActionError(null);
    try {
      const { url } = await (manage ? DocumentPayoutService.manage(token) : DocumentPayoutService.onboard(token));
      if (!current()) return;
      window.location.assign(documentPayoutLinkUrl(url, manage ? "management" : "onboarding"));
    } catch (error) {
      if (current()) setActionError({ scope, text: payoutErrorCopy(error, "Couldn't open bank setup. Try again.") });
    } finally {
      if (inFlight.current === scope) inFlight.current = null;
      if (current()) setBusyScope(null);
    }
  }, [token, active, disabled, scope]);
  useEffect(() => {
    if (!active || returnState !== "refresh" || !token || refreshed.current === scope) return;
    refreshed.current = scope;
    void start();
  }, [active, returnState, start, token, scope]);
  if (!active || !token) return null;
  const busy = busyScope === scope;
  const canManage = Boolean(account?.detailsSubmitted && (account.canManageBank ?? ready));
  const retryBankCheck = resource.failed && !canManage;
  const bankCheckUnavailable = account?.bankStatus === "unavailable";
  const label = canManage ? "Manage bank" : account ? "Finish setup" : "Link bank";
  const bankLabel = account?.bank
    ? [account.bank.name || "Bank", account.bank.last4 ? `•••• ${account.bank.last4}` : null].filter(Boolean).join(" ")
    : null;
  const description = resource.failed ? "Bank status unavailable"
    : account?.bankStatus === "needs_attention" ? "Update your bank"
    : account?.bankStatus === "missing" ? "Bank needed"
    : bankCheckUnavailable ? "Bank check unavailable"
    : account?.status === "restricted" ? "Verification needed"
    : bankLabel || (data?.stripeMode === "test" ? "Test payouts" : "US payouts");
  return (
    <section aria-label="Document payouts" className="space-y-4">
      <SettingsGroup title={compact ? undefined : "Bank account"} embedded={compact} density="compact">
        <SettingsRow icon={ProfileAccountBankIcon} iconTone="capability"
          title={ready && !resource.failed ? "Bank linked" : "Payout bank"} description={description}
          ariaLabel={retryBankCheck ? "Retry bank check" : label} chevron disabled={busy || disabled || resource.loading}
          onClick={retryBankCheck ? resource.retry : () => void start(canManage)}
          trailing={<span className="profile-account-inline-action" role={resource.loading ? "status" : undefined}>
            {resource.loading ? "Checking…" : busy ? "Opening…" : retryBankCheck ? "Retry" : label}
          </span>} />
        {canManage && !ready && !bankCheckUnavailable && account?.bankStatus !== "missing" && account?.bankStatus !== "needs_attention" ? (
          <SettingsRow icon={ProfileInnerReviewIcon} iconTone="capability" title="Verify details"
            description="Finish setup to receive payouts." chevron disabled={busy || disabled || resource.failed}
            onClick={() => void start()} />
        ) : null}
      </SettingsGroup>
      {bankCheckUnavailable && !resource.failed ? <Button type="button" size="sm" effect="fade" variant="none"
        disabled={busy || disabled} onClick={resource.retry}>Retry</Button> : null}
      {canManage && !compact ? <HelperText className="profile-account-note">Manage banks in Stripe. Replace your payout bank before removing it.</HelperText> : null}
      {resource.failed ? <div><HelperText role="alert" className="profile-account-note">{payoutErrorCopy(resource.error, "Couldn't check your bank. Try again.")}</HelperText>
        {canManage ? <Button type="button" size="sm" effect="fade" variant="none" onClick={resource.retry}>Retry</Button> : null}</div> : null}
      {actionError?.scope === scope ? <HelperText role="alert" className="profile-account-note">{actionError.text}</HelperText> : null}
      {!compact ? <DocumentEarningsHistory /> : null}
    </section>
  );
}

function earningStatus(item: DocumentEarning, activeMode?: "test" | "live"): string {
  if (item.stripeMode === "legacy") return "Under review";
  if (item.stripeMode === "test" && activeMode === "live") return "No bank deposit";
  switch (item.status) {
    case "awaiting_delivery": return "Awaiting delivery";
    case "awaiting_refund": return "Refund pending";
    case "awaiting_fee": return "Calculating fees";
    case "awaiting_account": return "Link bank to receive";
    case "due": case "dispatching": return "Transfer pending";
    case "transferred": return "Transferred to Stripe";
    case "reversal_due": case "reversal_unknown": return "Reversal pending";
    case "reversed": return "Reversed";
    case "void": return "No earnings";
    case "unknown": case "manual_review": return "Under review";
  }
}

function DocumentEarningsHistory() {
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
                trailing={<span className="flex shrink-0 items-center gap-2 tabular-nums">{money(item.netAmountCents)}<ChevronDown aria-hidden="true" className="size-4 text-muted-foreground group-open:rotate-180" /></span>} />
            </summary>
            <dl className="profile-account-details space-y-1 px-4 pb-3 text-sm">
              {([ ["Paid", item.grossAmountCents], ["Refund", item.refundAmountCents],
                ["Hushh (3%)", item.platformFeeCents], ["Stripe fees", item.processingFeeCents],
                ["Your earnings", item.netAmountCents],
                ...(item.reversedAmountCents ? [["Reversed", item.reversedAmountCents]] : []),
              ] as Array<[string, number | null]>).map(([label, cents]) => (
                <div key={label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{money(cents)}</dd></div>
              ))}
              {item.expectedFiles !== null && item.confirmedFiles !== null ?
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Files delivered</dt><dd>{item.confirmedFiles} of {item.expectedFiles}</dd></div> : null}
            </dl>
          </details>
        ))}
        {resource.loading ? <HelperText role="status" className="p-4">Loading transactions…</HelperText> : null}
        {history?.transactions.length === 0 ? <HelperText className="p-4">No earnings yet.</HelperText> : null}
      </SettingsGroup>
      {resource.failed ? <div><HelperText role="alert">Couldn't load transactions.</HelperText>
        <Button type="button" size="sm" effect="fade" variant="none" onClick={resource.retry}>Retry</Button></div> : null}
      {history?.nextCursor ? <Button type="button" size="sm" effect="fade" variant="none" disabled={moreBusy} onClick={() => void more()}>{moreBusy ? "Loading…" : "More transactions"}</Button> : null}
      {moreError ? <HelperText role="alert">Couldn't load more. Try again.</HelperText> : null}
      <HelperText className="profile-account-note">Stripe transfers and bank deposits update separately.</HelperText>
    </section>
  );
}

function bankPayoutCopy(payout: DocumentBankPayout): string {
  const amount = money(payout.amountCents);
  switch (payout.status) {
    case "pending": return `${amount} bank payout pending.`;
    case "in_transit": return `${amount} bank payout on its way.`;
    case "paid": return `${amount} bank payout paid.`;
    case "canceled": return `${amount} bank payout canceled.`;
    case "failed": return `${amount} bank payout failed. Check your linked bank details.`;
  }
}

/** Stripe's aggregate bank payout is separate from a document transfer. */
export function DocumentBankPayoutStatusCard({ compact = false, refreshOnFeedChange = false, onVisibleChange }: {
  compact?: boolean; refreshOnFeedChange?: boolean; onVisibleChange?: (visible: boolean) => void;
}) {
  const resource = usePayoutSnapshot(DocumentPayoutService.bankPayouts, { bankOnly: true, refreshOnFeedChange });
  const payouts = resource.data?.payouts;
  const latest = payouts?.[0] ?? null;
  useEffect(() => { onVisibleChange?.(Boolean(latest)); }, [latest, onVisibleChange]);
  if (!resource.token || (compact && !latest)) return null;
  return (
    <section aria-label="Bank payout status" className={compact ? "rounded-xl border border-border/60 px-4 py-3" : "space-y-2"}>
      {compact ? <><p className="text-sm font-semibold">Bank payout</p>
        <HelperText className="mt-1">{bankPayoutCopy(latest!)}</HelperText></> :
        <SettingsGroup title="Bank deposits" density="compact">
          {payouts?.map((payout) => <SettingsRow key={payout.id} icon={ProfileAccountBankIcon} iconTone="capability"
            title={bankPayoutCopy(payout)}
            description={payout.expectedArrivalAt && ["pending", "in_transit"].includes(payout.status)
              ? `Expected ${shortDate(payout.expectedArrivalAt)}` : undefined} />)}
          {resource.loading ? <HelperText role="status" className="p-4">Loading deposits…</HelperText> : null}
          {payouts?.length === 0 ? <HelperText className="p-4">No bank deposits yet.</HelperText> : null}
        </SettingsGroup>}
      {resource.failed ? <HelperText role="alert">Couldn't check bank payouts right now.</HelperText> : null}
      {latest ? <HelperText className="profile-account-note">Bank payouts may combine earnings from multiple requests.</HelperText> : null}
    </section>
  );
}
