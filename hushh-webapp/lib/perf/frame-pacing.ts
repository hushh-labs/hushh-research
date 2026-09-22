/**
 * The in-app frame-pacing probe.
 *
 * Loaded only through a dynamic import once the enablement check passes, so
 * a normal session never fetches this chunk. It records the interval between
 * animation frames, buckets those intervals by the gesture that was under way
 * (sheet drag, pager swipe, scroll, tab tap, nothing) and by route, and can
 * hand the result back as JSON with no personal information in it: no text,
 * no element content, no full URLs, no identifiers.
 *
 * WebKit has no Long Tasks or Long Animation Frames API, and Event Timing only
 * from iOS 26.2, so on the phone the frame interval is the primary signal.
 * Where the other observers exist (Android WebView, Chromium in CI) they are
 * attached too and reported per window.
 */

import { Capacitor } from "@capacitor/core";
import { type RenderCommit, setRenderCommitSink } from "@/lib/perf/render-commit-sink";

import {
  FrameAccumulator,
  frameBudgetMs,
  nominalHz,
  type FrameWindowStats,
  type NominalHz,
} from "./frame-stats";

export const PERF_EXPORT_SCHEMA = "hushh-render-perf-v1";
export const PERF_STATUS_TEST_ID = "hushh-perf-status";
export const PERF_CONSOLE_MARKER = "HUSHH_RENDER_PERF_JSON=";

export type GestureKind =
  | "sheet"
  | "drawer"
  | "pager"
  | "bottom-nav"
  | "top-tabs"
  | "scroll"
  | "tap"
  /** Keyboard input: opened by `input`/`keydown`, closed after TYPE_QUIET_MS without one. */
  | "type"
  /** The visual viewport changed size (the keyboard rose or fell) with no pointer window open. */
  | "viewport";

type WindowKind = GestureKind | `${GestureKind}→route` | "scroll:programmatic" | "stream";

/**
 * A streaming reply produces no input, so no pointer or scroll window covers
 * it; the assistant bubble marks itself while text arrives and the probe
 * keeps a window open for as long as the marker is present (polled every
 * STREAM_POLL_FRAMES frames: one querySelector, no observer in the lane).
 */
const STREAM_MARKER = '[data-agent-streaming="true"]';
const STREAM_POLL_FRAMES = 10;

/**
 * Where a pointer lands decides what the window is called. Order matters: a
 * sheet contains a scroll root, a pager contains list rows.
 */
const GESTURE_TARGETS: ReadonlyArray<readonly [string, GestureKind]> = [
  ['[data-slot="sheet-content"]', "sheet"],
  ['[data-slot="drawer-content"]', "drawer"],
  ['[data-swipe-views-root="true"]', "pager"],
  ['[data-testid="app-bottom-nav-frame"]', "bottom-nav"],
  ["[data-top-shell-tab-set]", "top-tabs"],
  ['[data-app-scroll-root="true"]', "scroll"],
];

const SCROLL_QUIET_MS = 160;
const POINTER_SETTLE_MS = 900;
// Typing on the native keyboard reaches the page as input events only (no
// pointer event, the keys are native); a window stays open while they keep
// coming and closes this long after the last one.
const TYPE_QUIET_MS = 600;
// A keyboard rise or fall resizes the visual viewport; when no pointer
// window is open (a tap outside an editable reaches the page as no pointer
// event on iOS while the keyboard is up) this is the only signal of it.
const VIEWPORT_SETTLE_MS = 900;
// A tap on a tab or nav item is followed by a route change that a cold dev
// server can take seconds to serve; keep those windows open long enough for
// the change to attach, so "tap to settled" includes the destination paint.
const NAV_SETTLE_MS = 2500;
const ROUTE_SETTLE_MS = 1200;
const NAVIGATION_KINDS: ReadonlySet<string> = new Set(["bottom-nav", "top-tabs", "tap"]);
const WINDOW_CAP_MS = 15_000;
const NATIVE_EXPORT_INTERVAL_MS = 10_000;
const BOOT_PROBE_MS = 1000;
const ROUTE_ID_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;
const ROUTE_VARIANT_KEYS = ["tab", "profile_pane", "action", "demo"] as const;

type EventTimingEntry = { name: string; duration_ms: number; processing_ms: number; at_ms: number };
type EventTimingSummary = {
  count: number;
  max_ms: number;
  over_100_count: number;
  inp_ms: number;
  /** The longest entries by duration, with the event's name and its offset in the window. */
  top: EventTimingEntry[];
};
/** One of the longest frames in a window: its gap and where in the window it ended. */
type WorstFrame = { gap_ms: number; at_ms: number };
/**
 * The two bottom bars on the chat route (the navigation stack and the
 * composer) ride the same scroll progress; per frame the probe reads both
 * transforms and keeps the largest vertical divergence. Two bars on one clock
 * read 0; a bar easing behind the other reads its lag in pixels.
 */
type BottomChromeSync = { samples: number; max_divergence_px: number };
/**
 * The keyboard's rise or fall, edge by edge: when `html.kb-open` flips, the
 * probe records for KEYBOARD_TRACE_MS the composer field's bottom edge and
 * the last transcript row's bottom edge on every frame. A smooth motion is a
 * monotonic series with no step larger than the curve's largest per-frame
 * move; a step is what a person calls a jitter.
 */
type KeyboardTrace = {
  phase: "show" | "hide";
  started_epoch_ms: number;
  composer_bottom: number[];
  last_row_bottom: number[];
  /** Largest per-frame move of each edge, and the frame it happened on. */
  composer_max_step: { px: number; frame: number };
  last_row_max_step: { px: number; frame: number };
};
const KEYBOARD_TRACE_MS = 450;
const KEYBOARD_TRACE_FRAMES_KEPT = 40;
const TRACE_COMPOSER = 'textarea[data-testid="agent-chat-composer-textarea"]';
const TRACE_LAST_ROW = ".agent-chat-workspace [data-message-role]";
const CHROME_NAV_STACK = "[data-bottom-shell-motion-stack]";
const CHROME_COMPOSER = '[data-agent-chat-composer-form="root"]';

function translateY(element: Element): number | null {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return 0;
  const name = transform.slice(0, transform.indexOf("(")).trim();
  const values = transform
    .slice(transform.indexOf("(") + 1, transform.lastIndexOf(")"))
    .split(",")
    .map((v) => Number.parseFloat(v));
  if (values.some((v) => Number.isNaN(v))) return null;
  // An engine resolves to a matrix; a test environment hands back the declared function.
  if (name === "matrix" && values.length === 6) return values[5] ?? null;
  if (name === "matrix3d" && values.length === 16) return values[13] ?? null;
  if (name === "translate3d" || name === "translate") return values[1] ?? 0;
  if (name === "translateY") return values[0] ?? null;
  return null;
}
const WORST_FRAMES_KEPT = 3;
const EVENT_ENTRIES_KEPT = 3;
type LongTaskSummary = { count: number; total_ms: number };
type LoafSummary = { count: number; blocking_ms: number };

type ProbeWindow = {
  id: number;
  kind: WindowKind;
  route: string;
  route_variant: string | null;
  scenario: string | null;
  startEpoch: number;
  startPerf: number;
  endEpoch: number | null;
  endPerf: number | null;
  acc: FrameAccumulator;
  events: EventTimingSummary | null;
  longtask: LongTaskSummary | null;
  loaf: LoafSummary | null;
  /** Largest duration per interaction id, for an INP-style value. */
  interactionMax: Map<number, number>;
  /** React commits inside the window (profiling build only; see render-commit-sink). */
  commits: CommitAccumulator;
  /** Set when the window carried a route change: the destination's first commit and first frame. */
  routeEnter: RouteEnterReport | null;
  /** The longest frames, so a single stall can be placed inside the window. */
  worst: WorstFrame[];
  /** Elements in the document when the window closed: the size of a whole-document style pass. */
  domNodes: number | null;
  /** Divergence between the bottom navigation and the chat composer while they ride a scroll. */
  chromeSync: BottomChromeSync | null;
};

function keepTop<T>(list: T[], item: T, limit: number, value: (item: T) => number): void {
  list.push(item);
  list.sort((a, b) => value(b) - value(a));
  if (list.length > limit) list.length = limit;
}

/** Top-N by actual duration plus totals; bounded so a long window stays small. */
class CommitAccumulator {
  count = 0;
  totalMs = 0;
  maxMs = 0;
  top: RenderCommit[] = [];

  add(commit: RenderCommit): void {
    this.count += 1;
    this.totalMs += commit.actual_ms;
    if (commit.actual_ms > this.maxMs) this.maxMs = commit.actual_ms;
    const smallest = this.top[this.top.length - 1];
    if (this.top.length < 3 || !smallest || commit.actual_ms > smallest.actual_ms) {
      this.top.push(commit);
      this.top.sort((a, b) => b.actual_ms - a.actual_ms);
      if (this.top.length > 3) this.top.length = 3;
    }
  }

  summary(): CommitSummary {
    return {
      count: this.count,
      total_ms: round(this.totalMs),
      max_ms: round(this.maxMs),
      top: this.top.map((c) => ({ phase: c.phase, actual_ms: round(c.actual_ms), base_ms: round(c.base_ms), at_ms: round(c.at_ms) })),
    };
  }
}

export type CommitSummary = {
  count: number;
  total_ms: number;
  max_ms: number;
  top: RenderCommit[];
};

export type RouteEnterReport = {
  route: string;
  /** actualDuration of the commit that rendered the destination (the last commit before the route change was observed). */
  first_commit_ms: number | null;
  /** Route change observed → second animation frame painted. */
  first_frame_ms: number | null;
};

export type ProbeWindowReport = FrameWindowStats & {
  id: number;
  kind: WindowKind;
  route: string;
  route_variant: string | null;
  scenario: string | null;
  start_epoch_ms: number;
  end_epoch_ms: number;
  duration_ms: number;
  event_timing: EventTimingSummary | null;
  longtask: LongTaskSummary | null;
  loaf: LoafSummary | null;
  commits: CommitSummary;
  route_enter: RouteEnterReport | null;
  worst_frames: WorstFrame[];
  dom_nodes: number | null;
  bottom_chrome_sync: BottomChromeSync | null;
};

export type ProbeExport = {
  schema_version: typeof PERF_EXPORT_SCHEMA;
  run_id: string;
  started_at_epoch_ms: number;
  exported_at_epoch_ms: number;
  platform: string;
  capacitor_native: boolean;
  ua_family: string;
  dpr: number;
  viewport: { width: number; height: number };
  hardware_concurrency: number | null;
  device_memory_gb: number | null;
  reduced_motion: boolean;
  supported_entry_types: string[];
  raf_hz: { raw: number; nominal: NominalHz; budget_ms: number; samples: number };
  hud: boolean;
  windows: ProbeWindowReport[];
  idle_by_route: Array<FrameWindowStats & { route: string; duration_ms: number; commits: CommitSummary }>;
  attribution: { loaf_top_scripts: Array<{ source: string; blocking_ms: number }> };
  /** Every keyboard rise and fall the probe saw, edge by edge per frame. */
  keyboard_traces: KeyboardTrace[];
  /** True once React reported a commit: a `next build --profile` bundle (attribution only, never certifies). */
  react_profiling: boolean;
  /** Attribution experiments applied for this launch; any entry means the run never certifies. */
  experiments: string[];
  /** Exceptions caught inside the frame loop; anything but 0 means the run's numbers are suspect. */
  tick_errors: number;
};

export type FramePacingProbe = {
  setRoute: (pathname: string, search: string) => void;
  scenario: (name: string | null) => void;
  export: (options?: { includeRaw?: boolean }) => ProbeExport;
  stop: () => void;
};

declare global {
  interface Window {
    __hushhPerf?: {
      export: () => string;
      scenario: (name: string | null) => void;
      snapshot: () => ProbeExport;
    };
  }
}

function sanitizeUserAgentFamily(ua: string): string {
  const device = /iPhone|iPad|Android|Macintosh|Windows|Linux/.exec(ua)?.[0] ?? "unknown";
  const engine =
    /Chrome\/\d+/.exec(ua)?.[0] ?? /AppleWebKit\/\d+/.exec(ua)?.[0] ?? "engine-unknown";
  return `${device} ${engine}`;
}

function normalizeRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (ROUTE_ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

function normalizeVariant(search: string): string | null {
  const params = new URLSearchParams(search);
  const parts: string[] = [];
  for (const key of ROUTE_VARIANT_KEYS) {
    const value = params.get(key);
    if (value !== null) parts.push(`${key}=${value.slice(0, 32)}`);
  }
  return parts.length ? parts.join("&") : null;
}

function classifyTarget(target: EventTarget | null): GestureKind {
  if (!(target instanceof Element)) return "tap";
  for (const [selector, kind] of GESTURE_TARGETS) {
    if (target.closest(selector)) return kind;
  }
  return "tap";
}

function randomRunId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Attribution experiments: one launch, applied by the probe, named in the
 * export (a run with one on never certifies). `autocorrect-off` turns the
 * chat composer's autocorrection and spell checking off before it is
 * focused, to separate WebKit's autocorrection-context work for the system
 * keyboard from what the page does when the keyboard rises or text wraps.
 * `kb-inset-off` asks KeyboardInsetManager to leave `--kb-height` alone for
 * the launch (read from `data-perf-experiment` on <html>), to separate the
 * system keyboard's presentation from the page's own keyboard work.
 */
const EXPERIMENT_DATASET_KEY = "perfExperiment";
const EXPERIMENT_COMPOSER = 'textarea[data-testid="agent-chat-composer-textarea"]';
const EXPERIMENT_POLL_FRAMES = 10;

function applyAutocorrectOff(): void {
  const composer = document.querySelector<HTMLTextAreaElement>(EXPERIMENT_COMPOSER);
  if (!composer || composer.getAttribute("autocorrect") === "off") return;
  composer.setAttribute("autocorrect", "off");
  composer.setAttribute("spellcheck", "false");
}

/** Spell checking alone off; autocorrection stays as the product ships it. */
function applySpellcheckOff(): void {
  const composer = document.querySelector<HTMLTextAreaElement>(EXPERIMENT_COMPOSER);
  if (!composer || composer.getAttribute("spellcheck") === "false") return;
  composer.setAttribute("spellcheck", "false");
}

export function startFramePacingProbe(options: { hud: boolean; experiments?: string[] }): FramePacingProbe {
  const startedAt = Date.now();
  const experiments = options.experiments ?? [];
  if (experiments.length > 0) document.documentElement.dataset[EXPERIMENT_DATASET_KEY] = experiments.join(",");
  // A throw inside the frame loop would end the run silently; it is counted
  // and exported instead, and the loop keeps its next frame.
  let tickErrors = 0;
  const runId = randomRunId();
  const windows: ProbeWindow[] = [];
  const idle = new Map<string, { acc: FrameAccumulator; durationMs: number; commits: CommitAccumulator }>();
  let reactProfiling = false;
  let lastCommit: RenderCommit | null = null;
  let routeEnterFrame: number | null = null;
  const loafScripts = new Map<string, number>();

  let route = normalizeRoute(window.location.pathname);
  let routeVariant = normalizeVariant(window.location.search);
  let scenario: string | null = null;
  let budgetMs = frameBudgetMs(60);
  let rafHz = { raw: 0, nominal: 60 as NominalHz, budget_ms: budgetMs, samples: 0 };
  let booting = true;
  let bootFrames = 0;
  let bootStart = 0;

  let current: ProbeWindow | null = null;
  let nextWindowId = 1;
  let lastFrameAt = 0;
  let frameIndex = 0;
  let lastScrollAt = 0;
  let lastInputAt = 0;
  let lastViewportAt = 0;
  let pointerUpAt: number | null = null;
  let routeChangedAt: number | null = null;
  let rafHandle = 0;
  let stopped = false;

  const statusNode = createStatusNode();
  const hudNode = options.hud ? createHudNode() : null;
  let exportedCount = 0;

  const idleFor = (key: string) => {
    let entry = idle.get(key);
    if (!entry) {
      entry = { acc: new FrameAccumulator(), durationMs: 0, commits: new CommitAccumulator() };
      idle.set(key, entry);
    }
    return entry;
  };

  // React commits (profiling build only): into the open window, else the
  // route's idle bucket. The last one is the destination's first commit when
  // a route change is observed right after it.
  setRenderCommitSink((commit) => {
    if (stopped) return;
    reactProfiling = true;
    lastCommit = commit;
    if (current) current.commits.add(commit);
    else idleFor(`idle:${route}`).commits.add(commit);
  });

  // Both bars exist only on the chat route; elsewhere the reading stays null.
  const sampleChromeSync = (w: ProbeWindow) => {
    // With the keyboard up the navigation is hidden and lifted by the
    // keyboard on `transform` while the composer lifts on `translate`; only
    // the scroll ride, keyboard down, is one motion to compare.
    if (document.documentElement.classList.contains("kb-open")) return;
    const nav = document.querySelector(CHROME_NAV_STACK);
    const composer = document.querySelector(CHROME_COMPOSER);
    if (!nav || !composer) return;
    const navY = translateY(nav);
    const composerY = translateY(composer);
    if (navY === null || composerY === null) return;
    const sync = (w.chromeSync ??= { samples: 0, max_divergence_px: 0 });
    sync.samples += 1;
    sync.max_divergence_px = Math.max(sync.max_divergence_px, round(Math.abs(navY - composerY)));
  };

  const closeWindow = (now: number) => {
    if (!current) return;
    current.endPerf = now;
    current.endEpoch = Date.now();
    // Read after the gesture, never inside it: a live collection's length
    // walks the tree once.
    current.domNodes = document.getElementsByTagName("*").length;
    current = null;
    pointerUpAt = null;
    routeChangedAt = null;
    updateStatus();
  };

  const openWindow = (kind: WindowKind, now: number) => {
    if (current) closeWindow(now);
    current = {
      id: nextWindowId++,
      kind,
      route,
      route_variant: routeVariant,
      scenario,
      startEpoch: Date.now(),
      startPerf: now,
      endEpoch: null,
      endPerf: null,
      acc: new FrameAccumulator(),
      events: null,
      longtask: null,
      loaf: null,
      interactionMax: new Map(),
      commits: new CommitAccumulator(),
      routeEnter: null,
      worst: [],
      domNodes: null,
      chromeSync: null,
    };
    windows.push(current);
  };

  const tick = (now: number) => {
    if (stopped) return;
    try {
      tickBody(now);
    } catch {
      tickErrors += 1;
    }
    lastFrameAt = now;
    rafHandle = window.requestAnimationFrame(tick);
  };

  // Keyboard trace: armed when html.kb-open flips, sampled each frame after.
  const keyboardTraces: KeyboardTrace[] = [];
  let keyboardOpen = document.documentElement.classList.contains("kb-open");
  let activeTrace: { trace: KeyboardTrace; startPerf: number; frames: number } | null = null;
  const sampleKeyboardTrace = (now: number) => {
    const open = document.documentElement.classList.contains("kb-open");
    if (open !== keyboardOpen) {
      keyboardOpen = open;
      const trace: KeyboardTrace = {
        phase: open ? "show" : "hide",
        started_epoch_ms: Date.now(),
        composer_bottom: [],
        last_row_bottom: [],
        composer_max_step: { px: 0, frame: 0 },
        last_row_max_step: { px: 0, frame: 0 },
      };
      keyboardTraces.push(trace);
      activeTrace = { trace, startPerf: now, frames: 0 };
    }
    if (!activeTrace) return;
    if (now - activeTrace.startPerf > KEYBOARD_TRACE_MS || activeTrace.frames >= KEYBOARD_TRACE_FRAMES_KEPT) {
      activeTrace = null;
      return;
    }
    const composer = document.querySelector(TRACE_COMPOSER);
    const rows = document.querySelectorAll(TRACE_LAST_ROW);
    const lastRow = rows.length ? rows[rows.length - 1] : null;
    const { trace } = activeTrace;
    const frame = activeTrace.frames;
    const push = (list: number[], value: number | null, step: { px: number; frame: number }) => {
      if (value === null) return;
      const previous = list[list.length - 1];
      list.push(round(value));
      if (previous !== undefined) {
        const move = round(Math.abs(value - previous));
        if (move > step.px) {
          step.px = move;
          step.frame = frame;
        }
      }
    };
    push(trace.composer_bottom, composer ? composer.getBoundingClientRect().bottom : null, trace.composer_max_step);
    push(trace.last_row_bottom, lastRow ? lastRow.getBoundingClientRect().bottom : null, trace.last_row_max_step);
    activeTrace.frames += 1;
  };

  const tickBody = (now: number) => {
    sampleKeyboardTrace(now);
    if (booting) {
      if (bootStart === 0) {
        bootStart = now;
      } else {
        bootFrames += 1;
        if (now - bootStart >= BOOT_PROBE_MS) {
          const raw = (bootFrames / (now - bootStart)) * 1000;
          const nominal = nominalHz(raw);
          budgetMs = frameBudgetMs(nominal);
          rafHz = { raw: round(raw), nominal, budget_ms: budgetMs, samples: bootFrames };
          booting = false;
          updateStatus();
        }
      }
    }
    frameIndex += 1;
    if (experiments.length > 0 && frameIndex % EXPERIMENT_POLL_FRAMES === 0) {
      try {
        if (experiments.includes("autocorrect-off")) applyAutocorrectOff();
        if (experiments.includes("spellcheck-off")) applySpellcheckOff();
      } catch {
        tickErrors += 1;
      }
    }
    if (frameIndex % STREAM_POLL_FRAMES === 0) {
      const streaming = document.querySelector(STREAM_MARKER) !== null;
      if (streaming && !current) openWindow("stream", now);
      else if (!streaming && current?.kind === "stream") closeWindow(now);
    }
    if (lastFrameAt) {
      const delta = now - lastFrameAt;
      if (current) {
        current.acc.add(delta, budgetMs);
        if (delta > budgetMs) {
          keepTop(current.worst, { gap_ms: round(delta), at_ms: round(now - current.startPerf) }, WORST_FRAMES_KEPT, (f) => f.gap_ms);
        }
        if (current.kind === "scroll") sampleChromeSync(current);
        const sinceScroll = now - lastScrollAt;
        const settleMs = NAVIGATION_KINDS.has(current.kind) ? NAV_SETTLE_MS : POINTER_SETTLE_MS;
        const settled =
          pointerUpAt !== null && now - pointerUpAt >= settleMs && sinceScroll >= SCROLL_QUIET_MS;
        const routeSettled = routeChangedAt !== null && now - routeChangedAt >= ROUTE_SETTLE_MS;
        const programmatic = current.kind === "scroll:programmatic" && sinceScroll >= SCROLL_QUIET_MS;
        const typingDone = current.kind === "type" && now - lastInputAt >= TYPE_QUIET_MS;
        const viewportDone = current.kind === "viewport" && now - lastViewportAt >= VIEWPORT_SETTLE_MS;
        if (
          (settled && (routeChangedAt === null || routeSettled)) ||
          programmatic ||
          typingDone ||
          viewportDone ||
          now - current.startPerf >= WINDOW_CAP_MS
        ) {
          closeWindow(now);
        }
      } else {
        const entry = idleFor(`idle:${route}`);
        entry.acc.add(delta, budgetMs);
        entry.durationMs += delta;
      }
      if (hudNode) updateHud(delta);
    }
  };

  const onPointerDown = (event: Event) => {
    const kind = classifyTarget(event.target);
    openWindow(kind, performance.now());
  };
  const onPointerUp = () => {
    if (!current) return;
    pointerUpAt = performance.now();
  };
  const onScroll = () => {
    lastScrollAt = performance.now();
    if (!current) openWindow("scroll:programmatic", lastScrollAt);
  };
  const onInput = () => {
    lastInputAt = performance.now();
    if (!current) openWindow("type", lastInputAt);
  };
  const onViewportResize = () => {
    lastViewportAt = performance.now();
    if (!current) openWindow("viewport", lastViewportAt);
  };

  const supportsPointer = typeof window.PointerEvent === "function";
  const downEvent = supportsPointer ? "pointerdown" : "touchstart";
  const upEvents = supportsPointer ? ["pointerup", "pointercancel"] : ["touchend", "touchcancel"];
  document.addEventListener(downEvent, onPointerDown, { capture: true, passive: true });
  for (const name of upEvents) {
    document.addEventListener(name, onPointerUp, { capture: true, passive: true });
  }
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("input", onInput, { capture: true, passive: true });
  document.addEventListener("keydown", onInput, { capture: true, passive: true });
  window.visualViewport?.addEventListener("resize", onViewportResize);

  // Observers where the engine has them. Safari: none of these before 26.2.
  const supported = (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes) || [];
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, handle: (entries: PerformanceEntryList) => void, init?: PerformanceObserverInit) => {
    if (!supported.includes(type)) return;
    try {
      const observer = new PerformanceObserver((list) => handle(list.getEntries()));
      observer.observe({ type, buffered: false, ...init } as PerformanceObserverInit);
      observers.push(observer);
    } catch {
      // Unsupported init shape on this engine; skip the observer.
    }
  };
  observe(
    "event",
    (entries) => {
      if (!current) return;
      const summary = (current.events ??= { count: 0, max_ms: 0, over_100_count: 0, inp_ms: 0, top: [] });
      for (const entry of entries) {
        const duration = entry.duration;
        summary.count += 1;
        if (duration > summary.max_ms) summary.max_ms = round(duration);
        if (duration > 100) summary.over_100_count += 1;
        const timing = entry as PerformanceEntry & { processingStart?: number; processingEnd?: number };
        keepTop(
          summary.top,
          {
            name: entry.name,
            duration_ms: round(duration),
            processing_ms: round((timing.processingEnd ?? 0) - (timing.processingStart ?? 0)),
            at_ms: round(entry.startTime - current.startPerf),
          },
          EVENT_ENTRIES_KEPT,
          (item) => item.duration_ms,
        );
        const interactionId = (entry as PerformanceEntry & { interactionId?: number }).interactionId;
        if (interactionId) {
          const previous = current.interactionMax.get(interactionId) ?? 0;
          if (duration > previous) current.interactionMax.set(interactionId, duration);
          summary.inp_ms = round(Math.max(...current.interactionMax.values()));
        }
      }
    },
    { durationThreshold: 16 } as PerformanceObserverInit,
  );
  observe("longtask", (entries) => {
    if (!current) return;
    const summary = (current.longtask ??= { count: 0, total_ms: 0 });
    for (const entry of entries) {
      summary.count += 1;
      summary.total_ms = round(summary.total_ms + entry.duration);
    }
  });
  observe("long-animation-frame", (entries) => {
    for (const entry of entries) {
      const loaf = entry as PerformanceEntry & {
        blockingDuration?: number;
        scripts?: Array<{ sourceURL?: string; invokerType?: string; duration?: number }>;
      };
      if (current) {
        const summary = (current.loaf ??= { count: 0, blocking_ms: 0 });
        summary.count += 1;
        summary.blocking_ms = round(summary.blocking_ms + (loaf.blockingDuration ?? 0));
      }
      for (const script of loaf.scripts ?? []) {
        const source = (script.sourceURL ?? script.invokerType ?? "unknown").split("?")[0] ?? "unknown";
        loafScripts.set(source, (loafScripts.get(source) ?? 0) + (script.duration ?? 0));
      }
    }
  });

  const snapshot = (): ProbeExport => {
    const now = performance.now();
    const reports: ProbeWindowReport[] = windows.map((w) => {
      const endPerf = w.endPerf ?? now;
      const durationMs = round(endPerf - w.startPerf);
      return {
        id: w.id,
        kind: w.kind,
        route: w.route,
        route_variant: w.route_variant,
        scenario: w.scenario,
        start_epoch_ms: w.startEpoch,
        end_epoch_ms: w.endEpoch ?? Date.now(),
        duration_ms: durationMs,
        ...w.acc.summary(durationMs),
        event_timing: w.events,
        longtask: w.longtask,
        loaf: w.loaf,
        commits: w.commits.summary(),
        route_enter: w.routeEnter,
        worst_frames: w.worst,
        dom_nodes: w.domNodes,
        bottom_chrome_sync: w.chromeSync,
      };
    });
    const idleReports = Array.from(idle.entries()).map(([key, entry]) => ({
      route: key,
      duration_ms: round(entry.durationMs),
      ...entry.acc.summary(entry.durationMs),
      commits: entry.commits.summary(),
    }));
    const topScripts = Array.from(loafScripts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([source, blocking]) => ({ source, blocking_ms: round(blocking) }));
    const nav = navigator as Navigator & { deviceMemory?: number };
    return {
      schema_version: PERF_EXPORT_SCHEMA,
      run_id: runId,
      started_at_epoch_ms: startedAt,
      exported_at_epoch_ms: Date.now(),
      platform: Capacitor.getPlatform(),
      capacitor_native: Capacitor.isNativePlatform(),
      ua_family: sanitizeUserAgentFamily(navigator.userAgent),
      dpr: window.devicePixelRatio,
      viewport: {
        width: Math.round(window.visualViewport?.width ?? window.innerWidth),
        height: Math.round(window.visualViewport?.height ?? window.innerHeight),
      },
      hardware_concurrency: navigator.hardwareConcurrency ?? null,
      device_memory_gb: nav.deviceMemory ?? null,
      reduced_motion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      supported_entry_types: Array.from(supported),
      raf_hz: rafHz,
      hud: options.hud,
      windows: reports,
      idle_by_route: idleReports,
      attribution: { loaf_top_scripts: topScripts },
      keyboard_traces: keyboardTraces,
      react_profiling: reactProfiling,
      experiments,
      tick_errors: tickErrors,
    };
  };

  const exportJson = (): string => {
    const json = JSON.stringify(snapshot());
    // console.warn survives removeConsole; the marker lets a harness find it.
    console.warn(`${PERF_CONSOLE_MARKER}${json}`);
    return json;
  };

  function updateStatus() {
    if (!statusNode) return;
    const over50 = windows.reduce((sum, w) => sum + w.acc.over50, 0);
    statusNode.textContent = `perf=${booting ? "booting" : "ready"};hz=${rafHz.nominal};windows=${windows.length};over50=${over50};exported=${exportedCount}`;
  }

  let hudLast = 0;
  function updateHud(deltaMs: number) {
    const now = performance.now();
    if (now - hudLast < 250 || !hudNode) return;
    hudLast = now;
    const w = current ?? windows[windows.length - 1];
    const stats = w ? w.acc.summary(now - w.startPerf) : null;
    hudNode.textContent = `hz ${rafHz.nominal} | Δ ${deltaMs.toFixed(1)} | p95 ${stats?.p95_ms ?? "-"} | max ${stats?.max_ms ?? "-"} | >50 ${stats?.over_50_count ?? 0} | ${w?.kind ?? "idle"}`;
  }

  // Native export: written to the app container while no gesture is in
  // flight, so the write never lands inside a window it would perturb.
  let exportTimer: number | null = null;
  const nativeExport = async () => {
    if (!Capacitor.isNativePlatform() || current) return;
    try {
      const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
      const directory = Capacitor.getPlatform() === "android" ? Directory.Data : Directory.Documents;
      await Filesystem.writeFile({
        path: `hushh-perf/${runId}.json`,
        data: JSON.stringify(snapshot()),
        directory,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      exportedCount += 1;
      updateStatus();
    } catch {
      // Filesystem unavailable: the console marker and status node remain.
    }
  };
  if (Capacitor.isNativePlatform()) {
    exportTimer = window.setInterval(() => void nativeExport(), NATIVE_EXPORT_INTERVAL_MS);
  }
  const onVisibility = () => {
    if (document.visibilityState === "hidden") void nativeExport();
  };
  document.addEventListener("visibilitychange", onVisibility);

  window.__hushhPerf = {
    export: exportJson,
    scenario: (name) => {
      scenario = name;
      if (name) openWindow("tap", performance.now());
      else closeWindow(performance.now());
      if (current) current.scenario = name;
    },
    snapshot,
  };

  rafHandle = window.requestAnimationFrame(tick);
  updateStatus();

  return {
    setRoute: (pathname, search) => {
      const nextRoute = normalizeRoute(pathname);
      const nextVariant = normalizeVariant(search);
      if (nextRoute === route && nextVariant === routeVariant) return;
      route = nextRoute;
      routeVariant = nextVariant;
      const enteredAt = performance.now();
      if (typeof performance.mark === "function") performance.mark("hushh:route-enter");
      if (current && !current.kind.endsWith("→route") && current.kind !== "scroll:programmatic") {
        current.kind = `${current.kind as GestureKind}→route`;
        routeChangedAt = enteredAt;
        // The Profiler commit that rendered the destination has already been
        // reported (commit phase precedes the pathname effect that calls us).
        const window_ = current;
        window_.routeEnter = {
          route: nextRoute,
          first_commit_ms: lastCommit ? round(lastCommit.actual_ms) : null,
          first_frame_ms: null,
        };
        if (routeEnterFrame !== null) window.cancelAnimationFrame(routeEnterFrame);
        // Two frames: the first rAF runs before the paint of the frame that
        // follows the commit, the second after it has been shown.
        routeEnterFrame = window.requestAnimationFrame(() => {
          routeEnterFrame = window.requestAnimationFrame(() => {
            routeEnterFrame = null;
            const firstFrameMs = round(performance.now() - enteredAt);
            window_.routeEnter = { ...(window_.routeEnter as RouteEnterReport), first_frame_ms: firstFrameMs };
            if (typeof performance.mark === "function") {
              performance.mark("hushh:route-first-frame");
              try {
                performance.measure("hushh:route-enter→first-frame", "hushh:route-enter", "hushh:route-first-frame");
              } catch {
                // A mark cleared by someone else; the JSON carries the number anyway.
              }
            }
          });
        });
      }
    },
    scenario: (name) => window.__hushhPerf?.scenario(name),
    export: () => snapshot(),
    stop: () => {
      stopped = true;
      setRenderCommitSink(null);
      if (routeEnterFrame !== null) window.cancelAnimationFrame(routeEnterFrame);
      window.cancelAnimationFrame(rafHandle);
      document.removeEventListener(downEvent, onPointerDown, { capture: true });
      for (const name of upEvents) document.removeEventListener(name, onPointerUp, { capture: true });
      document.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("input", onInput, { capture: true });
      document.removeEventListener("keydown", onInput, { capture: true });
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const observer of observers) observer.disconnect();
      if (exportTimer !== null) window.clearInterval(exportTimer);
      statusNode?.remove();
      hudNode?.remove();
      delete window.__hushhPerf;
    },
  };
}

function createStatusNode(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const node = document.createElement("div");
  node.setAttribute("data-testid", PERF_STATUS_TEST_ID);
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "off");
  node.className = "sr-only";
  document.body.appendChild(node);
  return node;
}

function createHudNode(): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("data-testid", "hushh-perf-hud");
  node.setAttribute("aria-hidden", "true");
  Object.assign(node.style, {
    position: "fixed",
    top: "env(safe-area-inset-top, 0px)",
    left: "8px",
    zIndex: "2147483647",
    pointerEvents: "none",
    font: "11px/1.4 ui-monospace, monospace",
    color: "#fff",
    background: "rgba(0,0,0,0.65)",
    padding: "2px 6px",
    borderRadius: "6px",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(node);
  return node;
}
