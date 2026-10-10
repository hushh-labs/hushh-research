"use client";

import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { WalletReferralCardDetails } from "./wallet-referral-card-details";
import type { ReferralSummary } from "@/lib/services/referral-service";
import { WalletCardWorkspace } from "@/components/wallet-card/wallet-card-workspace";
import { WalletAddCollection } from "./wallet-add-collection";
import { WalletSharing } from "./wallet-sharing";
import { WalletCardFace } from "./wallet-card-face";
import { WALLET_DEMO_CARDS, WalletDemoCardFace, isAgentWalletCard, type WalletDemoProfile } from "./wallet-demo-cards";
import { cardNetworkLabel } from "./card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { walletProfileUsername } from "@/lib/wallet/wallet-profile-username";
import { ROUTES } from "@/lib/navigation/routes";
import styles from "./wallet-card-browser.module.css";

export function WalletCardBrowser({ cards, cardholderNames = {}, selectedCardId, onSelect, onOverview, onAdd, onRemove, busyCardId, disabled = false, details, dockHost, ownerId, active = true, demoProfile, referralSummary, referralError = false, onRetryReferral }: {
  cards: WalletCardSummary[];
  cardholderNames?: Readonly<Record<string, string>>;
  selectedCardId: string | null;
  onSelect: (id: string) => void;
  onOverview: () => void;
  onAdd: () => void;
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
}) {
  const collection = [...WALLET_DEMO_CARDS, ...cards];
  const [mode, setMode] = useState<"all" | "card">(selectedCardId ? "card" : "all");
  const [agentCardId, setAgentCardId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedCardId) { setMode("card"); setAgentCardId(selectedCardId); }
  }, [selectedCardId]);
  useEffect(() => {
    if (active && !selectedCardId) setMode("all");
  }, [active, selectedCardId]);
  const content = useRef<HTMLDivElement>(null);
  const automaticScrollUntil = useRef(0);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const element = content.current;
    const root = element?.closest<HTMLElement>("[data-app-scroll-root]");
    if (!active || !element || !root) return;
    // The Cards pane always starts at its deck; never inherit the taller Add
    // or Sharing pane's scroll offset during the resize/transition.
    const observer = new ResizeObserver(() => {
      automaticScrollUntil.current = performance.now() + 350;
      root.scrollTo({ top: 0, behavior: "instant" });
      observer.disconnect();
    });
    observer.observe(root.firstElementChild ?? element);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
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
  const goToTop = () => {
    const element = content.current;
    const root = element?.closest<HTMLElement>("[data-app-scroll-root]");
    if (!element || !root) return;
    const top = Math.max(0, Math.min(root.scrollHeight - root.clientHeight,
      root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top - 12));
    automaticScrollUntil.current = performance.now() + 350;
    root.scrollTo({ top, behavior: "instant" });
    if (dockHost) dockHost.setAttribute("data-scrolling-down", "false");
  };
  const choose = (id: string) => {
    if (isBusy) return;
    setAgentCardId(id);
    if (isAgentWalletCard(id)) onOverview();
    else onSelect(id);
    setMode("card");
    goToTop();
  };
  const showAll = () => {
    if (isBusy) return;
    setMode("all");
    setAgentCardId(null);
    onOverview();
    goToTop();
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
      <WalletAddCollection hintOwnerId={ownerId} cards={collection} selectedCardId={null} onSelect={choose} onOpen={choose} onAdd={onAdd} onRemove={onRemove} busyCardId={busyCardId} disabled={disabled} demoProfile={demoProfile} renderCard={(card) => isAgentWalletCard(card.cardId) ? <WalletDemoCardFace summary={card} profile={demoProfile} /> : <WalletCardFace summary={card} cardholderName={cardholderNames[card.cardId]} collection />} cardControlSummary={(card) => isAgentWalletCard(card.cardId) ? {
        title: card.nickname || "Agent One",
        fields: [
          { label: "Username", value: demoProfile?.cardPayload?.username || walletProfileUsername(demoProfile?.displayName ?? "") },
          { label: "Member since", value: demoProfile?.memberSince && !Number.isNaN(Date.parse(demoProfile.memberSince)) ? String(new Date(demoProfile.memberSince).getFullYear()) : "—" },
          { label: "Wallet ID", value: demoProfile?.walletId?.slice(-8).toUpperCase() || "—" },
        ],
      } : { title: card.nickname || cardNetworkLabel(card.brand) }} scrollReveal showActions={false} showDetailsLink />
      <div className={styles.quickActions}>
        <Button variant="secondary" size="standard" className="w-full" onClick={onAdd} disabled={isBusy}><Plus aria-hidden="true" />{cards.length ? "Add another card" : "Add a payment card"}</Button>

      </div>
    </> : <div key={selected.cardId} className="motion-step-enter space-y-5" data-testid="wallet-selected-card">
      <div className={styles.detailNavigation}><Button variant="ghost" size="compact" onClick={showAll} disabled={isBusy}><ArrowLeft aria-hidden="true" className="size-4" />All cards</Button><span>{index + 1} / {collection.length}</span><Button variant="ghost" size="compact" disabled={isBusy || index === collection.length - 1} aria-label="Next card" onClick={() => { const next = collection[index + 1]; if (next) choose(next.cardId); }}><ArrowRight aria-hidden="true" className="size-4" /></Button></div>
      <div data-swipe-views-horizontal-scroll onTouchStart={(event) => { const point = event.touches[0]; gesture.current = event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : null; }} onTouchEnd={finishSwipe} onTouchCancel={() => { gesture.current = null; }} className={styles.selectedFace}>
        {isAgentWalletCard(selected.cardId) ? <WalletDemoCardFace summary={selected} profile={demoProfile} /> : <WalletCardFace summary={selected} cardholderName={cardholderNames[selected.cardId]} collection />}
      </div>
      {selected.cardId === "agent-one-referral" ? <WalletReferralCardDetails summary={referralSummary ?? null} shareToken={demoProfile?.shareToken ?? null} profile={demoProfile} failed={referralError} onRetry={onRetryReferral} /> : isAgentWalletCard(selected.cardId) ? <div className="space-y-4">
        {selected.cardId === "agent-one-nws" ? <p className="text-sm text-muted-foreground">This is a sample score; no net worth evaluation has been run. Sharing uses your Wallet Profile and its scan totals.</p> : null}
        <WalletCardWorkspace embedded active={active} passVariant={selected.cardId === "agent-one-nws" ? "nws" : "profile"} />
      </div> : <div className="space-y-5">
        {active ? <WalletSharing cardDetails /> : null}
        {details}
      </div>}
    </div>}
    {active && dockHost ? createPortal(dock, dockHost) : null}

  </div>;
}
