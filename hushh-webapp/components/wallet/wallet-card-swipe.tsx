"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { RowDescription, RowLabel } from "@/components/app-ui/typography";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { cardNetworkLabel } from "./card-network-mark";
import styles from "./wallet-card-gesture.module.css";

export type WalletCardControlSummary = {
  title: string;
  subtitle?: string;
  /** Only safe summary fields supplied by the card's owner data source. */
  fields?: readonly { label: string; value: string }[];
};

/** Card-local gestures only; opening this panel never reveals encrypted details. */
export function WalletCardSwipe({ card, children, disabled, hint, dismissHint, summary }: {
  card: WalletCardSummary; children: ReactNode; disabled: boolean;
  onOpen: () => void; hint: boolean; dismissHint: () => void;
  summary?: WalletCardControlSummary;
}) {
  const [opened, setOpened] = useState(false);
  const drag = useRef<{ x: number; y: number; base: number; axis: "x" | "y" | null } | null>(null);
  const suppressClick = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  const slidingCard = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const liveOffset = useRef(0);
  const openedRef = useRef(false);
  const dismiss = useRef(dismissHint);
  useEffect(() => { dismiss.current = dismissHint; }, [dismissHint]);
  const revealWidth = useCallback(() => controls.current?.offsetWidth || 190, []);
  // Gesture frames change a local transform, never React or page layout.
  const moveCard = useCallback((value: number, dragging = false) => {
    liveOffset.current = value;
    if (slidingCard.current) {
      slidingCard.current.style.transform = `translate3d(${value}px, 0, 0)`;
      slidingCard.current.dataset.dragging = String(dragging);
    }
  }, []);
  const settle = useCallback((next: boolean, returnFocus = false) => {
    openedRef.current = next;
    setOpened(next);
    moveCard(next ? -revealWidth() : 0);
    if (returnFocus) slidingCard.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [moveCard, revealWidth]);
  useEffect(() => {
    if (opened) closeButton.current?.focus({ preventScroll: true });
  }, [opened]);
  useEffect(() => {
    const node = surface.current;
    if (!node || disabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || !event.deltaX || drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss.current();
      const width = revealWidth();
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
      moveCard(Math.max(-width, Math.min(0, liveOffset.current - event.deltaX * units)), true);
      clearTimeout(timer);
      timer = setTimeout(() => settle(liveOffset.current < -width * .3), 120);
    };
    const observer = new ResizeObserver(() => {
      if (!drag.current) moveCard(openedRef.current ? -revealWidth() : 0);
    });
    observer.observe(node);
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => { observer.disconnect(); node.removeEventListener("wheel", onWheel); clearTimeout(timer); };
  }, [disabled, moveCard, revealWidth, settle]);
  const finish = (cancelled = false) => {
    if (!drag.current) return;
    const horizontal = drag.current.axis === "x";
    drag.current = null;
    if (!horizontal) return;
    settle(cancelled ? openedRef.current : liveOffset.current < -revealWidth() * .3);
    if (!cancelled) dismissHint();
  };
  const label = summary ?? {
    title: `${cardNetworkLabel(card.brand)} •••• ${card.last4}`,
  };
  // A title supplied for a saved payment card must not erase its safe summary.
  // This uses the list response only; swiping never requests decrypted data.
  const fields = summary?.fields?.length ? summary.fields : card.last4 ? [
    { label: "Network", value: cardNetworkLabel(card.brand) },
    { label: "Card number", value: `•••• ${card.last4}` },
    { label: "Expires", value: `${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).slice(-2)}` },
  ] : [];
  return <div ref={surface} className={styles.swipe} data-swipe-views-horizontal-scroll data-controls-open={opened}
    onKeyDown={event => {
      if (disabled) return;
      if (event.key === "ArrowLeft" && !opened) { event.preventDefault(); event.stopPropagation(); dismissHint(); settle(true); }
      if ((event.key === "Escape" || event.key === "ArrowRight") && opened) { event.preventDefault(); event.stopPropagation(); settle(false, true); }
    }}
    onPointerDown={event => {
      if (disabled || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest("[data-card-controls]")) return;
      suppressClick.current = false;
      drag.current = { x: event.clientX, y: event.clientY, base: liveOffset.current, axis: null };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!start.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
        start.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? "x" : "y";
        if (start.axis === "x") { event.currentTarget.setPointerCapture(event.pointerId); suppressClick.current = true; dismissHint(); }
      }
      if (start.axis === "x") moveCard(Math.max(-revealWidth(), Math.min(0, start.base + dx)), true);
    }}
    onPointerUp={() => finish()}
    onPointerCancel={() => finish(true)}
    onClickCapture={event => {
      if (suppressClick.current && event.detail > 0 && !(event.target as HTMLElement).closest("[data-card-controls]")) {
        event.preventDefault(); event.stopPropagation(); suppressClick.current = false;
      }
    }}>
    <div ref={controls} className={styles.controls} data-card-controls inert={!opened || undefined} aria-hidden={!opened || undefined}>
      <div className={styles.controlHeader}>
        <RowLabel as="p" compact className="min-w-0 [overflow-wrap:anywhere]">{label.title}</RowLabel>
        <ShellActionSurface ref={closeButton} aria-label="Back to card" className="size-11 shrink-0" onClick={() => settle(false, true)}><X aria-hidden="true" className="size-4" /></ShellActionSurface>
      </div>
      {label.subtitle ? <RowDescription compact className="px-2">{label.subtitle}</RowDescription> : null}
      <SettingsGroup embedded density="compact" separatorInset shellClassName="bg-transparent shadow-none">
        {fields.map(field => <SettingsRow key={field.label} title={field.label} description={field.value} className="[--settings-row-px:8px]" />)}
      </SettingsGroup>
    </div>
    <div ref={slidingCard} className={styles.slidingCard}>
      {children}
      {hint && !opened ? <div data-wallet-swipe-hint className={styles.hint} aria-hidden="true"><span className={styles.hintLabel}>Swipe left to see card controls</span><div className={styles.hintGesture}><span className={styles.hintTrail}>←</span><svg viewBox="0 0 64 64" fill="none"><path d="M25 34V13a5 5 0 0 1 10 0v17l3-4a4 4 0 0 1 7 1l2 4a4 4 0 0 1 7 2l2 10c1 6-2 10-7 16H28L14 41c-4-6 2-11 6-7l5 5" fill="white" stroke="#353535" strokeWidth="2" strokeLinejoin="round"/></svg></div></div> : null}
    </div>
  </div>;
}
