"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

/**
 * On the chat route a swipe to the right opens the chat history drawer, the
 * mirror of the swipe to the left that opens the profile pane on /one. The
 * drawer is a translated panel, so it follows the finger for the whole
 * gesture and settles on the commit, instead of appearing after it.
 *
 * The workspace owns the drawer's state; this gesture only drives the
 * panel's transform while the finger is down and then presses the
 * workspace's own toggle (the labelled "Open chat history" control), so the
 * state, focus handling and list loading stay where they live.
 */

const BACK_GESTURE_RESERVED_WIDTH_PX = 28;
const AXIS_LOCK_PX = 8;
const DIRECTION_RATIO = 1.12;
const COMMIT_DISTANCE_PX = 72;
const COMMIT_VELOCITY_PX_PER_MS = 0.48;
const SETTLE_MS = 150;
const SETTLE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

const WORKSPACE = '.agent-chat-workspace[data-agent-chat-route="root"]';
const DRAWER = `${WORKSPACE} [role="dialog"][aria-label="Agent chat history"]`;
const TOGGLE = 'button[aria-label="Open chat history"]';

type GestureInput = "pointer" | "touch";
type GestureAxis = "undecided" | "horizontal" | "vertical";

type DrawerGesture = {
  input: GestureInput;
  identifier: number;
  startX: number;
  startY: number;
  startedAt: number;
  axis: GestureAxis;
  drawer: HTMLElement;
  overlay: HTMLElement | null;
  width: number;
};

function shouldIgnoreSwipeTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return Boolean(
    element.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [data-no-route-swipe], [data-no-profile-swipe], [data-swipe-views-horizontal-scroll], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"], [data-slot="command"], [cmdk-root]',
    ),
  );
}

function hasBlockingOverlay(): boolean {
  return Boolean(
    document.querySelector(
      '[data-slot="dialog-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"], [data-slot="command"], [data-agent-history-drawer-open="true"], html.kb-open',
    ),
  );
}

/** The drawer at rest sits at -100%; the finger pulls it toward 0. */
function place(gesture: DrawerGesture, deltaX: number, settle: boolean) {
  const offset = Math.min(0, Math.max(-gesture.width, deltaX - gesture.width));
  const progress = 1 - Math.abs(offset) / gesture.width;
  const transition = settle ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}` : "none";
  gesture.drawer.style.transition = transition;
  gesture.drawer.style.transform = `translate3d(${offset}px, 0, 0)`;
  if (gesture.overlay) {
    gesture.overlay.style.transition = settle ? `opacity ${SETTLE_MS}ms ease-out` : "none";
    gesture.overlay.style.opacity = String(progress);
  }
}

function clearInline(gesture: DrawerGesture) {
  gesture.drawer.style.removeProperty("transition");
  gesture.drawer.style.removeProperty("transform");
  if (gesture.overlay) {
    gesture.overlay.style.removeProperty("transition");
    gesture.overlay.style.removeProperty("opacity");
  }
}

export function AppChatHistoryEdgeGesture({ enabled }: { enabled: boolean }) {
  const pathname = usePathname() || "/";

  useEffect(() => {
    if (!enabled || pathname !== ROUTES.HOME || typeof window === "undefined") {
      return;
    }

    let gesture: DrawerGesture | null = null;
    let settleTimer = 0;

    const reset = () => {
      gesture = null;
    };

    const begin = (params: Omit<DrawerGesture, "axis" | "drawer" | "overlay" | "width">) => {
      const drawer = document.querySelector<HTMLElement>(DRAWER);
      if (!drawer || drawer.getAttribute("aria-hidden") !== "true") return;
      const overlay = drawer.previousElementSibling instanceof HTMLElement ? drawer.previousElementSibling : null;
      window.clearTimeout(settleTimer);
      gesture = { ...params, axis: "undecided", drawer, overlay, width: drawer.offsetWidth || 320 };
    };

    const move = (x: number, y: number) => {
      if (!gesture) return;
      const deltaX = x - gesture.startX;
      const deltaY = y - gesture.startY;
      const horizontal = Math.abs(deltaX);
      const vertical = Math.abs(deltaY);
      if (gesture.axis === "undecided" && (horizontal >= AXIS_LOCK_PX || vertical >= AXIS_LOCK_PX)) {
        gesture.axis = horizontal > vertical * DIRECTION_RATIO ? "horizontal" : "vertical";
      }
      if (gesture.axis === "vertical" || deltaX <= 0) {
        if (gesture.axis === "horizontal") {
          place(gesture, 0, true);
          scheduleClear(gesture);
        }
        reset();
        return;
      }
      if (gesture.axis !== "horizontal") return;
      place(gesture, deltaX, false);
    };

    const scheduleClear = (current: DrawerGesture) => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => clearInline(current), SETTLE_MS + 30);
    };

    const finish = (x: number, y: number, timestamp: number) => {
      if (!gesture) return;
      const current = gesture;
      const deltaX = x - current.startX;
      const deltaY = y - current.startY;
      const horizontal = Math.abs(deltaX);
      const vertical = Math.abs(deltaY);
      const elapsed = Math.max(1, timestamp - current.startedAt);
      const velocity = horizontal / elapsed;
      const shouldOpen =
        current.axis === "horizontal" &&
        deltaX > 0 &&
        horizontal > vertical * DIRECTION_RATIO &&
        (horizontal >= COMMIT_DISTANCE_PX || velocity >= COMMIT_VELOCITY_PX_PER_MS);
      reset();
      if (current.axis !== "horizontal") return;
      if (shouldOpen) {
        // Settle to open from where the finger left it, then hand the state
        // to the workspace; its class puts the drawer at the same place.
        place(current, current.width, true);
        document.querySelector<HTMLButtonElement>(TOGGLE)?.click();
      } else {
        place(current, 0, true);
      }
      scheduleClear(current);
    };

    const pointerStart = (event: PointerEvent) => {
      if (
        event.pointerType !== "touch" ||
        event.clientX <= BACK_GESTURE_RESERVED_WIDTH_PX ||
        hasBlockingOverlay() ||
        shouldIgnoreSwipeTarget(event.target)
      ) {
        return;
      }
      begin({
        input: "pointer",
        identifier: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: event.timeStamp || performance.now(),
      });
    };
    const pointerMove = (event: PointerEvent) => {
      if (gesture?.input !== "pointer" || gesture.identifier !== event.pointerId) return;
      move(event.clientX, event.clientY);
    };
    const pointerEnd = (event: PointerEvent) => {
      if (gesture?.input !== "pointer" || gesture.identifier !== event.pointerId) return;
      finish(event.clientX, event.clientY, event.timeStamp || performance.now());
    };

    const touchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (gesture?.input === "pointer") return;
      if (
        !touch ||
        event.touches.length !== 1 ||
        touch.clientX <= BACK_GESTURE_RESERVED_WIDTH_PX ||
        hasBlockingOverlay() ||
        shouldIgnoreSwipeTarget(event.target)
      ) {
        return;
      }
      begin({
        input: "touch",
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: event.timeStamp || performance.now(),
      });
    };
    const touchForGesture = (touches: TouchList) =>
      gesture ? (Array.from(touches).find((touch) => touch.identifier === gesture?.identifier) ?? null) : null;
    const touchMove = (event: TouchEvent) => {
      if (gesture?.input !== "touch") return;
      const touch = touchForGesture(event.touches);
      if (!touch) return reset();
      move(touch.clientX, touch.clientY);
    };
    const touchEnd = (event: TouchEvent) => {
      if (gesture?.input !== "touch") return;
      const touch = touchForGesture(event.changedTouches);
      if (!touch) return reset();
      finish(touch.clientX, touch.clientY, event.timeStamp || performance.now());
    };
    const cancel = () => {
      if (gesture?.axis === "horizontal") {
        place(gesture, 0, true);
        scheduleClear(gesture);
      }
      reset();
    };

    const options = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", pointerStart, options);
    window.addEventListener("pointermove", pointerMove, options);
    window.addEventListener("pointerup", pointerEnd, options);
    window.addEventListener("pointercancel", cancel, { capture: true });
    window.addEventListener("touchstart", touchStart, options);
    window.addEventListener("touchmove", touchMove, options);
    window.addEventListener("touchend", touchEnd, options);
    window.addEventListener("touchcancel", cancel, { capture: true });

    return () => {
      window.clearTimeout(settleTimer);
      if (gesture) clearInline(gesture);
      reset();
      window.removeEventListener("pointerdown", pointerStart, true);
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerEnd, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("touchstart", touchStart, true);
      window.removeEventListener("touchmove", touchMove, true);
      window.removeEventListener("touchend", touchEnd, true);
      window.removeEventListener("touchcancel", cancel, true);
    };
  }, [enabled, pathname]);

  return null;
}
