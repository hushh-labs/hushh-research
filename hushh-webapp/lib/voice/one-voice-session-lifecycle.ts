"use client";

/**
 * Local timing for an already-authorized One Voice follow-up window.
 *
 * Greeting eligibility, epochs, and meaningful-activity timestamps belong to
 * the server. This module deliberately keeps only an in-memory capture timer
 * keyed by the server-minted opaque relay scope. It has no browser storage,
 * no client clock used for greeting policy, and accepts no user content.
 */

export const ONE_VOICE_FOLLOW_UP_WINDOW_MS = 10 * 1000;

// Mirrors the structurally validated relay-session projection. Do not broaden
// this to arbitrary strings: a Firebase uid or email must never become a key,
// even in a short-lived in-memory map.
const OPAQUE_USER_KEY_PATTERN = /^ovgs1_[A-Za-z0-9_-]{43}$/;

export type OneVoiceFollowUpWindow = Readonly<{
  openedAtMs: number;
  expiresAtMs: number;
}>;

export type OneVoiceSessionLifecycleOptions = Readonly<{
  now?: () => number;
}>;

export type OneVoiceSessionLifecycle = Readonly<{
  /** Open a local capture boundary after trusted greeting/reply output ends. */
  openFollowUpWindow: (
    opaqueUserKey: string,
    nowMs?: number,
  ) => OneVoiceFollowUpWindow | null;
  /** Extend only an existing local capture boundary after observed speech. */
  extendFollowUpOnSpeech: (
    opaqueUserKey: string,
    nowMs?: number,
  ) => OneVoiceFollowUpWindow | null;
  isFollowUpActive: (opaqueUserKey: string, nowMs?: number) => boolean;
  closeFollowUpWindow: (opaqueUserKey: string) => void;
  /** Clears the ephemeral timer at sign-out or an owner transition. */
  clearUser: (opaqueUserKey: string) => void;
}>;

type FollowUpWindowRecord = {
  openedAtMs: number;
  expiresAtMs: number;
};

function normalizeOpaqueUserKey(value: string): string | null {
  const normalized = value.trim();
  return OPAQUE_USER_KEY_PATTERN.test(normalized) ? normalized : null;
}

function safeNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function createOneVoiceSessionLifecycle(
  options: OneVoiceSessionLifecycleOptions = {},
): OneVoiceSessionLifecycle {
  const followUpWindows = new Map<string, FollowUpWindowRecord>();
  const now = options.now ?? Date.now;
  const readNow = (explicitNowMs?: number) => safeNow(explicitNowMs ?? now());

  return {
    openFollowUpWindow(opaqueUserKey, explicitNowMs) {
      const normalizedUserKey = normalizeOpaqueUserKey(opaqueUserKey);
      if (!normalizedUserKey) return null;
      const openedAtMs = readNow(explicitNowMs);
      const window = {
        openedAtMs,
        expiresAtMs: openedAtMs + ONE_VOICE_FOLLOW_UP_WINDOW_MS,
      };
      followUpWindows.set(normalizedUserKey, window);
      return { ...window };
    },

    extendFollowUpOnSpeech(opaqueUserKey, explicitNowMs) {
      const normalizedUserKey = normalizeOpaqueUserKey(opaqueUserKey);
      if (!normalizedUserKey) return null;
      const nowMs = readNow(explicitNowMs);
      const current = followUpWindows.get(normalizedUserKey);
      if (!current || nowMs >= current.expiresAtMs) {
        followUpWindows.delete(normalizedUserKey);
        return null;
      }
      const extended = {
        openedAtMs: current.openedAtMs,
        expiresAtMs: nowMs + ONE_VOICE_FOLLOW_UP_WINDOW_MS,
      };
      followUpWindows.set(normalizedUserKey, extended);
      return { ...extended };
    },

    isFollowUpActive(opaqueUserKey, explicitNowMs) {
      const normalizedUserKey = normalizeOpaqueUserKey(opaqueUserKey);
      if (!normalizedUserKey) return false;
      const nowMs = readNow(explicitNowMs);
      const current = followUpWindows.get(normalizedUserKey);
      if (!current) return false;
      if (nowMs >= current.expiresAtMs) {
        followUpWindows.delete(normalizedUserKey);
        return false;
      }
      return true;
    },

    closeFollowUpWindow(opaqueUserKey) {
      const normalizedUserKey = normalizeOpaqueUserKey(opaqueUserKey);
      if (normalizedUserKey) followUpWindows.delete(normalizedUserKey);
    },

    clearUser(opaqueUserKey) {
      const normalizedUserKey = normalizeOpaqueUserKey(opaqueUserKey);
      if (normalizedUserKey) followUpWindows.delete(normalizedUserKey);
    },
  };
}

/** App-root callers share only ephemeral, per-tab follow-up timing. */
export const oneVoiceSessionLifecycle = createOneVoiceSessionLifecycle();
