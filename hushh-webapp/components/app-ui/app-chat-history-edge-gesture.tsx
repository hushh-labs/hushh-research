"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { nativeShellOverlayBlocked, useNativeNavigationBlocked } from "@/lib/capacitor/native-navigation";

const EDGE_BACK_LANE = 28;
const AXIS_LOCK = 8;
const DIRECTION_RATIO = 1.12;
const COMMIT_DISTANCE = 72;
const COMMIT_VELOCITY = 0.48;
type Gesture = {
  identifier: number; x: number; y: number; time: number;
  axis: "undecided" | "horizontal";
  initialOpen: boolean; surface: HTMLElement;
  width: number; panel: HTMLElement; scrim: HTMLElement;
};

function excludedTarget(target: EventTarget | null, surface: HTMLElement, closing = false) {
  const element = target instanceof Element ? target : null;
  if (!element || !surface.contains(element) || element.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [inert], [hidden], [data-no-route-swipe], [data-no-profile-swipe], [data-swipe-views-horizontal-scroll], [data-slot="carousel"], [data-slot="carousel-content"], [data-slot="carousel-item"], [data-slot="slider"], [role="slider"]',
  ) || (!closing && element.closest('button, a'))) return true;
  // Tables, code blocks and charts retain their own horizontal pan.
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (["auto", "scroll"].includes(style.overflowX) && node.scrollWidth > node.clientWidth + 4) return true;
    if (node === surface) break;
  }
  return Boolean(window.getSelection()?.toString());
}

function domBlocked() {
  return Boolean(document.querySelector(
    'html.kb-open, [data-slot="dialog-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"], [data-slot="popover-content"][data-state="open"], [data-slot="dropdown-menu-content"][data-state="open"], [data-slot="command"]',
  ));
}

/** Presentation-only pull. The drawer owner supplies geometry and its authored
 * open action. No global listener, inferred button or route dispatch. React
 * changes only at gesture boundaries, never for a movement frame. */
export function AppChatHistoryEdgeGesture({ enabled, open = false, surfaceRef, drawerRef, scrimRef, onOpen, onClose }: {
  enabled: boolean;
  open?: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
  drawerRef: RefObject<HTMLElement | null>;
  scrimRef: RefObject<HTMLElement | null>;
  onOpen: () => void;
  onClose: () => void;
}) {
  const action = useRef({ onOpen, onClose });
  useLayoutEffect(() => { action.current = { onOpen, onClose }; }, [onOpen, onClose]);
  const [dragging, setDragging] = useState(false);
  const reconcile = useRef<((open: boolean) => void) | null>(null);
  const wasOpen = useRef(open);
  useNativeNavigationBlocked(dragging);
  useLayoutEffect(() => {
    if (wasOpen.current !== open) reconcile.current?.(open);
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const panel = drawerRef.current;
    const scrim = scrimRef.current;
    if (!enabled || !surface || !panel || !scrim) return;
    let gesture: Gesture | null = null;
    let settling: Gesture | null = null;
    let settlingOpen = false;
    let timer = 0;
    let suppressClickUntil = 0;
    // The closed panel already includes its authored shadow clearance.
    const shadowClearance = Math.max(0, -panel.getBoundingClientRect().left - panel.offsetWidth);

    const clear = (current: Gesture) => {
      for (const property of ["transition", "transform", "translate", "will-change"]) current.panel.style.removeProperty(property);
      for (const property of ["transition", "opacity", "visibility", "will-change"]) current.scrim.style.removeProperty(property);
    };
    const place = (current: Gesture, distance: number, phase: "drag" | "open" | "close") => {
      const offset = Math.min(0, Math.max(-current.width, distance - current.width));
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const motion = phase === "open" ? "enter" : "exit";
      current.panel.style.transition = phase === "drag" || reduced ? "none"
        : `transform var(--motion-sheet-${motion}-duration) var(--motion-sheet-${motion}-ease)`;
      // Tailwind v4's resting translate is independent of transform. Disable
      // it for the pull, otherwise both offsets add and the panel stays hidden.
      current.panel.style.translate = "none";
      current.scrim.style.transition = phase === "drag" || reduced ? "none"
        : `opacity var(--motion-sheet-${motion}-duration) var(--motion-sheet-${motion}-ease)`;
      current.panel.style.transform = `translate3d(${offset}px, 0, 0)`;
      current.scrim.style.opacity = String(1 - Math.abs(offset) / current.width);
      current.scrim.style.visibility = "visible";
    };
    const settle = (current: Gesture, open: boolean, notify = false) => {
      window.clearTimeout(timer);
      gesture = null;
      settling = current;
      settlingOpen = open;
      place(current, open ? current.width : 0, open ? "open" : "close");
      if (notify && open !== current.initialOpen) {
        // Existing state, focus, loading and isolation owner, once per release.
        if (open) action.current.onOpen(); else action.current.onClose();
      }
      const duration = getComputedStyle(current.panel).transitionDuration.split(",").reduce((max, value) => {
        const ms = parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000);
        return Number.isFinite(ms) ? Math.max(max, ms) : max;
      }, 0);
      timer = window.setTimeout(() => {
        clear(current); settling = null; setDragging(false);
      }, duration + 30);
    };
    const cancel = () => {
      if (gesture?.axis === "horizontal") settle(gesture, wasOpen.current);
      else gesture = null;
    };
    reconcile.current = (nextOpen) => {
      if (settling && settlingOpen !== nextOpen) settle(settling, nextOpen);
      else if (gesture?.axis === "horizontal") settle(gesture, nextOpen);
      else gesture = null;
    };
    const start = (event: TouchEvent) => {
      // A fresh touch ends the prior drag's synthetic-click sequence even if
      // settlement or an excluded control prevents this touch becoming a pan.
      suppressClickUntil = 0;
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0];
      if (!touch) return;
      const initialOpen = wasOpen.current;
      const origin = event.currentTarget as HTMLElement;
      if (settling || (initialOpen ? origin === surface : origin !== surface) ||
          panel.getAttribute("aria-hidden") !== String(!initialOpen) || touch.clientX <= EDGE_BACK_LANE ||
          (!initialOpen && nativeShellOverlayBlocked()) || domBlocked() || excludedTarget(event.target, origin, initialOpen)) return;
      // Include the authored closed shadow clearance, not just panel width.
      const width = initialOpen ? panel.offsetWidth + shadowClearance : Math.max(panel.offsetWidth, -panel.getBoundingClientRect().left);
      if (width <= 0) return;
      gesture = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY,
        time: event.timeStamp, axis: "undecided", initialOpen, surface: origin, width, panel, scrim };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = Array.from(event.touches).find(point => point.identifier === gesture?.identifier);
      if (!touch || panel.getAttribute("aria-hidden") !== String(!gesture.initialOpen) || gesture.surface.closest("[inert], [hidden]") ||
          domBlocked()) { cancel(); return; }
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (gesture.axis === "undecided") {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK) return;
        const directed = gesture.initialOpen ? -dx : dx;
        if (directed <= 0 || Math.abs(dx) <= Math.abs(dy) * DIRECTION_RATIO || (!gesture.initialOpen && nativeShellOverlayBlocked())) { gesture = null; return; }
        gesture.axis = "horizontal";
        panel.style.willChange = "transform";
        scrim.style.willChange = "opacity";
        setDragging(true);
      }
      suppressClickUntil = performance.now() + 500;
      event.stopPropagation(); // Keep owned moves local; Profile already yields to the open drawer.
      place(gesture, (gesture.initialOpen ? gesture.width : 0) + dx, "drag");
    };
    const end = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = Array.from(event.changedTouches).find(point => point.identifier === gesture?.identifier);
      if (!touch) { cancel(); return; }
      if (gesture.axis !== "horizontal") { gesture = null; return; }
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      event.stopPropagation();
      suppressClickUntil = performance.now() + 500;
      const directed = gesture.initialOpen ? -dx : dx;
      const velocity = directed / Math.max(1, event.timeStamp - gesture.time);
      const committed = !domBlocked() && panel.getAttribute("aria-hidden") === String(!gesture.initialOpen) &&
        directed > Math.abs(dy) * DIRECTION_RATIO &&
        (directed >= COMMIT_DISTANCE || (directed >= AXIS_LOCK * 2 && velocity >= COMMIT_VELOCITY));
      settle(gesture, committed ? !gesture.initialOpen : gesture.initialOpen, true);
    };
    const click = (event: MouseEvent) => {
      // A horizontal drag over a chat row/scrim must not select/delete/close it.
      if (event.detail === 0 || performance.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const visibility = () => { if (document.visibilityState === "hidden") cancel(); };
    const options = { passive: true } as const;
    const surfaces = [surface, panel, scrim];
    for (const node of surfaces) {
      node.addEventListener("touchstart", start, options);
      node.addEventListener("touchmove", move, options);
      node.addEventListener("touchend", end, options);
      node.addEventListener("touchcancel", cancel, options);
      node.addEventListener("click", click, true);
    }
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearTimeout(timer);
      if (gesture) clear(gesture);
      if (settling) clear(settling);
      reconcile.current = null;
      setDragging(false);
      for (const node of surfaces) {
        node.removeEventListener("touchstart", start);
        node.removeEventListener("touchmove", move);
        node.removeEventListener("touchend", end);
        node.removeEventListener("touchcancel", cancel);
        node.removeEventListener("click", click, true);
      }
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, surfaceRef, drawerRef, scrimRef]);
  return null;
}
