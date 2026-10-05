"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import {
  BOOT_RETRY_LABEL,
  BOOT_STUCK_TEXT,
  BOOT_TIMING,
  BOOT_TITLE,
  bootLineFor,
  isBootSurfaceShown,
  type BootLine,
  type BootPhase,
  type BootStage,
} from "@/lib/boot/boot-sequence";
import { usePathname } from "next/navigation";

import {
  markBootRouteCommitted,
  startBootSurface,
  useBootSurfaceState,
} from "@/lib/boot/boot-surface-store";
import { HushhMark } from "@/lib/morphy-ux/ui/hushh-mark";

/**
 * The one boot surface.
 *
 * Mounted once in the root layout, outside every guard and every Suspense
 * boundary, so it is in the static HTML of every route and is never
 * unmounted. Guards hold stages on it (see `lib/boot/boot-surface-store.ts`);
 * it shows the stage being waited on and exits once, into whatever the guards
 * resolved to: the app, the vault unlock, phone verification, or a recovery
 * screen.
 *
 * Geometry: the mark is centred on the viewport, exactly where the iOS launch
 * screen draws it (`Splash.imageset`: a centred Hussh mark whose height is 14.75% of
 * the screen under aspect-fill), so the native splash hands over with no
 * visible change. The text block hangs below the mark at a fixed offset; a
 * longer or wider line grows downward and can never move the mark.
 *
 * Motion is transform and opacity only: a two-ring halo and a matching
 * breath on the mark (one 2.4 s heartbeat), a 150 ms critically damped
 * spring for each status line, and a 150 ms exit fade (lengthened, never
 * blocking, when the minimum visible time is not yet met). Reduced motion
 * keeps the opacity changes and drops every transform and loop.
 */

const BOOT_SURFACE_TEST_ID = "boot-surface";

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function useOffline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine === false,
    () => false,
  );
}

type LineEntry = { key: string; line: BootLine; leaving: boolean };

/**
 * The current line plus, for one crossfade, the line it replaced. Both sit in
 * the same grid cell, so a change of stage never changes the layout.
 */
function useLineStack(line: BootLine | null): LineEntry[] {
  const key = line ? `${line.emoji} ${line.text}` : "";
  const [entries, setEntries] = useState<LineEntry[]>(() =>
    line ? [{ key, line, leaving: false }] : [],
  );

  useEffect(() => {
    setEntries((previous) => {
      const current = previous.find((entry) => !entry.leaving);
      if ((current?.key ?? "") === key) return previous;
      const next: LineEntry[] = [];
      if (current) next.push({ ...current, leaving: true });
      if (line) next.push({ key, line, leaving: false });
      return next;
    });
    // `line` is derived from `key`; keying on the string keeps identity stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const hasLeaving = entries.some((entry) => entry.leaving);
  useEffect(() => {
    if (!hasLeaving) return undefined;
    const timer = window.setTimeout(() => {
      setEntries((previous) => previous.filter((entry) => !entry.leaving));
    }, BOOT_TIMING.exitMs);
    return () => window.clearTimeout(timer);
  }, [hasLeaving]);

  return entries;
}

function reload(): void {
  window.location.reload();
}

export type BootSceneProps = {
  stage: BootStage | null;
  stuck?: boolean;
  offline?: boolean;
  onRetry?: () => void;
  /** Render in flow (inside the session privacy gate) instead of filling the fixed surface. */
  contained?: boolean;
};

/**
 * The surface's contents: mark, title, the live status line and, when a stage
 * hangs, the way out. Shared by the persistent surface and the contained
 * presentation used inside the session privacy gate (a top-layer dialog the
 * persistent surface cannot paint above).
 */
export function BootScene({
  stage,
  stuck = false,
  offline = false,
  onRetry = reload,
  contained = false,
}: BootSceneProps) {
  const titleId = useId();
  const line = bootLineFor(stage, offline);
  const entries = useLineStack(line);
  const current = entries.find((entry) => !entry.leaving) ?? null;

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={!stuck}
      className="boot-scene"
      data-boot-contained={contained ? "" : undefined}
      data-boot-stage={stage ?? ""}
      data-boot-stuck={stuck ? "true" : "false"}
    >
      <div className="boot-mark" data-boot-mark="" aria-hidden="true">
        <span className="boot-mark-ring" />
        <span className="boot-mark-ring boot-mark-ring-late" />
        <HushhMark className="boot-mark-glyph" priority />
      </div>
      <div className="boot-copy" data-boot-copy="">
        <p id={titleId} className="boot-title" data-boot-title="">
          {BOOT_TITLE}
        </p>
        <div className="boot-lines" data-boot-lines="" aria-hidden="true">
          {entries.map((entry) => (
            <p
              key={`${entry.key}:${entry.leaving ? "out" : "in"}`}
              className="boot-line"
              data-boot-line={entry.leaving ? "leaving" : "current"}
            >
              <span className="boot-line-emoji">{entry.line.emoji}</span>
              <span>{entry.line.text}</span>
            </p>
          ))}
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {current?.line.text ?? ""}
        </p>
        {stuck ? (
          <div className="boot-stuck" data-boot-stuck-panel="">
            <p className="boot-stuck-text">{BOOT_STUCK_TEXT}</p>
            <button
              type="button"
              className="boot-retry min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background"
              onClick={onRetry}
            >
              {BOOT_RETRY_LABEL}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The persistent surface. One instance, in `app/layout.tsx`.
 */
export function BootSurface() {
  const state = useBootSurfaceState();
  const offline = useOffline();

  useLayoutEffect(() => {
    startBootSurface();
  }, []);

  const shown = isBootSurfaceShown(state.phase);
  const phase: BootPhase = state.phase;

  return (
    <div
      className="boot-surface z-(--z-boot)"
      data-testid={BOOT_SURFACE_TEST_ID}
      data-boot-surface=""
      data-boot-phase={phase}
      data-boot-origin={state.launch ? "launch" : "app"}
      // Present in every route's static HTML; never a search snippet.
      data-nosnippet=""
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      style={{ "--boot-exit-duration": `${state.exitDuration}ms` } as CSSProperties}
      suppressHydrationWarning
    >
      <BootScene
        stage={state.stage}
        stuck={state.stuck}
        offline={offline && state.stage !== null}
      />
    </div>
  );
}

/**
 * Rendered once inside the app shell, beside the route tree. Its first layout
 * effect is the proof that the route has committed, so an empty claim set
 * after it means "nothing to wait for" rather than "guards not mounted yet".
 * Each later path change ends the holds a redirecting guard left behind.
 */
export function BootRouteCommitted() {
  const pathname = usePathname();
  useLayoutEffect(() => {
    markBootRouteCommitted(pathname);
  }, [pathname]);
  return null;
}
