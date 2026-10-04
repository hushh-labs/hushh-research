"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

import {
  activeBootStage,
  BOOT_TIMING,
  IDLE_BOOT_STATE,
  isBootSurfaceShown,
  LAUNCH_BOOT_STATE,
  launchBootState,
  nextBootDeadline,
  reduceBoot,
  type BootLaunch,
  type BootStage,
  type BootState,
} from "@/lib/boot/boot-sequence";

/**
 * Claim registry and timer driver for the one boot surface.
 *
 * Guards do not paint loaders any more. While a guard is waiting it holds a
 * claim on a stage (`useBootStageClaim`), and the single surface mounted in
 * the root layout shows the earliest held stage. Because the surface lives
 * above every guard, it stays mounted while one guard hands over to the next,
 * and while a guard redirects into another route whose own guard picks the
 * claim up.
 *
 * Releases are evaluated in a microtask after the commit. React runs a
 * departing guard's cleanup and an arriving guard's layout effect in the same
 * commit, so evaluating inside the commit would see a transient "nothing
 * held" and start an exit between two stages of one boot; a microtask sees the
 * settled set before the frame paints. (A timer was measured first: on a
 * loaded device it fired 171 ms after the resolved screen mounted, because it
 * queued behind that screen's own work.)
 *
 * Each change of the active stage is written to the performance timeline as
 * `hushh:boot:<stage>` marks and measures, and the first moment nothing is
 * held as `hushh:boot:ready`. The surface itself marks
 * `hushh:boot:surface-shown`, `hushh:boot:surface-released` (the exit begins
 * and input passes through to the app) and `hushh:boot:surface-idle` (fully
 * clear), so a cold start can be read on any device without a debugger.
 */

type Listener = () => void;

const claims = new Map<number, BootStage>();
const listeners = new Set<Listener>();
let claimSequence = 0;
let state: BootState = LAUNCH_BOOT_STATE;
let started = false;
let routeCommitted = false;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
let settleQueued = false;
let markedStage: BootStage | null = null;
let markedStageAt = 0;
let readyMarked = false;
let committedPath: string | null = null;
const NAVIGATION_HOLD_SAFETY_MS = 4_000;
const navigationHolds = new Map<number, ReturnType<typeof setTimeout>>();

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function emit(): void {
  for (const listener of listeners) listener();
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // The performance timeline is diagnostic only.
  }
}

function recordStage(stage: BootStage | null, at: number): void {
  if (stage === markedStage) return;
  if (markedStage) {
    try {
      performance.measure(`hushh:boot:${markedStage}`, {
        start: markedStageAt,
        end: at,
      });
    } catch {
      // Diagnostic only.
    }
  }
  markedStage = stage;
  markedStageAt = at;
  if (stage) {
    mark(`hushh:boot:${stage}`);
  } else if (routeCommitted && !readyMarked) {
    readyMarked = true;
    mark("hushh:boot:ready");
  }
}

function commit(next: BootState): void {
  if (next === state) return;
  const previousPhase = state.phase;
  const wasShown = isBootSurfaceShown(state.phase);
  const isShown = isBootSurfaceShown(next.phase);
  state = next;
  if (!wasShown && isShown) mark("hushh:boot:surface-shown");
  if (wasShown && !isShown) mark("hushh:boot:surface-released");
  if (next.phase === "idle" && previousPhase === "exiting") mark("hushh:boot:surface-idle");
  armDeadline();
  emit();
}

function armDeadline(): void {
  if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  deadlineTimer = null;
  const deadline = nextBootDeadline(state);
  if (deadline === null) return;
  const delay = Math.max(0, deadline - now());
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    commit(reduceBoot(state, { type: "tick", at: now() }));
    // A tick that changed nothing (a timer that fired early) re-arms itself.
    if (deadlineTimer === null) armDeadline();
  }, delay);
}

const SERVER_HOLD_RECHECK_MS = 100;
let serverHoldTimer: ReturnType<typeof setTimeout> | null = null;

function isRendered(node: Element | null): boolean {
  for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
    if (getComputedStyle(current).display === "none") return false;
  }
  return true;
}

/**
 * Stages held by guard markup that has not claimed yet.
 *
 * On the web a guard can arrive as server HTML and stay un-hydrated until its
 * JavaScript loads, while the shell beside it has already hydrated: measured
 * on localhost, `/one` showed "Checking secure session" for ~6.7 s with no
 * claim registered, and the surface concluded nothing was held. The holder's
 * own markup (`span[data-boot-stage]`, `components/app-ui/hushh-loader.tsx`)
 * is the truth until then. Markup inside a hidden subtree (a retained route
 * behind `display: none`) is not a hold.
 */
function serverHeldStages(): BootStage[] {
  if (typeof document === "undefined") return [];
  const stages: BootStage[] = [];
  for (const node of document.querySelectorAll<HTMLElement>("span[data-boot-stage]")) {
    const stage = node.dataset.bootStage as BootStage | undefined;
    if (stage && isRendered(node.parentElement)) stages.push(stage);
  }
  return stages;
}

function evaluate(): void {
  let stage = activeBootStage(claims.values());
  if (stage === null) {
    // Hydration can drop an un-claimed holder without any claim or release
    // to announce it, so re-check while one is on screen.
    stage = activeBootStage(serverHeldStages());
    if (stage !== null && serverHoldTimer === null) {
      serverHoldTimer = setTimeout(() => {
        serverHoldTimer = null;
        evaluate();
      }, SERVER_HOLD_RECHECK_MS);
    }
  }
  // Before the first route has committed, "nothing held" only means the
  // guards have not mounted yet; keep the launch surface up.
  if (stage === null && !routeCommitted) return;
  const at = now();
  recordStage(stage, at);
  commit(reduceBoot(state, { type: "stage", stage, at }));
}

function scheduleEvaluate(immediate: boolean): void {
  if (!started) return;
  if (immediate) {
    evaluate();
    return;
  }
  if (settleQueued) return;
  settleQueued = true;
  queueMicrotask(() => {
    settleQueued = false;
    evaluate();
  });
}

function detectLaunch(): BootLaunch {
  if (typeof document === "undefined") return "web";
  const root = document.documentElement;
  return root.classList.contains("native-ios") ||
    root.classList.contains("native-android")
    ? "native"
    : "web";
}

/**
 * Called once by the mounted surface. The client takes over the cold
 * document's surface from the time already elapsed since navigation start.
 */
export function startBootSurface(launch: BootLaunch = detectLaunch()): void {
  if (started) return;
  started = true;
  // Only the cold document's surface is taken over; a store that already
  // left it (a test seam, a remount) keeps its state.
  if (state === LAUNCH_BOOT_STATE) state = launchBootState(launch, now());
  armDeadline();
  emit();
  scheduleEvaluate(false);
}

function dropNavigationHolds(): void {
  if (navigationHolds.size === 0) return;
  for (const [id, timer] of navigationHolds) {
    clearTimeout(timer);
    claims.delete(id);
  }
  navigationHolds.clear();
  scheduleEvaluate(false);
}

/**
 * A route has committed. The first call proves the route tree exists, so an
 * empty claim set is real. A call with a new path ends every navigation hold:
 * the destination's own guards claimed in this same commit, before this
 * effect ran, so the evaluation sees them.
 */
export function markBootRouteCommitted(path: string | null = null): void {
  const pathChanged = committedPath !== null && path !== committedPath;
  committedPath = path;
  if (!routeCommitted) {
    routeCommitted = true;
    scheduleEvaluate(false);
    return;
  }
  if (pathChanged) queueMicrotask(dropNavigationHolds);
}

export type BootClaimOptions = {
  /**
   * For a guard that is redirecting: keep the stage held after it unmounts,
   * until the destination route commits (or a 4 s safety release). The old
   * route can unmount a frame or more before the new one commits; without
   * this the surface would start its exit between two steps of one boot.
   */
  holdThroughNavigation?: boolean;
};

/** Hold the surface on a stage until the returned release is called. */
export function claimBootStage(
  stage: BootStage,
  options: BootClaimOptions = {},
): () => void {
  const id = ++claimSequence;
  claims.set(id, stage);
  scheduleEvaluate(true);
  return () => {
    if (!claims.has(id) || navigationHolds.has(id)) return;
    if (options.holdThroughNavigation) {
      navigationHolds.set(
        id,
        setTimeout(() => {
          navigationHolds.delete(id);
          if (claims.delete(id)) scheduleEvaluate(false);
        }, NAVIGATION_HOLD_SAFETY_MS),
      );
      return;
    }
    claims.delete(id);
    scheduleEvaluate(false);
  };
}

export function subscribeBootSurface(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBootSurfaceState(): BootState {
  return state;
}

function getServerBootSurfaceState(): BootState {
  return LAUNCH_BOOT_STATE;
}

export function useBootSurfaceState(): BootState {
  return useSyncExternalStore(
    subscribeBootSurface,
    getBootSurfaceState,
    getServerBootSurfaceState,
  );
}

/**
 * Hold the boot surface on `stage` while mounted; `null` holds nothing.
 * Registered in a layout effect so the claim exists before the frame that
 * would otherwise paint the bare route underneath.
 */
export function useBootStageClaim(
  stage: BootStage | null,
  options: BootClaimOptions = {},
): void {
  const holdThroughNavigation = options.holdThroughNavigation === true;
  useLayoutEffect(() => {
    if (!stage) return undefined;
    return claimBootStage(stage, { holdThroughNavigation });
  }, [stage, holdThroughNavigation]);
}

/** Test seam: forget every claim, timer and mark, back to the cold document. */
export function resetBootSurfaceForTests(
  initial: BootState = LAUNCH_BOOT_STATE,
): void {
  claims.clear();
  listeners.clear();
  for (const timer of navigationHolds.values()) clearTimeout(timer);
  navigationHolds.clear();
  committedPath = null;
  if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  deadlineTimer = null;
  if (serverHoldTimer !== null) clearTimeout(serverHoldTimer);
  serverHoldTimer = null;
  settleQueued = false;
  claimSequence = 0;
  started = false;
  routeCommitted = false;
  markedStage = null;
  markedStageAt = 0;
  readyMarked = false;
  state = initial;
}

export { BOOT_TIMING, IDLE_BOOT_STATE };
