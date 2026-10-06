"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNativeNavigationBlocked } from "@/lib/capacitor/native-navigation";
import { isSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression";
import { renderedDrawerOffset } from "./drawer-motion";

type Pull = { id: number; x: number; y: number; time: number; width: number; offset: number; engaged: boolean };

/** A presentation-only rightward pull. The existing Sheet keeps modal, focus,
 * route and native-overlay ownership; only its owner may commit dismissal. */
export function ProfilePaneDrag({ open, presentationKey, panelRef, scrimRef, onClose }: {
  open: boolean;
  presentationKey?: string;
  panelRef: RefObject<HTMLDivElement | null>;
  scrimRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  useNativeNavigationBlocked(dragging, "profile-drag");
  const owner = useRef({ open, onClose });
  const reconcile = useRef<((open: boolean) => void) | null>(null);
  useLayoutEffect(() => {
    const previousOpen = owner.current.open;
    owner.current = { open, onClose };
    if (previousOpen !== open) reconcile.current?.(open);
  }, [open, onClose]);
  useEffect(() => {
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    if (!panel || !scrim) return;
    let pull: Pull | null = null;
    let settling = false;
    let timer = 0;
    let generation = 0;
    const cancelSettlement = () => { generation += 1; window.clearTimeout(timer); };
    let suppressClickUntil = 0;
    const blocked = () => !owner.current.open || isSessionChromeSuppressed() ||
      document.visibilityState === "hidden" || Boolean(document.querySelector("html.kb-open")) ||
      Array.from(document.querySelectorAll(
        '[data-slot="dialog-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"], [data-slot="popover-content"][data-state="open"], [data-slot="dropdown-menu-content"][data-state="open"], [data-slot="command"]',
      )).some(node => node !== panel);
    const clear = () => {
      panel.removeAttribute("data-profile-pull");
      scrim.removeAttribute("data-profile-pull");
      for (const property of ["transform", "transition", "will-change", "--profile-pull-x"]) panel.style.removeProperty(property);
      for (const property of ["opacity", "transition", "will-change", "--profile-pull-opacity"]) scrim.style.removeProperty(property);
      settling = false;
      setDragging(false);
    };
    const restore = () => {
      const engaged = pull?.engaged || settling;
      pull = null;
      if (!engaged) return;
      cancelSettlement();
      const currentGeneration = generation;
      settling = true;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.style.transition = reduced ? "none" : "transform var(--motion-drawer-settle-duration) var(--motion-sheet-enter-ease)";
      scrim.style.transition = reduced ? "none" : "opacity var(--motion-drawer-settle-duration) var(--motion-sheet-enter-ease)";
      panel.style.transform = "translate3d(0px, 0, 0)";
      scrim.style.opacity = "1";
      const duration = getComputedStyle(panel).transitionDuration.split(",").reduce((max, value) => {
        const ms = parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000);
        return Number.isFinite(ms) ? Math.max(max, ms) : max;
      }, 0);
      timer = window.setTimeout(() => { if (generation === currentGeneration) clear(); }, reduced ? 0 : duration + 30);
    };
    reconcile.current = (nextOpen) => {
      if (nextOpen) {
        if (pull?.engaged || settling) restore();
        else { cancelSettlement(); clear(); }
        return;
      }
      cancelSettlement();
      if (!pull?.engaged) return;
      pull = null;
      settling = true;
      panel.dataset.profilePull = "exit";
      scrim.dataset.profilePull = "exit";
    };
    const start = (event: TouchEvent) => {
      suppressClickUntil = 0;
      if (event.touches.length !== 1) { restore(); return; }
      const target = event.target instanceof Element ? event.target : null;
      if (blocked() || !target || !panel.contains(target) || target.closest(
        'button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [inert], [hidden], [data-no-profile-swipe], [data-no-route-swipe], [data-swipe-views-horizontal-scroll], [data-slot="carousel"], [data-slot="slider"], [role="slider"]',
      ) || window.getSelection()?.toString()) return;
      for (let node: Element | null = target; node; node = node.parentElement) {
        if (["auto", "scroll"].includes(getComputedStyle(node).overflowX) && node.scrollWidth > node.clientWidth + 4) return;
        if (node === panel) break;
      }
      const touch = event.touches[0];
      if (!touch || panel.offsetWidth <= 0 || touch.clientX <= 28) return;
      const offset = settling ? Math.max(0, renderedDrawerOffset(panel)) : 0;
      cancelSettlement();
      settling = false;
      pull = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp, width: panel.offsetWidth, offset, engaged: offset > 0 };
      if (pull.engaged) {
        panel.style.transition = "none"; scrim.style.transition = "none";
        panel.style.transform = `translate3d(${offset}px, 0, 0)`;
        panel.style.setProperty("--profile-pull-x", `${offset}px`);
        scrim.style.opacity = String(1 - offset / pull.width);
        scrim.style.setProperty("--profile-pull-opacity", scrim.style.opacity);
        setDragging(true);
      }
    };
    const move = (event: TouchEvent) => {
      if (!pull) return;
      const touch = Array.from(event.touches).find(point => point.identifier === pull?.id);
      if (!touch || event.touches.length !== 1 || blocked()) { restore(); return; }
      const dx = touch.clientX - pull.x;
      const dy = touch.clientY - pull.y;
      if (!pull.engaged) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
        if (dx <= 0 || dx <= Math.abs(dy) * 1.12) { pull = null; return; }
        pull.engaged = true;
        setDragging(true);
        panel.dataset.profilePull = "drag";
        scrim.dataset.profilePull = "drag";
        panel.style.transition = "none";
        scrim.style.transition = "none";
        panel.style.willChange = "transform";
        scrim.style.willChange = "opacity";
      }
      const distance = Math.min(pull.width, Math.max(0, pull.offset + dx));
      panel.style.setProperty("--profile-pull-x", `${distance}px`);
      panel.style.transform = `translate3d(${distance}px, 0, 0)`;
      scrim.style.opacity = String(1 - distance / pull.width);
      scrim.style.setProperty("--profile-pull-opacity", scrim.style.opacity);
      suppressClickUntil = performance.now() + 500;
      event.stopPropagation();
    };
    const end = (event: TouchEvent) => {
      if (!pull) return;
      const touch = Array.from(event.changedTouches).find(point => point.identifier === pull?.id);
      if (!pull.engaged || !touch) { restore(); return; }
      const dx = touch.clientX - pull.x;
      const dy = touch.clientY - pull.y;
      const commit = !blocked() && dx > Math.abs(dy) * 1.12 &&
        (dx >= 72 || (dx >= 16 && dx / Math.max(1, event.timeStamp - pull.time) >= 0.48));
      event.stopPropagation();
      suppressClickUntil = performance.now() + 500;
      if (!commit) { restore(); return; }
      pull = null;
      settling = true;
      panel.dataset.profilePull = "exit";
      scrim.dataset.profilePull = "exit";
      owner.current.onClose(); // Once, through the existing controlled Sheet.
    };
    const click = (event: MouseEvent) => {
      if (event.detail !== 0 && performance.now() < suppressClickUntil) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    const options = { passive: true } as const;
    panel.addEventListener("touchstart", start, options);
    panel.addEventListener("touchmove", move, options);
    panel.addEventListener("touchend", end, options);
    panel.addEventListener("touchcancel", restore, options);
    panel.addEventListener("click", click, true);
    window.addEventListener("blur", restore);
    document.addEventListener("visibilitychange", restore);
    const resized = () => { if (pull && panel.offsetWidth !== pull.width) restore(); };
    window.addEventListener("resize", resized);
    return () => {
      cancelSettlement();
      reconcile.current = null;
      clear();
      panel.removeEventListener("touchstart", start);
      panel.removeEventListener("touchmove", move);
      panel.removeEventListener("touchend", end);
      panel.removeEventListener("touchcancel", restore);
      panel.removeEventListener("click", click, true);
      window.removeEventListener("blur", restore);
      document.removeEventListener("visibilitychange", restore);
      window.removeEventListener("resize", resized);
    };
  }, [presentationKey, panelRef, scrimRef]);
  return null;
}
