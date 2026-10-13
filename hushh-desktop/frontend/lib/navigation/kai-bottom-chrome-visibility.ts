import { useEffect, useSyncExternalStore } from "react";

const MIN_SCROLL_Y_FOR_SHOW = 10;
const MIN_SCROLL_Y_FOR_HIDE = 24;
const JITTER_DELTA_PX = 1.5;
const DIRECTION_DELTA_PX = 2;
const PROGRESS_EPSILON = 0.001;
const ANIMATION_TIME_CONSTANT_MS = 85;
const APP_SCROLL_ROOT_SELECTOR = '[data-app-scroll-root="true"]';

type Listener = () => void;

interface VisibilityState {
  progress: number;
  targetProgress: number;
  lastY: number;
  initialized: boolean;
  rafId: number | null;
  lastFrameTs: number | null;
}

const listeners = new Set<Listener>();
let listenerRefCount = 0;
let scrollListenerAttached = false;
let activeScrollTarget: Window | HTMLElement | null = null;
const handleScroll = () => onScroll(readActiveScrollY());

const state: VisibilityState = {
  progress: 0,
  targetProgress: 0,
  lastY: 0,
  initialized: false,
  rafId: null,
  lastFrameTs: null,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function emit() {
  listeners.forEach((listener) => listener());
}

function cancelAnimation() {
  if (typeof window === "undefined" || state.rafId === null) return;
  cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.lastFrameTs = null;
}

function animateProgress(ts: number) {
  if (state.lastFrameTs === null) {
    state.lastFrameTs = ts;
  }
  const dt = Math.min(40, Math.max(1, ts - state.lastFrameTs));
  state.lastFrameTs = ts;

  const alpha = 1 - Math.exp(-dt / ANIMATION_TIME_CONSTANT_MS);
  const next = state.progress + (state.targetProgress - state.progress) * alpha;

  if (Math.abs(state.targetProgress - next) <= PROGRESS_EPSILON) {
    const shouldEmit = Math.abs(state.progress - state.targetProgress) > PROGRESS_EPSILON;
    state.progress = state.targetProgress;
    cancelAnimation();
    if (shouldEmit) {
      emit();
    }
    return;
  }

  if (Math.abs(next - state.progress) > PROGRESS_EPSILON) {
    state.progress = next;
    emit();
  }

  state.rafId = requestAnimationFrame(animateProgress);
}

function setTargetProgress(nextTarget: number) {
  const clampedTarget = clamp01(nextTarget);
  if (Math.abs(clampedTarget - state.targetProgress) <= PROGRESS_EPSILON) {
    return;
  }
  state.targetProgress = clampedTarget;

  if (Math.abs(state.progress - state.targetProgress) <= PROGRESS_EPSILON) {
    const shouldEmit = Math.abs(state.progress - state.targetProgress) > PROGRESS_EPSILON;
    state.progress = state.targetProgress;
    cancelAnimation();
    if (shouldEmit) {
      emit();
    }
    return;
  }

  if (typeof window !== "undefined" && state.rafId === null) {
    state.lastFrameTs = null;
    state.rafId = window.requestAnimationFrame(animateProgress);
  }
}

function readWindowY(): number {
  if (typeof window === "undefined") return 0;
  return Math.max(0, window.scrollY || window.pageYOffset || 0);
}

function readElementY(target: HTMLElement): number {
  return Math.max(0, target.scrollTop || 0);
}

function isWindowTarget(target: Window | HTMLElement | null): target is Window {
  return (
    typeof window !== "undefined" &&
    target !== null &&
    "scrollY" in target &&
    "pageYOffset" in target
  );
}

function resolveScrollTarget(): Window | HTMLElement | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  const appScrollRoot = document.querySelector<HTMLElement>(APP_SCROLL_ROOT_SELECTOR);
  if (appScrollRoot) {
    return appScrollRoot;
  }
  return window;
}

function readActiveScrollY(): number {
  if (!activeScrollTarget || isWindowTarget(activeScrollTarget)) {
    return readWindowY();
  }
  return readElementY(activeScrollTarget);
}

export function onScroll(y: number): void {
  const nextY = Math.max(0, Number.isFinite(y) ? y : 0);

  if (!state.initialized) {
    state.initialized = true;
    state.lastY = nextY;
    state.progress = 0;
    state.targetProgress = 0;
    return;
  }

  const delta = nextY - state.lastY;
  state.lastY = nextY;

  if (Math.abs(delta) < JITTER_DELTA_PX) {
    return;
  }

  if (nextY <= MIN_SCROLL_Y_FOR_SHOW) {
    setTargetProgress(0);
    return;
  }

  if (delta >= DIRECTION_DELTA_PX && nextY >= MIN_SCROLL_Y_FOR_HIDE) {
    setTargetProgress(1);
    return;
  }

  if (delta <= -DIRECTION_DELTA_PX) {
    setTargetProgress(0);
  }
}

function attachScrollListener() {
  if (scrollListenerAttached) return;

  const target = resolveScrollTarget();
  if (!target) return;

  activeScrollTarget = target;
  target.addEventListener("scroll", handleScroll, { passive: true });
  scrollListenerAttached = true;

  onScroll(readActiveScrollY());
}

function detachScrollListener() {
  if (!scrollListenerAttached || !activeScrollTarget) return;

  activeScrollTarget.removeEventListener("scroll", handleScroll);
  scrollListenerAttached = false;
  activeScrollTarget = null;
}

export function resetKaiBottomChromeVisibility(): void {
  cancelAnimation();
  state.progress = 0;
  state.targetProgress = 0;
  state.initialized = false;
  state.lastY = readActiveScrollY();
  emit();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return state.progress;
}

export function useKaiBottomChromeVisibility(enabled: boolean): {
  hidden: boolean;
  progress: number;
  onScroll: (y: number) => void;
} {
  const progress = useSyncExternalStore(subscribe, getSnapshot, () => 0);
  const hidden = progress >= 0.98;

  useEffect(() => {
    if (!enabled) {
      resetKaiBottomChromeVisibility();
      return;
    }

    listenerRefCount += 1;
    attachScrollListener();

    return () => {
      listenerRefCount = Math.max(0, listenerRefCount - 1);
      if (listenerRefCount === 0) {
        resetKaiBottomChromeVisibility();
        detachScrollListener();
      }
    };
  }, [enabled]);

  return { hidden: enabled ? hidden : false, progress: enabled ? progress : 0, onScroll };
}
