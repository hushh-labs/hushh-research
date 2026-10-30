/**
 * One app-wide watch over shared access that is live on this device, so a
 * stop to sharing reaches every surface within seconds, and each bundle is
 * read once per tick however many surfaces show it.
 *
 * Measured 2026-09-29 (localhost run 4): the request card took 20-26s to read
 * "Access ended", and an already-shared secure card kept sensitive values on
 * screen about 4 minutes after Stop sharing, because it re-checked only when
 * some unrelated event happened to fire. Every surface now registers what it
 * shows here and listens to the readings (`subscribeInformationRequest`,
 * `subscribeSharedWithMe`); the watch owns the only timer.
 *
 * Cadence: about every 5s for the first minute after an answer, then about
 * every 10s, only while the page is visible (no timer at all while hidden), and
 * at once on a push, a live event, focus or a return to the app. It reads
 * ledger status and the share list only, never a value.
 */
import { readInformationRequest, readSharedWithMe } from "@/lib/consent/information-request-reads";

export const LIVE_ACCESS_FAST_INTERVAL_MS = 5_000;
export const LIVE_ACCESS_FAST_WINDOW_MS = 60_000;
export const LIVE_ACCESS_INTERVAL_MS = 10_000;
/** Listeners of one event share one read; a read older than this is not the answer to it. */
export const LIVE_ACCESS_EVENT_JOIN_MS = 250;

/** The wait before the next check, given how long ago the newest answer arrived. */
export function liveAccessDelayMs(sinceAnswerMs: number): number {
  return sinceAnswerMs < LIVE_ACCESS_FAST_WINDOW_MS ? LIVE_ACCESS_FAST_INTERVAL_MS : LIVE_ACCESS_INTERVAL_MS;
}

type WatchedBundle = { token: string; sinceMs: number; holders: number };

const bundles = new Map<string, WatchedBundle>();
let shares: { token: string; holders: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function hasWatched(): boolean {
  return bundles.size > 0 || shares !== null;
}

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function nextDelayMs(): number {
  let newest: number | null = null;
  for (const entry of bundles.values()) if (newest === null || entry.sinceMs > newest) newest = entry.sinceMs;
  return newest === null ? LIVE_ACCESS_INTERVAL_MS : liveAccessDelayMs(Date.now() - newest);
}

function check(joinWithinMs?: number): void {
  for (const [bundleId, entry] of bundles) {
    void readInformationRequest({ bundleId, vaultOwnerToken: entry.token, joinWithinMs }).catch(() => undefined);
  }
  if (shares) void readSharedWithMe({ vaultOwnerToken: shares.token, joinWithinMs }).catch(() => undefined);
}

function schedule(): void {
  clearTimer();
  if (!hasWatched() || !isVisible()) return;
  timer = setTimeout(tick, nextDelayMs());
}

function tick(): void {
  timer = null;
  if (!hasWatched() || !isVisible()) return;
  check();
  schedule();
}

function onVisibility(): void {
  if (isVisible()) wakeLiveAccessWatch();
  else clearTimer();
}

function syncListening(): void {
  const want = hasWatched() && typeof document !== "undefined";
  if (want === listening) return;
  listening = want;
  if (typeof document === "undefined") return;
  if (want) {
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
  } else {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onVisibility);
  }
}

function released(): void {
  if (!hasWatched()) clearTimer();
  syncListening();
}

/** Check every watched bundle now and restart the cadence (a push, an event). */
export function wakeLiveAccessWatch(): void {
  if (!hasWatched()) return;
  if (isVisible()) check(LIVE_ACCESS_EVENT_JOIN_MS);
  schedule();
}

/**
 * Watch one bundle's live access. `sinceMs` is when its answer arrived (now,
 * by default): the watch runs fast for a minute after it. Returns the release;
 * the bundle leaves the watch when its last holder releases it.
 */
export function watchLiveAccess(input: { bundleId: string; vaultOwnerToken: string; sinceMs?: number }): () => void {
  const key = input.bundleId.toLowerCase();
  const sinceMs = input.sinceMs ?? Date.now();
  const existing = bundles.get(key);
  bundles.set(key, existing
    ? { token: input.vaultOwnerToken, sinceMs: Math.max(existing.sinceMs, sinceMs), holders: existing.holders + 1 }
    : { token: input.vaultOwnerToken, sinceMs, holders: 1 });
  syncListening();
  // A running timer keeps its phase: registering never delays a due check.
  if (timer === null) schedule();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const entry = bundles.get(key);
    if (!entry) return;
    if (entry.holders <= 1) bundles.delete(key);
    else bundles.set(key, { ...entry, holders: entry.holders - 1 });
    released();
  };
}

/**
 * Watch the share list (about every 10s), for an already-shared item that
 * names no request bundle. Returns the release.
 */
export function watchSharedWithMeAccess(vaultOwnerToken: string): () => void {
  shares = { token: vaultOwnerToken, holders: (shares?.holders ?? 0) + 1 };
  syncListening();
  if (timer === null) schedule();
  let done = false;
  return () => {
    if (done || !shares) return;
    done = true;
    shares = shares.holders <= 1 ? null : { ...shares, holders: shares.holders - 1 };
    released();
  };
}

/** What is watched right now, for tests and diagnostics. */
export function liveAccessWatchSnapshot(): { bundles: string[]; shares: boolean } {
  return { bundles: [...bundles.keys()], shares: shares !== null };
}

/** Drop every watch (sign-out, tests). */
export function resetLiveAccessWatch(): void {
  bundles.clear();
  shares = null;
  clearTimer();
  syncListening();
}
