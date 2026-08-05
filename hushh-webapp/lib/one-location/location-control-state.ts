/**
 * Non-coordinate state shared by every One Location control surface.
 *
 * Pause and Auto-share are non-sensitive, user-scoped device preferences. The
 * live activity flags are runtime-only mirrors of independent authorities:
 * self preview, private grants, and Nearby Check-In presence. No preference
 * creates consent; Nearby and private-share authority remain explicit.
 */
export type OneLocationControlState = {
  autoShareEnabled: boolean;
  paused: boolean;
  selfPreviewEnabled: boolean;
  nearbyPresenceActive: boolean;
  nearbyCheckedInAt: string | null;
};

const PAUSED_PREFERENCE_PREFIX = "one_location_updates_paused_v1:";
const AUTO_SHARE_PREFERENCE_PREFIX = "one_location_auto_share_v1:";
const EMPTY_STATE: OneLocationControlState = {
  autoShareEnabled: true,
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

function cloneState(state: OneLocationControlState): OneLocationControlState {
  return { ...state };
}

function pausedPreferenceKey(userId: string): string {
  return `${PAUSED_PREFERENCE_PREFIX}${userId}`;
}

function autoSharePreferenceKey(userId: string): string {
  return `${AUTO_SHARE_PREFERENCE_PREFIX}${userId}`;
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

function readAutoSharePreference(userId: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(autoSharePreferenceKey(userId)) !== "0";
  } catch {
    return true;
  }
}

function writeAutoSharePreference(userId: string, enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) {
      window.localStorage.removeItem(autoSharePreferenceKey(userId));
    } else {
      window.localStorage.setItem(autoSharePreferenceKey(userId), "0");
    }
  } catch {
    // The current in-memory preference remains authoritative for this session.
  }
}

export function readOneLocationControlState(
  userId: string | null | undefined,
): OneLocationControlState {
  if (!userId) return cloneState(EMPTY_STATE);
  const runtime = runtimeByUser.get(userId);
  if (runtime) return cloneState(runtime);
  return {
    ...EMPTY_STATE,
    autoShareEnabled: readAutoSharePreference(userId),
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
    autoShareEnabled: Boolean(updated.autoShareEnabled),
    paused,
    selfPreviewEnabled: !paused && Boolean(updated.selfPreviewEnabled),
    nearbyPresenceActive,
    nearbyCheckedInAt: nearbyPresenceActive ? updated.nearbyCheckedInAt : null,
  };
  runtimeByUser.set(userId, next);
  writeAutoSharePreference(userId, next.autoShareEnabled);
  writePausedPreference(userId, next.paused);
  for (const listener of listenersByUser.get(userId) ?? []) {
    listener(cloneState(next));
  }
  return cloneState(next);
}

export function subscribeOneLocationControlState(
  userId: string,
  listener: (state: OneLocationControlState) => void,
): () => void {
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
  for (const listener of listenersByUser.get(userId) ?? []) {
    listener(cloneState(next));
  }
}

export function clearAllOneLocationControlRuntime(): void {
  const userIds = Array.from(runtimeByUser.keys());
  runtimeByUser.clear();
  for (const userId of userIds) {
    const next = readOneLocationControlState(userId);
    for (const listener of listenersByUser.get(userId) ?? []) {
      listener(cloneState(next));
    }
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
      window.localStorage.removeItem(autoSharePreferenceKey(userId));
    } catch {
      // Best-effort account-deletion cleanup for restricted browser storage.
    }
  }
  for (const listener of listenersByUser.get(userId) ?? []) {
    listener(cloneState(EMPTY_STATE));
  }
}
