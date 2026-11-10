"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { ProfilePaneAccountIcon, ProfilePaneInviteIcon, ProfilePaneSecurityIcon, ProfilePaneCardIcon } from "@/components/profile/profile-pane-icons";
import { SettingsDetailPanel, SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { cardNetworkLabel } from "./card-network-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { withNativeFeedbackScope } from "@/lib/capacitor/native-feedback-sink";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";
import { CardRecipientKeyUnavailableError, prepareTemporaryCardShares } from "@/lib/services/wallet-card-share-service";
import { CardAccessUnavailableError, WalletCardAccessService, type CardAccessRecipient, type CardAccessState } from "@/lib/services/wallet-card-access-service";
import { WalletService, type WalletCardSummary, type WalletCardShareReceipt } from "@/lib/services/wallet-service";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import styles from "./wallet-saved-card-sharing.module.css";
import presentationStyles from "./wallet-connect-presentation.module.css";

// Present the existing API limit before the owner submits their selection.
const MAX_CARD_SHARE_RECIPIENTS = 20;
type AccessAuthority = { userId: string; cardId: string; vaultEpoch: number; current: () => boolean };
type AccessSnapshot = { value: CardAccessState; authority: AccessAuthority } | null;

export function useWalletSavedCardSharing({ card, getContext, compact = false, native = false }: {
  card: Pick<WalletCardSummary, "cardId"> & Partial<WalletCardSummary>; getContext: (cardId: string) => CardShareContext | null; disabled: boolean; showHistory?: boolean; compact?: boolean; native?: boolean;
}) {
  const notify = (create: () => unknown) => native ? withNativeFeedbackScope("workspace", create) : create();
  const isProfile = card.cardId.startsWith("profile_");
  const [manageOpen, setManageOpen] = useState(false);
  const revokeValue = useRef<{ target: string | null; revision: number }>({ target: null, revision: 0 });
  const [revokeSnapshot, setRevokeSnapshot] = useState(revokeValue.current);
  const revokeTarget = revokeSnapshot.target;
  const setRevokeTarget = useCallback((target: string | null) => {
    if (target === revokeValue.current.target) return;
    const next = { target, revision: revokeValue.current.revision + 1 };
    revokeValue.current = next; setRevokeSnapshot(next);
  }, []);
  const manageTrigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const searchValue = useRef({ query: "", revision: 0 });
  const [search, setSearch] = useState(searchValue.current);
  const query = search.query;
  const generation = useRef(0);
  const currentCardId = useRef(card.cardId);
  useLayoutEffect(() => { currentCardId.current = card.cardId; }, [card.cardId]);
  const setQuery = useCallback((value: string) => {
    if (value === searchValue.current.query) return;
    const next = { query: value, revision: searchValue.current.revision + 1 };
    searchValue.current = next;
    setSearch(next);
  }, []);
  const [lookup, setLookup] = useState<{ cardId: string; session: number; query: string; queryRevision: number; retry: number; userId?: string; vaultEpoch: number;
    phase: "loading" | "ready" | "failed"; items: CardAccessRecipient[]; hasMore: boolean; current: () => boolean } | null>(null);
  const [selectedState, setSelected] = useState<Record<string, CardAccessRecipient>>({});
  const selectedSnapshot = useRef(selectedState);
  const selectionAuthority = useRef<{ userId: string; cardId: string; session: number; vaultEpoch: number; current: () => boolean } | null>(null);
  const accessAuthority = useRef<AccessAuthority | null>(null);
  const activeContext = getContext(card.cardId);
  const selectionBinding = selectionAuthority.current;
  const selected = selectionBinding && selectionBinding.cardId === card.cardId && selectionBinding.session === generation.current &&
    selectionBinding.vaultEpoch === snapshotVaultSessionEpoch() && selectionBinding.current() &&
    activeContext?.userId === selectionBinding.userId && activeContext.isCurrent() && selectedSnapshot.current === selectedState ? selectedState : {};
  const selectedCount = Object.keys(selected).length;
  const durationValue = useRef<{ value: 15 | 60 | 120; revision: number }>({ value: 15, revision: 0 });
  const [durationSnapshot, setDurationSnapshot] = useState(durationValue.current);
  const duration = durationSnapshot.value;
  const setDuration = useCallback((value: 15 | 60 | 120) => {
    if (durationValue.current.value === value) return;
    const next = { value, revision: durationValue.current.revision + 1 };
    durationValue.current = next; setDurationSnapshot(next);
  }, []);
  const [access, setAccessState] = useState<AccessSnapshot>(null);
  const accessSnapshot = useRef<AccessSnapshot>(null);
  const setAccess = useCallback((update: SetStateAction<AccessSnapshot>) => {
    const next = typeof update === "function" ? update(accessSnapshot.current) : update;
    accessSnapshot.current = next; setAccessState(next);
  }, []);
  const state = access && access === accessSnapshot.current && access.authority === accessAuthority.current && access.authority.cardId === card.cardId &&
    access.authority.vaultEpoch === snapshotVaultSessionEpoch() && access.authority.current() &&
    activeContext?.userId === access.authority.userId && activeContext.isCurrent() ? access.value : null;
  const [stateFailed, setStateFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [recipientRevision, setRecipientRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [copies, setCopies] = useState<{ cardId: string; current: () => boolean; receipts: WalletCardShareReceipt[] } | null>(null);
  const [copiesOpen, setCopiesOpen] = useState(false);
  const moreRequest = useRef<AbortController | null>(null);
  const historyEnd = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const revoking = useRef(false);
  // Keep this key across uncertain delivery retries, never extend the original grant.
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const close = useCallback(() => {
    generation.current += 1;
    selectionAuthority.current = null;
    selectedSnapshot.current = {};
    setOpen(false); setQuery(""); setSelected(selectedSnapshot.current); setLookup(null); setBusy(false);
  }, [setQuery]);
  const lookupCurrent = !!lookup && open && lookup.cardId === card.cardId && lookup.session === generation.current &&
    lookup.query === search.query && lookup.queryRevision === search.revision && lookup.queryRevision === searchValue.current.revision &&
    lookup.vaultEpoch === snapshotVaultSessionEpoch() && (lookup.phase !== "ready" || !!activeContext && activeContext.userId === lookup.userId && activeContext.isCurrent()) &&
    lookup.retry === recipientRevision && lookup.current();
  const recipients = lookupCurrent && lookup.phase === "ready" ? lookup.items : [];
  const hasMore = lookupCurrent && lookup.phase === "ready" && lookup.hasMore;
  const loading = open && (!lookupCurrent || lookup.phase === "loading");
  const failed = lookupCurrent && lookup.phase === "failed";
  const selectRecipient = (recipient: CardAccessRecipient, checked?: boolean) => {
    if (!lookupCurrent || !lookup || lookup.phase !== "ready" || lookup.session !== generation.current ||
        lookup.queryRevision !== searchValue.current.revision || lookup.query !== searchValue.current.query ||
        lookup.cardId !== currentCardId.current || lookup.vaultEpoch !== snapshotVaultSessionEpoch() || !lookup.current() ||
        !lookup.items.some(item => item.personRef === recipient.personRef)) return;
    const base = getContext(lookup.cardId);
    if (!base || !base.isCurrent() || base.userId !== lookup.userId) return;
    const authority = selectionAuthority.current;
    if (authority && (authority.userId !== base.userId || authority.cardId !== lookup.cardId ||
        authority.session !== lookup.session || authority.vaultEpoch !== lookup.vaultEpoch || !authority.current())) return;
    if (!authority) selectionAuthority.current = { userId: base.userId, cardId: lookup.cardId,
      session: lookup.session, vaultEpoch: lookup.vaultEpoch, current: base.isCurrent };
    const previous = selectedSnapshot.current, next = { ...previous };
    const select = checked ?? !previous[recipient.personRef];
    if (select) { if (Object.keys(previous).length < MAX_CARD_SHARE_RECIPIENTS) next[recipient.personRef] = recipient; }
    else delete next[recipient.personRef];
    selectedSnapshot.current = next; setSelected(next);
  };
  const selectionAtRender = selectionAuthority.current;
  const removeSelected = (personRef: string) => {
    if (!selectionAtRender || selectionAuthority.current !== selectionAtRender || selectedSnapshot.current !== selectedState ||
        selectionAtRender.session !== generation.current || selectionAtRender.cardId !== currentCardId.current ||
        selectionAtRender.vaultEpoch !== snapshotVaultSessionEpoch() || !selectionAtRender.current()) return;
    const next = { ...selectedSnapshot.current }; delete next[personRef]; selectedSnapshot.current = next; setSelected(next);
  };
  useBackLayer(ROUTES.ONE_WALLET, !native && open ? 3 : 0, () => { close(); return true; });
  useBackLayer(ROUTES.ONE_WALLET, !native && compact && manageOpen ? 2 : 0, () => { if (!busy) setManageOpen(false); return true; });
  useBackLayer(ROUTES.ONE_WALLET, !native && compact && revokeTarget ? 4 : 0, () => { if (!busy) setRevokeTarget(null); return true; });
  const currentCopies = copies?.cardId === card.cardId && copies.current() ? copies.receipts : [];
  useBackLayer(ROUTES.ONE_WALLET, !native && copiesOpen && currentCopies.length ? compact ? 3 : 2 : 0, () => { setCopiesOpen(false); return true; });
  useEffect(() => { close(); setManageOpen(false); setRevokeTarget(null); setAccess(null); attempt.current = null; }, [card.cardId, getContext, close, setAccess, setRevokeTarget]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const context = getContext(card.cardId);
    if (!context) return;
    moreRequest.current?.abort(); moreRequest.current = null;
    setLoadingMore(false); setMoreFailed(false);
    setStateFailed(false); setUnavailable(false);
    accessAuthority.current = null;
    const vaultEpoch = snapshotVaultSessionEpoch();
    void WalletCardAccessService.state(context, card.cardId, controller.signal).then(result => {
      if (!cancelled && context.isCurrent() && vaultEpoch === snapshotVaultSessionEpoch() && currentCardId.current === card.cardId) {
        const authority = { userId: context.userId, cardId: card.cardId, vaultEpoch, current: context.isCurrent };
        accessAuthority.current = authority;
        setAccess({ value: result, authority });
      }
    }).catch(error => { if (!cancelled && context.isCurrent() && vaultEpoch === snapshotVaultSessionEpoch() && currentCardId.current === card.cardId) {
      setAccess(null); setStateFailed(true); setUnavailable(error instanceof CardAccessUnavailableError);
    } });
    return () => { cancelled = true; controller.abort(); moreRequest.current?.abort(); moreRequest.current = null; };
  }, [card.cardId, getContext, revision, setAccess]);
  useEffect(() => {
    let cancelled = false;
    let readRevision = 0;
    const clear = () => { readRevision += 1; setCopies(null); setCopiesOpen(false); };
    const load = () => {
      clear();
      const context = getContext(card.cardId);
      if (!context) return;
      const expected = readRevision;
      void WalletService.listCardShareReceipts({ ...context, cardId: card.cardId }).then(receipts => {
        if (!cancelled && expected === readRevision && context.isCurrent()) {
          setCopies({ cardId: card.cardId, current: context.isCurrent, receipts });
        }
      }).catch(() => { /* Sent copies never establish current grant authority. */ });
    };
    const visibility = () => { if (document.visibilityState === "hidden") clear(); else load(); };
    const retire = subscribeVaultSessionEpoch(clear);
    document.addEventListener("visibilitychange", visibility);
    load();
    return () => { cancelled = true; retire(); document.removeEventListener("visibilitychange", visibility); };
  }, [card.cardId, getContext]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    const captured = { cardId: card.cardId, session: generation.current, query: search.query, queryRevision: search.revision,
      retry: recipientRevision, vaultEpoch: snapshotVaultSessionEpoch() };
    setLookup({ ...captured, phase: "loading", items: [], hasMore: false, current: () => true });
    const timer = window.setTimeout(() => {
      const context = getContext(card.cardId);
      if (!context) { close(); return; }
      const current = () => !cancelled && context.isCurrent() && captured.session === generation.current &&
        captured.queryRevision === searchValue.current.revision && captured.query === searchValue.current.query &&
        captured.vaultEpoch === snapshotVaultSessionEpoch() && captured.cardId === currentCardId.current;
      void WalletCardAccessService.recipients(context, query, controller.signal).then(result => {
        if (current()) setLookup({ ...captured, userId: context.userId, phase: "ready", items: result.items, hasMore: result.hasMore, current: context.isCurrent });
      }).catch(() => { if (current()) setLookup({ ...captured, phase: "failed", items: [], hasMore: false, current: context.isCurrent }); });
    }, 200);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [open, search, query, card.cardId, getContext, recipientRevision, close]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") close(); };
    const retire = subscribeVaultSessionEpoch(() => { accessAuthority.current = null; close(); setAccess(null); setRevision(value => value + 1); });
    document.addEventListener("visibilitychange", hide);
    return () => { generation.current += 1; retire(); document.removeEventListener("visibilitychange", hide); };
  }, [close, setAccess]);
  const loadMore = useCallback(async () => {
    const context = getContext(card.cardId);
    const cursor = state?.nextCursor;
    const authority = accessAuthority.current;
    if (!context || !authority || authority.userId !== context.userId || authority.cardId !== card.cardId ||
        authority.vaultEpoch !== snapshotVaultSessionEpoch() || !authority.current() || !context.isCurrent() ||
        !cursor || moreRequest.current || sending.current || revoking.current || stateFailed) return;
    const current = () => accessAuthority.current === authority && authority.cardId === currentCardId.current &&
      authority.vaultEpoch === snapshotVaultSessionEpoch() && authority.current() && context.isCurrent();
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true); setMoreFailed(false);
    try {
      const page = await WalletCardAccessService.state(context, card.cardId, controller.signal, cursor);
      if (controller.signal.aborted || !current()) return;
      setAccess(previous => {
        if (!previous || previous.authority !== authority || previous.value.nextCursor !== cursor) return previous;
        const existing = new Set(previous.value.grants.map(grant => grant.id));
        return { ...previous, value: { ...page, grants: [...previous.value.grants, ...page.grants.filter(grant => !existing.has(grant.id))] } };
      });
    } catch {
      if (!controller.signal.aborted && current()) setMoreFailed(true);
    } finally {
      if (moreRequest.current === controller) { moreRequest.current = null; setLoadingMore(false); }
    }
  }, [card.cardId, getContext, state?.nextCursor, stateFailed, setAccess]);
  useEffect(() => {
    const node = historyEnd.current;
    if (!node || !state?.nextCursor || loadingMore || moreFailed || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, state?.nextCursor, loadingMore, moreFailed]);
  const send = async () => {
    const base = getContext(card.cardId);
    const refs = Object.keys(selected).sort();
    const selection = selectionBinding, authority = access?.authority;
    if (!base || !base.isCurrent() || !selection || selectionAuthority.current !== selection || selectedSnapshot.current !== selectedState ||
        durationValue.current !== durationSnapshot || accessSnapshot.current !== access ||
        !authority || accessAuthority.current !== authority || selection.userId !== base.userId || authority.userId !== base.userId ||
        selection.cardId !== card.cardId || authority.cardId !== card.cardId || currentCardId.current !== card.cardId ||
        selection.session !== generation.current || selection.vaultEpoch !== snapshotVaultSessionEpoch() ||
        authority.vaultEpoch !== snapshotVaultSessionEpoch() || !selection.current() || !authority.current() ||
        !refs.length || refs.length > MAX_CARD_SHARE_RECIPIENTS || sending.current || stateFailed || !state) return;
    const requestGeneration = generation.current;
    moreRequest.current?.abort(); moreRequest.current = null; setLoadingMore(false);
    const ownerCurrent = () => currentCardId.current === card.cardId &&
      getContext(card.cardId)?.userId === base.userId && selection.vaultEpoch === snapshotVaultSessionEpoch() &&
      authority.vaultEpoch === snapshotVaultSessionEpoch() && selection.current() && authority.current() && base.isCurrent();
    const selectionCurrent = () => requestGeneration === generation.current && selectionAuthority.current === selection && selectedSnapshot.current === selectedState &&
      durationValue.current === durationSnapshot && accessSnapshot.current === access && accessAuthority.current === authority;
    const context = { ...base, isCurrent: () => ownerCurrent() && selectionCurrent() };
    const dispatchContext = { ...base, isCurrent: ownerCurrent, canDispatch: selectionCurrent };
    const fingerprint = JSON.stringify([base.userId, card.cardId, refs, duration]);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    sending.current = true; setBusy(true);
    try {
      if (!state.eligible && isProfile) throw new Error("Profile sharing is unavailable.");
      if (!state.eligible) await WalletService.prepareCardSharing({ ...context, cardId: card.cardId });
      if (!context.isCurrent()) return;
      const encryptedCards = isProfile ? undefined : await prepareTemporaryCardShares(context, card.cardId, refs);
      if (!context.isCurrent()) return;
      await WalletCardAccessService.share(dispatchContext, card.cardId, refs, duration, attempt.current.id, encryptedCards);
      if (!ownerCurrent()) return;
      attempt.current = null; if (selectionCurrent()) close(); setRevision(value => value + 1);
      notify(() => morphyToast.success("Card shared."));
    } catch (error) {
      if (ownerCurrent()) {
        if (error instanceof CardRecipientKeyUnavailableError) {
          notify(() => morphyToast.error(error.message));
        } else if (error instanceof CardAccessUnavailableError) {
          close(); setAccess(null); setStateFailed(true); setUnavailable(true);
          notify(() => morphyToast.error("Card sharing is temporarily unavailable. Try again later."));
        } else {
          notify(() => morphyToast.error("Could not confirm sharing. Retry to check the same request."));
        }
      }
    }
    finally {
      sending.current = false;
      if (requestGeneration === generation.current && currentCardId.current === card.cardId && base.isCurrent()) setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    const base = getContext(card.cardId), authority = access?.authority;
    if (!base || !authority || accessSnapshot.current !== access || accessAuthority.current !== authority ||
        ((compact || native) && (revokeSnapshot.target !== id || revokeValue.current !== revokeSnapshot)) ||
        !access?.value.grants.some(grant => grant.id === id && grant.status === "active") ||
        authority.userId !== base.userId || authority.cardId !== card.cardId ||
        authority.cardId !== currentCardId.current || authority.vaultEpoch !== snapshotVaultSessionEpoch() ||
        !authority.current() || !base.isCurrent() || busy || revoking.current) return;
    const context = { ...base, isCurrent: () => authority.cardId === currentCardId.current &&
      getContext(card.cardId)?.userId === base.userId && authority.vaultEpoch === snapshotVaultSessionEpoch() && authority.current() && base.isCurrent(),
      canDispatch: () => accessSnapshot.current === access && accessAuthority.current === authority &&
        (!(compact || native) || revokeValue.current === revokeSnapshot) };
    moreRequest.current?.abort(); moreRequest.current = null; setLoadingMore(false);
    revoking.current = true; setBusy(true);
    try {
      await WalletCardAccessService.revoke(context, id);
      if (context.isCurrent()) {
        if (accessSnapshot.current === access && accessAuthority.current === authority) {
          setAccess(previous => previous?.authority === authority ? { ...previous, value: { ...previous.value, grants: previous.value.grants.map(grant => grant.id === id ? { ...grant, status: "revoked" } : grant) } } : previous);
        } else setRevision(value => value + 1);
        if (revokeValue.current === revokeSnapshot) setRevokeTarget(null);
        notify(() => morphyToast.success("Access revoked."));
      }
    } catch { if (context.isCurrent()) notify(() => morphyToast.error("Could not revoke access. Try again.")); }
    finally {
      revoking.current = false;
      if (context.isCurrent()) setBusy(false);
    }
  };
  return { isProfile, manageOpen, setManageOpen, revokeTarget, setRevokeTarget, manageTrigger, open, setOpen, query, setQuery, recipients, selected, selectRecipient, removeSelected, selectedCount, duration, setDuration, hasMore, loading, failed, state, stateFailed, unavailable, busy, setRevision, setRecipientRevision, loadingMore, moreFailed, copiesOpen, setCopiesOpen, historyEnd, close, currentCopies, loadMore, send, revoke };
}

export function WalletSavedCardSharing(props: Parameters<typeof useWalletSavedCardSharing>[0]) {
  const { card, disabled, showHistory = true, compact = false } = props;
  const { isProfile, manageOpen, setManageOpen, revokeTarget, setRevokeTarget, manageTrigger, open, setOpen, query, setQuery, recipients, selected, selectRecipient, removeSelected, selectedCount, duration, setDuration, hasMore, loading, failed, state, stateFailed, unavailable, busy, setRevision, setRecipientRevision, loadingMore, moreFailed, copiesOpen, setCopiesOpen, historyEnd, close, currentCopies, loadMore, send, revoke } = useWalletSavedCardSharing(props);
  const sharingHistory = <>
      {showHistory ? <SettingsGroup title="Shared with">
        {state?.grants.length ? state.grants.map(grant => <SettingsRow key={grant.id} icon={ProfilePaneAccountIcon} iconTone="transparent"
          title={grant.recipientName} description={<span>
            {compact ? <span className="block">{grant.status === "active" ? `Access ends ${new Date(grant.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : grant.status === "revoked" ? "Revoked" : "Expired"}</span> : null}
            {grant.createdAt ? <time className="block" dateTime={grant.createdAt}>Shared {new Date(grant.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time> : null}
          </span>}
          trailing={grant.status === "active" ? <Button variant="destructive" size="compact" disabled={busy} onClick={() => compact ? setRevokeTarget(grant.id) : void revoke(grant.id)}>Revoke</Button> : undefined} />)
          : <SettingsRow icon={ProfilePaneAccountIcon} iconTone="transparent" title={stateFailed ? "Could not load shared access." : state ? "No active shares" : "Loading shares…"} />}
      </SettingsGroup> : null}
      {showHistory && state?.nextCursor ? <div ref={historyEnd} className="px-2 py-2" aria-live="polite">
        <Button variant="ghost" size="compact" className={presentationStyles.quietAction} disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading more shares…" : moreFailed ? "Retry loading shares" : "Load more shares"}
        </Button>
      </div> : null}
      {currentCopies.length ? <Accordion type="single" collapsible value={copiesOpen ? "copies" : ""} onValueChange={value => setCopiesOpen(value === "copies")}>
        <AccordionItem value="copies"><AccordionTrigger>Previously sent copies</AccordionTrigger><AccordionContent>
          <SettingsGroup title="Sent copies">
            {[...currentCopies].reverse().map(receipt => <SettingsRow key={receipt.messageId} icon={ProfilePaneAccountIcon} iconTone="transparent"
              title={receipt.recipientName} description="Sent copy · cannot be recalled" trailing={new Date(receipt.sentAt).toLocaleDateString()} />)}
          </SettingsGroup>
        </AccordionContent></AccordionItem>
      </Accordion> : null}
  </>;
  const sharingFeedback = stateFailed ? <div role="alert" className="space-y-2 text-sm text-muted-foreground">
    <p>{unavailable ? "Card sharing is temporarily unavailable." : "Could not check card sharing."}</p>
    <Button variant="secondary" size="compact" disabled={busy} onClick={() => setRevision(value => value + 1)}>Retry sharing</Button>
  </div> : !state ? <p role="status" className="text-sm text-muted-foreground">Checking card sharing…</p> : null;
  return <SettingsPresentationProvider separatorInset density="compact">
    <section className={`${profileStyles.walletContent} ${presentationStyles.walletSurface} space-y-4`} aria-label="Card sharing">
      {compact ? <div className={styles.cardActions}>
        <Button className="w-full" size="standard" disabled={disabled || busy} onClick={() => setOpen(true)}><ProfilePaneInviteIcon className="size-4" />Share card</Button>
        <Button ref={manageTrigger} variant="secondary" size="standard" className="w-full" disabled={disabled || busy} onClick={() => setManageOpen(true)}>Manage access{state ? <span className={styles.shareCount}>{state.grants.filter(grant => grant.status === "active").length}{state.nextCursor ? "+" : ""}</span> : null}</Button>
      </div> : <SettingsGroup title="Sharing">
        <SettingsRow icon={ProfilePaneInviteIcon} iconTone="transparent" title="Share card"
          description="Temporary access for your connections."
          chevron onClick={() => setOpen(true)} disabled={disabled || busy} />
        {stateFailed ? <SettingsRow title="Retry" description={unavailable ? "Card sharing is temporarily unavailable." : "Could not load sharing. Check your connection."} onClick={() => setRevision(value => value + 1)} /> : null}
      </SettingsGroup>}
      {compact ? <SettingsDetailPanel open={manageOpen} onOpenChange={value => { if (!busy) setManageOpen(value); }} title="Manage access" description="Choose who can keep viewing this card." headerTextOverflow="wrap"
        surfaceClassName={`${styles.accessSurface} ${presentationStyles.walletPortal} ${presentationStyles.walletDialog}`} bodyClassName={styles.accessBody} desktopMaxWidth="520px" desktopMaxWidthClassName="sm:!max-w-[520px]"
        onCloseAutoFocus={event => { event.preventDefault(); manageTrigger.current?.focus({ preventScroll: true }); }}
        footer={<Button className="w-full" disabled={disabled || busy} onClick={() => setOpen(true)}>Share with someone else</Button>}>
          {sharingFeedback}
          <div className="space-y-5">{sharingHistory}</div>
          <p className={styles.privacyNote}>Revoking stops future access. Details already copied or captured can’t be recalled.</p>
      </SettingsDetailPanel> : sharingHistory}
      <SettingsDetailPanel open={open} onOpenChange={value => { if (!value) close(); }} title={isProfile ? "Share Profile Card" : "Share card"} description={isProfile ? "Choose who can see your selected profile details." : "Choose who can view this card and for how long."}

        mobilePresentation="fullscreen" desktopMaxWidth="520px" desktopMaxWidthClassName="sm:!max-w-[520px]" surfaceClassName={`${styles.accessSurface} ${presentationStyles.walletPortal} ${presentationStyles.walletDialog}`} bodyClassName={styles.accessBody}
        footer={<div className="w-full"><Button size="standard" className="w-full" disabled={busy || stateFailed || !state || !Object.keys(selected).length} onClick={() => void send()}>{busy ? "Sharing…" : `Share with ${Object.keys(selected).length}`}</Button></div>}>
        <div className="space-y-4">
          <div className={styles.cardSummary}><ProfilePaneCardIcon className="size-7" /><div><strong>{isProfile ? "Profile card" : card.nickname || (card.brand ? cardNetworkLabel(card.brand) : "Your card")}{card.last4 ? ` · •••• ${card.last4}` : ""}</strong><span>Share with your connections</span></div></div>
          {sharingFeedback}
          {selectedCount ? <section aria-label="Selected connections" className="space-y-1">
            <p className="text-sm font-medium">Selected</p>
            {Object.values(selected).map(recipient => <div key={recipient.personRef} className="flex min-h-11 items-center gap-3">
              <span className="min-w-0 flex-1 break-words">{recipient.displayName}</span>
              <Button variant="ghost" size="compact" className="min-h-11" disabled={busy} aria-label={`Remove ${recipient.displayName}`} onClick={() => removeSelected(recipient.personRef)}>Remove</Button>
            </div>)}
          </section> : null}
          <Input aria-label="Search connections" placeholder="Search connections" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
          <div className={styles.recipientList} aria-label="Connections">
            {loading ? <div role="status" aria-label="Finding connections"><span className="sr-only">Finding connections…</span>{[0, 1, 2].map(index => <div key={index} className="flex min-h-14 items-center gap-3 px-3 py-2"><Skeleton className="size-8 rounded-full" /><Skeleton className="h-4 w-40" /></div>)}</div> : failed ? <Button variant="secondary" size="compact" className={presentationStyles.quietAction} onClick={() => setRecipientRevision(value => value + 1)}>Retry connections</Button> : recipients.map(recipient => <label key={recipient.personRef} className="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 text-sm leading-[21px]">
              <Avatar className="size-8"><AvatarImage src={recipient.photoUrl || undefined} alt="" /><AvatarFallback>{recipient.displayName.slice(0, 1)}</AvatarFallback></Avatar>
              <span className="min-w-0 flex-1 break-words">{recipient.displayName}{recipient.trusted ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><ProfilePaneSecurityIcon size={14} />Trusted Circle</span> : null}</span>
              <Checkbox aria-label={`Share with ${recipient.displayName}`} checked={Boolean(selected[recipient.personRef])} disabled={busy || (selectedCount >= MAX_CARD_SHARE_RECIPIENTS && !selected[recipient.personRef])}
                onCheckedChange={checked => selectRecipient(recipient, checked === true)} />
            </label>)}
            {!loading && !failed && !recipients.length ? <p className="py-3 text-xs text-muted-foreground">No connections found.</p> : null}
            {hasMore ? <p className="text-xs text-muted-foreground">Search by name to find more connections.</p> : null}
          </div>
          <p role="status" className="text-xs text-muted-foreground">{selectedCount} of {MAX_CARD_SHARE_RECIPIENTS} connections selected. Share with up to {MAX_CARD_SHARE_RECIPIENTS} at a time.</p>
          <fieldset><legend className="mb-2 text-[15px] leading-[22px] font-medium">Access time</legend><div className="flex flex-wrap gap-2">{([15, 60, 120] as const).map(minutes => <Button key={minutes} variant={duration === minutes ? "default" : "secondary"} size="compact" aria-pressed={duration === minutes} disabled={busy} onClick={() => setDuration(minutes)}>{minutes === 15 ? "15 minutes" : minutes === 60 ? "1 hour" : "2 hours"}</Button>)}</div></fieldset>
          <p className="text-xs text-muted-foreground">{isProfile ? "Only your selected profile details are shared." : "Shares the full card number, name, network and expiry. CVV and PIN are never shared."}</p>
          <p className="text-xs text-muted-foreground">People outside your Trusted Circle verify their identity before viewing.</p>
        </div>
      </SettingsDetailPanel>
      <AlertDialog open={Boolean(revokeTarget)} onOpenChange={value => { if (!value && !busy) setRevokeTarget(null); }}><AlertDialogContent className={presentationStyles.walletDialog}>
        <AlertDialogHeader><AlertDialogTitle>Revoke this card share?</AlertDialogTitle><AlertDialogDescription>This stops future access for {state?.grants.find(grant => grant.id === revokeTarget)?.recipientName}. Details already viewed cannot be recalled.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep sharing</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); if (revokeTarget) void revoke(revokeTarget); }}>Revoke access</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent></AlertDialog>
    </section>
  </SettingsPresentationProvider>;
}
