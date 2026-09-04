import type { AutoApproveScope } from "@/lib/one-location/types";

export type { AutoApproveScope } from "@/lib/one-location/types";

/**
 * Non-coordinate state shared by every One Location control surface.
 *
 * Pause is a user-scoped device preference. Auto-approve fields remain only as
 * a fail-closed compatibility shape; the Postgres preference returned by the
 * Location API is the sole standing-consent authority. The live activity flags are
 * runtime-only mirrors of independent authorities:
 * self preview, private grants, and Nearby Check-In presence. No preference
 * creates consent; Nearby and private-share authority remain explicit.
 */
export type OneLocationControlState = {
  /**
   * Compatibility-only. Always false; read `state.autoApprovePreference`.
   */
  autoApproveRequestsEnabled: boolean;
  /**
   * Compatibility-only. Always null.
   */
  autoApproveScope: AutoApproveScope | null;
  /**
   * Compatibility-only. Always null.
   */
  autoApproveEnabledAt: string | null;
  paused: boolean;
  selfPreviewEnabled: boolean;
  nearbyPresenceActive: boolean;
  nearbyCheckedInAt: string | null;
};

const PAUSED_PREFERENCE_PREFIX = "one_location_updates_paused_v1:";
/**
 * Deliberately not the old `one_location_auto_share_v1:` key. That value meant
 * "keep publishing to approved shares"; reusing it would silently read a
 * publishing preference as standing permission to approve strangers' requests.
 */
const LEGACY_AUTO_APPROVE_PREFERENCE_PREFIX =
  "one_location_auto_approve_requests_v1:";
const EMPTY_STATE: OneLocationControlState = {
  autoApproveRequestsEnabled: false,
  autoApproveScope: null,
  autoApproveEnabledAt: null,
  paused: false,
  selfPreviewEnabled: false,
  nearbyPresenceActive: false,
  nearbyCheckedInAt: null,
};

const runtimeByUser = new Map<string, OneLocationControlState>();
const listenersByUser = new Map<
  string,
  Set<(state: OneLocationControlState) => void>
>();
let storageListenerInstalled = false;

function cloneState(state: OneLocationControlState): OneLocationControlState {
  return { ...state };
}

function pausedPreferenceKey(userId: string): string {
  return `${PAUSED_PREFERENCE_PREFIX}${userId}`;
}

function readPausedPreference(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(pausedPreferenceKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writePausedPreference(userId: string, paused: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (paused) {
      window.localStorage.setItem(pausedPreferenceKey(userId), "1");
    } else {
      window.localStorage.removeItem(pausedPreferenceKey(userId));
    }
  } catch {
    // A blocked localStorage write only reduces cross-reload continuity. The
    // current in-memory pause still applies for this session.
  }
}

function notifyControlState(userId: string, state: OneLocationControlState): void {
  for (const listener of listenersByUser.get(userId) ?? []) {
    listener(cloneState(state));
  }
}

function installPausedPreferenceStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(PAUSED_PREFERENCE_PREFIX)) return;
    const userId = event.key.slice(PAUSED_PREFERENCE_PREFIX.length);
    if (!userId) return;
    const current = readOneLocationControlState(userId);
    const paused = event.newValue === "1";
    const next: OneLocationControlState = {
      ...current,
      paused,
      selfPreviewEnabled: paused ? false : current.selfPreviewEnabled,
      nearbyPresenceActive: paused ? false : current.nearbyPresenceActive,
      nearbyCheckedInAt: paused ? null : current.nearbyCheckedInAt,
    };
    runtimeByUser.set(userId, next);
    notifyControlState(userId, next);
  });
  storageListenerInstalled = true;
}

export function readOneLocationControlState(
  userId: string | null | undefined,
): OneLocationControlState {
  if (!userId) return cloneState(EMPTY_STATE);
  const runtime = runtimeByUser.get(userId);
  if (runtime) return cloneState(runtime);
  return {
    ...EMPTY_STATE,
    paused: readPausedPreference(userId),
  };
}

export function updateOneLocationControlState(
  userId: string | null | undefined,
  updater: (current: OneLocationControlState) => OneLocationControlState,
): OneLocationControlState {
  if (!userId) return cloneState(EMPTY_STATE);
  const current = readOneLocationControlState(userId);
  const updated = updater(current);
  const paused = Boolean(updated.paused);
  const nearbyPresenceActive = !paused && Boolean(updated.nearbyPresenceActive);
  const next: OneLocationControlState = {
    autoApproveRequestsEnabled: false,
    autoApproveScope: null,
    autoApproveEnabledAt: null,
    paused,
    selfPreviewEnabled: !paused && Boolean(updated.selfPreviewEnabled),
    nearbyPresenceActive,
    nearbyCheckedInAt: nearbyPresenceActive ? updated.nearbyCheckedInAt : null,
  };
  runtimeByUser.set(userId, next);
  writePausedPreference(userId, next.paused);
  notifyControlState(userId, next);
  return cloneState(next);
}

export function subscribeOneLocationControlState(
  userId: string,
  listener: (state: OneLocationControlState) => void,
): () => void {
  installPausedPreferenceStorageListener();
  const listeners =
    listenersByUser.get(userId) ??
    new Set<(state: OneLocationControlState) => void>();
  listeners.add(listener);
  listenersByUser.set(userId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByUser.delete(userId);
  };
}

/** Clear volatile activity mirrors while retaining user preferences. */
export function clearOneLocationControlRuntime(
  userId: string | null | undefined,
): void {
  if (!userId) return;
  runtimeByUser.delete(userId);
  const next = readOneLocationControlState(userId);
  notifyControlState(userId, next);
}

export function clearAllOneLocationControlRuntime(): void {
  const userIds = Array.from(runtimeByUser.keys());
  runtimeByUser.clear();
  for (const userId of userIds) {
    const next = readOneLocationControlState(userId);
    notifyControlState(userId, next);
  }
}

export function forgetOneLocationControlPreference(
  userId: string | null | undefined,
): void {
  if (!userId) return;
  runtimeByUser.delete(userId);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(pausedPreferenceKey(userId));
      window.localStorage.removeItem(
        `${LEGACY_AUTO_APPROVE_PREFERENCE_PREFIX}${userId}`,
      );
    } catch {
      // Best-effort account-deletion cleanup for restricted browser storage.
    }
  }
  notifyControlState(userId, EMPTY_STATE);
}
