"use client";

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
import { WALLET_DEMO_CARDS, WalletDemoCardFace } from "./wallet-demo-cards";
import { CONSENT_ACTION_COMPLETE_EVENT, CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { loadWalletSharing, walletSharingKind } from "@/lib/services/wallet-sharing-service";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

function expiryLabel(value: ConsentCenterEntry["expires_at"]): string {
  if (value == null) return "Check access duration in Manage";
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return "Check access duration in Manage";
  return date.getTime() <= Date.now() ? "Expired" : `Expires ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

type SharingState = { owner: string; requests: ConsentCenterEntry[]; grants: ConsentCenterEntry[]; incompleteRequests?: boolean; error: boolean };

export function WalletSharing() {
  const { user } = useAuth();
  const { vaultKey } = useVault();
  const actions = useConsentActions({ userId: user?.uid });
  const [selection, setSelection] = useState<{ entry: ConsentCenterEntry; active: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [duration, setDuration] = useState(24);
  const [state, setState] = useState<SharingState | null>(null);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState<"all" | "summary" | "details">("all");
  const [query, setQuery] = useState("");

  const reviewTrigger = useRef<HTMLButtonElement | null>(null);
  const owner = user?.uid;
  const current = state?.owner === owner ? state : null;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setState(null);
    setSelection(null);
    setConfirmRevoke(false);
    const deadline = window.setTimeout(() => {
      cancelled = true;
      setState({ owner: user.uid, requests: [], grants: [], error: true });
    }, 15_000);
    void user.getIdToken().then((idToken) => loadWalletSharing({
      userId: user.uid, idToken, cancelled: () => cancelled,
    })).then((result) => {
      if (!cancelled) { window.clearTimeout(deadline); setState({ owner: user.uid, ...result, error: false }); }
    }).catch(() => {
      if (!cancelled) { window.clearTimeout(deadline); setState({ owner: user.uid, requests: [], grants: [], error: true }); }
    });
    return () => { cancelled = true; window.clearTimeout(deadline); };
  }, [user, revision]);

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

  const matches = (entry: ConsentCenterEntry) =>
    (filter === "all" || walletSharingKind(entry) === filter) &&
    (entry.counterpart_label || "Requester").toLowerCase().includes(query.trim().toLowerCase());
  const renderGroup = (title: string, entries: ConsentCenterEntry[], active: boolean) => (
    <section className="space-y-3" aria-label={title}>
      <h3 className="text-xl font-semibold">{title} <span className="ml-1 text-sm font-normal text-muted-foreground">{current && !current.error ? entries.length : "—"}</span></h3>
      <div className={styles.group}>
        {!current || current.error ? <div className={styles.empty}><ShieldCheck aria-hidden="true" className="size-6 shrink-0 text-muted-foreground" /><p className="text-sm text-muted-foreground">{current?.error ? "Access status unavailable. Retry to load this section." : active ? "Checking existing access…" : "Checking incoming requests…"}</p></div> : entries.length ? entries.map((entry) => {
          const details = walletSharingKind(entry) === "details";
          const name = entry.counterpart_label || "Requester";
          return <div key={entry.request_id || entry.id} className={styles.row}>
            <div aria-hidden="true" className={styles.avatar}>{name.slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="break-words text-sm font-semibold">{name}</p>
              <p className="text-sm">{details ? "Card details" : "Card summary"}</p>
              <p className="text-xs text-muted-foreground">{active ? expiryLabel(entry.expires_at) : details ? "Sensitive information · Review required" : "Requested access to Wallet summaries"}</p>
            </div>
            <Button variant="ghost" size="compact" className="shrink-0" onClick={(event) => {
              reviewTrigger.current = event.currentTarget;
              open(entry, active);
            }}>{active ? "Manage" : "Review"}<ArrowUpRight aria-hidden="true" className="size-4" /></Button>
          </div>;
        }) : <div className={styles.empty}><div className={styles.cards} aria-hidden="true"><i /><i /><i><ShieldCheck /></i></div><div className="space-y-1">
          <p className="text-sm font-medium">{query || filter !== "all" ? "No matching permissions" : active ? "No active Wallet sharing" : current?.incompleteRequests ? "Some requests are still arriving" : "No Wallet requests"}</p>
          <p className="text-sm text-muted-foreground">{active ? "People with approved Wallet access will appear here." : "Review requests here before deciding what to share."}</p>
        </div></div>}
      </div>
    </section>
  );

  return <div className={`${styles.content} motion-step-enter mx-auto w-full max-w-[820px] space-y-6 py-4`} data-testid="wallet-sharing-content">
    <section className={styles.hero}>
      <div className={styles.heroTop}><span>WALLET SHARING</span><ShieldCheck aria-hidden="true" className="size-5" /></div>
      <h2>Your cards.<br />Your control.</h2>
      <p>You choose who can access your Wallet information.</p>
      <figure className={styles.heroCard}>
        <WalletDemoCardFace summary={WALLET_DEMO_CARDS[0]!} />
        <figcaption>Illustrative card · Your saved details stay private</figcaption>
      </figure>
    </section>
    <section className="space-y-3" aria-label="Sharing guide">
      <h3 className="text-xl font-semibold">What you can share</h3>
      <div className={styles.guide}>
        <details><summary><span className={styles.guideIcon}><ShieldCheck aria-hidden="true" className="size-5" /></span><span>Card summary<small>Everyday details, without the full number</small></span><span aria-hidden="true">+</span></summary><p>Includes network, last four digits, expiry, nickname and issuing region. Approval covers Wallet summaries, not just one selected card.</p></details>
        <details><summary><span className={styles.guideIcon}><Lock aria-hidden="true" className="size-5" /></span><span>Full card details<small>Sensitive access. Always review first.</small></span><span aria-hidden="true">+</span></summary><p>Includes full card numbers and saved security details across your Wallet. Review the requester and duration carefully. Approval requires your unlocked Wallet.</p></details>
      </div>
    </section>
    <section className="space-y-3" aria-label="Access controls">
      <div className="flex items-center justify-between gap-2"><h3 className="text-xl font-semibold">Your sharing activity</h3><Button size="compact" variant="ghost" disabled={!current || busy} onClick={() => setRevision(value => value + 1)}>Refresh access</Button></div>
      <label className="block text-sm"><span className="sr-only">Search recipients</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name" className={styles.duration} /></label>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter permissions">{(["all", "summary", "details"] as const).map(value => <Button key={value} size="compact" variant={filter === value ? "secondary" : "ghost"} className={styles.filter} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "All access" : value === "summary" ? "Summaries" : "Full details"}</Button>)}</div>
    </section>
    {!current ? <p role="status" className="text-sm text-muted-foreground">Checking Wallet sharing...</p> : current.error ? <div role="alert" className="space-y-3 rounded-2xl border border-border p-5"><p className="text-sm">We couldn&apos;t check Wallet access. Try again to see the current status.</p><Button variant="secondary" size="compact" onClick={() => setRevision((value) => value + 1)}>Try again</Button></div> : null}
    {renderGroup("Requests", current && !current.error ? current.requests.filter(matches) : [], false)}
    {renderGroup("Shared with", current && !current.error ? current.grants.filter(matches) : [], true)}
    <details className={styles.help}><summary>How sharing works</summary><ol><li>Someone requests Wallet access.</li><li>You review what they need and choose how long to share.</li><li>Approve or decline. Manage approved access here and revoke it at any time.</li></ol><p>Revoking stops future access. It cannot remove information someone already received.</p></details>
    <div className={styles.note}><Lock aria-hidden="true" className="size-4 shrink-0" /><p>Your Wallet stays private until you approve access. You can stop sharing at any time.</p></div>
    {current?.incompleteRequests ? <p role="status" className="text-sm text-muted-foreground">Some requests are still arriving. Refresh to see their complete details.</p> : null}
    <Dialog modal open={Boolean(selection && current && !current.error)} onOpenChange={value => { if (!value && !busy) setSelection(null); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[420px]" onCloseAutoFocus={event => { event.preventDefault(); reviewTrigger.current?.focus({ preventScroll: true }); }}>
        <DialogHeader><DialogTitle>{selection?.active ? "Manage access" : "Review request"}</DialogTitle><DialogDescription>{selection?.active ? "See what is shared and stay in control." : "Check every detail before sharing."}</DialogDescription></DialogHeader>
        {selection ? <div className="space-y-5">
          <div className={styles.accessCard}><ShieldCheck aria-hidden="true" className="size-6" /><p>{walletSharingKind(selection.entry) === "details" ? "Full card details" : "Card summary"}</p><span>WALLET ACCESS</span></div>
          <dl className={styles.facts}>
            <div><dt>{selection.active ? "Shared with" : "Requested by"}</dt><dd>{selection.entry.counterpart_label || "Requester"}</dd></div>
            <div><dt>What is included</dt><dd>{walletSharingKind(selection.entry) === "details" ? "Full card information, including card numbers and saved security details." : "Network, last four digits, expiry, nickname and issuing region."}</dd></div>
            <div><dt>Which cards</dt><dd>Wallet-wide access. This permission is not limited to one card.</dd></div>
            {selection.entry.reason ? <div><dt>Reason</dt><dd>{selection.entry.reason}</dd></div> : null}
            {selection.active ? <><div><dt>Status</dt><dd>{selection.entry.status}</dd></div><div><dt>Access expires</dt><dd>{expiryLabel(selection.entry.expires_at)}</dd></div></> : null}
          </dl>
          {!selection.active ? <label className="block space-y-2 text-sm font-medium">Access duration<select className={styles.duration} value={duration} disabled={busy} onChange={event => setDuration(Number(event.target.value))}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></label> : null}
          {walletSharingKind(selection.entry) === "details" ? <p className={styles.warning}><Lock aria-hidden="true" className="size-4 shrink-0" />Full card details are sensitive. Approve only if you trust this requester.</p> : null}
          {!vaultKey ? <p role="status" className="text-sm">Unlock your Wallet before changing access.</p> : null}
          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          {selection.active ? <Button variant="destructive" className="w-full" disabled={busy || !vaultKey || !selection.entry.request_id || !selection.entry.scope} onClick={() => setConfirmRevoke(true)}>Revoke access</Button> : <div className="grid grid-cols-2 gap-3"><Button variant="secondary" disabled={busy || !vaultKey || !isInlineDecidableConsentEntry(selection.entry)} onClick={() => void mutate("decline")}>Decline</Button><Button disabled={busy || !vaultKey || !isInlineDecidableConsentEntry(selection.entry)} onClick={() => void mutate("approve")}>{busy ? "Updating…" : "Approve"}</Button></div>}
        </div> : null}
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmRevoke && Boolean(selection)} onOpenChange={value => { if (!busy) setConfirmRevoke(value); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Stop sharing Wallet access?</AlertDialogTitle><AlertDialogDescription>This revokes this recipient’s selected permission. Information they previously received cannot be taken back.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep sharing</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void mutate("revoke"); }}>Revoke access</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
