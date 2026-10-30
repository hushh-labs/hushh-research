"use client";

import { isNative } from "@/lib/capacitor/platform";

/**
 * Lifecycle serialization for the @capacitor/google-maps native map.
 *
 * The plugin addresses every native map by its string id alone. `destroy()`
 * resolves to `maps.removeValue(forKey: id)` on both iOS and Android with no
 * check that the caller is the instance that registered it, and `create()`
 * cannot be called back: it waits ~200 ms (longer while the element still
 * measures zero) before the native view is registered, and nothing cancels it.
 *
 * So an unmount landing inside a create window used to leave Your Map blank.
 * The cleanup found no map handle yet and destroyed nothing, the abandoned
 * create registered its map anyway, and its cancelled branch then destroyed
 * the id -- which by then belonged to the map the NEXT mount had created. The
 * screen reported itself ready over a native canvas that no longer existed.
 *
 * Serializing create and destroy per id restores the ordering: a superseded
 * instance tears its own map down while still holding the lock, so the next
 * create always starts on a free id and no destroy outlives it.
 *
 * Extracted from the component so the ordering and its latency budget can be
 * asserted directly instead of only through a rendered map.
 */

/** How long the box wait may run before giving up, in ms. */
export const LAYOUT_WAIT_TIMEOUT_MS = 960;
/** Gap between box measurements while waiting for layout, in ms. */
export const LAYOUT_WAIT_INTERVAL_MS = 32;

const MAX_LAYOUT_ATTEMPTS = Math.ceil(
  LAYOUT_WAIT_TIMEOUT_MS / LAYOUT_WAIT_INTERVAL_MS,
);

type Lane = { queue: Promise<unknown>; generation: number };

const lanes = new Map<string, Lane>();

function laneFor(mapId: string): Lane {
  let lane = lanes.get(mapId);
  if (!lane) {
    lane = { queue: Promise.resolve(), generation: 0 };
    lanes.set(mapId, lane);
  }
  return lane;
}

/**
 * Run `task` with exclusive access to `mapId`'s native slot. Tasks run in call
 * order and never overlap.
 *
 * A rejected task must not poison the lane: the next caller has to run
 * normally, or one failed create would hang every later map forever. The
 * rejection still reaches this call's own caller.
 */
export function withNativeMapLock<T>(
  mapId: string,
  task: () => Promise<T>,
): Promise<T> {
  const lane = laneFor(mapId);
  const run = lane.queue.then(task, task);
  lane.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Claim `mapId` for a new owner. Returns a token that later reports whether
 * this owner is still the current one. Claim before any await, so a later
 * mount wins the id even if effects run before the previous cleanup.
 */
export function claimNativeMap(mapId: string): number {
  const lane = laneFor(mapId);
  lane.generation += 1;
  return lane.generation;
}

/** True once some other owner has claimed `mapId`. */
export function isNativeMapSuperseded(mapId: string, token: number): boolean {
  return laneFor(mapId).generation !== token;
}

/**
 * The plugin measures the container once and bakes width/height into the
 * native view's frame, but it only retries while the *width* is zero. A
 * container measured mid-layout at full width and zero height is accepted as
 * given, and the native map is placed with no height at all -- created, ready,
 * and invisible, with no later resize to correct it.
 *
 * Resolves as soon as the element has a real box, so a laid-out container adds
 * no latency at all: the common path never yields to a timer.
 */
export async function waitForLaidOutBox(element: HTMLElement): Promise<void> {
  // Native only: on web the plugin renders the JS SDK into this element and
  // has no native frame to get wrong, and jsdom reports every box as zero.
  if (!isNative()) return;
  for (let attempt = 0; attempt < MAX_LAYOUT_ATTEMPTS; attempt += 1) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return;
    await new Promise((resolve) =>
      window.setTimeout(resolve, LAYOUT_WAIT_INTERVAL_MS),
    );
  }
  // Bounded: a container that never lays out must not hold the lane open, or
  // one stuck map would stall every later create behind it.
}

/** Test-only: clears every lane so each case starts from a known state. */
export function __resetNativeMapLifecycleForTests(): void {
  lanes.clear();
}
