/**
 * Non-coordinate state shared by every One Location control surface.
 *
 * Pause and Auto-approve are non-sensitive, user-scoped device preferences. The
 * live activity flags are runtime-only mirrors of independent authorities:
 * self preview, private grants, and Nearby Check-In presence. No preference
 * creates consent; Nearby and private-share authority remain explicit.
 */
export type AutoApproveScope =
  { kind: "all_contacts" } | { kind: "circle"; circleId: string };

export type OneLocationControlState = {
  /**
   * Approve incoming location requests without asking each time.
   *
   * This used to be `autoShareEnabled`, which gated whether already-approved
   * grants kept receiving live updates -- a publishing cadence, not a decision
   * anyone was asking to make. The control has always been read as "requests
   * from people I trust should just go through", so it now means that, and
   * live updates follow the grant and the pause switch alone.
   *
   * Defaults OFF. Approving a location request is consent, and consent is not
   * something a default may give on someone's behalf.
   */
  autoApproveRequestsEnabled: boolean;
  /**
   * Required scope for automatic approval. Null means the setting is off or the
   * legacy preference was too broad to trust.
   */
  autoApproveScope: AutoApproveScope | null;
  /**
   * When auto-approve was last switched on, ISO-8601, or null while it is off.
   *
   * Requests already waiting when it was switched on are deliberately out of
   * scope: turning a setting on is not a decision about the specific people
   * who are already asking. Only requests that arrive afterwards pass.
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
const AUTO_APPROVE_PREFERENCE_PREFIX = "one_location_auto_approve_requests_v1:";
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

function cloneState(state: OneLocationControlState): OneLocationControlState {
  return { ...state };
}

function pausedPreferenceKey(userId: string): string {
  return `${PAUSED_PREFERENCE_PREFIX}${userId}`;
}

function autoApprovePreferenceKey(userId: string): string {
  return `${AUTO_APPROVE_PREFERENCE_PREFIX}${userId}`;
}

function normalizeAutoApproveScope(
  scope: AutoApproveScope | null | undefined,
): AutoApproveScope | null {
  if (!scope || typeof scope !== "object") return null;
  if (scope.kind === "all_contacts") return { kind: "all_contacts" };
  if (scope.kind === "circle" && typeof scope.circleId === "string") {
    const circleId = scope.circleId.trim();
    return circleId ? { kind: "circle", circleId } : null;
  }
  return null;
}

function autoApproveScopeKey(scope: AutoApproveScope | null): string {
  if (!scope) return "off";
  return scope.kind === "circle" ? `circle:${scope.circleId}` : "all_contacts";
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

/**
 * The stored value IS the moment auto-approve was switched on, so the setting
 * and the watermark that bounds it cannot drift apart. Absent, unreadable, or
 * unparseable all mean off -- a preference that grants consent has to fail
 * closed, including when storage itself is unavailable.
 */
function readAutoApprovePreference(userId: string): {
  enabled: boolean;
  enabledAt: string | null;
  scope: AutoApproveScope | null;
} {
  if (typeof window === "undefined") {
    return { enabled: false, enabledAt: null, scope: null };
  }
  try {
    const stored = window.localStorage.getItem(
      autoApprovePreferenceKey(userId),
    );
    if (!stored) {
      return { enabled: false, enabledAt: null, scope: null };
    }
    // Legacy values stored only the timestamp. They granted automatic approval
    // without a scope, so they now fail closed instead of widening to contacts.
    if (Number.isFinite(Date.parse(stored))) {
      return { enabled: false, enabledAt: null, scope: null };
    }
    const parsed = JSON.parse(stored) as {
      enabledAt?: unknown;
      scope?: unknown;
    };
    const enabledAt =
      typeof parsed.enabledAt === "string" &&
      Number.isFinite(Date.parse(parsed.enabledAt))
        ? parsed.enabledAt
        : null;
    const scope = normalizeAutoApproveScope(
      parsed.scope as AutoApproveScope | null | undefined,
    );
    if (!enabledAt || !scope) {
      return { enabled: false, enabledAt: null, scope: null };
    }
    return { enabled: true, enabledAt, scope };
  } catch {
    return { enabled: false, enabledAt: null, scope: null };
  }
}

function writeAutoApprovePreference(
  userId: string,
  enabled: boolean,
  enabledAt: string | null,
  scope: AutoApproveScope | null,
): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled && enabledAt && scope) {
      window.localStorage.setItem(
        autoApprovePreferenceKey(userId),
        JSON.stringify({ enabledAt, scope }),
      );
    } else {
      window.localStorage.removeItem(autoApprovePreferenceKey(userId));
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
  const autoApprove = readAutoApprovePreference(userId);
  return {
    ...EMPTY_STATE,
    autoApproveRequestsEnabled: autoApprove.enabled,
    autoApproveEnabledAt: autoApprove.enabledAt,
    autoApproveScope: autoApprove.scope,
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
  const autoApproveScope = normalizeAutoApproveScope(updated.autoApproveScope);
  const autoApproveRequestsEnabled = Boolean(
    updated.autoApproveRequestsEnabled && autoApproveScope,
  );
  const autoApproveScopeChanged =
    autoApproveScopeKey(current.autoApproveScope) !==
    autoApproveScopeKey(autoApproveScope);
  // The watermark is stamped once, when the setting goes off -> on, and is
  // carried forward untouched by every unrelated write. Restamping it on each
  // update (a pause, a nearby check-in) would keep pushing the boundary
  // forward, so a request that arrived a minute ago would fall behind it and
  // never auto-approve.
  const autoApproveEnabledAt = !autoApproveRequestsEnabled
    ? null
    : (current.autoApproveRequestsEnabled &&
      current.autoApproveEnabledAt &&
      !autoApproveScopeChanged &&
      current.autoApproveScope
        ? current.autoApproveEnabledAt
        : null) ||
      (!autoApproveScopeChanged ? updated.autoApproveEnabledAt : null) ||
      new Date().toISOString();
  const next: OneLocationControlState = {
    autoApproveRequestsEnabled,
    autoApproveScope: autoApproveRequestsEnabled ? autoApproveScope : null,
    autoApproveEnabledAt,
    paused,
    selfPreviewEnabled: !paused && Boolean(updated.selfPreviewEnabled),
    nearbyPresenceActive,
    nearbyCheckedInAt: nearbyPresenceActive ? updated.nearbyCheckedInAt : null,
  };
  runtimeByUser.set(userId, next);
  writeAutoApprovePreference(
    userId,
    next.autoApproveRequestsEnabled,
    next.autoApproveEnabledAt,
    next.autoApproveScope,
  );
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
      window.localStorage.removeItem(autoApprovePreferenceKey(userId));
    } catch {
      // Best-effort account-deletion cleanup for restricted browser storage.
    }
  }
  for (const listener of listenersByUser.get(userId) ?? []) {
    listener(cloneState(EMPTY_STATE));
  }
}
