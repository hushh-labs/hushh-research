"use client";

import styles from "./wallet-sharing.module.css";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProfilePaneAccountIcon } from "@/components/profile/profile-pane-icons";
import { SettingsGroup, SettingsRow, SettingsPresentationProvider } from "@/components/profile/settings-ui";
import { WalletCardAccessService, type CardSharingHistory, type CardSharingHistoryItem } from "@/lib/services/wallet-card-access-service";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";

import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";

type State = { context: CardShareContext; page: CardSharingHistory; direction: string };
const date = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Small ledger in the existing Sharing tab; access remains server-authorized. */
export function WalletSharingHistory({ ownerId, active, getContext }: {
  ownerId: string; active: boolean; getContext: (cardId: string) => CardShareContext | null;
}) {
  const [direction, setDirection] = useState<"outgoing" | "received">("outgoing");
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<CardSharingHistoryItem | null>(null);
  const pending = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const current = active && state?.context.userId === ownerId && state.direction === direction && state.context.isCurrent() ? state : null;
  const loadedCount = useRef(0);
  loadedCount.current = current?.page.items.length ?? 0;
  useBackLayer(ROUTES.ONE_WALLET, selection ? 2 : 0, () => { if (!busy) setSelection(null); return true; });
  useEffect(() => { setSelection(null); }, [active, ownerId, direction]);

  useEffect(() => WalletCardAccessService.subscribe(ownerId, () => setRevision(value => value + 1)), [ownerId]);
  useEffect(() => {
    const refresh = () => { if (active && document.visibilityState === "visible") setRevision(value => value + 1); };
    const hide = () => { if (document.visibilityState === "hidden") { pending.current?.abort(); setState(null); } else refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", hide);
    const timer = window.setInterval(refresh, 30_000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", hide); window.clearInterval(timer); };
  }, [active]);
  useEffect(() => {
    pending.current?.abort(); pending.current = null;
    setBusy(null); setLoading(false); setMoreFailed(false);
    if (!active) { setState(null); return; }
    const context = getContext("");
    if (!context || context.userId !== ownerId) { setState(null); return; }
    const controller = new AbortController();
    setFailed(false); setLoading(true);
    const refresh = async () => {
      const target = loadedCount.current;
      let page = await WalletCardAccessService.history(context, { direction }, controller.signal);
      while (page.nextCursor && page.items.length < target && !controller.signal.aborted && context.isCurrent()) {
        const next = await WalletCardAccessService.history(context, { direction, cursor: page.nextCursor }, controller.signal);
        const ids = new Set(page.items.map(item => `${item.cardType}:${item.id}`));
        if (next.nextCursor === page.nextCursor) throw new Error("History cursor did not advance.");
        page = { ...next, items: [...page.items, ...next.items.filter(item => !ids.has(`${item.cardType}:${item.id}`))] };
      }
      return page;
    };
    void refresh().then(page => {
      if (!controller.signal.aborted && context.isCurrent()) setState({ context, page, direction });
    }).catch(() => { if (!controller.signal.aborted && context.isCurrent()) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted && context.isCurrent()) setLoading(false); });
    return () => { controller.abort(); pending.current?.abort(); pending.current = null; };
  }, [active, ownerId, direction, revision, getContext]);

  const loadMore = useCallback(async () => {
    const cursor = current?.page.nextCursor;
    if (!current || !cursor || pending.current || loading) return;
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setMoreFailed(false);
    try {
      const page = await WalletCardAccessService.history(current.context, { direction, cursor }, controller.signal);
      if (controller.signal.aborted || !current.context.isCurrent()) return;
      setState(previous => {
        if (!previous || previous.page.nextCursor !== cursor || previous.context !== current.context) return previous;
        const ids = new Set(previous.page.items.map(item => `${item.cardType}:${item.id}`));
        return { ...previous, page: { ...page, items: [...previous.page.items, ...page.items.filter(item => !ids.has(`${item.cardType}:${item.id}`))] } };
      });
    } catch { if (!controller.signal.aborted && current.context.isCurrent()) setMoreFailed(true); }
    finally { if (pending.current === controller) { pending.current = null; setLoading(false); } }
  }, [current, direction, loading]);
  useEffect(() => {
    if (!current?.page.nextCursor || moreFailed || typeof IntersectionObserver === "undefined" || !end.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMore(); });
    observer.observe(end.current); return () => observer.disconnect();
  }, [current?.page.nextCursor, moreFailed, loadMore]);
  const revoke = async (item: CardSharingHistoryItem) => {
    if (!current || busy || direction !== "outgoing") return;
    const context = current.context; setBusy(item.id);
    const operation = WalletCardAccessService.revoke(context, item.id);
    void morphyToast.promise(operation, { loading: "Revoking access...", success: "Access revoked.", error: "Could not revoke access. Try again." });
    try { await operation; if (context.isCurrent()) setSelection(null); }
    catch { /* Toast owns action feedback; confirmed history stays visible. */ }
    finally { if (context.isCurrent()) setBusy(null); }
  };
  return <SettingsPresentationProvider density="compact"><section aria-label="Card sharing history" className={`space-y-3.5 ${styles.history}`}>
    <div className={`${styles.directionActions} flex min-h-11 flex-wrap items-center gap-2`} role="group" aria-label="Share direction">
      <Button size="compact" className="ui-text-compact-button-label" variant={direction === "outgoing" ? "default" : "secondary"} aria-pressed={direction === "outgoing"} onClick={() => setDirection("outgoing")}>Sent cards</Button>
      <Button size="compact" className="ui-text-compact-button-label" variant={direction === "received" ? "default" : "secondary"} aria-pressed={direction === "received"} onClick={() => setDirection("received")}>Received cards</Button>
    </div>
    <SettingsGroup title={direction === "outgoing" ? `Shared cards${current?.page.recipientCount != null ? ` | ${current.page.recipientCount}` : ""}` : "Cards shared with you"}>
      {current?.page.items.map(item => <SettingsRow key={`${item.cardType}:${item.id}`} icon={ProfilePaneAccountIcon} iconTone="transparent"
        title={`${item.displayLabel} | ${direction === "outgoing" ? item.recipientName : item.senderName}`}
        description={<div className="space-y-1">
          <p><time dateTime={item.createdAt}>{date(item.createdAt)}</time> | {item.durationMinutes} minutes</p>
          <p>{item.status === "revoked" ? "Revoked" : item.status === "expired" ? "Expired" : "Active"} | {item.trustedCircle === true ? "Trusted Circle when shared" : item.trustedCircle === false ? "Connection" : "Earlier share"}</p>
          <p>{item.verifiedAt ? `Identity verified ${date(item.verifiedAt)}` : item.verificationMethod === "identity_reauthentication" ? "Identity verification required" : item.trustedCircle === true && item.verificationMethod === "trusted_circle" ? "Trusted access when shared" : "Verification details unavailable"}</p>
          <p>Expires <time dateTime={item.expiresAt}>{date(item.expiresAt)}</time></p>
          {item.revokedAt ? <p>Revoked {date(item.revokedAt)}</p> : null}
          {item.lastAccessedAt ? <p>Last viewed {date(item.lastAccessedAt)}</p> : null}
          <details><summary>Activity</summary><ul className="mt-2 space-y-1">{item.activity.filter((event, index, events) => event.event !== "SHARE_OPENED" || index === events.findIndex(candidate => candidate.event === "SHARE_OPENED")).map((event, index) => <li key={`${event.event}:${event.at}:${index}`}>{event.event.toLowerCase().replaceAll("_", " ")} | {date(event.at)}</li>)}</ul></details>
        </div>}
        trailing={direction === "outgoing" && item.status === "active" ? <Button size="compact" variant="secondary" aria-label={`Revoke ${item.displayLabel} shared with ${item.recipientName}`} disabled={Boolean(busy)} onClick={() => setSelection(item)}>Revoke</Button> : undefined} />)}
      {!current && !failed ? <SettingsRow title="Loading shared cards..." /> : null}
      {current && !current.page.items.length ? <SettingsRow title={direction === "outgoing" ? "No cards shared yet" : "No cards received yet"} /> : null}
    </SettingsGroup>
    {failed ? <div role="alert"><p className="ui-text-row-description">Could not refresh card sharing.</p><Button variant="ghost" size="compact" onClick={() => setRevision(value => value + 1)}>Try again</Button></div> : null}
    {current?.page.nextCursor ? <div ref={end}><Button variant="ghost" size="compact" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading more shares..." : moreFailed ? "Retry loading shares" : "Load more shares"}</Button></div> : null}
    <AlertDialog open={Boolean(selection && current)} onOpenChange={value => { if (!value && !busy) setSelection(null); }}>
      <AlertDialogContent className={profileStyles.accountDialog}><AlertDialogHeader><AlertDialogTitle>Revoke this card share?</AlertDialogTitle><AlertDialogDescription>This stops future access for {selection?.recipientName}. Information already viewed cannot be taken back.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={Boolean(busy)}>Keep sharing</AlertDialogCancel><AlertDialogAction disabled={Boolean(busy)} onClick={event => { event.preventDefault(); if (selection) void revoke(selection); }}>Revoke access</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section></SettingsPresentationProvider>;
}
