"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { cardNetworkLabel } from "./card-network-mark";
import styles from "./wallet-card-gesture.module.css";

/** Card-local gestures only; opening this panel never reveals encrypted details. */
export function WalletCardSwipe({ card, children, disabled, onOpen, hint, dismissHint }: {
  card: WalletCardSummary; children: ReactNode; disabled: boolean;
  onOpen: () => void; hint: boolean; dismissHint: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [opened, setOpened] = useState(false);
  const drag = useRef<{ x:number; y:number; base:number; axis:"x"|"y"|null } | null>(null);
  const suppressClick = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  const liveOffset = useRef(0);
  const dismiss = useRef(dismissHint);
  useEffect(() => { dismiss.current = dismissHint; }, [dismissHint]);
  const moveCard = (value: number) => {
    liveOffset.current = value;
    setOffset(value);
  };
  useEffect(() => {
    const node = surface.current;
    if (!node || disabled) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || !event.deltaX || drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss.current();
      setDragging(true);
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
      moveCard(Math.max(-210, Math.min(0, liveOffset.current - event.deltaX * units)));
      clearTimeout(settle);
      settle = setTimeout(() => {
        const next = liveOffset.current < -65;
        setOpened(next);
        moveCard(next ? -190 : 0);
        setDragging(false);
      }, 120);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => { node.removeEventListener("wheel", onWheel); clearTimeout(settle); };
  }, [disabled]);
  const finish = (cancelled = false) => {
    if (!drag.current) return;
    const horizontal = drag.current.axis === "x";
    drag.current = null;
    setDragging(false);
    if (!horizontal) return;
    const next = cancelled ? opened : liveOffset.current < -65;
    setOpened(next);
    moveCard(next ? -190 : 0);
    if (!cancelled) dismissHint();
  };
  return <div ref={surface} className={styles.swipe} data-swipe-views-horizontal-scroll data-controls-open={opened}
    onPointerDown={event => {
      if (disabled || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest("[data-card-controls]")) return;
      suppressClick.current = false;
      drag.current = { x:event.clientX, y:event.clientY, base:opened ? -190 : 0, axis:null };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start) return;
      const dx = event.clientX-start.x, dy = event.clientY-start.y;
      if (!start.axis && Math.max(Math.abs(dx),Math.abs(dy)) > 8) {
        start.axis = Math.abs(dx) > Math.abs(dy)*1.3 ? "x" : "y";
        if (start.axis === "x") { event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); suppressClick.current = true; dismissHint(); }
      }
      if (start.axis === "x") moveCard(Math.max(-210,Math.min(0,start.base+dx)));
    }}
    onPointerUp={() => finish()}
    onPointerCancel={() => finish(true)}
    onClickCapture={event => { if (suppressClick.current && !(event.target as HTMLElement).closest("[data-card-controls]")) { event.preventDefault(); event.stopPropagation(); suppressClick.current=false; } }}>
    <div className={styles.controls} data-card-controls inert={!opened || undefined} aria-hidden={!opened || undefined}>
      <p>{cardNetworkLabel(card.brand)} •••• {card.last4}</p>
      <span>Expires {String(card.expiryMonth).padStart(2,"0")}/{String(card.expiryYear).slice(-2)}</span>
      <Button size="compact" disabled={disabled} onClick={onOpen}>View card details</Button>
      <Button size="compact" variant="ghost" onClick={() => { setOpened(false); moveCard(0); }}>Back to card</Button>
    </div>
    <div className={styles.slidingCard} style={{ transform:`translateX(${offset}px) rotateY(${offset/28}deg)`, transition:dragging ? "none" : undefined }}>
      {children}
      {hint && !opened ? <div data-wallet-swipe-hint className={styles.hint} aria-hidden="true"><span>Swipe left to see card controls</span><svg viewBox="0 0 64 64" fill="none"><path d="M25 34V13a5 5 0 0 1 10 0v17l3-4a4 4 0 0 1 7 1l2 4a4 4 0 0 1 7 2l2 10c1 6-2 10-7 16H28L14 41c-4-6 2-11 6-7l5 5" fill="white" stroke="#353535" strokeWidth="2" strokeLinejoin="round"/></svg></div> : null}
    </div>
  </div>;
}
