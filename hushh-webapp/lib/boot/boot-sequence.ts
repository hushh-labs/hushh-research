/**
 * The boot sequence as one surface.
 *
 * Cold start used to walk a person through up to six separate loader screens
 * ("Checking session...", "Checking vault...", "Checking phone
 * requirement...", "Checking setup...", "Opening chat...", "Loading chat..."),
 * each painted by a different guard, in a different box (`h-screen` here,
 * `min-h-[60vh]` there), so the text jumped between screens as the guards
 * handed over. This module is the pure half of the replacement: the stages,
 * the line each one shows, and the timing machine that decides whether the
 * single persistent surface is shown at all. It has no DOM, React or timer
 * dependency, so the thresholds are proven by unit tests, not by eye.
 *
 * The rendering half lives in `components/app-ui/boot-surface.tsx`; the claim
 * registry and timer driver in `lib/boot/boot-surface-store.ts`.
 */

/**
 * Every stage a guard can hold the app in, in dependency order. When more
 * than one guard holds at once, the earliest stage is the one actually being
 * waited on (a vault cannot be checked before the session is known), so it is
 * the line shown.
 */
export const BOOT_STAGES = [
  "session",
  "redirect",
  "reconnect",
  "vault",
  "phone",
  "setup",
  "workspace",
] as const;

export type BootStage = (typeof BOOT_STAGES)[number];

export type BootLine = Readonly<{ emoji: string; text: string }>;

/**
 * One short, friendly line per real stage. The line names the step the app is
 * actually waiting on; it never advances on a timer, so it can never claim
 * progress that has not happened.
 */
export const BOOT_STAGE_LINES: Readonly<Record<BootStage, BootLine>> = {
  session: { emoji: "🔑", text: "Checking it's you" },
  redirect: { emoji: "👋", text: "Taking you to sign in" },
  reconnect: { emoji: "🔄", text: "Reconnecting securely" },
  vault: { emoji: "🔐", text: "Opening your vault" },
  phone: { emoji: "📱", text: "Checking your number" },
  setup: { emoji: "🧭", text: "Checking your setup" },
  workspace: { emoji: "🤝", text: "Getting One ready" },
};

export const BOOT_TITLE = "Hussh One is getting ready";
export const BOOT_OFFLINE_LINE: BootLine = {
  emoji: "📡",
  text: "Waiting for a connection",
};
export const BOOT_STUCK_TEXT = "This is taking longer than usual.";
export const BOOT_RETRY_LABEL = "Try again";

/**
 * Timing contract.
 *
 * - `showAfterMs` 200: a response inside ~200 ms reads as immediate, and a
 *   loader that flashes for fewer frames than that reads as flicker rather
 *   than feedback. A warm path (cached session, vault in memory, admission
 *   cached) settles inside this window and paints nothing extra.
 * - `minVisibleMs` 400: once shown, the surface is on screen for at least
 *   this long, enough for its 150 ms entrance to finish and for one line to
 *   be read (24 frames at 60 Hz), so it can never show and vanish as a flash.
 *   It is honoured by lengthening the exit fade, never by blocking: the
 *   moment the guards release, input passes through to the app and the app
 *   paints under the fading surface. Measured on localhost, a blocking hold
 *   made a signed-out cold start ~120 ms slower to interactive; this does not.
 * - `exitMs` 150: the exit fade when the minimum is already met; the overlay
 *   presentation ceiling (`--motion-duration-xl`).
 * - `stuckAfterMs` 10000: no real stage waits this long without failing into
 *   its own recovery screen (vault presence retries back off at 2/5/10 s and
 *   then surface SessionVerificationRecovery). Ten seconds on one stage is a
 *   hang, and the person gets a way out instead of an endless loader.
 */
export const BOOT_TIMING = Object.freeze({
  showAfterMs: 200,
  minVisibleMs: 400,
  exitMs: 150,
  stuckAfterMs: 10_000,
});

export type BootTiming = typeof BOOT_TIMING;

/**
 * - `idle`: nothing held, nothing painted.
 * - `pending`: a guard holds, but not yet for `showAfterMs`; nothing painted.
 * - `launch`: the cold document's own surface. On native it continues the
 *   OS splash from the first frame; on the web it reveals at `showAfterMs`
 *   from navigation start through CSS, before any JavaScript runs.
 * - `visible`: shown, holding a stage.
 * - `exiting`: every guard released; input already reaches the app while the
 *   surface fades over `exitDuration`.
 */
export type BootPhase =
  | "idle"
  | "pending"
  | "launch"
  | "visible"
  | "exiting";

export type BootLaunch = "native" | "web";

export type BootState = Readonly<{
  phase: BootPhase;
  /** The stage on screen; kept through `exiting` so the line does not blank. */
  stage: BootStage | null;
  /** True while the surface is still the cold document's (splash-matched) surface. */
  launch: boolean;
  /** When the current phase began (ms on the performance clock). */
  since: number;
  /** When the surface became visible, or null while not shown. */
  shownAt: number | null;
  /** When the active stage began, for the stuck fallback. */
  stageSince: number | null;
  stuck: boolean;
  /** Length of the current exit fade: `exitMs`, or longer to honour `minVisibleMs`. */
  exitDuration: number;
}>;

export type BootEvent =
  | Readonly<{ type: "stage"; stage: BootStage | null; at: number }>
  | Readonly<{ type: "tick"; at: number }>;

export function isBootSurfaceShown(phase: BootPhase): boolean {
  return phase === "launch" || phase === "visible";
}

/** The stage being waited on when several guards hold at once. */
export function activeBootStage(
  stages: Iterable<BootStage>,
): BootStage | null {
  let best = -1;
  for (const stage of stages) {
    const rank = BOOT_STAGES.indexOf(stage);
    if (rank >= 0 && (best < 0 || rank < best)) best = rank;
  }
  return best < 0 ? null : (BOOT_STAGES[best] ?? null);
}

export const IDLE_BOOT_STATE: BootState = Object.freeze({
  phase: "idle",
  stage: null,
  launch: false,
  since: 0,
  shownAt: null,
  stageSince: null,
  stuck: false,
  exitDuration: BOOT_TIMING.exitMs,
});

/**
 * The state the cold document is painted in, on the server and on the first
 * client render, so hydration matches the static HTML exactly.
 */
export const LAUNCH_BOOT_STATE: BootState = Object.freeze({
  phase: "launch",
  stage: null,
  launch: true,
  since: 0,
  shownAt: null,
  stageSince: 0,
  stuck: false,
  exitDuration: BOOT_TIMING.exitMs,
});

/**
 * Where the client takes over the cold document's surface.
 *
 * Native: the splash has been on screen since the tap, so the minimum visible
 * time is already spent; a release exits at once. Web: CSS revealed the
 * surface at `showAfterMs` after navigation start (if the document lived that
 * long), and the minimum visible time counts from that reveal.
 */
export function launchBootState(
  launch: BootLaunch,
  at: number,
  timing: BootTiming = BOOT_TIMING,
): BootState {
  if (launch === "native") {
    return { ...LAUNCH_BOOT_STATE, shownAt: -timing.minVisibleMs };
  }
  return {
    ...LAUNCH_BOOT_STATE,
    shownAt: at >= timing.showAfterMs ? timing.showAfterMs : null,
  };
}

function onStage(
  state: BootState,
  stage: BootStage | null,
  at: number,
  timing: BootTiming,
): BootState {
  if (stage !== null) {
    const stageChanged = stage !== state.stage;
    const stageSince = stageChanged || state.stageSince === null ? at : state.stageSince;
    const stuck = stageChanged ? false : state.stuck;
    switch (state.phase) {
      case "idle":
        return {
          ...state,
          phase: "pending",
          stage,
          launch: false,
          since: at,
          shownAt: null,
          stageSince: at,
          stuck: false,
        };
      case "pending":
      case "launch":
      case "visible":
        return { ...state, stage, stageSince, stuck };
      case "exiting":
        // A guard claimed again before the exit finished (a redirect into a
        // guarded route, a second check): stay on the one surface.
        return {
          ...state,
          phase: state.launch ? "launch" : "visible",
          since: at,
          stage,
          stageSince,
          stuck,
        };
    }
  }

  switch (state.phase) {
    case "idle":
    case "exiting":
      return state;
    case "pending":
      // Fast path: released before it was ever shown. Nothing painted.
      return { ...IDLE_BOOT_STATE, since: at };
    case "launch":
      if (state.shownAt === null) {
        // Web document that settled before its CSS reveal: never shown.
        return { ...IDLE_BOOT_STATE, since: at };
      }
      return releaseShown(state, at, timing);
    case "visible":
      return releaseShown(state, at, timing);
  }
}

function releaseShown(state: BootState, at: number, timing: BootTiming): BootState {
  const shownAt = state.shownAt ?? at;
  const remaining = timing.minVisibleMs - (at - shownAt);
  return {
    ...state,
    phase: "exiting",
    since: at,
    stuck: false,
    exitDuration: Math.min(timing.minVisibleMs, Math.max(timing.exitMs, remaining)),
  };
}

function onTick(state: BootState, at: number, timing: BootTiming): BootState {
  switch (state.phase) {
    case "idle":
      return state;
    case "pending":
      if (at - state.since < timing.showAfterMs) return state;
      return {
        ...state,
        phase: "visible",
        since: at,
        shownAt: at,
      };
    case "launch":
    case "visible": {
      let next = state;
      if (state.phase === "launch" && state.shownAt === null && at >= timing.showAfterMs) {
        next = { ...next, shownAt: timing.showAfterMs };
      }
      const stuckFrom = next.stageSince ?? next.since;
      if (!next.stuck && at - stuckFrom >= timing.stuckAfterMs) {
        next = { ...next, stuck: true };
      }
      return next;
    }
    case "exiting":
      if (at - state.since < state.exitDuration) return state;
      return { ...IDLE_BOOT_STATE, since: at };
  }
}

export function reduceBoot(
  state: BootState,
  event: BootEvent,
  timing: BootTiming = BOOT_TIMING,
): BootState {
  return event.type === "stage"
    ? onStage(state, event.stage, event.at, timing)
    : onTick(state, event.at, timing);
}

/**
 * The next moment a tick can change the state, or null when only a stage
 * change can. The driver arms exactly one timer for it.
 */
export function nextBootDeadline(
  state: BootState,
  timing: BootTiming = BOOT_TIMING,
): number | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "pending":
      return state.since + timing.showAfterMs;
    case "launch":
    case "visible": {
      if (state.stuck) return null;
      const stuckAt = (state.stageSince ?? state.since) + timing.stuckAfterMs;
      if (state.phase === "launch" && state.shownAt === null) {
        return Math.min(timing.showAfterMs, stuckAt);
      }
      return stuckAt;
    }
    case "exiting":
      return state.since + state.exitDuration;
  }
}

/** The line on screen for a state; offline outranks the stage, because it is what is actually blocking. */
export function bootLineFor(
  stage: BootStage | null,
  offline: boolean,
): BootLine | null {
  if (offline) return BOOT_OFFLINE_LINE;
  return stage ? BOOT_STAGE_LINES[stage] : null;
}
