/**
 * Per-user, client-side preferences for One's voice/live-agent runtime.
 *
 * Unlike `one-location/location-control-state.ts` (which fails CLOSED because
 * its settings grant something -- auto-approving a location request is
 * consent, and consent may not default in), every field here is a
 * user-chosen RESTRICTION on a capability that is already authorized. Absent,
 * unreadable, or unparseable storage must therefore resolve to today's exact
 * behavior -- voice on, spoken confirmation accepted, nothing domain-scoped
 * -- never to "block everything". A user who has never opened this panel
 * must see the identical voice experience they always have.
 */
export type OneVoicePreferencesState = {
  /** Per-user override on top of the deployment-wide NEXT_PUBLIC_AGENT_GEMINI_VOICE_ENABLED flag. */
  voiceEnabled: boolean;
  /** When true, confirm_required voice actions must be tapped, not spoken. */
  requireTapConfirmation: boolean;
  /** Domain keys (see voice-engine-domains.ts) the user has turned voice OFF for. */
  disabledDomains: string[];
};

const PREFERENCES_KEY_PREFIX = "one_voice_preferences_v1:";

const DEFAULT_STATE: OneVoicePreferencesState = {
  voiceEnabled: true,
  requireTapConfirmation: false,
  disabledDomains: [],
};

const runtimeByUser = new Map<string, OneVoicePreferencesState>();
const listenersByUser = new Map<
  string,
  Set<(state: OneVoicePreferencesState) => void>
>();

function cloneState(state: OneVoicePreferencesState): OneVoicePreferencesState {
  return { ...state, disabledDomains: [...state.disabledDomains] };
}

function preferencesKey(userId: string): string {
  return `${PREFERENCES_KEY_PREFIX}${userId}`;
}

function sanitizeState(value: unknown): OneVoicePreferencesState {
  if (!value || typeof value !== "object") return cloneState(DEFAULT_STATE);
  const raw = value as Record<string, unknown>;
  const disabledDomains = Array.isArray(raw.disabledDomains)
    ? raw.disabledDomains.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  return {
    voiceEnabled: raw.voiceEnabled !== false,
    requireTapConfirmation: raw.requireTapConfirmation === true,
    disabledDomains,
  };
}

function readStoredPreferences(userId: string): OneVoicePreferencesState {
  if (typeof window === "undefined") return cloneState(DEFAULT_STATE);
  try {
    const stored = window.localStorage.getItem(preferencesKey(userId));
    if (!stored) return cloneState(DEFAULT_STATE);
    return sanitizeState(JSON.parse(stored));
  } catch {
    // A corrupted or unavailable store must never read as "voice is
    // restricted" -- fail open, same as a store that was simply never
    // written.
    return cloneState(DEFAULT_STATE);
  }
}

function writeStoredPreferences(
  userId: string,
  state: OneVoicePreferencesState,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(preferencesKey(userId), JSON.stringify(state));
  } catch {
    // The current in-memory preference remains authoritative for this session.
  }
}

export function readVoicePreferences(
  userId: string | null | undefined,
): OneVoicePreferencesState {
  if (!userId) return cloneState(DEFAULT_STATE);
  const runtime = runtimeByUser.get(userId);
  if (runtime) return cloneState(runtime);
  return readStoredPreferences(userId);
}

export function updateVoicePreferences(
  userId: string | null | undefined,
  updater: (current: OneVoicePreferencesState) => OneVoicePreferencesState,
): OneVoicePreferencesState {
  if (!userId) return cloneState(DEFAULT_STATE);
  const current = readVoicePreferences(userId);
  const next = sanitizeState(updater(current));
  runtimeByUser.set(userId, next);
  writeStoredPreferences(userId, next);
  for (const listener of listenersByUser.get(userId) ?? []) {
    listener(cloneState(next));
  }
  return cloneState(next);
}

export function subscribeVoicePreferences(
  userId: string,
  listener: (state: OneVoicePreferencesState) => void,
): () => void {
  const listeners =
    listenersByUser.get(userId) ??
    new Set<(state: OneVoicePreferencesState) => void>();
  listeners.add(listener);
  listenersByUser.set(userId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByUser.delete(userId);
  };
}

/** Best-effort account-deletion cleanup for restricted browser storage. */
export function forgetVoicePreferences(userId: string | null | undefined): void {
  if (!userId) return;
  runtimeByUser.delete(userId);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(preferencesKey(userId));
    } catch {
      // Nothing further to do -- the in-memory runtime is already cleared.
    }
  }
  for (const listener of listenersByUser.get(userId) ?? []) {
    listener(cloneState(DEFAULT_STATE));
  }
}
