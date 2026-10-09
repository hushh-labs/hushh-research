"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { WalletCardSwipe, type WalletCardControlSummary } from "./wallet-card-swipe";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import { WALLET_DEMO_CARDS, WalletDemoCardFace, WalletDemoCardDetails, type WalletDemoProfile } from "@/components/wallet/wallet-demo-cards";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import styles from "./wallet-card-gesture.module.css";

/** Layout coordinates stay stable while the collection's entrance transforms animate. */
function layoutTop(element: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) {
    top += node.offsetTop + ((node.offsetParent as HTMLElement | null)?.clientTop ?? 0);
  }
  return top;
}

function EmptyCardPreview() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <figure className="space-y-3" data-testid="wallet-add-preview">
      <WalletAddCollection cards={WALLET_DEMO_CARDS} selectedCardId={selected} onSelect={setSelected}
        onAdd={() => {}} onRemove={() => {}} busyCardId={null} preview cardControlSummary={card => ({ title: card.nickname || "Agent One" })} />
      {selected ? <WalletDemoCardDetails cardId={selected} /> : null}
      <figcaption className="text-center text-xs text-muted-foreground">Example cards</figcaption>
    </figure>
  );
}

/** Cards collection presentation of the workspace's summaries; never fetches or reveals secrets. */
export function WalletAddCollection({ cards, selectedCardId, onSelect, onAdd, onRemove, busyCardId, disabled = false, preview = false, initialExpanded = false, scrollStack = false, showActions = true, showDetailsLink = false, scrollReveal = false, hintOwnerId, onOpen, demoProfile, renderCard, cardControlSummary }: {
  renderCard?: (card: WalletCardSummary) => ReactNode;
  cardControlSummary?: (card: WalletCardSummary) => WalletCardControlSummary;
  scrollStack?: boolean;
  scrollReveal?: boolean;
  hintOwnerId?: string;
  showDetailsLink?: boolean;
  initialExpanded?: boolean;
  showActions?: boolean;
  onOpen?: (id: string) => void;
  demoProfile?: WalletDemoProfile | null;
  disabled?: boolean;
  preview?: boolean;
  cards: WalletCardSummary[];
  selectedCardId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (card: WalletCardSummary) => void;
  busyCardId: string | null;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [hintOwner, setHintOwner] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollReveal || !hintOwnerId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const owner = hintOwnerId;
    void OnboardingLocalService.hasSeenWalletSwipeHint(owner).then(seen => {
      if (cancelled || seen) return;
      setHintOwner(owner);
      timer = setTimeout(() => {
        setHintOwner(null);
        void OnboardingLocalService.markWalletSwipeHintSeen(owner);
      }, 6800);
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [scrollReveal, hintOwnerId]);
  const dismissHint = () => {
    if (hintOwner && hintOwner === hintOwnerId) void OnboardingLocalService.markWalletSwipeHintSeen(hintOwner);
    setHintOwner(null);
  };
  const openCard = (cardId: string) => { dismissHint(); (onOpen ?? onSelect)(cardId); };
  const stackId = useId();
  const stackRef = useRef<HTMLDivElement>(null);
  const collectionRef = useRef<HTMLElement>(null);
  const start = useRef<{ x: number; y: number; time: number; cardId?: string } | null>(null);
  const suppressClickUntil = useRef(0);
  const selected = cards.find((card) => card.cardId === selectedCardId) ?? cards[0];
  // The scrolling deck keeps the same order when a card opens or its information updates.
  const displayCards = scrollReveal ? cards : selected ? [selected, ...cards.filter((card) => card !== selected)] : [];
  const depth = Math.min(3, Math.max(0, cards.length - 1));
  const canExpand = cards.length > 1;
  const isExpanded = canExpand && (expanded || scrollReveal);
  useEffect(() => {
    if (!scrollReveal || expanded) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stack = stackRef.current;
    if (!stack) return;
    // Nested shells and the document can both own native scrolling. Listen to
    // ancestors rather than assuming one named shell is always the scroll owner.
    const ancestors: HTMLElement[] = [];
    for (let element = stack.parentElement; element; element = element.parentElement) ancestors.push(element);
    const documentRoot = document.scrollingElement ?? document.documentElement;
    let frame = 0;
    let foldedGap = (showDetailsLink ? 52 : 0) + 36;
    let edgeStep = 28;
    const chrome = document.querySelector<HTMLElement>("[data-app-bottom-shell], [data-bottom-chrome]");
    const measureFit = () => {
      const collection = collectionRef.current;
      const host = collection?.parentElement;
      if (!collection || !host) return;
      const hostStyle = getComputedStyle(host);
      const hostWidth = host.clientWidth - parseFloat(hostStyle.paddingLeft || "0") - parseFloat(hostStyle.paddingRight || "0");
      if (hostWidth <= 0) { schedule(); return; }
      const viewportBottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
      const visibleBottom = Math.min(viewportBottom, chrome?.getBoundingClientRect().top ?? viewportBottom);
      const deckTop = layoutTop(stack);
      const room = Math.max(0, visibleBottom - deckTop);
      const detailsHeight = showDetailsLink ? 52 : 0;
      const visibleEdges = Math.min(2, cards.length - 1);
      // Reserve two real edge strips and a little air above the shared dock.
      // Only short windows use the smaller card measure; ordinary laptops and
      // phones keep their full available width, with a readable 260px floor.
      const fitWidth = Math.min(420, hostWidth, Math.max(260, (room - detailsHeight - visibleEdges * 12 - 8) * 85.6 / 53.98));
      const cardHeight = fitWidth * 53.98 / 85.6;
      edgeStep = Math.max(12, Math.min(28, (room - cardHeight - detailsHeight - 8) / Math.max(1, visibleEdges)));
      foldedGap = detailsHeight + Math.max(0, Math.min(36, room - cardHeight - detailsHeight - visibleEdges * edgeStep - 8));
      const nextWidth = `${fitWidth.toFixed(2)}px`;
      if (collection.style.getPropertyValue("--wallet-deck-max-width") !== nextWidth) collection.style.setProperty("--wallet-deck-max-width", nextWidth);
      schedule();
    };
    const update = () => {
      frame = 0;
      const cardHeight = stack.clientWidth * 53.98 / 85.6;
      const scrollers = ancestors.filter(element => element !== documentRoot &&
        (element.matches("[data-app-scroll-root]") || /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY)));
      const scrollOwners = [...scrollers, documentRoot];
      const offset = scrollOwners.reduce((total, element) => total + Math.max(0, element.scrollTop), 0);
      const available = scrollOwners.reduce((total, element) => total + Math.max(0, element.scrollHeight - element.clientHeight), 0);
      // The reserved final column gives native scrolling its full range. Finish
      // before that range ends, including short pages and tall desktop windows.
      const travel = Math.min(cardHeight, available * .8);
      const progress = reducedMotion.matches || travel <= 1 ? 1 : Math.min(1, offset / travel);
      const gap = (showDetailsLink ? 52 : 0) + 36;
      const layers = Array.from(stack.querySelectorAll<HTMLElement>("li[data-reveal-rank]"));
      stack.dataset.unfolded = String(progress === 1);
      layers.forEach(layer => {
        const rank = Number(layer.dataset.revealRank);
        const folded = rank ? cardHeight + foldedGap + (rank - 1) * edgeStep : 0;
        const lined = rank * (cardHeight + gap);
        const scale = rank ? 1 - Math.min(2, cards.length - 1 - rank) * .035 * (1 - progress) : 1;
        layer.style.transform = `translate3d(0, ${folded + (lined - folded) * progress}px, 0) scale(${scale})`;
        const details = layer.querySelector<HTMLElement>("[data-stack-details]");
        if (details) details.style.visibility = rank > 0 && progress < .98 ? "hidden" : "";
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(measureFit);
    observer.observe(stack);
    if (chrome) observer.observe(chrome);
    ancestors.forEach(element => { observer.observe(element); element.addEventListener("scroll", schedule, { passive: true }); });
    reducedMotion.addEventListener("change", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", measureFit);
    window.visualViewport?.addEventListener("resize", measureFit);
    // The entry transform changes visual bounds without a ResizeObserver
    // notification. Refit against the settled position, rather than retaining
    // a narrower cold-entry deck until the next tab/viewport change.
    const collection = collectionRef.current;
    collection?.addEventListener("animationend", measureFit);
    // These only schedule a read of the ensuing native scroll position. They
    // never consume input or manufacture progress when the page did not move.
    stack.addEventListener("wheel", schedule, { passive: true });
    stack.addEventListener("touchmove", schedule, { passive: true });
    measureFit();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener("change", schedule);
      ancestors.forEach(element => element.removeEventListener("scroll", schedule));
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", measureFit);
      window.visualViewport?.removeEventListener("resize", measureFit);
      collection?.removeEventListener("animationend", measureFit);
      stack.removeEventListener("wheel", schedule);
      stack.removeEventListener("touchmove", schedule);
      stack.querySelectorAll<HTMLElement>("[data-stack-details]").forEach(details => { details.style.visibility = ""; });
    };
  }, [scrollReveal, expanded, cards.length, showDetailsLink]);
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack || !isExpanded || scrollReveal) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scrollRoot = stack.closest<HTMLElement>("[data-app-scroll-root]");
    const target = scrollRoot ?? window;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scrollRoot?.getBoundingClientRect().top ?? 0;
      const layers = Array.from(stack.querySelectorAll<HTMLElement>("[data-card-motion]"));
      const stackBottom = stack.getBoundingClientRect().bottom;
      const frames = layers.map((card, rank) => {
        const bounds = card.parentElement!.getBoundingClientRect();
        const pinTop = top + rank * 20;
        const lift = scrollStack && !reducedMotion.matches
          ? Math.max(0, Math.min(pinTop - bounds.top, stackBottom - bounds.bottom))
          : 0;
        const progress = reducedMotion.matches ? 0 : Math.min(1, Math.max(0, (pinTop - bounds.top) / Math.max(1, bounds.height)));
        return { card, lift, scale: 1 - progress * 0.045, stacked: lift > 0 || progress > 0 };
      });
      frames.forEach(({ card, lift, scale, stacked }) => {
        card.style.transform = `translateY(${lift}px) scale(${scale})`;
        const details = card.querySelector<HTMLElement>("[data-stack-details]");
        if (details) details.style.visibility = stacked ? "hidden" : "";
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const settled = (event: TransitionEvent) => {
      if (event.propertyName === "transform" && event.target instanceof HTMLElement && event.target.tagName === "LI") schedule();
    };
    stack.addEventListener("transitionend", settled);
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    reducedMotion.addEventListener("change", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      stack.removeEventListener("transitionend", settled);
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      reducedMotion.removeEventListener("change", schedule);
      stack.querySelectorAll<HTMLElement>("[data-card-motion]").forEach((card) => { card.style.transform = ""; const details = card.querySelector<HTMLElement>("[data-stack-details]"); if (details) details.style.visibility = ""; });
    };
  }, [isExpanded, selectedCardId, cards.length, scrollStack, scrollReveal]);
  const endGesture = (event: TouchEvent) => {
    const origin = start.current;
    start.current = null;
    if (!origin || disabled || busyCardId) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dy = touch.clientY - origin.y;
    const dx = touch.clientX - origin.x;
    if (scrollReveal || !canExpand) return;
    // A short, directed flick changes presentation; slow page scrolling stays scrolling.
    // Never preventDefault or capture touch movement: the page remains the scroll owner.
    if (Date.now() - origin.time > 450 || Math.abs(dy) < 64 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
    suppressClickUntil.current = Date.now() + 400;
    setExpanded(dy < 0);
  };

  return (
    <section ref={collectionRef} style={scrollReveal ? { maxWidth: "var(--wallet-deck-max-width, 420px)" } : undefined} className={`motion-step-enter mx-auto w-full max-w-[420px] space-y-5 ${scrollReveal ? "py-0" : "py-4"}`} data-testid={preview ? "wallet-preview-collection" : "wallet-add-collection"} aria-label={preview && !renderCard ? "Example cards" : "Your cards"}>
      {!preview && !scrollReveal ? <div className="space-y-1">
        <h2 className={TYPOGRAPHY_CLASSNAMES.mediumRowLabel}>Your cards</h2>
        <p className={TYPOGRAPHY_CLASSNAMES.helperText}>
          {cards.length ? "Manage the cards available to your Wallet." : "No cards added yet."}
        </p>
      </div> : null}
      {!selected ? <EmptyCardPreview /> : null}
      {selected ? (
        <>
          <div
            ref={stackRef}
            id={stackId}
            className="@container relative isolate w-full"
            data-testid={preview ? "wallet-preview-stack" : "wallet-add-stack"}
            data-expanded={isExpanded}
            data-unfolded={expanded ? true : undefined}
            onKeyDownCapture={(event) => {
              // Tab exposes the whole keyboard traversal; pointer focus and
              // horizontal card controls must never move the vertical deck.
              if (scrollReveal && event.key === "Tab") setExpanded(true);
            }}
            onTouchStart={(event) => {
              suppressClickUntil.current = 0;
              const touch = event.touches[0];
              start.current = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, time: Date.now(), cardId: (event.target as HTMLElement).closest<HTMLElement>("[data-gesture-card]")?.dataset.gestureCard } : null;
            }}
            onTouchMove={(event) => { if (event.touches.length !== 1) start.current = null; }}
            onTouchEnd={endGesture}
            onTouchCancel={() => { start.current = null; }}
          >
            {/* In-flow geometry reserves the whole stack; only the cards' transforms animate. */}
            <div aria-hidden="true" style={{ height: isExpanded
              ? `calc(${cards.length} * 100cqw * 53.98 / 85.6 + ${(cards.length - 1) * (scrollReveal ? 36 : 16) + (showDetailsLink ? cards.length * 52 : 0) + (scrollReveal ? 32 : 0)}px)`
              : `calc(100cqw * 53.98 / 85.6 + ${depth * 20}px)` }} />
            <ul className="absolute inset-x-0 top-0 m-0 list-none p-0" aria-label={preview && !renderCard ? "Example cards" : "Your cards"}>
              {cards.map((card) => {
                const rank = displayCards.indexOf(card);
                const active = rank === 0;
                const hidden = !isExpanded && rank > 3;
                const scale = scrollReveal && !expanded ? (rank ? 1 - Math.min(2, cards.length - 1 - rank) * .035 : 1) : isExpanded ? 1 : 1 - Math.min(rank, 3) * .045;
                const y = scrollReveal && !expanded ? (rank ? `calc(100cqw * 53.98 / 85.6 + ${(showDetailsLink ? 52 : 0) + 36 + (rank - 1) * 28}px)` : "0px") : isExpanded ? `calc(${rank} * (100% + ${scrollReveal ? 36 : 16}px))` : `${(depth - Math.min(rank, depth)) * 20}px`;
                return (
                  <li key={card.cardId} data-gesture-card={card.cardId} data-reveal-rank={rank}
                    className={`absolute inset-x-0 top-0 origin-top ${scrollReveal ? "" : "[transition:transform_300ms_var(--motion-ease-decelerate),opacity_220ms_ease-out]"} motion-reduce:[transition:none] ${!isExpanded && !active ? "[&_[data-testid=wallet-card-face]>span]:invisible" : ""}`}
                    aria-hidden={hidden || undefined} inert={hidden || undefined}
                    data-testid={preview ? `wallet-preview-layer-${card.cardId}` : `wallet-add-layer-${card.last4 || card.cardId}`} data-selected={active}
                    style={{ transform: `translate3d(0, ${y}, 0) scale(${scale})`,
                      zIndex: scrollReveal ? (active ? cards.length + 1 : rank) : isExpanded && scrollStack ? rank + 1 : cards.length - rank, opacity: hidden || busyCardId === card.cardId ? 0 : 1,
                      pointerEvents: hidden ? "none" : undefined }}>
                    <div data-card-motion className="relative origin-bottom">
                    <WalletCardSwipe card={card} disabled={disabled || Boolean(busyCardId)} onOpen={() => openCard(card.cardId)} summary={cardControlSummary?.(card)} hint={scrollReveal && active && Boolean(hintOwnerId) && hintOwner === hintOwnerId} dismissHint={dismissHint}>
                    <button type="button"
                      disabled={disabled || Boolean(busyCardId)}
                      aria-label={cardControlSummary?.(card).title ?? (preview ? card.nickname : `${card.nickname || cardNetworkLabel(card.brand)}, ${cardNetworkLabel(card.brand)} ending in ${card.last4}`)}
                      aria-pressed={active}
                      onClick={(event) => {
                        if (event.detail > 0 && Date.now() < suppressClickUntil.current) return;
                        if (onOpen) { openCard(card.cardId); }
                        else if (preview) { onSelect(card.cardId); setExpanded(false); }
                        else if (active) setExpanded(!isExpanded);
                        else { onSelect(card.cardId); setExpanded(false); }
                      }}
                      className="block origin-bottom w-full rounded-[3.72cqw] text-left outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                      {renderCard ? renderCard(card) : preview ? <WalletDemoCardFace summary={card} profile={demoProfile} /> : <WalletCardFace summary={card} collection />}
                    </button>
                    </WalletCardSwipe>
                    {showDetailsLink && isExpanded ? <div data-stack-details className="flex h-[52px] items-center justify-center"><ShellActionSurface variant="pill" className={styles.detailsButton} disabled={disabled || Boolean(busyCardId)} onClick={() => openCard(card.cardId)} aria-label={`View details for ${cardControlSummary?.(card).title ?? card.nickname ?? cardNetworkLabel(card.brand)}`}><span data-card-details-label className={styles.detailsLabel}>View details <span aria-hidden="true">›</span></span></ShellActionSurface></div> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {canExpand && !scrollReveal ? <Button variant="ghost" size="compact" disabled={disabled || Boolean(busyCardId)} aria-expanded={isExpanded} aria-controls={stackId}
              onClick={() => setExpanded(!isExpanded)}>
              {isExpanded ? "Collapse cards" : `View all ${cards.length} cards`}
            </Button> : <span />}
            {showDetailsLink && !isExpanded ? <ShellActionSurface variant="pill" className={styles.detailsButton} disabled={disabled || Boolean(busyCardId)} onClick={() => openCard(selected.cardId)}><span data-card-details-label className={styles.detailsLabel}>View details <span aria-hidden="true">›</span></span></ShellActionSurface> : null}
            {!preview && showActions ? <Button variant="ghost" size="compact" disabled={disabled || Boolean(busyCardId)}
              onClick={() => { setExpanded(false); onRemove(selected); }}>
              Remove card
            </Button> : null}
          </div>
        </>
      ) : null}
      {!preview && showActions ? <Button variant="secondary" size="standard" className="w-full" onClick={onAdd} disabled={disabled || Boolean(busyCardId)}>
        <Plus aria-hidden="true" />{cards.length ? "Add another card" : "Add your first card"}
      </Button> : null}
    </section>
  );
}
