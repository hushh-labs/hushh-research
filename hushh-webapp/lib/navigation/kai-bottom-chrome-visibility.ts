import {
  useEffect,
  useSyncExternalStore,
  type RefObject,
} from "react";

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
let scrollRootObserver: MutationObserver | null = null;
let scrollRootRefreshFrame: number | null = null;
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
  const target = resolveScrollTarget();
  if (!target) return;

  // The app's Suspense fallback and resolved shell each own a scroll root. A
  // route settlement can replace that node without remounting this singleton;
  // keep the listener attached to the live root instead of a detached
  // fallback element.
  if (scrollListenerAttached && activeScrollTarget === target) return;

  if (scrollListenerAttached && activeScrollTarget) {
    activeScrollTarget.removeEventListener("scroll", handleScroll);
  }

  activeScrollTarget = target;
  target.addEventListener("scroll", handleScroll, { passive: true });
  scrollListenerAttached = true;

  resetKaiBottomChromeVisibility();
  onScroll(readActiveScrollY());
}

function scheduleScrollTargetRefresh() {
  if (
    typeof window === "undefined" ||
    scrollRootRefreshFrame !== null ||
    listenerRefCount === 0
  ) {
    return;
  }

  scrollRootRefreshFrame = window.requestAnimationFrame(() => {
    scrollRootRefreshFrame = null;
    attachScrollListener();
  });
}

function observeScrollRoot() {
  if (
    scrollRootObserver ||
    typeof MutationObserver === "undefined" ||
    typeof document === "undefined" ||
    !document.body
  ) {
    return;
  }

  scrollRootObserver = new MutationObserver(scheduleScrollTargetRefresh);
  scrollRootObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function stopObservingScrollRoot() {
  scrollRootObserver?.disconnect();
  scrollRootObserver = null;
  if (scrollRootRefreshFrame !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(scrollRootRefreshFrame);
  }
  scrollRootRefreshFrame = null;
}

function detachScrollListener() {
  if (!scrollListenerAttached || !activeScrollTarget) return;

  activeScrollTarget.removeEventListener("scroll", handleScroll);
  scrollListenerAttached = false;
  activeScrollTarget = null;
  stopObservingScrollRoot();
}

export function resetKaiBottomChromeVisibility(): void {
  cancelAnimation();
  state.progress = 0;
  state.targetProgress = 0;
  state.initialized = false;
  state.lastY = readActiveScrollY();
  emit();
}

/**
 * Snap the bottom chrome fully visible with NO animation. Called on
 * pointerdown inside the bottom nav: when a tap lands while the hide/reveal
 * animation is mid-flight, the buttons translate away between pointerdown and
 * pointerup and the browser registers no click, which surfaced on iOS as
 * "sometimes I have to tap the bottom bar twice". Freezing the chrome at its
 * mean position for the press guarantees the target is stationary at
 * pointerup.
 */
export function snapKaiBottomChromeVisible(): void {
  cancelAnimation();
  state.progress = 0;
  state.targetProgress = 0;
  state.lastY = readActiveScrollY();
  emit();
}

/**
 * Re-seed the singleton from the ACTUAL current scroll position of the active
 * target and animate toward the matching mean/hidden target.
 *
 * The singleton is module-level and shared across consumers. When a transient
 * consumer (e.g. the AgentBar, which unmounts while the agent window is open)
 * remounts, it reads the frozen `state.progress` snapshot via
 * useSyncExternalStore. If progress was left at 1 (hidden) from an earlier
 * scroll-down and no scroll event fired on the active target in the meantime
 * (because scrolling happened inside the agent window's own containers), the
 * bar would render stuck off its mean position until the user scrolled the real
 * root up again. Re-syncing on enable makes the chrome reflect reality at mount
 * time instead of a stale value.
 */
export function syncKaiBottomChromeVisibilityToScroll(): void {
  const nextY = readActiveScrollY();
  state.lastY = nextY;
  state.initialized = true;
  // At/near the top the chrome is always shown (mean position). Otherwise leave
  // the existing target untouched so a genuinely hidden state is preserved when
  // the user really is scrolled down.
  if (nextY <= MIN_SCROLL_Y_FOR_SHOW) {
    setTargetProgress(0);
  }
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
    observeScrollRoot();
    syncKaiBottomChromeVisibilityToScroll();

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

const BOTTOM_CHROME_PROGRESS_VAR = "--bottom-chrome-progress";
const BOTTOM_CHROME_SHARED_TRANSLATION =
  "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance, var(--bottom-chrome-full-height))), 0)";

/**
 * Drives the bottom-chrome hide animation by writing the continuous scroll
 * progress to a CSS variable on the document root, WITHOUT returning the value
 * into React render output.
 *
 * The earlier `useKaiBottomChromeVisibility` hook returns `progress` (a value
 * that changes on every scroll frame) via useSyncExternalStore. When that hook
 * is consumed in the root app shell, every scroll frame re-renders the entire
 * provider subtree, which made pages like /consents appear to "reload" on
 * scroll. This hook isolates the per-frame update to a CSS variable mutation so
 * the React tree is never re-rendered by scrolling; consumers read
 * `var(--bottom-chrome-progress)` from the cascade instead.
 */
export function useKaiBottomChromeProgressCssVar(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      resetKaiBottomChromeVisibility();
      if (typeof document !== "undefined") {
        document.documentElement.style.setProperty(
          BOTTOM_CHROME_PROGRESS_VAR,
          "0",
        );
      }
      return;
    }

    const root = document.documentElement;
    const writeVar = () => {
      root.style.setProperty(
        BOTTOM_CHROME_PROGRESS_VAR,
        String(getSnapshot()),
      );
    };

    listenerRefCount += 1;
    attachScrollListener();
    observeScrollRoot();
    syncKaiBottomChromeVisibilityToScroll();
    writeVar();
    const unsubscribe = subscribe(writeVar);

    return () => {
      unsubscribe();
      listenerRefCount = Math.max(0, listenerRefCount - 1);
      if (listenerRefCount === 0) {
        resetKaiBottomChromeVisibility();
        detachScrollListener();
      }
      root.style.setProperty(BOTTOM_CHROME_PROGRESS_VAR, "0");
    };
  }, [enabled]);
}

/**
 * Bind a fixed sibling to the established bottom-chrome motion without
 * subscribing its React owner to every scroll frame. The Agent Bar is mounted
 * outside the route shell, so it receives the shared CSS variables directly on
 * its own fixed wrapper.
 *
 * The translation is deliberately the navigation's measured travel distance,
 * not the fixed sibling's height. When the navigation exits, the Agent Bar
 * settles into its vacated bottom slot and remains entirely visible. Measuring
 * the Agent Bar itself here would move it beyond the viewport and make the
 * primary conversation control disappear.
 */
export function useKaiBottomChromeElementTranslation(
  elementRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const element = elementRef.current;
    if (!enabled || !element) {
      element?.style.removeProperty("transform");
      return;
    }

    // Browser-side CSS resolves the current runtime-measured nav size and the
    // root scroll progress without a scroll listener, layout read, or React
    // update for the Agent Bar subtree.
    element.style.transform = BOTTOM_CHROME_SHARED_TRANSLATION;

    return () => {
      element.style.removeProperty("transform");
    };
  }, [elementRef, enabled]);
}
