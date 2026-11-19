import type { OneLocationGrant } from "./types";

export function formatDateTime(value?: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function expiresLabel(grant: OneLocationGrant): string {
  if (grant.status === "revoked") return "Revoked";
  if (grant.status === "expired") return "Expired";
  if (grant.durationMode === "until_stopped") return "Until stopped";
  return `Expires ${formatDateTime(grant.expiresAt)}`;
}

// Human, at-a-glance countdown to when a share auto-stops (e.g. "Stops in
// 14 min"). This is a key confidence cue: the user can always see that sharing
// is time-boxed and will end on its own. Falls back to the absolute time when
// the window is long, and degrades gracefully if the timestamp is missing.
export function expiresCountdownLabel(
  value?: string | null,
  // Injected so every countdown on the screen ticks off one clock. Defaulted
  // for the handful of callers that render once and do not need to move.
  nowMs: number = Date.now(),
): string | null {
  if (!value) return null;
  const expiresAt = new Date(value).getTime();
  if (!Number.isFinite(expiresAt)) return null;
  const diffMs = expiresAt - nowMs;
  if (diffMs <= 0) return "Stopping now";
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) {
    return `Stops in ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMinutes = minutes % 60;
    return remMinutes
      ? `Stops in ${hours}h ${remMinutes}m`
      : `Stops in ${hours}h`;
  }
  return `Stops ${formatDateTime(value)}`;
}
