"use client";

import { Capacitor } from "@capacitor/core";
import styles from "./wallet-sharing.module.css";
import presentationStyles from "./wallet-connect-presentation.module.css";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CreditCard } from "@/components/icons";
import { ProfilePaneAccountIcon } from "@/components/profile/profile-pane-icons";
import { SettingsGroup, SettingsRow, SettingsPresentationProvider, SettingsDetailPanel } from "@/components/profile/settings-ui";
import { CardAccessUnavailableError, WalletCardAccessService, type CardSharingHistory, type CardSharingHistoryItem } from "@/lib/services/wallet-card-access-service";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";
import { WalletSavedCardSharing } from "./wallet-saved-card-sharing";
import { WalletCollectionSkeleton } from "./wallet-collection-skeleton";
import { WalletCardFace } from "./wallet-card-face";
import { isCardNetworkId } from "@/lib/wallet/card-validation";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import browserStyles from "./wallet-card-browser.module.css";
const WalletCardAccessMessage = lazy(() => import("./wallet-card-access-message").then(module => ({ default: module.WalletCardAccessMessage })));
import { ROUTES } from "@/lib/navigation/routes";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

type State = { context: CardShareContext; page: CardSharingHistory; direction: string };
const date = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function SharedCardPreview({ item }: { item: CardSharingHistoryItem }) {
  if (item.cardType === "payment") {
    // History exposes the sender-approved network label and last four only.
    const network = item.displayLabel.match(/^([A-Z][A-Z0-9_-]{0,39}) •••• \d{4}$/)?.[1]?.toLowerCase();
    return <div data-testid="wallet-received-card-preview" data-status={item.status}>
      <WalletCardFace protectedDetails summary={{
        cardId: item.id, nickname: "Shared card", brand: isCardNetworkId(network) ? network : "other",
        last4: /^\d{4}$/.test(item.last4 ?? "") ? item.last4! : "",
        expiryMonth: 0, expiryYear: 0, issuingRegion: "", createdAt: item.createdAt,
      }} />
    </div>;
  }
  return <div className={styles.receivedFace} data-testid="wallet-received-card-preview" data-status={item.status}>
    <span className={styles.receivedFaceTop}><span>{item.cardType === "profile" ? "Profile card" : "Shared card"}</span><CreditCard aria-hidden="true" className="size-6" /></span>
    <strong>{item.displayLabel}</strong><small>Details protected</small>
  </div>;
}

function accessLabel(item: CardSharingHistoryItem, serverNow: string) {
  if (item.status !== "active") return item.status === "revoked" ? "Revoked" : "Expired";
  const minutes = Math.ceil((Date.parse(item.expiresAt) - Date.parse(serverNow)) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes < 60 ? `${minutes} min left` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""} left` : "Access ending";
}

/** History is display metadata; the existing recipient viewer authorizes every reveal. */
export type WalletSharingHistoryProps = {
  direction?: "outgoing" | "received"; presentation?: "list" | "cards";
  ownerId: string; active: boolean; getContext: (cardId: string) => CardShareContext | null;
};
export function useWalletSharingHistoryOwner({ ownerId, active, getContext, direction = "outgoing" }: WalletSharingHistoryProps, native = false) {
  const [viewer, setViewer] = useState<{ ownerId: string; grantId: string; request: number } | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [profile, setProfile] = useState<{ context: CardShareContext; cardId: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // A readiness result belongs to this owner, direction and in-memory session.
  const suspended = useRef<{ ownerId: string; direction: string; token: string; epoch: number } | null>(null);
  const isSuspended = useCallback((context: CardShareContext | null) => {
    const pause = suspended.current;
    return Boolean(pause && pause.ownerId === ownerId && pause.direction === direction
      && pause.epoch === snapshotVaultSessionEpoch() && (!context || pause.token === context.vaultOwnerToken));
  }, [ownerId, direction]);
  const retry = useCallback(() => { suspended.current = null; setUnavailable(false); setRevision(value => value + 1); }, []);
  const [loading, setLoading] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [opened, setOpened] = useState<{ id: string; cardType: string } | null>(null);
  const [selection, setSelection] = useState<CardSharingHistoryItem | null>(null);
  const pending = useRef<AbortController | null>(null);
  const initialPending = useRef<AbortController | null>(null);
  const returnTarget = useRef<{ element: HTMLButtonElement; context: CardShareContext; activation: number } | null>(null);
  const detailBack = useRef<HTMLButtonElement | null>(null);
  const revokeButton = useRef<HTMLButtonElement | null>(null);
  const revoked = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const activation = useRef({ active, revision: 0 });
  if (activation.current.active !== active) activation.current = { active, revision: activation.current.revision + 1 };
  const retained = state?.context.userId === ownerId && state.direction === direction && state.context.isCurrent() ? state : null;
  const current = active ? retained : null;
  const detail = current?.page.items.find(item => item.id === opened?.id && item.cardType === opened.cardType);
  const loadedCount = useRef(0);
  loadedCount.current = retained?.page.items.length ?? 0;
  useBackLayer(ROUTES.ONE_WALLET, !native && detail ? 2 : 0, () => { if (!busy) setOpened(null); return true; });
  useBackLayer(ROUTES.ONE_WALLET, !native && selection && current ? 3 : 0, () => { if (!busy) setSelection(null); return true; });
  useEffect(() => { setSelection(null); setOpened(null); setBusy(null); setViewer(null); }, [active, ownerId, direction]);

  useEffect(() => WalletCardAccessService.subscribe(ownerId, retry), [ownerId, retry]);
  useEffect(() => subscribeVaultSessionEpoch(() => {
    suspended.current = null; setUnavailable(false);
    initialPending.current?.abort(); initialPending.current = null; pending.current?.abort(); setState(null); setProfile(null); setOpened(null); setSelection(null); setViewer(null); setRevision(value => value + 1);
  }), []);
  useEffect(() => {
    const refresh = () => {
      if (initialPending.current || pending.current || isSuspended(getContext(""))) return;
      if (document.visibilityState === "visible") setRevision(value => value + 1);
    };
    const hide = () => { if (document.visibilityState === "hidden") { initialPending.current?.abort(); initialPending.current = null; pending.current?.abort(); setState(null); setProfile(null); setOpened(null); setSelection(null); } else refresh(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", hide);
    const timer = window.setInterval(refresh, 30_000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", hide); window.clearInterval(timer); };
  }, [getContext, isSuspended]);
  useEffect(() => {
    pending.current?.abort(); pending.current = null;
    setBusy(null); setLoading(false); setMoreFailed(false);
    const context = getContext("");
    if (!context || context.userId !== ownerId) { setState(null); setProfile(null); return; }
    if (isSuspended(context)) return;
    suspended.current = null; setUnavailable(false);
    const controller = new AbortController();
    initialPending.current = controller;
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
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !context.isCurrent()) return;
      if (error instanceof CardAccessUnavailableError && error.readinessUnavailable) {
        suspended.current = { ownerId, direction, token: context.vaultOwnerToken, epoch: snapshotVaultSessionEpoch() };
        setUnavailable(true);
      }
      setFailed(true);
    })
      .finally(() => { if (initialPending.current === controller) initialPending.current = null; if (!controller.signal.aborted && context.isCurrent()) setLoading(false); });
    if (direction === "outgoing") void WalletCardAccessService.profile(context, controller.signal).then(result => {
      if (!controller.signal.aborted && context.isCurrent()) setProfile(result.eligible && result.cardId ? { context, cardId: result.cardId } : null);
    }).catch(() => { if (!controller.signal.aborted && context.isCurrent()) setProfile(null); });
    return () => { controller.abort(); if (initialPending.current === controller) initialPending.current = null; pending.current?.abort(); pending.current = null; };
  }, [ownerId, direction, revision, getContext, isSuspended]);

  const loadMore = useCallback(async () => {
    const cursor = current?.page.nextCursor;
    if (!current || !cursor || pending.current || loading || isSuspended(current.context)) return;
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
    } catch (error: unknown) {
      if (controller.signal.aborted || !current.context.isCurrent()) return;
      if (error instanceof CardAccessUnavailableError && error.readinessUnavailable) {
        suspended.current = { ownerId, direction, token: current.context.vaultOwnerToken, epoch: snapshotVaultSessionEpoch() };
        setUnavailable(true); setFailed(true);
      }
      setMoreFailed(true);
    }
    finally { if (pending.current === controller) { pending.current = null; setLoading(false); } }
  }, [current, ownerId, direction, loading, isSuspended]);
  useEffect(() => {
    if (!current?.page.nextCursor || moreFailed || typeof IntersectionObserver === "undefined" || !end.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMore(); });
    observer.observe(end.current); return () => observer.disconnect();
  }, [current?.page.nextCursor, moreFailed, loadMore]);
  const revoke = async (item: CardSharingHistoryItem) => {
    if (!current || busy || direction !== "outgoing") return;
    const session = current.context, revision = activation.current.revision;
    // Reading can preload across tabs; a mutation still belongs to this activation.
    const isCurrent = () => session.isCurrent() && activation.current.active && activation.current.revision === revision;
    const context = { ...session, isCurrent, getIdToken: async () => {
      if (!isCurrent()) throw new Error("Wallet changed.");
      return session.getIdToken();
    } };
    setBusy(item.id);
    const operation = WalletCardAccessService.revoke(context, item.id);
    void morphyToast.promise(operation, { loading: "Revoking access...", success: "Access revoked.", error: "Could not revoke access. Try again." });
    try { await operation; if (context.isCurrent()) { revoked.current = true; setSelection(null); } }
    catch { /* Toast owns action feedback; confirmed history stays visible. */ }
    finally { if (context.isCurrent()) setBusy(null); }
  };
  const restoreFocus = (event: Event, target: HTMLButtonElement | null) => {
    event.preventDefault();
    const origin = returnTarget.current;
    if (!active || !origin || origin.context.userId !== ownerId || !origin.context.isCurrent()
      || origin.activation !== activation.current.revision || !target?.isConnected || target.disabled) return;
    target.focus({ preventScroll: true });
  };
  return { viewer, setViewer, current, profile, failed, unavailable, loading, moreFailed, busy, opened, detail, selection, setSelection, setOpened, returnTarget, detailBack, revokeButton, revoked, end, activation, loadMore, retry, revoke, restoreFocus, beginRevoke: (item: CardSharingHistoryItem) => { revoked.current = false; setSelection(item); } };
}
export function WalletSharingHistory({ ownerId, active, getContext, direction = "outgoing", presentation = "list" }: WalletSharingHistoryProps) {
  const { viewer, setViewer, current, profile, failed, unavailable, loading, moreFailed, busy, opened, detail, selection, setSelection, setOpened, returnTarget, detailBack, revokeButton, revoked, end, activation, loadMore, retry, revoke, restoreFocus, beginRevoke } = useWalletSharingHistoryOwner({ ownerId, active, getContext, direction });
  return <SettingsPresentationProvider density="compact"><section aria-label={direction === "outgoing" ? "Card sharing history" : "Received card history"} className={`space-y-3.5 ${styles.history}`}>
    {direction === "outgoing" && active && profile?.context.isCurrent() && profile.context.userId === ownerId ? <WalletSavedCardSharing card={{ cardId: profile.cardId }} getContext={getContext} disabled={Boolean(busy)} showHistory={false} /> : null}
    {presentation === "cards" && direction === "received" ? <>
      <h2 className="sr-only">Cards shared with you</h2>
      <div className={browserStyles.cardGrid} aria-label="Cards shared with you">
        {current?.page.items.filter(item => item.status === "active").map(item => <article key={`${item.cardType}:${item.id}`}>
          <button type="button" className={styles.receivedCard} aria-label={`View ${item.displayLabel} from ${item.senderName}`} onClick={event => {
            returnTarget.current = { element: event.currentTarget, context: current.context, activation: activation.current.revision };
            setOpened({ id: item.id, cardType: item.cardType });
          }}>
            <SharedCardPreview item={item} />
            <span className={styles.receivedCaption}><span className={styles.receivedAvatar} aria-hidden="true">{item.senderName.slice(0, 1)}</span><span><strong>From {item.senderName}</strong><small>{item.displayLabel}</small></span><span className={styles.accessStatus}>{accessLabel(item, current.page.serverNow)}</span></span>
          </button>
        </article>)}
      </div>
      {!current && !failed ? <WalletCollectionSkeleton /> : null}
      {current && !current.page.items.some(item => item.status === "active") ? <div className={styles.receivedEmpty}><CreditCard aria-hidden="true" className="size-8" /><h3>No active shared cards</h3><p>{current.page.nextCursor ? "Load more to see earlier shares." : "Cards people share with you will appear here."}</p></div> : null}
      {current?.page.items.some(item => item.status !== "active") ? <details className={styles.pastAccess}><summary>Past access <span>{current.page.items.filter(item => item.status !== "active").length}</span></summary><div className={browserStyles.cardGrid}>
        {current.page.items.filter(item => item.status !== "active").map(item => <button type="button" key={`${item.cardType}:${item.id}`} className={styles.receivedCard} aria-label={`View ${item.displayLabel} from ${item.senderName}`} onClick={event => {
          returnTarget.current = { element: event.currentTarget, context: current.context, activation: activation.current.revision };
          setOpened({ id: item.id, cardType: item.cardType });
        }}><SharedCardPreview item={item} /><span className={styles.receivedCaption}><span><strong>From {item.senderName}</strong><small>{item.displayLabel}</small></span><span className={styles.accessStatus} data-ended="true">{accessLabel(item, current.page.serverNow)}</span></span></button>)}
      </div></details> : null}
    </> : <>
    <SettingsGroup title={direction === "outgoing" ? `Shared cards${current?.page.recipientCount != null ? ` | ${current.page.recipientCount}` : ""}` : "Cards shared with you"}>
      {current?.page.items.map(item => <SettingsRow key={`${item.cardType}:${item.id}`} asChild icon={ProfilePaneAccountIcon} iconTone="transparent"
        title={direction === "outgoing" ? item.recipientName : item.senderName}
        description={<time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString([], { dateStyle: "medium" })}</time>}
        chevron><button type="button"
          aria-label={`View ${item.displayLabel} ${direction === "outgoing" ? `shared with ${item.recipientName}` : `from ${item.senderName}`}`}
          onClick={event => {
            returnTarget.current = { element: event.currentTarget, context: current.context, activation: activation.current.revision };
            setOpened({ id: item.id, cardType: item.cardType });
          }} /></SettingsRow>)}
      {!current && !failed ? <SettingsRow title="Loading shared cards..." /> : null}
      {current && !current.page.items.length ? <SettingsRow title={direction === "outgoing" ? "No cards shared yet" : "No cards received yet"} /> : null}
    </SettingsGroup>
    </>}
    {failed ? <div role="alert"><p className="ui-text-row-description">{unavailable ? "Card sharing is unavailable. Automatic refresh is paused." : "Could not refresh card sharing."}</p><Button variant="ghost" size="compact" className={presentationStyles.quietAction} onClick={retry}>Try again</Button></div> : null}
    {current?.page.nextCursor ? <div ref={end}><Button variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading more shares..." : moreFailed ? "Retry loading shares" : "Load more shares"}</Button></div> : null}
    <SettingsDetailPanel open={Boolean(detail)} onOpenChange={open => { if (!open && !busy) { setSelection(null); setOpened(null); } }}
      onCloseAutoFocus={event => { if (opened || selection) { event.preventDefault(); return; } restoreFocus(event, returnTarget.current?.element ?? null); }}
      title={detail ? direction === "outgoing" ? detail.recipientName : detail.senderName : "Share details"}
      description={detail?.displayLabel} eyebrow={direction === "outgoing" ? "Shared card" : "Received card"}
      leading={<Button ref={detailBack} variant="ghost" size="icon-touch" aria-label="Back to sharing history" disabled={Boolean(busy)} onClick={() => { setSelection(null); setOpened(null); }}><ArrowLeft aria-hidden="true" className="size-5 text-[var(--app-accent)]" /></Button>} showCloseButton={false} headerTextOverflow="wrap" surfaceClassName={`${styles.history} ${styles.historyDetail} ${presentationStyles.walletPortal} ${presentationStyles.walletDialog}`}
      bodyClassName="space-y-5"
      footer={detail && direction === "outgoing" && detail.status === "active" ? <Button ref={revokeButton} size="compact" variant="destructive" className={presentationStyles.modalAction} aria-label={`Revoke ${detail.displayLabel} shared with ${detail.recipientName}`} disabled={Boolean(busy)} onClick={() => beginRevoke(detail)}>Revoke access</Button> : undefined}>
      {detail ? <>
        {presentation === "cards" ? <><SharedCardPreview item={detail} /><div className={styles.receivedDetailCaption}><span>From {detail.senderName}</span><span className={styles.accessStatus} data-ended={detail.status !== "active"}>{accessLabel(detail, current!.page.serverNow)}</span></div>
          {detail.status === "active" ? <>{Capacitor.isNativePlatform() ? <p className="text-sm text-muted-foreground">Open this card in your browser to view its details.</p> : <Button className="w-full" onClick={() => setViewer(previous => ({ ownerId, grantId: detail.id, request: (previous?.request ?? 0) + 1 }))}>View card</Button>}</> : <p role="status" className="py-3 text-sm text-muted-foreground">{detail.status === "revoked" ? "The owner stopped sharing this card." : "This share has expired. Ask the sender for a new share."}</p>}
        </> : null}
        <SettingsGroup title="Share details">
          <SettingsRow title="Status" description={detail.status === "revoked" ? "Revoked" : detail.status === "expired" ? "Expired" : "Active"} />
          <SettingsRow title="Shared" description={<time dateTime={detail.createdAt}>{date(detail.createdAt)}</time>} />
          <SettingsRow title="Access time" description={detail.durationMinutes % 60 === 0 ? `${detail.durationMinutes / 60} ${detail.durationMinutes === 60 ? "hour" : "hours"}` : `${detail.durationMinutes} minutes`} />
          <SettingsRow title="Expires" description={<time dateTime={detail.expiresAt}>{date(detail.expiresAt)}</time>} />
          <SettingsRow title="Connection" description={detail.trustedCircle === true ? "Trusted Circle when shared" : detail.trustedCircle === false ? "Connection" : "Earlier share"} />
          <SettingsRow title="Verification" description={detail.verifiedAt ? `Identity verified ${date(detail.verifiedAt)}` : detail.verificationMethod === "identity_reauthentication" ? "Identity verification required" : detail.trustedCircle === true && detail.verificationMethod === "trusted_circle" ? "Trusted access when shared" : "Verification details unavailable"} />
          {detail.revokedAt ? <SettingsRow title="Revoked" description={date(detail.revokedAt)} /> : null}
          {detail.lastAccessedAt ? <SettingsRow title="Last viewed" description={date(detail.lastAccessedAt)} /> : null}
        </SettingsGroup>
        <SettingsGroup title="Activity">
          {detail.activity.filter((event, index, events) => event.event !== "SHARE_OPENED" || index === events.findIndex(candidate => candidate.event === "SHARE_OPENED")).map((event, index) => <SettingsRow key={`${event.event}:${event.at}:${index}`} title={event.event.toLowerCase().replaceAll("_", " ")} description={<time dateTime={event.at}>{date(event.at)}</time>} />)}
          {!detail.activity.length ? <SettingsRow title="No activity yet" /> : null}
        </SettingsGroup>
      </> : null}
    </SettingsDetailPanel>
    {viewer?.ownerId === ownerId && active ? <Suspense fallback={<p role="status">Opening card…</p>}><WalletCardAccessMessage key={`${ownerId}:${viewer.grantId}`} grantId={viewer.grantId} compact hideTrigger openRequest={viewer.request} /></Suspense> : null}
    <AlertDialog open={Boolean(selection && current)} onOpenChange={value => { if (!value && !busy) setSelection(null); }}>
      <AlertDialogContent className={`${profileStyles.accountDialog} ${presentationStyles.walletDialog}`} onCloseAutoFocus={event => {
        if (selection || !detail) { event.preventDefault(); return; }
        restoreFocus(event, revoked.current ? detailBack.current : revokeButton.current ?? detailBack.current);
      }}><AlertDialogHeader><AlertDialogTitle>Revoke this card share?</AlertDialogTitle><AlertDialogDescription>This stops future access for {selection?.recipientName}. Information already viewed cannot be taken back.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={Boolean(busy)}>Keep sharing</AlertDialogCancel><AlertDialogAction disabled={Boolean(busy)} onClick={event => { event.preventDefault(); if (selection) void revoke(selection); }}>Revoke access</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section></SettingsPresentationProvider>;
}
