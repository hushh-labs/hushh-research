"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { shouldWakePod } from "@/lib/feed/agent-presence-policy";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { ApiService } from "@/lib/services/api-service";

/**
 * Proactively wake the person's own pod so it is warm the moment they need it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The default tier is economy: the pod is scale-to-zero and takes ~11s to cold start
 * (`gcp_backend.py` minScale 0, founder directive; `pod_wake.py` WAKE_ETA_MS 12000).
 * The wake primitive (`ApiService.wakePod` -> POST /api/one/pod/wake) has always
 * existed and its own doc long PROMISED it fired "on composer focus so the cold start
 * runs while the person is typing" -- but nothing ever called it except the
 * post-failure "Reconnect" button. So a returning person's first turn ate the whole
 * cold start inline, shown as ordinary "Thinking", and a not-yet-serving pod read as
 * an amber "unreachable" fault. This hook makes the promise real.
 *
 * WHY THE DE-DUP IS MODULE-LEVEL
 * ------------------------------
 * More than one mounted surface consumes this (the chat workspace and the home
 * presence chip), and app-foreground + surface-mount + composer-focus can all fire in
 * one burst. A per-instance cooldown would let each surface wake independently and
 * hammer a shared, costed dev pod. The cooldown and the single in-flight promise live
 * at MODULE scope, so every trigger anywhere collapses into at most one wake per
 * window; the per-instance state is only the "Waking your agent..." affordance for the
 * surface the person is actually looking at.
 *
 * One wake keeps a Cloud Run instance warm for its idle window, so re-firing inside
 * the cooldown is pure cost with no benefit -- hence a cooldown comfortably longer
 * than the cold start plus the serving idle beat.
 */

export type WakeState = "awake" | "waking" | "gone";

/** How often to re-touch the pod while the person is actually looking at the app.
 *
 * Founder directive 2026-09-02: "we don't need to keep the agent asleep when user is
 * already on the app or has active tab running." A single wake is not enough for that
 * -- one request keeps a Cloud Run instance warm only for its idle window, so a person
 * reading the app for ten minutes still paid the ~11s cold start on their next message.
 * This re-touches inside that window, and ONLY while the tab is visible: the moment
 * they leave, the ticks stop and the pod goes back to costing nothing. */
const KEEP_ALIVE_INTERVAL_MS = 240_000;

/** Longer than cold start (~11s) + the serving idle window: one wake keeps the pod
 *  warm, so a second inside this window buys nothing and costs a request on a costed
 *  fleet. */
const WAKE_COOLDOWN_MS = 45_000;

// Module-scoped so every surface and every trigger share ONE cooldown and ONE
// in-flight wake. Not React state: these coordinate network side effects across
// unrelated component trees, not any single component's render.
let lastWakeAtMs = 0;
let wakeInFlight: Promise<{ state: WakeState; etaMs: number; needsFreshSetup?: boolean }> | null =
  null;

/**
 * Issue at most one wake per cooldown, coalescing concurrent callers onto the same
 * request. Returns `null` when the cooldown suppressed the wake (nothing was sent),
 * or the wake result when one was issued (or is already in flight).
 */
async function issueWakeDeduped(): Promise<
  { state: WakeState; etaMs: number; needsFreshSetup?: boolean } | null
> {
  if (wakeInFlight) return wakeInFlight;
  if (Date.now() - lastWakeAtMs < WAKE_COOLDOWN_MS) return null;
  lastWakeAtMs = Date.now();
  const pending = ApiService.wakePod().finally(() => {
    if (wakeInFlight === pending) wakeInFlight = null;
  });
  wakeInFlight = pending;
  return pending;
}

/** Test-only: reset the module cooldown/in-flight between cases. */
export function __resetProactiveWakeForTests(): void {
  lastWakeAtMs = 0;
  wakeInFlight = null;
}

/**
 * Wire proactive wake into a surface. Pass the pod's live `state` + `health` from
 * `useAgentDeploymentFollow` (this hook adds NO polling of its own) and it returns:
 *   - `wakeNow(reason)` -- fire on composer focus / any high-signal moment.
 *   - `isWaking` / `etaMs` -- a determinate "Waking your agent..." affordance for
 *     THIS surface, sourced from the server's own estimate, never invented.
 *
 * On mount, on transition into eligibility, and on app resume-to-foreground it wakes
 * on its own -- the cases the founder asked about ("app opened on the device, do we
 * send a wakeup immediately"). A `gone` verdict is NOT looped on here: it is the
 * recovery classifier's job (probe -> adopt -> reinit/rebuild), reached through the
 * failed-turn path.
 */
export function useProactiveAgentWake(input: {
  state: string | null;
  health: string | null;
  enabled?: boolean;
}): {
  wakeNow: (reason: string) => void;
  isWaking: boolean;
  etaMs: number;
  /** What the POD last told us, as opposed to what the status poll last cached.
   *
   * `useAgentDeploymentFollow` stops polling the moment the row is terminal, so its
   * `health` freezes at whatever it read first -- which is why a pod that had been
   * woken kept reporting "Asleep" for the rest of the session. The wake route answers
   * with the pod's live state on every touch, so this is the fresher of the two and
   * the chip prefers it. `null` means nothing has answered yet. */
  livePresence: WakeState | null;
} {
  const enabled = input.enabled ?? true;
  const [isWaking, setIsWaking] = useState(false);
  const [etaMs, setEtaMs] = useState(0);
  const [livePresence, setLivePresence] = useState<WakeState | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest gating inputs, read by the STABLE wakeNow closure so it never goes
  // stale without making wakeNow itself change identity on every poll. Written in an
  // effect, never during render (React forbids a render-time ref write); every wakeNow
  // call site -- focus handler, mount effect, lifecycle listener -- runs after commit,
  // so it always sees the latest committed value, and useRef seeds it correctly for the
  // mount wake before any effect runs.
  const gateRef = useRef({ state: input.state, health: input.health, enabled });
  useEffect(() => {
    gateRef.current = { state: input.state, health: input.health, enabled };
  }, [input.state, input.health, enabled]);

  const wakeNow = useCallback((_reason: string) => {
    const { state, health, enabled: on } = gateRef.current;
    if (!on || !shouldWakePod(state, health)) return;
    void (async () => {
      try {
        const result = await issueWakeDeduped();
        if (!result) return; // cooldown suppressed it; the pod is already warm enough
        setLivePresence(result.state);
        if (result.state === "waking") {
          setEtaMs(result.etaMs || 0);
          setIsWaking(true);
          if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
          // Clear on the server's own estimate. Presence TRUTH still arrives through
          // the follow hook's health; this only bounds the transient affordance so it
          // cannot get stuck on if a later poll never contradicts it.
          clearTimerRef.current = setTimeout(
            () => setIsWaking(false),
            Math.max(result.etaMs || 0, 1_000),
          );
        } else {
          // awake -> already serving; gone -> recovery owns it. Either way, not waking.
          setIsWaking(false);
        }
      } catch {
        // Best-effort by construction: a wake that fails must never break the surface
        // it is trying to help. The real turn will surface any genuine fault.
        setIsWaking(false);
      }
    })();
  }, []);

  // Self-driven triggers: mount + transition-into-eligibility (the deps are the pod's
  // own state/health, which only change by VALUE, so this is not per-poll), plus app
  // resume-to-foreground through the existing lifecycle spine.
  useEffect(() => {
    if (!enabled) return;
    wakeNow("presence");
    const unsubscribe = appInteractionCoordinator.subscribeLifecycle(() => {
      if (appInteractionCoordinator.getLifecycleSnapshot().state === "active") {
        wakeNow("app_foreground");
      }
    });
    return () => {
      unsubscribe();
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, [enabled, input.state, input.health, wakeNow]);

  // The keep-alive. Deliberately NOT routed through `wakeNow`: that path asks
  // `shouldWakePod`, which declines once health reads `healthy` -- correct for a
  // courtesy wake, wrong for "stay awake while I am here", which is a decision about
  // the person's presence rather than about the pod's last known health. The
  // module-level cooldown still applies, so several open surfaces collapse to one
  // request, and a hidden tab schedules nothing at all.
  useEffect(() => {
    if (!enabled) return;
    if (input.state !== "active") return;
    if (typeof document === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const touch = () => {
      void (async () => {
        try {
          const result = await issueWakeDeduped();
          if (result) setLivePresence(result.state);
        } catch {
          // Best effort: a missed tick costs a cold start, never a broken surface.
        }
      })();
    };
    const start = () => {
      if (timer) return;
      touch();
      timer = setInterval(touch, KEEP_ALIVE_INTERVAL_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [enabled, input.state]);

  return { wakeNow, isWaking, etaMs, livePresence };
}
