"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
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
  type PayoutVerification,
} from "@/lib/services/document-payout-service";
import { getSessionItem, removeSessionItem, setSessionItem } from "@/lib/utils/session-storage";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { COMMERCE_RETURN_EVENT, openCommerceHostedUrl, openCommerceHostedWindow } from "@/lib/services/scope-commerce-browser";
import { parseCommerceReturn, type CommerceHostedSession } from "@/lib/services/scope-commerce-return";

import { DocumentEarningsHistory } from "./earnings-history";
import { payoutErrorCopy } from "./payout-copy";
import { shortDate } from "./payout-format";
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

// Stripe's return, a retry and a return to the page check Stripe itself, not
// the server's short display cache.
const loadFreshPayoutAccount = (token: string) => DocumentPayoutService.account(token, { fresh: true });

/** The card's last bank read, so a screen can gate on it without a second read. */
export type PayoutAccountState = {
  account: DocumentPayoutAccount | null; loading: boolean; failed: boolean; stripeMode?: "test" | "live";
};

/** Shared click guards for web rows, receipts and the native Profile scene. */
export function payoutBankActions(bank: ReturnType<typeof usePayoutBank>): PayoutBankActions {
  const manageBank = () => {
    if (bank.busyAction || bank.resource.loading) return;
    if (bank.retryBankCheck) bank.resource.retry();
    else void bank.start(!bank.expired && bank.canManage);
  };
  return { manageBank, verifyDetails: () => {
    const actionable = bank.account && verificationShown(bank.verification) && bank.verification.state !== "in_review";
    if (actionable && !bank.busyAction && !bank.resource.failed) void bank.start(false, "verify");
    else manageBank();
  } };
}

type BankAction = "bank" | "verify";

/** Stripe needs details now or soon; "none" means nothing to show. */
function verificationShown(verification: PayoutVerification | undefined): verification is PayoutVerification {
  return verification !== undefined && verification.state !== "none";
}

/** One short line for the Verify details row. */
export function verificationCopy(verification: PayoutVerification): string {
  switch (verification.state) {
    case "past_due": return "Overdue · payouts paused";
    case "in_review": return "In review";
    case "disabled": return "Payouts paused";
    default: return verification.deadline ? `Due ${shortDate(verification.deadline)}` : "Stripe needs more information";
  }
}

/**
 * The owner's payout bank: one account read, Stripe's return markers, and the
 * actions that open Stripe. Shared by the "Your money" rows and the
 * standalone card, so both read and act the same way.
 */
export function usePayoutBank({ active = true, handleReturn = false, disabled = false, onAccountChange }: {
  active?: boolean; handleReturn?: boolean; disabled?: boolean;
  onAccountChange?: (state: PayoutAccountState) => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const returnState = handleReturn ? searchParams.get("documentPayouts") : null;
  const arrival = handleReturn ? parseCommerceReturn(`${pathname}?${searchParams.toString()}`) : null;
  // Only the Payouts page's own `from` names where setup began; under the
  // pane, the query belongs to the screen beneath it.
  const origin = handleReturn && resolveProfileRouteState(pathname).panel === "payouts"
    ? normalizeInternalRouteHref(searchParams.get("from")) : null;
  // The store rereads the account on its payout doorbells (bank or
  // verification) with the cached read; only the owner's own actions skip it.
  const resource = usePayoutSnapshot(DocumentPayoutService.account, {
    active, refreshKey: arrival?.source === "documents" && !arrival.action ? "done" : returnState ?? "", bankOnly: true, ignoreReadyEvent: true,
    freshLoad: loadFreshPayoutAccount,
  });
  const { data, token, scope, loading, failed, retry } = resource;
  const [expiredHint, setExpiredHint] = useState<{ scope: typeof scope; epoch: ReturnType<typeof snapshotVaultSessionEpoch> } | null>(null);
  const expired = expiredHint?.scope === scope && isVaultSessionEpochCurrent(expiredHint.epoch);
  const setExpired = useCallback((value: boolean) => {
    setExpiredHint(value ? { scope, epoch: snapshotVaultSessionEpoch() } : null);
  }, [scope]);
  const lastReturnQuery = useRef("");
  const account = data?.account ?? null;
  const ready = account?.ready === true;
  const stripeMode = data?.stripeMode;
  useEffect(() => {
    onAccountChange?.({ account, loading, failed, stripeMode });
  }, [onAccountChange, account, loading, failed, stripeMode]);
  const [busy, setBusy] = useState<{ scope: typeof scope; action: BankAction } | null>(null);
  const [actionError, setActionError] = useState<{ scope: typeof scope; action: BankAction; text: string } | null>(null);
  const inFlight = useRef<typeof scope | null>(null);
  const refreshed = useRef<typeof scope | null>(null);
  const announced = useRef<{ scope: typeof scope; ready: boolean } | null>(null);
  const currentScope = useRef<typeof scope | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    currentScope.current = scope;
    const retire = () => { controller.current?.abort(); controller.current = null; setExpiredHint(null); };
    const unsubscribe = subscribeVaultSessionEpoch(retire);
    return () => { currentScope.current = null; unsubscribe(); retire(); };
  }, [scope]);
  useEffect(() => {
    const query = `${returnState ?? ""}:${arrival?.attemptId ?? ""}:${arrival?.action ?? ""}:${arrival?.source ?? ""}`;
    if (!token || query === lastReturnQuery.current) return;
    lastReturnQuery.current = query;
    setExpired(returnState === "refresh" || (arrival?.source === "documents" && arrival.action === "onboarding_refresh"));
  }, [token, returnState, arrival?.attemptId, arrival?.source, arrival?.action, setExpired]);
  useEffect(() => {
    const returned = (event: Event) => {
      const hint = (event as CustomEvent<{ source?: string; action?: string }>).detail;
      if (!active || hint?.source !== "documents") return;
      setExpired(hint.action === "onboarding_refresh");
      retry();
    };
    window.addEventListener(COMMERCE_RETURN_EVENT, returned);
    return () => window.removeEventListener(COMMERCE_RETURN_EVENT, returned);
  }, [active, retry, setExpired]);
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
  const start = useCallback(async (manage = false, purpose?: "verify") => {
    if (!token || !active || disabled || inFlight.current === scope) return;
    const action: BankAction = purpose === "verify" ? "verify" : "bank";
    // Stripe's bank settings never return here, so on the web they open in a
    // new tab and this one keeps its unlocked vault. Opened inside the click.
    const tab = manage ? (!isNative() ? window.open("about:blank", "_blank") : null) : openCommerceHostedWindow();
    if (!isNative() && !tab) {
      setActionError({ scope, action, text: "Allow pop-ups for One, then try again. Your unlocked session stays here." });
      return;
    }
    if (tab) tab.opener = null;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => currentScope.current === scope && isVaultSessionEpochCurrent(epoch);
    inFlight.current = scope;
    const pending = new AbortController();
    if (!manage) {
      pending.signal.addEventListener("abort", () => { try { tab?.close(); } catch { /* Browser owns the window. */ } }, { once: true });
      controller.current = pending;
    }
    setBusy({ scope, action });
    setActionError(null);
    try {
      const session: Awaited<ReturnType<typeof DocumentPayoutService.onboard>> = await (manage ? DocumentPayoutService.manage(token)
        : DocumentPayoutService.onboard(token, purpose, crypto.randomUUID()));
      const { url } = session;
      if (!current()) { tab?.close(); return; }
      const link = documentPayoutLinkUrl(url, manage ? "management" : "onboarding");
      // Only onboarding returns here. A retry after that return keeps the first origin.
      if (!manage && !returnState && refreshed.current !== scope) rememberPayoutReturn(origin);
      if (!manage) {
        if (!("returnUrl" in session) || !session.returnUrl || !session.attemptId || session.source !== "documents") {
          throw new Error("Payout setup return could not be verified. Refresh before continuing.");
        }
        setExpired(false);
        await openCommerceHostedUrl(session as CommerceHostedSession, "onboarding", tab, pending.signal);
        if (current() && !pending.signal.aborted) retry();
      } else if (tab) tab.location.replace(link);
      else {
        const { Browser } = await import("@capacitor/browser");
        if (current()) await Browser.open({ url: link });
      }
    } catch (error) {
      tab?.close();
      if (current()) setActionError({ scope, action, text: payoutErrorCopy(error, "Couldn't open bank setup. Try again.") });
    } finally {
      if (!manage) pending.abort();
      if (controller.current === pending) controller.current = null;
      if (inFlight.current === scope) inFlight.current = null;
      if (current()) setBusy(null);
    }
  }, [token, active, disabled, scope, returnState, origin, retry, setExpired]);
  const canManage = Boolean(account?.detailsSubmitted && (account.canManageBank ?? ready));
  const verification = account?.verification;
  return {
    resource, account, ready, stripeMode, canManage, verification, start,
    shown: active && Boolean(token),
    busyAction: busy?.scope === scope ? busy.action : null,
    actionError: actionError?.scope === scope ? actionError : null,
    retryBankCheck: resource.failed && !canManage,
    bankCheckUnavailable: account?.bankStatus === "unavailable",
    label: expired ? "Get a new payout setup link" : canManage ? "Manage bank" : account ? "Finish setup" : "Link bank",
    expired,
    bankLabel: account?.bank
      ? [account.bank.name || "Bank", account.bank.last4 ? `•••• ${account.bank.last4}` : null].filter(Boolean).join(" ")
      : null,
    // Payouts may still run while Stripe asks for details; never call that "Bank linked".
    linked: ready && !resource.failed && !["due", "past_due", "disabled"].includes(verification?.state ?? "none"),
  };
}

/** One Connect account serves packet and document earnings; each keeps its ledger. */
export function DocumentPayoutAccountCard({
  active = true, compact = false, handleReturn = false, disabled = false, showHistory = true, onAccountChange,
}: {
  active?: boolean; compact?: boolean; handleReturn?: boolean; disabled?: boolean; showHistory?: boolean;
  onAccountChange?: (state: PayoutAccountState) => void;
}) {
  const bank = usePayoutBank({ active, handleReturn, disabled, onAccountChange });
  if (!bank.shown) return null;
  const { resource, account, ready, stripeMode, canManage, retryBankCheck, bankCheckUnavailable, label, bankLabel } = bank;
  const busy = bank.busyAction !== null;
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
          title={bank.linked ? "Bank linked" : "Payout bank"} description={description}
          ariaLabel={retryBankCheck ? "Retry bank check" : label} chevron disabled={busy || disabled || resource.loading}
          onClick={retryBankCheck ? resource.retry : () => void bank.start(!bank.expired && canManage)}
          trailing={<span className="profile-account-inline-action" role={resource.loading ? "status" : undefined}>
            {resource.loading ? "Checking…" : busy ? "Opening…" : retryBankCheck ? "Retry" : label}
          </span>} />
        {canManage && !ready && !bankCheckUnavailable && account?.bankStatus !== "missing" && account?.bankStatus !== "needs_attention" ? (
          <SettingsRow icon={ProfileInnerReviewIcon} iconTone="capability" title="Verify details"
            description="Finish setup to receive payouts." chevron disabled={busy || disabled || resource.failed}
            onClick={() => void bank.start()} />
        ) : null}
      </SettingsGroup>
      {bankCheckUnavailable && !resource.failed ? <Button type="button" size="sm" effect="fade" variant="none"
        disabled={busy || disabled} onClick={resource.retry}>Retry</Button> : null}
      {canManage && !compact ? <HelperText className="profile-account-note">Change your bank in Stripe. Deposits go to the bank shown here.</HelperText> : null}
      {resource.failed ? <div><HelperText role="alert" className="profile-account-note">{payoutErrorCopy(resource.error, "Couldn't check your bank. Try again.")}</HelperText>
        {canManage ? <Button type="button" size="sm" effect="fade" variant="none" onClick={resource.retry}>Retry</Button> : null}</div> : null}
      {bank.actionError ? <HelperText role="alert" className="profile-account-note">{bank.actionError.text}</HelperText> : null}
      {!compact && showHistory ? <DocumentEarningsHistory /> : null}
    </section>
  );
}

/**
 * The bank rows' own actions, for another control on Payouts (a receipt's
 * next step). Each does what tapping its row does, with the same busy guard,
 * and shows any failure on that row.
 */
export type PayoutBankActions = {
  /** The bank row: Manage in Stripe (or finish setup, or re-check the bank). */
  manageBank: () => void;
  /** The Verify details row; the bank row while that row can't act. */
  verifyDetails: () => void;
};

/**
 * The payout bank as SettingsRows for use INSIDE a SettingsGroup ("Your
 * money"): the masked bank with an inline Manage, and "Verify details" while
 * Stripe needs more information. Mount it once per screen with handleReturn.
 */
export function PayoutBankRows({ handleReturn = false, onAccountChange, actionsRef }: {
  handleReturn?: boolean;
  onAccountChange?: (state: PayoutAccountState) => void;
  /** Filled with the rows' actions while they're mounted. */
  actionsRef?: Ref<PayoutBankActions>;
}) {
  const bank = usePayoutBank({ handleReturn, onAccountChange });
  const { resource, account, stripeMode, canManage, retryBankCheck, bankCheckUnavailable, label, bankLabel, verification } = bank;
  const busy = bank.busyAction !== null;
  const verify = account && verificationShown(verification) ? verification : null;
  // Nothing to do while Stripe reviews; the row only reports it.
  const canVerify = verify !== null && verify.state !== "in_review";
  const openBank = retryBankCheck ? resource.retry : () => void bank.start(!bank.expired && canManage);
  const openVerify = () => void bank.start(false, "verify");
  useImperativeHandle(actionsRef, () => payoutBankActions(bank));
  if (!bank.shown) return null;
  const failure = (action: BankAction): string | null =>
    bank.actionError?.action === action ? bank.actionError.text : null;
  // What needs the owner; routine lines stay out of the row's spoken name.
  const attention = failure("bank") ?? (resource.failed ? "Bank status unavailable"
    : account?.bankStatus === "needs_attention" ? "Update your bank"
    : account?.bankStatus === "missing" ? "Bank needed"
    : bankCheckUnavailable ? "Bank check unavailable"
    // The Verify details row names what Stripe needs when the server says.
    : account?.status === "restricted" && !verificationShown(verification) ? "Verification needed"
    : undefined);
  const description = attention ?? (bankLabel ? "Default for deposits"
    : resource.loading ? undefined
    : stripeMode === "test" ? "Test payouts" : "US payouts");
  // Read out once, outside the row's name.
  const announce = failure("bank") ?? (resource.failed
    ? payoutErrorCopy(resource.error, "Couldn't check your bank. Try again.") : null);
  // A failed check, or a bank list Stripe cut short, gets a fresh check. With
  // nothing to manage, the row is that check; otherwise the row keeps Manage,
  // since the fix may be in Stripe, and Retry sits beside it.
  const retryBeside = (resource.failed || bankCheckUnavailable) && !retryBankCheck;
  const alert = announce ? <span role="alert" className="sr-only">{announce}</span> : null;
  return <>
    <SettingsRow testId="payout-bank-row" icon={ProfileAccountBankIcon} iconTone="capability"
      title={bankLabel ?? "Payout bank"} description={description}
      ariaLabel={[retryBankCheck ? "Retry bank check" : label, bankLabel, attention].filter(Boolean).join(", ")}
      chevron disabled={busy || resource.loading}
      onClick={openBank}
      trailingInteractive={retryBeside}
      trailing={retryBeside ? <>{alert}
        <Button type="button" size="compact" variant="none" effect="fade" className="profile-account-inline-action"
          aria-label="Retry bank check" disabled={busy} onClick={resource.retry}>Retry</Button></>
        : <span className="profile-account-inline-action" role={resource.loading ? "status" : undefined}>
          {alert}{resource.loading ? "Checking…" : bank.busyAction === "bank" ? "Opening…" : retryBankCheck ? "Retry"
            : canManage ? "Manage" : label}
        </span>} />
    {verify ? <SettingsRow testId="payout-verify-row" icon={ProfileInnerReviewIcon} iconTone="capability"
      title="Verify details" description={failure("verify") ? <span role="alert">{failure("verify")}</span> : verificationCopy(verify)}
      chevron={canVerify} disabled={canVerify && (busy || resource.failed)}
      onClick={canVerify ? openVerify : undefined}
      trailing={bank.busyAction === "verify"
        ? <span className="profile-account-inline-action">Opening…</span> : undefined} /> : null}
  </>;
}
