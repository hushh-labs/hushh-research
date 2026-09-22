"use client";

import { useEffect } from "react";
import { ChevronLeft } from "@/components/icons";
import { usePathname } from "next/navigation";

import { requestProfilePaneOpen } from "@/lib/navigation/profile-pane";
import { ROUTES } from "@/lib/navigation/routes";

const BACK_GESTURE_RESERVED_WIDTH_PX = 28;
const AXIS_LOCK_PX = 8;
const DIRECTION_RATIO = 1.12;
const COMMIT_DISTANCE_PX = 72;
const COMMIT_VELOCITY_PX_PER_MS = 0.48;
const INDICATOR_REVEAL_DISTANCE_PX = 44;
const INDICATOR_MAX_OFFSET_PX = 34;

type GestureInput = "pointer" | "touch";
type GestureAxis = "undecided" | "horizontal" | "vertical";

type ProfileBodyGesture = {
  input: GestureInput;
  identifier: number;
  startX: number;
  startY: number;
  startedAt: number;
  axis: GestureAxis;
};

function isOneSurfaceRoute(pathname: string): boolean {
  // The body gesture belongs to the dashboard surface and to the chat
  // surface (whose only horizontal gesture is the mirror one that opens the
  // chat history drawer). Profile remains available from the top-shell
  // affordance on other authenticated routes, but a finance/location/connect
  // surface must retain ownership of its own horizontal gestures and tab
  // pagers.
  return pathname === ROUTES.ONE_HOME || pathname === ROUTES.HOME;
}

function hasHorizontalScrollParent(target: HTMLElement | null): boolean {
  if (!target || typeof window === "undefined") return false;
  let node: HTMLElement | null = target;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    if (
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      node.scrollWidth > node.clientWidth + 4
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function shouldIgnoreSwipeTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  if (
    element.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [data-no-route-swipe], [data-no-profile-swipe], [data-swipe-views-horizontal-scroll], [data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"], [data-slot="command"], [cmdk-root], [data-slot="carousel"], [data-slot="carousel-content"], [data-slot="carousel-item"]',
    )
  ) {
    return true;
  }
  return hasHorizontalScrollParent(element);
}

function hasBlockingOverlay(): boolean {
  // The chat history drawer and an open keyboard own the surface too.
  return Boolean(
    document.querySelector(
      '[data-slot="dialog-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"], [data-slot="command"], [data-agent-history-drawer-open="true"], html.kb-open',
    ),
  );
}

function setIndicator(
  root: HTMLElement,
  params: { active: boolean; offset?: number; y?: number },
) {
  root.dataset.appProfileEdgeActive = params.active ? "true" : "false";
  root.style.setProperty(
    "--app-profile-edge-offset",
    `${Math.max(0, params.offset ?? 0)}px`,
  );
  root.style.setProperty("--app-profile-edge-y", `${params.y ?? -64}px`);
  root.style.setProperty(
    "--app-profile-edge-opacity",
    params.active ? "1" : "0",
  );
}

function consume(event: Event) {
  event.stopPropagation();
}

/**
 * Touch-body left-swipe for the signed-in Profile pane. The gesture is broad
 * by design, but yields to controls and horizontal surfaces so it cannot steal
 * a carousel, pager, input, or the app-owned extreme-left back gesture.
 */
export function AppProfileEdgeGesture({ enabled }: { enabled: boolean }) {
  const pathname = usePathname() || "/";

  useEffect(() => {
    if (
      !enabled ||
      !isOneSurfaceRoute(pathname) ||
      typeof window === "undefined"
    ) {
      return;
    }

    const root = document.documentElement;
    let gesture: ProfileBodyGesture | null = null;

    const reset = () => {
      gesture = null;
      setIndicator(root, { active: false });
    };

    const begin = (params: Omit<ProfileBodyGesture, "axis">) => {
      gesture = { ...params, axis: "undecided" };
      setIndicator(root, {
        active: true,
        y: Math.max(16, Math.min(window.innerHeight - 64, params.startY - 24)),
      });
    };

    const move = (x: number, y: number, event: Event) => {
      if (!gesture) return;
      const deltaX = x - gesture.startX;
      const deltaY = y - gesture.startY;
      const horizontal = Math.abs(deltaX);
      const vertical = Math.abs(deltaY);

      if (
        gesture.axis === "undecided" &&
        (horizontal >= AXIS_LOCK_PX || vertical >= AXIS_LOCK_PX)
      ) {
        gesture.axis =
          horizontal > vertical * DIRECTION_RATIO ? "horizontal" : "vertical";
      }
      if (gesture.axis === "vertical" || deltaX >= 0) {
        reset();
        return;
      }
      if (gesture.axis !== "horizontal") return;

      consume(event);
      // No preventDefault: the window listeners are passive so scrolling
      // never waits on this handler (see app-edge-back-gesture.tsx for the
      // WebKit reasoning). `touch-pan-y` on the scroll root already refuses
      // the horizontal pan this gesture owns.
      const progress = Math.min(
        1,
        Math.abs(deltaX) / INDICATOR_REVEAL_DISTANCE_PX,
      );
      setIndicator(root, {
        active: true,
        offset: progress * INDICATOR_MAX_OFFSET_PX,
        y: Math.max(16, Math.min(window.innerHeight - 64, y - 24)),
      });
    };

    const finish = (x: number, y: number, timestamp: number, event: Event) => {
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
        deltaX < 0 &&
        horizontal > vertical * DIRECTION_RATIO &&
        (horizontal >= COMMIT_DISTANCE_PX ||
          velocity >= COMMIT_VELOCITY_PX_PER_MS);

      if (current.axis === "horizontal") consume(event);
      reset();
      if (shouldOpen) requestProfilePaneOpen("native_swipe");
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
      if (
        gesture?.input !== "pointer" ||
        gesture.identifier !== event.pointerId
      ) {
        return;
      }
      move(event.clientX, event.clientY, event);
    };
    const pointerEnd = (event: PointerEvent) => {
      if (
        gesture?.input !== "pointer" ||
        gesture.identifier !== event.pointerId
      ) {
        return;
      }
      finish(
        event.clientX,
        event.clientY,
        event.timeStamp || performance.now(),
        event,
      );
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
    const touchForGesture = (touches: TouchList) => {
      if (!gesture) return null;
      return (
        Array.from(touches).find(
          (touch) => touch.identifier === gesture?.identifier,
        ) ?? null
      );
    };
    const touchMove = (event: TouchEvent) => {
      if (gesture?.input !== "touch") return;
      const touch = touchForGesture(event.touches);
      if (!touch) return reset();
      move(touch.clientX, touch.clientY, event);
    };
    const touchEnd = (event: TouchEvent) => {
      if (gesture?.input !== "touch") return;
      const touch = touchForGesture(event.changedTouches);
      if (!touch) return reset();
      finish(
        touch.clientX,
        touch.clientY,
        event.timeStamp || performance.now(),
        event,
      );
    };

    window.addEventListener("pointerdown", pointerStart, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointermove", pointerMove, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointerup", pointerEnd, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointercancel", reset, { capture: true });
    window.addEventListener("touchstart", touchStart, {
      capture: true,
      passive: true,
    });
    window.addEventListener("touchmove", touchMove, {
      capture: true,
      passive: true,
    });
    window.addEventListener("touchend", touchEnd, {
      capture: true,
      passive: true,
    });
    window.addEventListener("touchcancel", reset, { capture: true });

    return () => {
      reset();
      window.removeEventListener("pointerdown", pointerStart, true);
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerEnd, true);
      window.removeEventListener("pointercancel", reset, true);
      window.removeEventListener("touchstart", touchStart, true);
      window.removeEventListener("touchmove", touchMove, true);
      window.removeEventListener("touchend", touchEnd, true);
      window.removeEventListener("touchcancel", reset, true);
      root.removeAttribute("data-app-profile-edge-active");
      root.style.removeProperty("--app-profile-edge-offset");
      root.style.removeProperty("--app-profile-edge-y");
      root.style.removeProperty("--app-profile-edge-opacity");
    };
  }, [enabled, pathname]);

  return (
    <div
      aria-hidden
      data-testid="app-profile-edge-indicator"
      className="pointer-events-none fixed right-0 top-0 z-[130] flex h-12 w-12 items-center justify-center rounded-l-2xl border border-border/60 bg-background/86 text-foreground shadow-lg backdrop-blur-xl transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: "var(--app-profile-edge-opacity, 0)",
        transform:
          "translate3d(calc(3rem - var(--app-profile-edge-offset, 0px)), var(--app-profile-edge-y, -64px), 0)",
      }}
    >
      <ChevronLeft className="h-5 w-5" />
    </div>
  );
}
