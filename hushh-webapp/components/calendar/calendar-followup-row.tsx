"use client";

import { useCallback, useEffect, useId, useRef, type PointerEvent } from "react";
import { CheckIcon, Mail, XIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import styles from "./calendar-insights.module.css";

const AXIS_THRESHOLD = 10;
const COMMIT_DISTANCE = 84;
const MAX_REVEAL = 132;
const TRACKPAD_IDLE_MS = 140;
// A committed gesture must not also affect the next row as momentum settles.
let trackpadCooldownUntil = 0;

export function CalendarFollowupRow({ title, description, busy, onReview, onKeep, onRemove }: {
  title: string;
  description: string;
  busy: boolean;
  onReview: (trigger: HTMLButtonElement) => void;
  onKeep: () => void;
  onRemove: (trigger: HTMLButtonElement) => void;
}) {
  const hint = useId();
  const container = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLDivElement>(null);
  const remove = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; offset: number; horizontal: boolean } | null>(null);
  const suppressClick = useRef(false);
  const actions = useRef({ onKeep, onRemove });
  useEffect(() => {
    actions.current = { onKeep, onRemove };
  }, [onKeep, onRemove]);
  const cancelTrackpad = useRef<() => void>(() => undefined);

  const paint = useCallback((offset: number) => {
    if (row.current) row.current.style.transform = offset ? `translate3d(${offset}px,0,0)` : "";
    if (keep.current) keep.current.style.opacity = String(Math.min(1, Math.max(0, offset / COMMIT_DISTANCE)));
    if (remove.current) remove.current.style.opacity = String(Math.min(1, Math.max(0, -offset / COMMIT_DISTANCE)));
  }, []);

  useEffect(() => {
    const target = container.current;
    if (!target || busy) return;
    let offset = 0;
    let timer: number | undefined;
    const cancel = () => {
      window.clearTimeout(timer);
      offset = 0;
      paint(0);
    };
    cancelTrackpad.current = cancel;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || drag.current || !event.deltaX || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.15) return;
      event.preventDefault();
      event.stopPropagation();
      if (performance.now() < trackpadCooldownUntil) return;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.clientWidth : 1;
      offset = Math.max(-MAX_REVEAL, Math.min(MAX_REVEAL, offset - event.deltaX * units));
      paint(offset);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const released = offset;
        cancel();
        if (Math.abs(released) < COMMIT_DISTANCE || performance.now() < trackpadCooldownUntil) return;
        trackpadCooldownUntil = performance.now() + 450;
        if (released < 0 && row.current) actions.current.onRemove(row.current);
        if (released > 0) actions.current.onKeep();
      }, TRACKPAD_IDLE_MS);
    };
    target.addEventListener("wheel", wheel, { passive: false });
    return () => {
      target.removeEventListener("wheel", wheel);
      cancel();
      cancelTrackpad.current = () => undefined;
    };
  }, [busy, paint]);

  const reset = () => {
    drag.current = null;
    paint(0);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.horizontal) {
      if (Math.hypot(dx, dy) < AXIS_THRESHOLD) return;
      suppressClick.current = true;
      if (Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      current.horizontal = true;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId) === false) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }
    current.offset = Math.max(-MAX_REVEAL, Math.min(MAX_REVEAL, dx));
    paint(current.offset);
  };

  return <div ref={container} className="relative isolate min-w-0 overflow-hidden border-t first:border-t-0" data-no-route-swipe data-swipe-views-horizontal-scroll>
    <div ref={keep} aria-hidden="true" className={styles.keepReveal}><CheckIcon className="size-4" /> Keep</div>
    <div ref={remove} aria-hidden="true" className={styles.removeReveal}>Remove <XIcon className="size-4" /></div>
    <Button ref={row} variant="ghost" size="compact" type="button" className={styles.followupRow}
      disabled={busy} aria-label={`Review ${title}`} aria-describedby={hint}
      aria-keyshortcuts="ArrowRight Delete Backspace"
      onPointerDown={event => {
        suppressClick.current = false;
        if (event.isPrimary === false || event.button !== 0 || (event.pointerType === "touch" && event.clientX <= 28)) return;
        cancelTrackpad.current();
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset: 0, horizontal: false };
      }}
      onPointerMove={move}
      onPointerUp={event => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        reset();
        if (current.offset <= -COMMIT_DISTANCE) onRemove(event.currentTarget);
        if (current.offset >= COMMIT_DISTANCE) onKeep();
      }}
      onPointerCancel={reset}
      onLostPointerCapture={reset}
      onContextMenu={event => {
        event.preventDefault();
        onRemove(event.currentTarget);
      }}
      onClick={event => {
        if (event.detail !== 0 && suppressClick.current) return;
        onReview(event.currentTarget);
      }}
      onKeyDown={event => {
        if (!["ArrowRight", "Delete", "Backspace"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "ArrowRight") onKeep(); else onRemove(event.currentTarget);
      }}>
      <Mail className="size-4 shrink-0 text-[var(--app-accent)]" aria-hidden />
      <span className={styles.copy}><strong className="line-clamp-2">{title}</strong>
        <span className={styles.muted}>{description}</span></span>
      <span className={styles.reviewLabel}>Review</span>
    </Button>
    <span id={hint} className="sr-only">Swipe right or press Right Arrow to keep. Swipe left or press Delete to remove.</span>
  </div>;
}
