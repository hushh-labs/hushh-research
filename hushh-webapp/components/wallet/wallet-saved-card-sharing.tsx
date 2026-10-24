"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ProfilePaneAccountIcon, ProfilePaneInviteIcon, ProfilePaneSecurityIcon } from "@/components/profile/profile-pane-icons";
import { SettingsDetailPanel, SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";
import { CardRecipientKeyUnavailableError, prepareTemporaryCardShares } from "@/lib/services/wallet-card-share-service";
import { CardAccessUnavailableError, WalletCardAccessService, type CardAccessRecipient, type CardAccessState } from "@/lib/services/wallet-card-access-service";
import { WalletService, type WalletCardSummary, type WalletCardShareReceipt } from "@/lib/services/wallet-service";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import styles from "./wallet-saved-card-sharing.module.css";
import presentationStyles from "./wallet-connect-presentation.module.css";

// Present the existing API limit before the owner submits their selection.
const MAX_CARD_SHARE_RECIPIENTS = 20;

export function WalletSavedCardSharing({ card, getContext, disabled, showHistory = true }: {
  card: Pick<WalletCardSummary, "cardId">; getContext: (cardId: string) => CardShareContext | null; disabled: boolean; showHistory?: boolean;
}) {
  const isProfile = card.cardId.startsWith("profile_");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recipients, setRecipients] = useState<CardAccessRecipient[]>([]);
  const [selected, setSelected] = useState<Record<string, CardAccessRecipient>>({});
  const selectedCount = Object.keys(selected).length;
  const [duration, setDuration] = useState<15 | 60 | 120>(15);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [state, setState] = useState<CardAccessState | null>(null);
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
  const generation = useRef(0);
  const sending = useRef(false);
  // Keep this key across uncertain delivery retries, never extend the original grant.
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const close = useCallback(() => {
    generation.current += 1;
    setOpen(false); setQuery(""); setSelected({}); setRecipients([]); setBusy(false);
  }, []);
  useBackLayer(ROUTES.ONE_WALLET, open ? 3 : 0, () => { close(); return true; });
  const currentCopies = copies?.cardId === card.cardId && copies.current() ? copies.receipts : [];
  useBackLayer(ROUTES.ONE_WALLET, copiesOpen && currentCopies.length ? 2 : 0, () => { setCopiesOpen(false); return true; });
  useEffect(() => { close(); setState(null); attempt.current = null; }, [card.cardId, getContext, close]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const context = getContext(card.cardId);
    if (!context) return;
    moreRequest.current?.abort(); moreRequest.current = null;
    setLoadingMore(false); setMoreFailed(false);
    setStateFailed(false); setUnavailable(false);
    void WalletCardAccessService.state(context, card.cardId, controller.signal).then(result => {
      if (!cancelled && context.isCurrent()) setState(result);
    }).catch(error => { if (!cancelled && context.isCurrent()) { setState(null); setStateFailed(true); setUnavailable(error instanceof CardAccessUnavailableError); } });
    return () => { cancelled = true; controller.abort(); moreRequest.current?.abort(); moreRequest.current = null; };
  }, [card.cardId, getContext, revision]);
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
    setLoading(true); setFailed(false);
    const timer = window.setTimeout(() => {
      const context = getContext(card.cardId);
      if (!context) { close(); return; }
      void WalletCardAccessService.recipients(context, query, controller.signal).then(result => {
        if (!cancelled && context.isCurrent()) { setRecipients(result.items); setHasMore(result.hasMore); }
      }).catch(() => { if (!cancelled && context.isCurrent()) setFailed(true); })
        .finally(() => { if (!cancelled && context.isCurrent()) setLoading(false); });
    }, 200);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [open, query, card.cardId, getContext, recipientRevision, close]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") close(); };
    document.addEventListener("visibilitychange", hide);
    return () => { generation.current += 1; document.removeEventListener("visibilitychange", hide); };
  }, [close]);
  const loadMore = useCallback(async () => {
    const context = getContext(card.cardId);
    const cursor = state?.nextCursor;
    if (!context || !cursor || moreRequest.current || stateFailed) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true); setMoreFailed(false);
    try {
      const page = await WalletCardAccessService.state(context, card.cardId, controller.signal, cursor);
      if (controller.signal.aborted || !context.isCurrent()) return;
      setState(previous => {
        if (!previous || previous.nextCursor !== cursor) return previous;
        const existing = new Set(previous.grants.map(grant => grant.id));
        return { ...page, grants: [...previous.grants, ...page.grants.filter(grant => !existing.has(grant.id))] };
      });
    } catch {
      if (!controller.signal.aborted && context.isCurrent()) setMoreFailed(true);
    } finally {
      if (moreRequest.current === controller) { moreRequest.current = null; setLoadingMore(false); }
    }
  }, [card.cardId, getContext, state?.nextCursor, stateFailed]);
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
    if (!base || !refs.length || refs.length > MAX_CARD_SHARE_RECIPIENTS || sending.current || stateFailed || !state) return;
    const requestGeneration = generation.current;
    const context = { ...base, isCurrent: () => requestGeneration === generation.current && base.isCurrent() };
    const fingerprint = JSON.stringify([base.userId, card.cardId, refs, duration]);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    sending.current = true; setBusy(true);
    try {
      if (!state.eligible && isProfile) throw new Error("Profile sharing is unavailable.");
      if (!state.eligible) await WalletService.prepareCardSharing({ ...context, cardId: card.cardId });
      if (!context.isCurrent()) return;
      const encryptedCards = isProfile ? undefined : await prepareTemporaryCardShares(context, card.cardId, refs);
      if (!context.isCurrent()) return;
      await WalletCardAccessService.share(context, card.cardId, refs, duration, attempt.current.id, encryptedCards);
      if (!context.isCurrent()) return;
      attempt.current = null; close(); setRevision(value => value + 1);
      morphyToast.success("Card shared.");
    } catch (error) {
      if (context.isCurrent()) {
        if (error instanceof CardRecipientKeyUnavailableError) {
          morphyToast.error(error.message);
        } else if (error instanceof CardAccessUnavailableError) {
          close(); setState(null); setStateFailed(true); setUnavailable(true);
          morphyToast.error("Card sharing is temporarily unavailable. Try again later.");
        } else {
          morphyToast.error("Could not confirm sharing. Retry to check the same request.");
        }
      }
    }
    finally { sending.current = false; if (context.isCurrent()) setBusy(false); }
  };
  const revoke = async (id: string) => {
    const context = getContext(card.cardId);
    if (!context || busy) return;
    setBusy(true);
    try {
      await WalletCardAccessService.revoke(context, id);
      if (context.isCurrent()) {
        setState(previous => previous ? { ...previous, grants: previous.grants.map(grant => grant.id === id ? { ...grant, status: "revoked" } : grant) } : previous);
        morphyToast.success("Access revoked.");
      }
    } catch { if (context.isCurrent()) morphyToast.error("Could not revoke access. Try again."); }
    finally { if (context.isCurrent()) setBusy(false); }
  };
  return <SettingsPresentationProvider separatorInset density="compact">
    <section className={`${profileStyles.walletContent} ${presentationStyles.walletSurface} space-y-4`} aria-label="Card sharing">
      <SettingsGroup title="Sharing">
        <SettingsRow icon={ProfilePaneInviteIcon} iconTone="transparent" title="Share card"
          description="Temporary access for your connections."
          chevron onClick={() => setOpen(true)} disabled={disabled || busy || stateFailed || !state} />
        {stateFailed ? <SettingsRow title="Retry" description={unavailable ? "Card sharing is temporarily unavailable." : "Could not load sharing. Check your connection."} onClick={() => setRevision(value => value + 1)} /> : null}
      </SettingsGroup>
      {showHistory ? <SettingsGroup title="Shared with">
        {state?.grants.length ? state.grants.map(grant => <SettingsRow key={grant.id} icon={ProfilePaneAccountIcon} iconTone="transparent"
          title={grant.recipientName} description={<span>
            {grant.createdAt ? <time className="block" dateTime={grant.createdAt}>Shared {new Date(grant.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time> : null}
          </span>}
          trailing={grant.status === "active" ? <Button variant="destructive" size="compact" disabled={busy} onClick={() => void revoke(grant.id)}>Revoke</Button> : undefined} />)
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
      <SettingsDetailPanel open={open} onOpenChange={value => { if (!value) close(); }} title={isProfile ? "Share Profile Card" : "Share card"} description={isProfile ? "Share your selected profile details with your connections." : "Share your full card number and details with selected connections."}

        mobilePresentation="sheet" desktopMaxWidth="580px" desktopMaxWidthClassName="sm:!max-w-[580px]" surfaceClassName={`${styles.accessSurface} ${presentationStyles.walletPortal} ${presentationStyles.walletDialog}`} bodyClassName={styles.accessBody}
        footer={<div className="mx-auto w-full max-w-[244px]"><Button variant="secondary" size="compact" className={`w-full ${presentationStyles.quietAction}`} disabled={busy || stateFailed || !state || !Object.keys(selected).length} onClick={() => void send()}>{busy ? "Sharing…" : `Share with ${Object.keys(selected).length}`}</Button></div>}>
        <div className="space-y-4">
          <Input aria-label="Search connections" placeholder="Search connections" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
          <div className="max-h-64 overflow-y-auto" aria-label="Connections">
            {loading ? <p role="status">Finding connections…</p> : failed ? <Button variant="secondary" size="compact" className={presentationStyles.quietAction} onClick={() => setRecipientRevision(value => value + 1)}>Retry connections</Button> : recipients.map(recipient => <label key={recipient.personRef} className="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 text-sm leading-[21px]">
              <Avatar className="size-8"><AvatarImage src={recipient.photoUrl || undefined} alt="" /><AvatarFallback>{recipient.displayName.slice(0, 1)}</AvatarFallback></Avatar>
              <span className="min-w-0 flex-1 break-words">{recipient.displayName}{recipient.trusted ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><ProfilePaneSecurityIcon size={14} />Trusted Circle</span> : null}</span>
              <Checkbox aria-label={`Share with ${recipient.displayName}`} checked={Boolean(selected[recipient.personRef])} disabled={busy || (selectedCount >= MAX_CARD_SHARE_RECIPIENTS && !selected[recipient.personRef])}
                onCheckedChange={checked => setSelected(previous => { const next = { ...previous }; if (checked === true) { if (Object.keys(previous).length < MAX_CARD_SHARE_RECIPIENTS) next[recipient.personRef] = recipient; } else delete next[recipient.personRef]; return next; })} />
            </label>)}
            {!loading && !failed && !recipients.length ? <p className="py-3 text-xs text-muted-foreground">No connections found.</p> : null}
            {hasMore ? <p className="text-xs text-muted-foreground">Search by name to find more connections.</p> : null}
          </div>
          <p role="status" className="text-xs text-muted-foreground">{selectedCount} of {MAX_CARD_SHARE_RECIPIENTS} connections selected. Share with up to {MAX_CARD_SHARE_RECIPIENTS} at a time.</p>
          <fieldset><legend className="mb-2 text-[15px] leading-[22px] font-medium">Access time</legend><div className="flex flex-wrap gap-2">{([15, 60, 120] as const).map(minutes => <Button key={minutes} variant={duration === minutes ? "default" : "secondary"} size="compact" aria-pressed={duration === minutes} disabled={busy} onClick={() => setDuration(minutes)}>{minutes === 15 ? "15 minutes" : minutes === 60 ? "1 hour" : "2 hours"}</Button>)}</div></fieldset>
          <p className="text-xs text-muted-foreground">People outside your Trusted Circle verify their identity before viewing. Security codes are never shared.</p>
        </div>
      </SettingsDetailPanel>
    </section>
  </SettingsPresentationProvider>;
}
