"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileAccountBankIcon } from "@/components/profile/profile-your-account-icons";
import { ProfileInnerReviewIcon } from "@/components/profile/profile-inner-icons";
import { Button } from "@/lib/morphy-ux/button";
import { isNative } from "@/lib/capacitor/platform";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { resolveProfileRouteState } from "@/lib/navigation/profile-routes";
import { normalizeInternalRouteHref } from "@/lib/navigation/routes";
import {
  DocumentPayoutService,
  documentPayoutLinkUrl,
  type DocumentPayoutAccount,
} from "@/lib/services/document-payout-service";
import { getSessionItem, removeSessionItem, setSessionItem } from "@/lib/utils/session-storage";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

import { DocumentEarningsHistory } from "./earnings-history";
import { payoutErrorCopy } from "./payout-copy";
import { PAYOUT_READY_SOURCE, usePayoutSnapshot } from "./use-payout-snapshot";

// Stripe returns to a fixed Payouts URL, so the screen that sent the owner
// here is kept for this tab. The session helpers guard every storage access.
const PAYOUT_RETURN_KEY = "one_document_payout_return_v1";
const PAYOUT_RETURN_TTL_MS = 60 * 60 * 1000;
function rememberPayoutReturn(from: string | null): void {
  if (from) setSessionItem(PAYOUT_RETURN_KEY, JSON.stringify({ from, at: Date.now() }));
  else removeSessionItem(PAYOUT_RETURN_KEY);
}
function takePayoutReturn(): string | null {
  const raw = getSessionItem(PAYOUT_RETURN_KEY);
  removeSessionItem(PAYOUT_RETURN_KEY);
  try {
    const { from, at } = (JSON.parse(raw ?? "null") ?? {}) as { from?: unknown; at?: unknown };
    const age = typeof at === "number" ? Date.now() - at : NaN;
    return typeof from === "string" && age >= 0 && age < PAYOUT_RETURN_TTL_MS ? normalizeInternalRouteHref(from) : null;
  } catch {
    return null;
  }
}

/** The card's last bank read, so a screen can gate on it without a second read. */
export type PayoutAccountState = {
  account: DocumentPayoutAccount | null; loading: boolean; failed: boolean; stripeMode?: "test" | "live";
};

/** One Connect account serves packet and document earnings; each keeps its ledger. */
export function DocumentPayoutAccountCard({
  active = true, compact = false, handleReturn = false, disabled = false, showHistory = true, onAccountChange,
}: {
  active?: boolean; compact?: boolean; handleReturn?: boolean; disabled?: boolean; showHistory?: boolean;
  onAccountChange?: (state: PayoutAccountState) => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const returnState = handleReturn ? searchParams.get("documentPayouts") : null;
  // Only the Payouts page's own `from` names where setup began; under the
  // pane, the query belongs to the screen beneath it.
  const origin = handleReturn && resolveProfileRouteState(pathname).panel === "payouts"
    ? normalizeInternalRouteHref(searchParams.get("from")) : null;
  const resource = usePayoutSnapshot(DocumentPayoutService.account, {
    active, refreshKey: returnState ?? "", bankOnly: true, ignoreReadyEvent: true,
  });
  const { data, token, scope, loading, failed } = resource;
  const account = data?.account ?? null;
  const ready = account?.ready === true;
  const stripeMode = data?.stripeMode;
  useEffect(() => {
    onAccountChange?.({ account, loading, failed, stripeMode });
  }, [onAccountChange, account, loading, failed, stripeMode]);
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
  // Back to where setup began once the account first reads ready; until then
  // the owner stays here to see what is missing.
  useEffect(() => {
    if (returnState !== "done" || !ready) return;
    const from = takePayoutReturn();
    if (from) router.replace(from);
  }, [returnState, ready, router]);
  const start = useCallback(async (manage = false, expiredLink = false) => {
    if (!token || !active || disabled || inFlight.current === scope) return;
    // Stripe's bank settings never return here, so on the web they open in a
    // new tab and this one keeps its unlocked vault. Opened inside the click.
    const tab = manage && !isNative() ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => currentScope.current === scope && isVaultSessionEpochCurrent(epoch);
    inFlight.current = scope;
    setBusyScope(scope);
    setActionError(null);
    try {
      const { url } = await (manage ? DocumentPayoutService.manage(token) : DocumentPayoutService.onboard(token));
      if (!current()) { tab?.close(); return; }
      const link = documentPayoutLinkUrl(url, manage ? "management" : "onboarding");
      // Only onboarding returns here. A retry after that return keeps the first origin.
      if (!manage && !returnState && refreshed.current !== scope) rememberPayoutReturn(origin);
      if (tab) tab.location.replace(link);
      // The fresh link takes the expired one's place, so Back can't reopen it.
      else if (expiredLink) window.location.replace(link);
      else window.location.assign(link);
    } catch (error) {
      tab?.close();
      if (current()) setActionError({ scope, text: payoutErrorCopy(error, "Couldn't open bank setup. Try again.") });
    } finally {
      if (inFlight.current === scope) inFlight.current = null;
      if (current()) setBusyScope(null);
    }
  }, [token, active, disabled, scope, returnState, origin]);
  useEffect(() => {
    if (!active || returnState !== "refresh" || !token || refreshed.current === scope) return;
    refreshed.current = scope;
    // Drop Stripe's marker first, so returning to this page can't start setup again.
    const query = new URLSearchParams(searchParams.toString());
    query.delete("documentPayouts");
    const rest = query.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
    void start(false, true);
  }, [active, returnState, start, token, scope, searchParams, pathname, router]);
  if (!active || !token) return null;
  const busy = busyScope === scope;
  const canManage = Boolean(account?.detailsSubmitted && (account.canManageBank ?? ready));
  const retryBankCheck = resource.failed && !canManage;
  const bankCheckUnavailable = account?.bankStatus === "unavailable";
  const label = canManage ? "Manage bank" : account ? "Finish setup" : "Link bank";
  const bankLabel = account?.bank
    ? [account.bank.name || "Bank", account.bank.last4 ? `•••• ${account.bank.last4}` : null].filter(Boolean).join(" ")
    : null;
  // Stripe reports only the default bank, the one that receives deposits.
  const description = resource.failed ? "Bank status unavailable"
    : account?.bankStatus === "needs_attention" ? "Update your bank"
    : account?.bankStatus === "missing" ? "Bank needed"
    : bankCheckUnavailable ? "Bank check unavailable"
    : account?.status === "restricted" ? "Verification needed"
    : bankLabel ? `${bankLabel} · Default for deposits`
    : stripeMode === "test" ? "Test payouts" : "US payouts";
  return (
    <section aria-label="Document payouts" className="space-y-4">
      <SettingsGroup title={compact ? undefined : stripeMode === "test" ? "Test bank account" : "Bank account"} embedded={compact} density="compact">
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
      {canManage && !compact ? <HelperText className="profile-account-note">Change your bank in Stripe. Deposits go to the bank shown here.</HelperText> : null}
      {resource.failed ? <div><HelperText role="alert" className="profile-account-note">{payoutErrorCopy(resource.error, "Couldn't check your bank. Try again.")}</HelperText>
        {canManage ? <Button type="button" size="sm" effect="fade" variant="none" onClick={resource.retry}>Retry</Button> : null}</div> : null}
      {actionError?.scope === scope ? <HelperText role="alert" className="profile-account-note">{actionError.text}</HelperText> : null}
      {!compact && showHistory ? <DocumentEarningsHistory /> : null}
    </section>
  );
}

/**
 * CONTRACT (account-holds lane): the payout bank as SettingsRows for use
 * INSIDE a SettingsGroup ("Your money"): bank + last4 · Manage, and a
 * "Verify details" row when Stripe needs more information. This scaffold
 * renders the standalone card until that lane lands the row version.
 */
export function PayoutBankRows({ handleReturn = false, onAccountChange }: {
  handleReturn?: boolean;
  onAccountChange?: (state: PayoutAccountState) => void;
}) {
  return <DocumentPayoutAccountCard handleReturn={handleReturn} showHistory={false} onAccountChange={onAccountChange} />;
}
