"use client";

import { PersonProfileButton } from "@/components/connections/person-profile-button";

import { useEffect, useRef, useState } from "react";

import { Lock, ShieldCheck, ArrowUpRight } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useConsentActions } from "@/lib/consent/use-consent-actions";
import { consentEntryToPendingConsent, isInlineDecidableConsentEntry } from "@/lib/consent/owner-consent-request";
import { useVault } from "@/lib/vault/vault-context";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import styles from "./wallet-sharing.module.css";
import presentationStyles from "./wallet-connect-presentation.module.css";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import type { WalletDemoProfile } from "./wallet-demo-cards";
import { CONSENT_ACTION_COMPLETE_EVENT, CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { loadWalletSharing, walletSharingKind } from "@/lib/services/wallet-sharing-service";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";
import { WalletSharingHistory } from "./wallet-sharing-history";

export function expiryLabel(value: ConsentCenterEntry["expires_at"]): string {
  if (value == null) return "Check access duration in Manage";
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return "Check access duration in Manage";
  return date.getTime() <= Date.now() ? "Expired" : `Expires ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

type SharingState = { owner: string; requests: ConsentCenterEntry[]; grants: ConsentCenterEntry[]; incompleteRequests?: boolean; error: boolean };

export type WalletSharingProps = { cards?: WalletCardSummary[]; cardDetails?: boolean; profile?: WalletDemoProfile | null; active?: boolean; getHistoryContext?: (cardId: string) => CardShareContext | null; receivedHistory?: boolean };
export function useWalletSharingOwner({ cardDetails = false, active = true, getHistoryContext }: WalletSharingProps = {}) {
  const { user, userId } = useAuth();
  const { vaultKey } = useVault();
  const actions = useConsentActions({ userId });
  const [selection, setSelection] = useState<{ entry: ConsentCenterEntry; active: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [duration, setDuration] = useState(24);
  const [state, setState] = useState<SharingState | null>(null);
  const [revision, setRevision] = useState(0);

  const reviewTrigger = useRef<HTMLButtonElement | null>(null);
  const owner = userId;
  const current = state?.owner === owner ? state : null;

  useEffect(() => {
    if (!user || !userId) return;
    let cancelled = false;
    // Keep this owner's confirmed rows in place while refreshing in the background.
    setSelection(null);
    setConfirmRevoke(false);
    const deadline = window.setTimeout(() => {
      cancelled = true;
      setState({ owner: userId, requests: [], grants: [], error: true });
    }, 15_000);
    void user.getIdToken().then((idToken) => loadWalletSharing({
      userId, idToken, cancelled: () => cancelled,
    })).then((result) => {
      if (!cancelled) { window.clearTimeout(deadline); setState({ owner: userId, ...result, error: false }); }
    }).catch(() => {
      if (!cancelled) { window.clearTimeout(deadline); setState({ owner: userId, requests: [], grants: [], error: true }); }
    });
    return () => { cancelled = true; window.clearTimeout(deadline); };
  }, [user, userId, revision, cardDetails, getHistoryContext]);

  useEffect(() => {
    if (!active) { setSelection(null); setConfirmRevoke(false); }
  }, [active]);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, refresh);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    const interval = window.setInterval(visible, 60_000);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, refresh);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
      window.clearInterval(interval);
    };
  }, []);

  const open = (entry: ConsentCenterEntry, active: boolean) => {
    setConfirmRevoke(false);
    setSelection({ entry, active });
    setActionError(null);
    setDuration(24);
  };
  const mutate = async (kind: "approve" | "decline" | "revoke") => {
    if (!selection || !current || current.error || !vaultKey || busyRef.current) return;
    const entry = selection.entry;
    const id = entry.request_id || entry.id;
    if (kind === "revoke" && (!selection.active || !entry.request_id || !entry.scope)) return;
    if (kind !== "revoke" && !isInlineDecidableConsentEntry(entry)) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    const promise = kind === "approve"
      ? actions.handleApprove(consentEntryToPendingConsent(entry, duration), { quiet: true })
      : kind === "decline" ? actions.handleDeny(id, { quiet: true })
      : actions.handleRevoke(entry.scope!, entry.request_id!, { quiet: true });
    void morphyToast.promise(promise, {
      loading: kind === "approve" ? "Sharing securely…" : "Updating access…",
      success: kind === "approve" ? "Wallet access approved." : kind === "decline" ? "Request declined. Nothing shared." : "Sharing stopped.",
      error: "Could not update access. Please try again.",
    });
    try {
      await promise;
      setSelection(null);
      setConfirmRevoke(false);
      setRevision(value => value + 1);
    } catch {
      setActionError("Could not update access. Nothing is confirmed; please try again.");
    } finally { busyRef.current = false; setBusy(false); }
  };

  return { owner, current, selection, setSelection, busy, actionError, confirmRevoke, setConfirmRevoke, duration, setDuration, setRevision, vaultKey, open, mutate, reviewTrigger };
}

export function WalletSharing({ cardDetails = false, active = true, getHistoryContext, receivedHistory = true }: WalletSharingProps = {}) {
  const { owner, current, selection, setSelection, busy, actionError, confirmRevoke, setConfirmRevoke, duration, setDuration, setRevision, vaultKey, open, mutate, reviewTrigger } = useWalletSharingOwner({ cardDetails, active, getHistoryContext });
  const renderGroup = (title: string, entries: ConsentCenterEntry[], active: boolean) => (
    <section className="space-y-3" aria-label={title}>
      <h3 className="ui-text-section-title">{title} <span className="ml-1 text-sm font-normal text-muted-foreground">{current && !current.error ? entries.length : "—"}</span></h3>
      <div className={styles.group}>
        {!current || current.error ? <div className={styles.empty}><ShieldCheck aria-hidden="true" className="size-6 shrink-0 text-muted-foreground" /><p className="text-sm text-muted-foreground">{current?.error ? "Could not load shared access." : "Loading shared access…"}</p></div> : entries.length ? entries.map((entry) => {
          const details = walletSharingKind(entry) === "details";
          const name = entry.counterpart_label || "Requester";
          return <div key={entry.request_id || entry.id} className={styles.row}>
            <PersonProfileButton userId={["person", "investor", "ria"].includes(entry.counterpart_type) ? entry.counterpart_id : undefined} label={name} className={styles.avatar}>{name.slice(0, 1).toUpperCase()}</PersonProfileButton>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="break-words text-sm font-semibold">{name}</p>
              <p className="text-sm">{details ? "Card details" : "Card summary"}</p>
              {cardDetails ? <p className="text-xs text-muted-foreground">{expiryLabel(entry.expires_at).replace("Check access duration in Manage", "Access duration unavailable")}</p> : null}
            </div>
            {!cardDetails ? <Button variant="ghost" size="compact" className={`${presentationStyles.quietAction} shrink-0`} onClick={(event) => {
              reviewTrigger.current = event.currentTarget;
              open(entry, active);
            }}>{active ? "Manage" : "Review"}<ArrowUpRight aria-hidden="true" className="size-4" /></Button> : null}
          </div>;
        }) : <div className={styles.empty}><p className="text-sm text-muted-foreground">Not shared with anyone yet.</p></div>}

      </div>
    </section>
  );

  return <div className={`${styles.content} ${presentationStyles.walletSurface} mx-auto w-full max-w-[820px] space-y-6 pb-4`} data-testid="wallet-sharing-content">
    {cardDetails ? <p className="text-xs text-muted-foreground">These recipients have Wallet-wide access, including this card.</p> : null}
    {!current ? <p role="status" className="text-sm text-muted-foreground">Loading shared access…</p> : current.error ? <div role="alert" className="space-y-3 rounded-2xl border border-border p-5"><p className="text-sm">Couldn&apos;t load shared access.</p><Button variant="secondary" size="compact" className={presentationStyles.quietAction} onClick={() => setRevision(value => value + 1)}>Try again</Button></div> : renderGroup(cardDetails ? "Wallet access" : "Wallet-wide access", current.grants, true)}
    {!cardDetails && owner && getHistoryContext ? <>
      <WalletSharingHistory ownerId={owner} active={active} getContext={getHistoryContext} />
      {receivedHistory ? <WalletSharingHistory ownerId={owner} active={active} getContext={getHistoryContext} direction="received" /> : null}
    </> : null}
    <Dialog modal open={Boolean(selection && current && !current.error)} onOpenChange={value => { if (!value && !busy) setSelection(null); }}>
      <DialogContent className={`${presentationStyles.walletDialog} max-h-[85dvh] overflow-y-auto sm:max-w-[420px]`} onCloseAutoFocus={event => { event.preventDefault(); reviewTrigger.current?.focus({ preventScroll: true }); }}>
        <DialogHeader><DialogTitle>{selection?.active ? "Manage access" : "Review request"}</DialogTitle><DialogDescription>{selection?.active ? "See what is shared and stay in control." : "Check every detail before sharing."}</DialogDescription></DialogHeader>
        {selection ? <div className="space-y-5">
          <div className={styles.accessCard}><ShieldCheck aria-hidden="true" className="size-6" /><p>{walletSharingKind(selection.entry) === "details" ? "Full card details" : "Card summary"}</p><span>WALLET ACCESS</span></div>
          <dl className={styles.facts}>
            <div><dt>{selection.active ? "Shared with" : "Requested by"}</dt><dd>{selection.entry.counterpart_label || "Requester"}</dd></div>
            <div><dt>What is included</dt><dd>{walletSharingKind(selection.entry) === "details" ? "Card numbers and cardholder names. Saved security codes are not shared." : "Network, last four digits, expiry, nickname and issuing region."}</dd></div>
            <div><dt>Which cards</dt><dd>Wallet-wide access. This permission is not limited to one card.</dd></div>
            {selection.entry.reason ? <div><dt>Reason</dt><dd>{selection.entry.reason}</dd></div> : null}
            {selection.active ? <><div><dt>Status</dt><dd>{selection.entry.status}</dd></div><div><dt>Access expires</dt><dd>{expiryLabel(selection.entry.expires_at)}</dd></div></> : null}
          </dl>
          {!selection.active ? <label className="block space-y-2 text-[15px] leading-[22px] font-[550]">Access duration<select className={styles.duration} value={duration} disabled={busy} onChange={event => setDuration(Number(event.target.value))}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></label> : null}
          {walletSharingKind(selection.entry) === "details" ? <p className={styles.warning}><Lock aria-hidden="true" className="size-4 shrink-0" />Full card details are sensitive. Approve only if you trust this requester.</p> : null}
          {!vaultKey ? <p role="status" className="text-[13px] leading-[18px]">Unlock your Wallet before changing access.</p> : null}
          {actionError ? <p role="alert" className="text-[13px] leading-[18px] text-destructive">{actionError}</p> : null}
          {selection.active ? <Button variant="destructive" size="compact" className={`w-full ${presentationStyles.modalAction}`} disabled={busy || !vaultKey || !selection.entry.request_id || !selection.entry.scope} onClick={() => setConfirmRevoke(true)}>Revoke access</Button> : <div className="grid grid-cols-2 gap-3"><Button variant="secondary" size="compact" className={presentationStyles.modalAction} disabled={busy || !vaultKey || !isInlineDecidableConsentEntry(selection.entry)} onClick={() => void mutate("decline")}>Decline</Button><Button size="compact" className={presentationStyles.modalAction} disabled={busy || !vaultKey || !isInlineDecidableConsentEntry(selection.entry)} onClick={() => void mutate("approve")}>{busy ? "Updating…" : "Approve"}</Button></div>}
        </div> : null}
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmRevoke && Boolean(selection)} onOpenChange={value => { if (!busy) setConfirmRevoke(value); }}><AlertDialogContent className={presentationStyles.walletDialog}><AlertDialogHeader><AlertDialogTitle>Stop sharing Wallet access?</AlertDialogTitle><AlertDialogDescription>This revokes this recipient’s selected permission. Information they previously received cannot be taken back.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep sharing</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void mutate("revoke"); }}>Revoke access</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
