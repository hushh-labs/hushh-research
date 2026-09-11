"use client";

import { useEffect } from "react";
import { ChevronLeft } from "lucide-react";
import { Capacitor } from "@capacitor/core";

import { requestProfilePaneOpen } from "@/lib/navigation/profile-pane";

const EDGE_WIDTH_PX = 28;
const AXIS_LOCK_PX = 8;
const COMMIT_DISTANCE_PX = 72;
const COMMIT_VELOCITY_PX_PER_MS = 0.48;
const INDICATOR_REVEAL_DISTANCE_PX = 44;
const INDICATOR_MAX_OFFSET_PX = 34;

type GestureInput = "pointer" | "touch";
type GestureAxis = "undecided" | "horizontal" | "vertical";

type ProfileEdgeGesture = {
  input: GestureInput;
  identifier: number;
  startX: number;
  startY: number;
  startedAt: number;
  axis: GestureAxis;
};

function isNativeIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

function hasBlockingOverlay(): boolean {
  return Boolean(
    document.querySelector(
      '[data-slot="dialog-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"], [data-slot="command"]',
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
 * iOS-only right-edge gesture for opening the signed-in Profile pane. It is
 * deliberately separate from route navigation: opening Profile is a
 * reversible surface action, while every setting selected inside it still
 * navigates to its canonical dedicated route.
 */
export function AppProfileEdgeGesture({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled || !isNativeIOS() || typeof window === "undefined") return;

    const root = document.documentElement;
    let gesture: ProfileEdgeGesture | null = null;

    const reset = () => {
      gesture = null;
      setIndicator(root, { active: false });
    };

    const begin = (params: Omit<ProfileEdgeGesture, "axis">) => {
      gesture = { ...params, axis: "undecided" };
      setIndicator(root, {
        active: true,
        y: Math.max(16, Math.min(window.innerHeight - 64, params.startY - 24)),
      });
    };

    const move = (x: number, y: number, event: Event) => {
      if (!gesture) return;
      consume(event);
      const deltaX = x - gesture.startX;
      const deltaY = y - gesture.startY;
      const horizontal = Math.abs(deltaX);
      const vertical = Math.abs(deltaY);

      if (
        gesture.axis === "undecided" &&
        (horizontal >= AXIS_LOCK_PX || vertical >= AXIS_LOCK_PX)
      ) {
        gesture.axis = horizontal > vertical * 1.12 ? "horizontal" : "vertical";
      }
      if (gesture.axis === "vertical" || deltaX >= 0) {
        reset();
        return;
      }
      if (gesture.axis !== "horizontal") return;

      event.preventDefault();
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
      consume(event);
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
        horizontal > vertical * 1.12 &&
        (horizontal >= COMMIT_DISTANCE_PX ||
          velocity >= COMMIT_VELOCITY_PX_PER_MS);

      reset();
      if (shouldOpen) requestProfilePaneOpen("native_swipe");
    };

    const pointerStart = (event: PointerEvent) => {
      if (
        event.pointerType !== "touch" ||
        event.clientX < window.innerWidth - EDGE_WIDTH_PX ||
        hasBlockingOverlay()
      )
        return;
      begin({
        input: "pointer",
        identifier: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: event.timeStamp || performance.now(),
      });
      consume(event);
    };
    const pointerMove = (event: PointerEvent) => {
      if (
        gesture?.input !== "pointer" ||
        gesture.identifier !== event.pointerId
      )
        return;
      move(event.clientX, event.clientY, event);
    };
    const pointerEnd = (event: PointerEvent) => {
      if (
        gesture?.input !== "pointer" ||
        gesture.identifier !== event.pointerId
      )
        return;
      finish(
        event.clientX,
        event.clientY,
        event.timeStamp || performance.now(),
        event,
      );
    };

    const touchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (gesture?.input === "pointer") {
        consume(event);
        return;
      }
      if (
        !touch ||
        event.touches.length !== 1 ||
        touch.clientX < window.innerWidth - EDGE_WIDTH_PX ||
        hasBlockingOverlay()
      )
        return;
      begin({
        input: "touch",
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: event.timeStamp || performance.now(),
      });
      consume(event);
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
      passive: false,
    });
    window.addEventListener("pointerup", pointerEnd, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointercancel", reset, { capture: true });
    window.addEventListener("touchstart", touchStart, {
      capture: true,
      passive: true,
    });
    window.addEventListener("touchmove", touchMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener("touchend", touchEnd, {
      capture: true,
      passive: false,
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
  }, [enabled]);

  return (
    <div
      aria-hidden
      data-testid="app-profile-edge-indicator"
      className="pointer-events-none fixed right-0 top-0 z-[130] flex h-12 w-12 items-center justify-center rounded-l-2xl border border-border/60 bg-background/86 text-foreground shadow-lg backdrop-blur-xl transition-[opacity,transform] duration-150 ease-out"
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
