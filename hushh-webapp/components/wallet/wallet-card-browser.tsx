"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { WalletReferralCardDetails } from "./wallet-referral-card-details";
import type { ReferralSummary } from "@/lib/services/referral-service";
import { WalletCardWorkspace } from "@/components/wallet-card/wallet-card-workspace";
import { WalletAddCollection } from "./wallet-add-collection";
import type { WalletCardArtwork } from "@/lib/wallet/card-artwork";
import { WalletCardFace } from "./wallet-card-face";
import { WALLET_DEMO_CARDS, WalletDemoCardFace, isAgentWalletCard, type WalletDemoProfile } from "./wallet-demo-cards";
import { cardNetworkLabel } from "./card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { unwindBackLayer, useBackLayer } from "@/lib/navigation/back-layers";
import { walletCardImageFields } from "@/lib/wallet/wallet-card-image";
import { ROUTES } from "@/lib/navigation/routes";
import styles from "./wallet-card-browser.module.css";

export function WalletCardBrowser({ cards, cardholderNames = {}, artworks = {}, pendingArtworkIds, selectedCardId, onSelect, onOverview, onAdd, onRemove, busyCardId, disabled = false, details, dockHost, ownerId, active = true, demoProfile, referralSummary, referralError = false, onRetryReferral, onRevokeReferral }: {
  cards: WalletCardSummary[];
  cardholderNames?: Readonly<Record<string, string>>;
  artworks?: Readonly<Record<string, WalletCardArtwork | undefined>>;
  pendingArtworkIds?: ReadonlySet<string>;
  selectedCardId: string | null;
  onSelect: (id: string) => void;
  onOverview: () => void;
  onAdd: () => void;
  onRemove: (card: WalletCardSummary) => void;
  busyCardId: string | null;
  disabled?: boolean;
  details: ReactNode;
  dockHost?: HTMLElement | null;
  ownerId?: string;
  active?: boolean;
  demoProfile?: WalletDemoProfile | null;
  referralSummary?: ReferralSummary | null;
  referralError?: boolean;
  onRetryReferral?: () => void;
  onRevokeReferral?: (slug: string) => Promise<void>;
}) {
  const collection = [...WALLET_DEMO_CARDS, ...cards];
  const [mode, setMode] = useState<"all" | "card">(selectedCardId ? "card" : "all");
  const [agentCardId, setAgentCardId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedCardId) { setMode("card"); setAgentCardId(selectedCardId); }
  }, [selectedCardId]);
  useEffect(() => {
    if (!active) { setMode("all"); setAgentCardId(null); }
  }, [active]);
  useEffect(() => {
    if (agentCardId && !isAgentWalletCard(agentCardId) && !cards.some(card => card.cardId === agentCardId)) {
      setMode("all");
      setAgentCardId(null);
    }
  }, [agentCardId, cards]);
  const content = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const automaticScrollUntil = useRef(0);
  useEffect(() => {
    const root = content.current?.closest<HTMLElement>("[data-app-scroll-root]");
    if (!active || !root || !dockHost) return;
    let previous = root.scrollTop;
    const onScroll = () => {
      const top = Math.max(0, root.scrollTop);
      const delta = top - previous;
      if (performance.now() < automaticScrollUntil.current) {
        previous = top;
        dockHost.setAttribute("data-scrolling-down", "false");
        return;
      }
      if (Math.abs(delta) < 3 && top > 0) return;
      dockHost.setAttribute("data-scrolling-down", String(top > 0 && delta > 0));
      previous = top;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") dockHost.setAttribute("data-scrolling-down", "false");
    };
    document.addEventListener("keydown", onKeyDown, true);
    root.addEventListener("scroll", onScroll, { passive:true });
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      root.removeEventListener("scroll", onScroll);
      dockHost.removeAttribute("data-scrolling-down");
    };
  }, [active, dockHost]);
  const selected = collection.find((card) => card.cardId === (agentCardId ?? selectedCardId)) ?? collection[0];
  const index = selected ? collection.indexOf(selected) : -1;
  const isBusy = disabled || Boolean(busyCardId);
  useLayoutEffect(() => {
    if (!active) return;
    const root = content.current?.closest<HTMLElement>("[data-app-scroll-root]");
    if (!root) return;
    // Reset after React commits the new card, then after the pager measures its
    // height. Measuring the outgoing card inherited its scrolled position.
    const reset = () => {
      automaticScrollUntil.current = performance.now() + 350;
      root.scrollTo({ top: 0, behavior: "instant" });
      dockHost?.setAttribute("data-scrolling-down", "false");
    };
    reset();
    const frame = requestAnimationFrame(reset);
    return () => cancelAnimationFrame(frame);
  }, [active, mode, selected?.cardId, dockHost]);
  const choose = (id: string) => {
    if (isBusy) return;
    setAgentCardId(id);
    onSelect(id);
    setMode("card");
  };
  const showAll = () => {
    if (isBusy) return;
    setMode("all");
    setAgentCardId(null);
    onOverview();
  };
  useBackLayer(ROUTES.ONE_WALLET, active && mode === "card" ? 1 : 0, () => {
    showAll();
    return true;
  });
  if (!selected) return null;
  const finishSwipe = (event: TouchEvent) => {
    const start = gesture.current;
    gesture.current = null;
    const end = event.changedTouches[0];
    if (!start || !end || isBusy) return;
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const next = collection[index + (dx < 0 ? 1 : -1)];
    if (next) choose(next.cardId);
  };
  const dock = <nav aria-label="Wallet card switcher" className={`${styles.dock} sr-only`} data-testid="wallet-card-switcher">
    <Button variant="ghost" size="compact" aria-pressed={mode === "all"} disabled={isBusy} onClick={showAll} className={styles.allButton}>All <span>({collection.length})</span></Button>
    <div className={styles.thumbnails} data-swipe-views-horizontal-scroll>
      {collection.map((card, cardIndex) => <button key={card.cardId} type="button" disabled={isBusy} aria-label={isAgentWalletCard(card.cardId) ? `Open ${card.nickname}` : `Open ${card.nickname || cardNetworkLabel(card.brand)}, ending ${card.last4}`} aria-pressed={mode === "card" && selected.cardId === card.cardId} onClick={() => choose(card.cardId)} className={styles.thumbnailButton}>
        <span className={styles.thumbnail} data-finish={cardIndex % 3} aria-hidden="true"><span>{cardNetworkLabel(card.brand)}</span><i /><small>{card.last4}</small></span>
      </button>)}
    </div>
    <Button variant="secondary" size="compact" disabled={isBusy} aria-label="Add a card" onClick={onAdd} className={styles.plus}><Plus aria-hidden="true" className="size-5" /></Button>
  </nav>;
  return <div ref={content} className={styles.browser} data-testid="wallet-card-browser" data-mode={mode}>
    <h2 className="sr-only">Your cards</h2>
    {mode === "all" ? <>
      <WalletAddCollection hintOwnerId={ownerId} cards={collection} selectedCardId={null} onSelect={choose} onOpen={choose} onAdd={onAdd} onRemove={onRemove} busyCardId={busyCardId} disabled={disabled} demoProfile={demoProfile} renderCard={(card) => isAgentWalletCard(card.cardId) ? <WalletDemoCardFace summary={card} profile={demoProfile} /> : <WalletCardFace summary={card} artwork={artworks[card.cardId]} artworkPending={pendingArtworkIds?.has(card.cardId)} cardholderName={cardholderNames[card.cardId]} collection />} cardControlSummary={(card) => isAgentWalletCard(card.cardId) ? {
        title: card.nickname || "Agent One",
        fields: [
          { label: "Name", value: walletCardImageFields(demoProfile).username },
          { label: "Member since", value: demoProfile?.memberSince && !Number.isNaN(Date.parse(demoProfile.memberSince)) ? String(new Date(demoProfile.memberSince).getFullYear()) : "—" },
          { label: "Wallet ID", value: demoProfile?.walletId?.slice(-8).toUpperCase() || "—" },
        ],
      } : { title: card.nickname || cardNetworkLabel(card.brand) }} scrollReveal showDetailsLink showActions={false} />
      <div className={styles.quickActions}>
        <Button size="prominent" className={styles.addAction} onClick={onAdd} disabled={isBusy}><Plus aria-hidden="true" className="size-4" />{cards.length ? "Add another card" : "Add a payment card"}</Button>
      </div>
    </> : <div key={selected.cardId} className="motion-step-enter space-y-5" data-testid="wallet-selected-card">
      <div className={styles.detailNavigation}><Button variant="ghost" size="compact" showRipple={false} onClick={() => unwindBackLayer(ROUTES.ONE_WALLET)} disabled={isBusy}><ArrowLeft aria-hidden="true" className="size-4" />Back</Button><span>{index + 1} / {collection.length}</span><Button variant="ghost" size="compact" showRipple={false} disabled={isBusy || index === collection.length - 1} aria-label="Next card" onClick={() => { const next = collection[index + 1]; if (next) choose(next.cardId); }}><ArrowRight aria-hidden="true" className="size-4" /></Button></div>
      <div data-swipe-views-horizontal-scroll onTouchStart={(event) => { const point = event.touches[0]; gesture.current = event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : null; }} onTouchEnd={finishSwipe} onTouchCancel={() => { gesture.current = null; }} className={styles.selectedFace}>
        {isAgentWalletCard(selected.cardId) ? <WalletDemoCardFace summary={selected} profile={demoProfile} /> : <WalletCardFace summary={selected} artwork={artworks[selected.cardId]} artworkPending={pendingArtworkIds?.has(selected.cardId)} cardholderName={cardholderNames[selected.cardId]} collection />}
      </div>
      {selected.cardId === "agent-one-referral" ? <WalletReferralCardDetails summary={referralSummary ?? null} shareToken={demoProfile?.shareToken ?? null} profile={demoProfile} failed={referralError} onRetry={onRetryReferral} onRevoke={active ? onRevokeReferral : undefined} /> : isAgentWalletCard(selected.cardId) ? <div className="space-y-4">
        {selected.cardId === "agent-one-nws" ? <p className="text-xs text-muted-foreground">This is a sample score; no net worth evaluation has been run. Sharing uses your Wallet Profile and its scan totals.</p> : null}
        <WalletCardWorkspace embedded active={active} passVariant={selected.cardId === "agent-one-nws" ? "nws" : "profile"} />
      </div> : <div className="space-y-5">
        {details}
      </div>}
    </div>}
    {active && dockHost ? createPortal(dock, dockHost) : null}
  </div>;
}
