"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { formatCardExpiry } from "@/lib/wallet/wallet-card-presentation";
import styles from "./wallet-card-stack.module.css";

export interface WalletCardStackProps {
  cards: WalletCardSummary[];
  focusedCardId: string | null;
  detailsId: string;
  onSelect: (cardId: string) => void;
  active?: boolean;
  detailsOpen?: boolean;
  removingCardId?: string | null;
  details?: ReactNode;
}

/** Presentation only: cards stay in service order; selection never grants reveal authority. */
export const WalletCardStack = forwardRef<HTMLDivElement, WalletCardStackProps>(
  function WalletCardStack(
    {
      cards,
      focusedCardId,
      detailsId,
      onSelect,
      active = true,
      detailsOpen = false,
      removingCardId,
      details,
    },
    forwardedRef,
  ) {
    const root = useRef<HTMLDivElement>(null);
    useImperativeHandle(forwardedRef, () => root.current!, []);
    const [expanded, setExpanded] = useState(false);
    const [expandedOrder, setExpandedOrder] = useState<string[]>([]);
    const listId = useId();
    const nodes = useRef(new Map<string, HTMLLIElement>());
    const gesture = useRef<{ x: number; y: number; time: number } | null>(null);
    const suppressClickUntil = useRef(0);
    const selected =
      cards.find((card) => card.cardId === focusedCardId) ?? cards[0];
    const selectedId = selected?.cardId;
    const latest = useRef({ onSelect, selectedId });
    latest.current = { onSelect, selectedId };
    const visualStackOrder = selected
      ? [
          selected.cardId,
          ...cards
            .filter((card) => card.cardId !== selected.cardId)
            .map((card) => card.cardId),
        ]
      : [];
    const order = expanded
      ? expandedOrder
          .filter((id) => cards.some((card) => card.cardId === id))
          .concat(
            cards
              .filter((card) => !expandedOrder.includes(card.cardId))
              .map((card) => card.cardId),
          )
      : visualStackOrder;
    const depth = Math.min(3, Math.max(0, cards.length - 1));
    const reduced = () =>
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const bringIntoView = () =>
      root.current?.scrollIntoView?.({
        block: "nearest",
        behavior: reduced() ? "auto" : "smooth",
      });
    const choose = (id: string) => {
      onSelect(id);
      setExpanded(false);
      requestAnimationFrame(bringIntoView);
    };
    const toggleExpanded = () => {
      if (selectedId) onSelect(selectedId); // Mask an existing reveal before opening overview.
      if (!expanded) setExpandedOrder(visualStackOrder);
      setExpanded(!expanded);
      if (expanded) requestAnimationFrame(bringIntoView);
    };

    useEffect(() => {
      if (!active || detailsOpen) setExpanded(false);
    }, [active, detailsOpen]);
    useEffect(() => {
      if (!active || !expanded || !root.current) return;
      const scrollRoot = root.current.closest<HTMLElement>(
        '[data-app-scroll-root="true"]',
      );
      const visible = new Map<string, number>();
      const height = scrollRoot?.clientHeight ?? window.innerHeight;
      const cardHeight =
        nodes.current.values().next().value?.getBoundingClientRect().height ??
        240;
      const inset = Math.max(0, (height - cardHeight * 1.4) / 2);
      // Observe visibility thresholds, then choose the card nearest the reading
      // region's center. A 24px dead band prevents adjacent cards oscillating.
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            visible.set(
              (entry.target as HTMLElement).dataset.cardId!,
              entry.intersectionRatio,
            );
          const bounds = scrollRoot?.getBoundingClientRect();
          const center =
            (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) * 0.5;
          const candidates = [...visible]
            .filter(([, ratio]) => ratio >= 0.65)
            .map(([id]) => {
              const box = nodes.current.get(id)!.getBoundingClientRect();
              return {
                id,
                distance: Math.abs(box.top + box.height / 2 - center),
              };
            })
            .sort((a, b) => a.distance - b.distance);
          const best = candidates[0];
          const current = candidates.find(
            (card) => card.id === latest.current.selectedId,
          );
          if (
            best &&
            best.id !== latest.current.selectedId &&
            (!current || best.distance + 24 < current.distance)
          )
            latest.current.onSelect(best.id);
        },
        {
          root: scrollRoot,
          rootMargin: `-${inset}px 0px -${inset}px 0px`,
          threshold: [0, 0.25, 0.5, 0.6, 0.65, 0.8, 1],
        },
      );
      nodes.current.forEach((node) => observer.observe(node));
      return () => observer.disconnect();
    }, [active, expanded, cards]);

    if (!selected) return null;
    const selectedIndex = cards.findIndex((card) => card.cardId === selectedId);
    return (
      <div
        ref={root}
        className="mx-auto w-full max-w-[420px] space-y-4"
        data-testid="wallet-stack"
        data-state={expanded ? "expanded" : "collapsed"}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Your cards</p>
          <span
            className="text-xs text-muted-foreground tabular-nums"
            aria-live="polite"
            aria-atomic="true"
          >
            <span key={selectedId} className={styles.count}>
              {selectedIndex + 1} of {cards.length}
            </span>
          </span>
        </div>
        <div
          className="@container relative isolate w-full touch-pan-y"
          data-swipe-views-horizontal-scroll="true"
          onTouchStart={(event) => {
            const touch = event.touches[0];
            gesture.current =
              event.touches.length === 1 && touch
                ? { x: touch.clientX, y: touch.clientY, time: Date.now() }
                : null;
          }}
          onTouchMove={(event) => {
            const start = gesture.current,
              touch = event.touches[0];
            if (!start || !touch) return;
            // Once vertical intent wins, leave the entire gesture to page scrolling.
            if (
              event.touches.length !== 1 ||
              Math.abs(touch.clientY - start.y) >
                Math.max(12, Math.abs(touch.clientX - start.x))
            )
              gesture.current = null;
          }}
          onTouchCancel={() => {
            gesture.current = null;
          }}
          onTouchEnd={(event) => {
            const start = gesture.current;
            gesture.current = null;
            const touch = event.changedTouches[0];
            if (!start || !touch || Date.now() - start.time > 650) return;
            const dx = touch.clientX - start.x,
              dy = touch.clientY - start.y;
            if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
            const next = cards[selectedIndex + (dx < 0 ? 1 : -1)];
            suppressClickUntil.current = Date.now() + 400;
            if (next) choose(next.cardId);
          }}
        >
          <div
            aria-hidden="true"
            data-slot="wallet-stack-spacer"
            style={{
              height: expanded
                ? `calc(${cards.length} * 100cqw * 53.98 / 85.6 + ${Math.max(0, cards.length - 1) * 24}px)`
                : `calc(100cqw * 53.98 / 85.6 + ${depth} * clamp(28px, 8cqw, 34px))`,
            }}
          />
          <ul
            id={listId}
            data-testid="one-wallet-list"
            aria-label="Cards"
            className="absolute inset-x-0 top-0 m-0 list-none p-0"
          >
            {cards.map((card) => {
              const rank = order.indexOf(card.cardId),
                focused = card.cardId === selectedId;
              const hidden = !expanded && rank > 3,
                removing = card.cardId === removingCardId;
              const y = expanded
                ? `calc(${rank} * (100cqw * 53.98 / 85.6 + 24px))`
                : `calc(${Math.min(rank, 3)} * clamp(28px, 8cqw, 34px))`;
              return (
                <li
                  key={card.cardId}
                  ref={(node) => {
                    if (node) nodes.current.set(card.cardId, node);
                    else nodes.current.delete(card.cardId);
                  }}
                  data-testid="wallet-card"
                  data-card-id={card.cardId}
                  data-focused={focused}
                  aria-hidden={hidden || undefined}
                  inert={hidden || undefined}
                  className={`absolute inset-x-0 top-0 origin-top ${styles.layer}`}
                  style={{
                    transform: `translate3d(0, calc(${y} + ${removing ? 16 : 0}px), 0) scale(${removing ? 0.96 : expanded ? 1 : 1 - Math.min(rank, 3) * 0.015})`,
                    opacity: hidden || removing ? 0 : 1,
                    zIndex: expanded ? 1 : cards.length - rank,
                    pointerEvents: hidden || removing ? "none" : undefined,
                  }}
                >
                  <button
                    type="button"
                    data-testid={`one-wallet-card-${card.last4}`}
                    aria-label={`${card.nickname || cardNetworkLabel(card.brand)}, ${cardNetworkLabel(card.brand)} ending ${card.last4}`}
                    aria-pressed={focused}
                    aria-controls={focused ? detailsId : undefined}
                    onClick={(event) => {
                      if (
                        event.detail === 0 ||
                        Date.now() >= suppressClickUntil.current
                      )
                        choose(card.cardId);
                    }}
                    className="block w-full rounded-[3.72cqw] text-left outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <WalletCardFace summary={card} collection>
                      <MaterialRipple variant="none" effect="fill" />
                    </WalletCardFace>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {cards.length > 1 ? (
            <Button
              variant="ghost"
              size="compact"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={toggleExpanded}
            >
              {expanded ? "Collapse cards" : "View all cards"}
            </Button>
          ) : (
            <span />
          )}
          {!expanded && cards.length > 4 ? (
            <span className="text-xs text-muted-foreground">
              +{cards.length - 4} more
            </span>
          ) : null}
          {cards.length > 1 ? (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="compact"
                aria-label="Previous card"
                disabled={selectedIndex === 0}
                onClick={() =>
                  cards[selectedIndex - 1] &&
                  choose(cards[selectedIndex - 1]!.cardId)
                }
              >
                Previous
              </Button>
              <Button
                variant="ghost"
                size="compact"
                aria-label="Next card"
                disabled={selectedIndex === cards.length - 1}
                onClick={() =>
                  cards[selectedIndex + 1] &&
                  choose(cards[selectedIndex + 1]!.cardId)
                }
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
        {!expanded ? (
          <div id={detailsId} className="space-y-4">
            <div className="text-center">
              <p className="text-sm font-medium">
                {selected.nickname || cardNetworkLabel(selected.brand)}
              </p>
              <p className="text-xs text-muted-foreground">
                •••• {selected.last4} · Expires{" "}
                {formatCardExpiry(selected.expiryMonth, selected.expiryYear)}
              </p>
            </div>
            {details}
          </div>
        ) : null}
      </div>
    );
  },
);
