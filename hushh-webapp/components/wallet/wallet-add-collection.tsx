"use client";

import { useEffect, useId, useRef, useState, type TouchEvent } from "react";
import { Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import { WALLET_DEMO_CARDS, WalletDemoCardFace, WalletDemoCardDetails } from "@/components/wallet/wallet-demo-cards";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";


function EmptyCardPreview() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <figure className="space-y-3" data-testid="wallet-add-preview">
      <WalletAddCollection cards={WALLET_DEMO_CARDS} selectedCardId={selected} onSelect={setSelected}
        onAdd={() => {}} onRemove={() => {}} busyCardId={null} preview />
      {selected ? <WalletDemoCardDetails cardId={selected} /> : null}
      <figcaption className="text-center text-xs text-muted-foreground">Example cards</figcaption>
    </figure>
  );
}

/** Cards collection presentation of the workspace's summaries; never fetches or reveals secrets. */
export function WalletAddCollection({ cards, selectedCardId, onSelect, onAdd, onRemove, busyCardId, disabled = false, preview = false, initialExpanded = false, scrollStack = false, showActions = true, showDetailsLink = false, onOpen }: {
  scrollStack?: boolean;
  showDetailsLink?: boolean;
  initialExpanded?: boolean;
  showActions?: boolean;
  onOpen?: (id: string) => void;
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
  const stackId = useId();
  const stackRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; time: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const selected = cards.find((card) => card.cardId === selectedCardId) ?? cards[0];
  // Derive presentation order only. The workspace and encrypted store retain their order.
  const displayCards = selected ? [selected, ...cards.filter((card) => card !== selected)] : [];
  const depth = Math.min(3, Math.max(0, cards.length - 1));
  const canExpand = cards.length > 1;
  const isExpanded = canExpand && expanded;
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack || !isExpanded) return;
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
  }, [isExpanded, selectedCardId, cards.length, scrollStack]);
  const endGesture = (event: TouchEvent) => {
    const origin = start.current;
    start.current = null;
    if (!origin || !canExpand) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dy = touch.clientY - origin.y;
    const dx = touch.clientX - origin.x;
    // A short, directed flick changes presentation; slow page scrolling stays scrolling.
    // Never preventDefault or capture touch movement: the page remains the scroll owner.
    if (Date.now() - origin.time > 450 || Math.abs(dy) < 64 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
    suppressClickUntil.current = Date.now() + 400;
    setExpanded(dy < 0);
  };

  return (
    <section className="motion-step-enter mx-auto w-full max-w-[420px] space-y-5 py-4" data-testid={preview ? "wallet-preview-collection" : "wallet-add-collection"} aria-label={preview ? "Example cards" : "Your cards"}>
      {!preview ? <div className="space-y-1">
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
            onTouchStart={(event) => {
              suppressClickUntil.current = 0;
              const touch = event.touches[0];
              start.current = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, time: Date.now() } : null;
            }}
            onTouchMove={(event) => { if (event.touches.length !== 1) start.current = null; }}
            onTouchEnd={endGesture}
            onTouchCancel={() => { start.current = null; }}
          >
            {/* In-flow geometry reserves the whole stack; only the cards' transforms animate. */}
            <div aria-hidden="true" style={{ height: isExpanded
              ? `calc(${cards.length} * 100cqw * 53.98 / 85.6 + ${(cards.length - 1) * 16 + (showDetailsLink ? cards.length * 40 : 0)}px)`
              : `calc(100cqw * 53.98 / 85.6 + ${depth * 20}px)` }} />
            <ul className="absolute inset-x-0 top-0 m-0 list-none p-0" aria-label={preview ? "Example cards" : "Saved cards"}>
              {cards.map((card) => {
                const rank = displayCards.indexOf(card);
                const active = rank === 0;
                const hidden = !isExpanded && rank > 3;
                const y = isExpanded ? `calc(${rank} * (100% + 16px))` : `${(depth - Math.min(rank, depth)) * 20}px`;
                return (
                  <li key={card.cardId}
                    className={`absolute inset-x-0 top-0 origin-top [transition:transform_300ms_var(--motion-ease-decelerate),opacity_220ms_ease-out] motion-reduce:[transition:none] ${!isExpanded && !active ? "[&_[data-testid=wallet-card-face]>span]:invisible" : ""}`}
                    aria-hidden={hidden || undefined} inert={hidden || undefined}
                    data-testid={preview ? `wallet-preview-layer-${card.cardId}` : `wallet-add-layer-${card.last4}`} data-selected={active}
                    style={{ transform: `translate3d(0, ${y}, 0) scale(${isExpanded ? 1 : 1 - Math.min(rank, 3) * 0.045})`,
                      zIndex: isExpanded && scrollStack ? rank + 1 : cards.length - rank, opacity: hidden || busyCardId === card.cardId ? 0 : 1,
                      pointerEvents: hidden ? "none" : undefined }}>
                    <div data-card-motion className="origin-bottom">
                    <button type="button"
                      disabled={disabled || Boolean(busyCardId)}
                      aria-label={preview ? card.nickname : `${card.nickname || cardNetworkLabel(card.brand)}, ${cardNetworkLabel(card.brand)} ending in ${card.last4}`}
                      aria-pressed={active}
                      onClick={(event) => {
                        if (event.detail > 0 && Date.now() < suppressClickUntil.current) return;
                        if (onOpen) { onOpen(card.cardId); }
                        else if (preview) { onSelect(card.cardId); setExpanded(false); }
                        else if (active) setExpanded(!isExpanded);
                        else { onSelect(card.cardId); setExpanded(false); }
                      }}
                      className="block origin-bottom w-full rounded-[3.72cqw] text-left outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                      {preview ? <WalletDemoCardFace summary={card} /> : <WalletCardFace summary={card} collection />}
                    </button>
                    {showDetailsLink && isExpanded ? <div data-stack-details className="flex h-10 items-center justify-center"><Button variant="ghost" size="compact" disabled={disabled || Boolean(busyCardId)} onClick={() => onOpen?.(card.cardId)} aria-label={`View details for ${card.nickname || cardNetworkLabel(card.brand)}`}>View details <span aria-hidden="true">›</span></Button></div> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {canExpand ? <Button variant="ghost" size="compact" disabled={disabled || Boolean(busyCardId)} aria-expanded={isExpanded} aria-controls={stackId}
              onClick={() => setExpanded(!isExpanded)}>
              {isExpanded ? "Collapse cards" : `View all ${cards.length} cards`}
            </Button> : <span />}
            {showDetailsLink && !isExpanded ? <Button variant="ghost" size="compact" disabled={disabled || Boolean(busyCardId)} onClick={() => onOpen?.(selected.cardId)}>View details <span aria-hidden="true">›</span></Button> : null}
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
