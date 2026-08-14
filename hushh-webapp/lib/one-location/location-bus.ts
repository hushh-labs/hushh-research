/**
 * LocationBus — the account's current position, held once for the whole app.
 *
 * Before this existed, every surface that wanted a coordinate reached for
 * `HushhLocation` itself, which meant a fresh OS prompt per surface and one GPS
 * subscription per consumer. The bus makes position a property of the session
 * rather than a feature of one agent: any agent, service or screen reads the
 * same snapshot, and the device is asked at most once.
 *
 * Boundaries this deliberately keeps:
 * - Nothing here talks to the network. Callers decide what, if anything,
 *   crosses that boundary — matching the backend's refusal of plaintext
 *   location.
 * - No *plaintext* coordinate is ever written to storage. Once an account is
 *   attached the bus may keep a fix across reloads, but only sealed by
 *   `location-grant-memory`, which encrypts it to the owner's own key before it
 *   touches the disk. Detached, the bus is memory-only exactly as before.
 * - `request()` must be called from a user gesture. iOS grants exactly one
 *   system prompt; firing it on mount spends it before the user knows why.
 *
 * Holding position in memory alone was the original design, and it is why a
 * reload used to land on "we couldn't get a location reading". The device had
 * answered five minutes earlier; the app had simply forgotten. `attachUser()`
 * is what stops that — see `location-grant-memory.ts` for what is stored and
 * how long it lives.
 */

import { HushhLocation, type HushhLocationPermissionState } from "@/lib/capacitor";
import {
  LAST_KNOWN_FIX_RETENTION_MS,
  readLastKnownFix,
  rememberLastKnownFix,
  rememberLocationGrant,
} from "@/lib/one-location/location-grant-memory";
import { isLocationPermissionDeniedError } from "@/lib/one-location/location-readiness";
import type { PlainLocationPoint } from "@/lib/one-location/types";

export type LocationSnapshot = {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  capturedAt: string;
  /**
   * Which platform produced the fix.
   *
   * Carried on the snapshot rather than re-derived by whoever needs it,
   * because the snapshot is written from four places — a capture, a watch
   * fix, a restore, and the held fix returned by a failed refresh — and only
   * the snapshot itself is right on all four. It is required on
   * `PlainLocationPoint`, sealed into the envelope, and shown to the
   * recipient, so a caller that guesses "web" relabels every iPhone share.
   */
  sourcePlatform?: PlainLocationPoint["sourcePlatform"] | null;
};

export type LocationPermission = HushhLocationPermissionState["state"];

export type LocationBusStatus =
  /** Never asked. */
  | "idle"
  /** A fix is being acquired. */
  | "locating"
  /** `snapshot` is populated by a fix taken this session. */
  | "ready"
  /**
   * `snapshot` is populated, but by a fix restored from a previous session
   * rather than taken now.
   *
   * Deliberately not `ready`. Every existing consumer gates on `ready`, so a
   * restored coordinate cannot silently start passing checks written when the
   * only way to hold a snapshot was to have just measured it. A surface that
   * wants the restored fix opts in by reading `snapshot` and looking at this
   * status; one that needs a live measurement keeps the behaviour it had.
   */
  | "stale"
  /** The user said no; recoverable only through settings. */
  | "denied"
  /** No geolocation on this device/browser at all. */
  | "unavailable"
  /** Permission is fine but no fix came back, and nothing was restored. */
  | "error";

export type LocationBusState = {
  status: LocationBusStatus;
  permission: LocationPermission | null;
  snapshot: LocationSnapshot | null;
  error: string | null;
  /**
   * Where `snapshot` came from: measured this session, or restored from the
   * previous one. Lets a surface label a position honestly ("last known")
   * instead of implying it was just taken.
   */
  snapshotOrigin: "fresh" | "restored" | null;
};

/** A fix younger than this is reused instead of re-hitting the GPS. */
export const DEFAULT_MAX_AGE_MS = 120_000;

const INITIAL_STATE: LocationBusState = {
  status: "idle",
  permission: null,
  snapshot: null,
  error: null,
  snapshotOrigin: null,
};

let state: LocationBusState = INITIAL_STATE;
const listeners = new Set<(next: LocationBusState) => void>();

/** In-flight capture, shared so N simultaneous callers cause one GPS read. */
let pendingCapture: Promise<LocationSnapshot | null> | null = null;

let watchId: string | null = null;
let watchStarting: Promise<void> | null = null;
let watchers = 0;

/**
 * The account whose durable memory this bus reads and writes.
 *
 * Null until `attachUser()` — the bus is shared by surfaces that run before
 * sign-in, and a coordinate has to belong to somebody before it can be sealed
 * to their key. While null the bus behaves exactly as it did before durable
 * memory existed.
 */
let attachedUserId: string | null = null;

/** In-flight hydration, so N surfaces mounting together cause one read. */
let pendingHydration: Promise<void> | null = null;

/**
 * How often a fix is written through to durable memory.
 *
 * `watch()` fires on every movement, and each write costs an ECDH derivation
 * plus an AES-GCM seal. Persisting every tick would spend real battery to
 * improve a fallback that only ever gets read once, on the next cold start.
 * A minute-old starting point is indistinguishable from a current one for that
 * purpose.
 */
const FIX_PERSIST_INTERVAL_MS = 60_000;

let lastPersistedAtMs = 0;

function emit(patch: Partial<LocationBusState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener(state);
}

/**
 * Did this failure come from a refused permission?
 *
 * Delegated rather than reimplemented. The local version matched
 * `/denied|blocked/i`, and both native plugins reject a refusal with
 * "Location permission was not granted." — which contains neither word and
 * carries no custom `name`. So on iOS and Android a real denial read as a
 * transient failure, and the degradation path below would have swallowed it:
 * the owner would have been shown their last known position, indefinitely,
 * instead of the one screen that can get them un-blocked.
 */
function isDeniedError(error: unknown): boolean {
  return isLocationPermissionDeniedError(error);
}

function statusForPermission(
  permission: LocationPermission,
): LocationBusStatus | null {
  if (permission === "denied" || permission === "restricted") return "denied";
  if (permission === "unavailable") return "unavailable";
  return null;
}

function isFresh(snapshot: LocationSnapshot | null, maxAgeMs: number): boolean {
  if (!snapshot) return false;
  const capturedMs = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedMs)) return false;
  return Date.now() - capturedMs <= maxAgeMs;
}

function toSnapshot(point: {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  capturedAt: string;
  sourcePlatform?: string | null;
}): LocationSnapshot {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    accuracyM: point.accuracyM ?? null,
    capturedAt: point.capturedAt,
    sourcePlatform:
      (point.sourcePlatform as PlainLocationPoint["sourcePlatform"]) ?? null,
  };
}

/**
 * Write a fix through to durable memory, throttled.
 *
 * The grant is refreshed on every fix — it is two short strings and it is what
 * keeps an active account from ever ageing out of its own permission. Only the
 * sealed coordinate is rate-limited.
 */
function recordFix(point: {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  capturedAt: string;
  sourcePlatform?: string | null;
}): void {
  if (!attachedUserId) return;
  // A coordinate arrived, which is the only proof of consent worth recording:
  // a permission API can answer "granted" on a device that never produces a
  // fix, and Safari cannot answer at all.
  rememberLocationGrant(attachedUserId);

  const now = Date.now();
  if (now - lastPersistedAtMs < FIX_PERSIST_INTERVAL_MS) return;
  lastPersistedAtMs = now;
  void rememberLastKnownFix({
    userId: attachedUserId,
    point: {
      latitude: point.latitude,
      longitude: point.longitude,
      accuracyM: point.accuracyM ?? null,
      capturedAt: point.capturedAt,
      sourcePlatform:
        (point.sourcePlatform as PlainLocationPoint["sourcePlatform"]) ?? "web",
    },
  });
}

async function capture(): Promise<LocationSnapshot | null> {
  try {
    const point = await HushhLocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeoutMs: 15_000,
    });
    const snapshot = toSnapshot(point);
    emit({
      status: "ready",
      snapshot,
      snapshotOrigin: "fresh",
      error: null,
      permission: "granted",
    });
    recordFix(point);
    return snapshot;
  } catch (error) {
    const denied = isDeniedError(error);
    if (!denied && state.snapshot) {
      // We already hold a position. A failed refresh in that situation is a
      // refresh that failed, not a location we do not have — and the two used
      // to look identical on screen. `kCLErrorLocationUnknown` is routine on
      // any machine without a GPS radio, so treating the first one as a hard
      // error is what put "we couldn't get a location reading" in front of
      // people whose location was perfectly well known.
      emit({
        status: "stale",
        error:
          error instanceof Error
            ? error.message
            : "Could not refresh your location.",
      });
      return state.snapshot;
    }
    emit({
      status: denied ? "denied" : "error",
      permission: denied ? "denied" : state.permission,
      error:
        error instanceof Error ? error.message : "Could not get your location.",
    });
    return null;
  }
}

/**
 * Restore the previous session's fix, once, before the first capture resolves.
 *
 * The point is what the owner sees in the second before the GPS answers — and
 * what they keep seeing if it never does. Never overwrites a fix taken this
 * session: a restored coordinate is strictly a floor, never a replacement.
 */
async function hydrateFromMemory(userId: string): Promise<void> {
  // Read through a call rather than touching `state` directly: `state` is a
  // module-level binding, so TypeScript narrows it at the first check and then
  // believes the identical check after the await is dead code. It is not — the
  // await is exactly when a capture can land.
  const originNow = () => LocationBus.getState().snapshotOrigin;

  if (originNow() === "fresh") return;
  const point = await readLastKnownFix({
    userId,
    maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS,
  });
  if (!point) return;
  // The GPS may have answered while the store was being read. It wins.
  if (originNow() === "fresh") return;
  emit({
    snapshot: toSnapshot({
      latitude: point.latitude,
      longitude: point.longitude,
      accuracyM: point.accuracyM ?? null,
      capturedAt: point.capturedAt,
      sourcePlatform: point.sourcePlatform,
    }),
    snapshotOrigin: "restored",
    // A restored fix answers "where were you", not "did this attempt work", so
    // it must not cancel a capture that is still running or clear a denial that
    // is still true.
    ...(state.status === "idle" || state.status === "error"
      ? { status: "stale" as const }
      : {}),
  });
}

export const LocationBus = {
  getState(): LocationBusState {
    return state;
  },

  subscribe(listener: (next: LocationBusState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Read the OS permission without prompting. Safe to call on mount. */
  async syncPermission(): Promise<LocationPermission | null> {
    try {
      const permission = await HushhLocation.getPermissionState();
      const mapped = statusForPermission(permission.state);
      emit({
        permission: permission.state,
        ...(mapped && state.status !== "ready" ? { status: mapped } : {}),
      });
      return permission.state;
    } catch {
      // A failed permission read is not a failed location: leave the status
      // alone so a later capture can still succeed.
      return null;
    }
  },

  /**
   * Return a position, prompting only if the OS has not decided yet.
   * Reuses a fix younger than `maxAgeMs` and coalesces concurrent callers.
   */
  async ensure(options?: { maxAgeMs?: number }): Promise<LocationSnapshot | null> {
    const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    // Only a fix measured this session short-circuits the GPS. A restored one
    // is there to fill the screen, not to end the attempt — reusing it would
    // mean an app that never refreshes as long as its memory looks recent.
    if (state.snapshotOrigin === "fresh" && isFresh(state.snapshot, maxAgeMs)) {
      return state.snapshot;
    }
    if (pendingCapture) return pendingCapture;

    if (state.status !== "ready") {
      // Keep `stale` while a restored fix is on screen: flipping to `locating`
      // would blank a position the owner can already see, which is the flicker
      // this whole change exists to remove.
      emit({
        status: state.snapshotOrigin === "restored" ? "stale" : "locating",
        error: null,
      });
    }

    pendingCapture = capture().finally(() => {
      pendingCapture = null;
    });
    return pendingCapture;
  },

  /**
   * Bind the bus to an account so a fix can outlive the page.
   *
   * Idempotent, and safe to call on every mount. Switching accounts clears the
   * previous account's position immediately rather than letting it linger while
   * the new one loads — one person's coordinate must never appear under another
   * person's session, however briefly.
   */
  async attachUser(userId: string | null | undefined): Promise<void> {
    const next = userId || null;
    if (next === attachedUserId) {
      await pendingHydration?.catch(() => undefined);
      return;
    }
    const switchingAccounts = attachedUserId !== null;
    attachedUserId = next;
    pendingHydration = null;

    if (switchingAccounts) {
      // One person's coordinate must never appear under another person's
      // session, however briefly.
      state = { ...INITIAL_STATE };
      for (const listener of [...listeners]) listener(state);
    }
    if (!next) return;

    // The very first attach is different: nothing was ever attributed to
    // anyone else, and a surface may already have captured a fix while key
    // bootstrap was still running. Clearing here would throw away a live
    // position and replace it with an older stored one — the exact inversion
    // of the point of this change. Keep it, and write it through.
    if (!switchingAccounts && state.snapshotOrigin === "fresh" && state.snapshot) {
      lastPersistedAtMs = 0;
      // The snapshot knows which platform produced it. Hardcoding "web" here
      // persisted every first-attach fix on an iPhone as a web fix, and that
      // label is what the recipient is shown.
      recordFix(state.snapshot);
      return;
    }

    pendingHydration = hydrateFromMemory(next)
      .catch(() => undefined)
      .finally(() => {
        pendingHydration = null;
      });
    await pendingHydration;
  },

  /**
   * Ask the device for permission, then capture. Call from a user gesture only.
   */
  async request(): Promise<LocationSnapshot | null> {
    emit({ status: "locating", error: null });
    try {
      const permission = await HushhLocation.requestLocationPermission();
      emit({ permission: permission.state });
      const blocked = statusForPermission(permission.state);
      if (blocked) {
        emit({
          status: blocked,
          error:
            blocked === "denied"
              ? "Location is off for Hussh."
              : "Location is unavailable on this device.",
        });
        return null;
      }
    } catch (error) {
      if (isDeniedError(error)) {
        emit({
          status: "denied",
          permission: "denied",
          error: "Location is off for Hussh.",
        });
        return null;
      }
      // Fall through: some platforms reject the permission call but still
      // resolve a position.
    }
    return LocationBus.ensure({ maxAgeMs: 0 });
  },

  /**
   * Subscribe to movement-driven updates. Refcounted: the app keeps exactly one
   * underlying watch no matter how many surfaces are live. Returns a stop fn.
   */
  async watch(): Promise<() => void> {
    watchers += 1;
    let released = false;

    if (!watchId && !watchStarting) {
      watchStarting = HushhLocation.watchPosition(
        { enableHighAccuracy: true, timeoutMs: 20_000 },
        (point, error) => {
          if (point) {
            emit({
              status: "ready",
              snapshot: toSnapshot(point),
              snapshotOrigin: "fresh",
              error: null,
              permission: "granted",
            });
            recordFix(point);
            return;
          }
          if (!error) return;
          const denied = error.code === 1;
          if (!denied && state.snapshot) {
            // A live watch reports POSITION_UNAVAILABLE/TIMEOUT routinely
            // between fixes. We already hold a position, so this is noise, not
            // a failure — surfacing its message here previously left "Could not
            // get your location" on screen while location was working fine.
            return;
          }
          emit({
            status: denied ? "denied" : "error",
            permission: denied ? "denied" : state.permission,
            error: error.message,
          });
        },
      )
        .then((id) => {
          watchId = id || null;
        })
        .catch(() => {
          watchId = null;
        })
        .finally(() => {
          watchStarting = null;
        });
    }
    await watchStarting?.catch(() => undefined);

    return () => {
      if (released) return;
      released = true;
      watchers = Math.max(0, watchers - 1);
      if (watchers === 0 && watchId) {
        const id = watchId;
        watchId = null;
        void HushhLocation.clearWatch({ id }).catch(() => undefined);
      }
    };
  },

  /** Test seam. Never call from app code. */
  __resetForTests(): void {
    state = INITIAL_STATE;
    listeners.clear();
    pendingCapture = null;
    watchId = null;
    watchStarting = null;
    watchers = 0;
    attachedUserId = null;
    pendingHydration = null;
    lastPersistedAtMs = 0;
  },
};
