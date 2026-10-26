"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { WalletReferralCardDetails } from "./wallet-referral-card-details";
import type { ReferralSummary } from "@/lib/services/referral-service";
import { WalletCardWorkspace } from "@/components/wallet-card/wallet-card-workspace";
import { SettingsDetailPanel } from "@/components/profile/settings-ui";
import type { WalletCardArtwork } from "@/lib/wallet/card-artwork";
import { WalletCardFace } from "./wallet-card-face";
import { WALLET_DEMO_CARDS, WalletDemoCardFace, isAgentWalletCard, type WalletDemoProfile } from "./wallet-demo-cards";
import { cardNetworkLabel } from "./card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { unwindBackLayer, useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import styles from "./wallet-card-browser.module.css";
import presentationStyles from "./wallet-connect-presentation.module.css";

export function WalletCardBrowser({ cards, cardholderNames = {}, artworks = {}, pendingArtworkIds, selectedCardId, onSelect, onOverview, onAdd, pendingCard, addDisabled = false, busyCardId, disabled = false, details, dockHost, active = true, demoProfile, referralSummary, referralError = false, onRetryReferral, onRevokeReferral }: {
  cards: WalletCardSummary[];
  cardholderNames?: Readonly<Record<string, string>>;
  artworks?: Readonly<Record<string, WalletCardArtwork | undefined>>;
  pendingArtworkIds?: ReadonlySet<string>;
  selectedCardId: string | null;
  onSelect: (id: string) => void;
  onOverview: () => void;
  onAdd: () => void;
  pendingCard?: ReactNode;
  addDisabled?: boolean;
  onRemove: (card: WalletCardSummary) => void;
  busyCardId: string | null;
  disabled?: boolean;
  details: ReactNode;
  dockHost: HTMLElement | null;
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
  const returnCardId = useRef(selectedCardId);
  useEffect(() => {
    if (selectedCardId) { returnCardId.current = selectedCardId; setMode("card"); setAgentCardId(selectedCardId); }
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
  const returnTarget = useRef<HTMLElement | null>(null);
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
    if (document.activeElement instanceof HTMLElement && content.current?.contains(document.activeElement)) returnTarget.current = document.activeElement;
    returnCardId.current = id;
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
    <Button variant="secondary" size="compact" disabled={isBusy || addDisabled} aria-label="Add a card" onClick={onAdd} className={styles.plus}><Plus aria-hidden="true" className="size-5" /></Button>
  </nav>;
  return <div ref={content} className={styles.browser} data-testid="wallet-card-browser" data-mode={mode}>
    <h2 className="sr-only">Your cards</h2>
    <div className={styles.collection} aria-label="Saved payment cards">
      {cards.length || pendingCard ? <div className={styles.cardGrid}>{pendingCard}{cards.map(card => <article key={card.cardId} className={styles.cardTile}>
        <button type="button" disabled={isBusy} onClick={() => choose(card.cardId)} className={styles.cardOpen} data-wallet-card-id={card.cardId} data-selected-return={selected.cardId === card.cardId ? "true" : undefined}
          aria-label={card.nickname || `${cardNetworkLabel(card.brand)} ending ${card.last4}`}>
          <WalletCardFace summary={card} artwork={artworks[card.cardId]} artworkPending={pendingArtworkIds?.has(card.cardId)} cardholderName={cardholderNames[card.cardId]} collection />
          <span className={styles.cardCaption}><span><strong>{card.nickname || cardNetworkLabel(card.brand)}</strong><small>{cardNetworkLabel(card.brand)} · •••• {card.last4}</small></span><ArrowRight aria-hidden="true" className="size-4" /></span>
        </button>
      </article>)}</div> : <div className={styles.emptyCollection}><p>No payment cards yet</p><span>Add a card to keep its details close.</span><Button size="compact" variant="secondary" onClick={onAdd} disabled={isBusy || addDisabled}><Plus aria-hidden="true" className="size-4" />Add a payment card</Button></div>}
      <section className={styles.oneCards} aria-label="Your One cards"><div className={styles.sectionHeading}><h3>Your One cards</h3><span>Identity & membership</span></div>
        <div className={styles.oneCardGrid} data-swipe-views-horizontal-scroll>{WALLET_DEMO_CARDS.map(card => <button type="button" key={card.cardId} disabled={isBusy} onClick={() => choose(card.cardId)} className={styles.oneCardOpen} data-wallet-card-id={card.cardId} data-selected-return={selected.cardId === card.cardId ? "true" : undefined} aria-label={card.nickname}>
          <span className={styles.oneCardArt} aria-hidden="true"><WalletDemoCardFace summary={card} profile={demoProfile} /></span>
          <span className={styles.oneCardCaption}><span><strong>{card.cardId === "agent-one-profile" ? "Profile" : card.cardId === "agent-one-referral" ? "Referral" : "NWS"}</strong><small>{card.cardId === "agent-one-profile" ? "Share your introduction" : card.cardId === "agent-one-referral" ? "Invite your people" : "Sample card"}</small></span><ArrowRight aria-hidden="true" className="size-4" /></span>
        </button>)}</div>
      </section>
    </div>
    <SettingsDetailPanel open={active && mode === "card"} onOpenChange={open => { if (!open) unwindBackLayer(ROUTES.ONE_WALLET); }}
      title={selected.nickname || (isAgentWalletCard(selected.cardId) ? "One card" : cardNetworkLabel(selected.brand))}
      description={isAgentWalletCard(selected.cardId) ? undefined : `${cardNetworkLabel(selected.brand)} · •••• ${selected.last4}`}
      eyebrow="Your card" headerTextOverflow="wrap"
      leading={<Button variant="ghost" size="icon-touch" aria-label="Back" onClick={() => unwindBackLayer(ROUTES.ONE_WALLET)} disabled={isBusy}><ArrowLeft aria-hidden="true" className="size-5" /></Button>}
      onCloseAutoFocus={event => { event.preventDefault(); (Array.from(content.current?.querySelectorAll<HTMLButtonElement>("[data-wallet-card-id]") ?? []).find(button => button.dataset.walletCardId === returnCardId.current) ?? (returnTarget.current?.isConnected ? returnTarget.current : null))?.focus({ preventScroll: true }); }}
      contentClassName="md:translate-x-0 md:translate-y-0" surfaceClassName={`${styles.detailPanel} ${presentationStyles.walletPortal} ${presentationStyles.walletDialog}`} bodyClassName={styles.detailBody}
      desktopMaxWidth="520px" desktopMaxWidthClassName="sm:!max-w-[520px]">
      {mode === "card" ? <div key={selected.cardId} className="motion-step-enter space-y-5" data-testid="wallet-selected-card">
        <div className={styles.detailNavigation}><Button variant="ghost" size="compact" showRipple={false} onClick={showAll} disabled={isBusy}>All cards</Button><span>{index + 1} / {collection.length}</span><Button variant="ghost" size="icon-touch" aria-label="Add a card" disabled={isBusy || addDisabled} onClick={onAdd}><Plus aria-hidden="true" className="size-4" /></Button><Button variant="ghost" size="compact" showRipple={false} disabled={isBusy || index === collection.length - 1} aria-label="Next card" onClick={() => { const next = collection[index + 1]; if (next) choose(next.cardId); }}><ArrowRight aria-hidden="true" className="size-4" /></Button></div>
        <div data-swipe-views-horizontal-scroll onTouchStart={(event) => { const point = event.touches[0]; gesture.current = event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : null; }} onTouchEnd={finishSwipe} onTouchCancel={() => { gesture.current = null; }} className={styles.selectedFace}>
          {isAgentWalletCard(selected.cardId) ? <WalletDemoCardFace summary={selected} profile={demoProfile} /> : <WalletCardFace summary={selected} artwork={artworks[selected.cardId]} artworkPending={pendingArtworkIds?.has(selected.cardId)} cardholderName={cardholderNames[selected.cardId]} collection />}
        </div>
        {selected.cardId === "agent-one-referral" ? <WalletReferralCardDetails summary={referralSummary ?? null} shareToken={demoProfile?.shareToken ?? null} profile={demoProfile} failed={referralError} onRetry={onRetryReferral} onRevoke={active ? onRevokeReferral : undefined} /> : isAgentWalletCard(selected.cardId) ? <div className="space-y-4">
          {selected.cardId === "agent-one-nws" ? <p className="text-xs leading-[18px] text-[color:var(--app-secondary-label)]">This is a sample score; no net worth evaluation has been run. Sharing uses your Wallet Profile and its scan totals.</p> : null}
          <WalletCardWorkspace embedded active={active} passVariant={selected.cardId === "agent-one-nws" ? "nws" : "profile"} />
        </div> : details}
      </div> : null}
    </SettingsDetailPanel>
    {active && dockHost ? createPortal(dock, dockHost) : null}

  </div>;
}
