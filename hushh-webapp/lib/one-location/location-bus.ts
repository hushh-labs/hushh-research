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
 * - Coordinates live in memory only. Nothing here writes to storage, and
 *   nothing here talks to the network. Callers decide what, if anything,
 *   crosses a boundary — matching the backend's refusal of plaintext location.
 * - `request()` must be called from a user gesture. iOS grants exactly one
 *   system prompt; firing it on mount spends it before the user knows why.
 */

import { HushhLocation, type HushhLocationPermissionState } from "@/lib/capacitor";

export type LocationSnapshot = {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  capturedAt: string;
};

export type LocationPermission = HushhLocationPermissionState["state"];

export type LocationBusStatus =
  /** Never asked. */
  | "idle"
  /** A fix is being acquired. */
  | "locating"
  /** `snapshot` is populated. */
  | "ready"
  /** The user said no; recoverable only through settings. */
  | "denied"
  /** No geolocation on this device/browser at all. */
  | "unavailable"
  /** Permission is fine but no fix came back. */
  | "error";

export type LocationBusState = {
  status: LocationBusStatus;
  permission: LocationPermission | null;
  snapshot: LocationSnapshot | null;
  error: string | null;
};

/** A fix younger than this is reused instead of re-hitting the GPS. */
export const DEFAULT_MAX_AGE_MS = 120_000;

const INITIAL_STATE: LocationBusState = {
  status: "idle",
  permission: null,
  snapshot: null,
  error: null,
};

let state: LocationBusState = INITIAL_STATE;
const listeners = new Set<(next: LocationBusState) => void>();

/** In-flight capture, shared so N simultaneous callers cause one GPS read. */
let pendingCapture: Promise<LocationSnapshot | null> | null = null;

let watchId: string | null = null;
let watchStarting: Promise<void> | null = null;
let watchers = 0;

function emit(patch: Partial<LocationBusState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener(state);
}

function isDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "LocationPermissionDeniedError" ||
    /denied|blocked/i.test(error.message)
  );
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
}): LocationSnapshot {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    accuracyM: point.accuracyM ?? null,
    capturedAt: point.capturedAt,
  };
}

async function capture(): Promise<LocationSnapshot | null> {
  try {
    const point = await HushhLocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeoutMs: 15_000,
    });
    const snapshot = toSnapshot(point);
    emit({ status: "ready", snapshot, error: null, permission: "granted" });
    return snapshot;
  } catch (error) {
    const denied = isDeniedError(error);
    emit({
      status: denied ? "denied" : "error",
      permission: denied ? "denied" : state.permission,
      error:
        error instanceof Error ? error.message : "Could not get your location.",
    });
    return null;
  }
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
    if (isFresh(state.snapshot, maxAgeMs)) return state.snapshot;
    if (pendingCapture) return pendingCapture;

    if (state.status !== "ready") emit({ status: "locating", error: null });

    pendingCapture = capture().finally(() => {
      pendingCapture = null;
    });
    return pendingCapture;
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
              error: null,
              permission: "granted",
            });
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
  },
};
