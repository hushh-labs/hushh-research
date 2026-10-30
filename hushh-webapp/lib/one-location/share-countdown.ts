/**
 * How a running location share reports the time it has left.
 *
 * Two audiences, two formats. Sighted users get a clock that visibly moves —
 * `47:05` re-rendering every second is the proof that sharing really is
 * time-boxed and really is still running. Screen readers get a coarse sentence
 * instead, because announcing a new value every second is unusable.
 *
 * Pure functions: no clock of its own, no storage, no React. The caller passes
 * the current time so tests are deterministic.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The moving part, without a unit word: `47:05`, `1h 47m`, `2d 3h`.
 *
 * Under an hour it counts seconds, which is what makes the status feel live.
 * Above an hour the seconds are noise, so it settles to whole minutes.
 */
export function formatShareDuration(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / SECOND_MS));
  if (durationMs < HOUR_MS) {
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  }
  if (durationMs < DAY_MS) {
    const hours = Math.floor(durationMs / HOUR_MS);
    const minutes = Math.floor((durationMs % HOUR_MS) / MINUTE_MS);
    return `${hours}h ${pad(minutes)}m`;
  }
  const days = Math.floor(durationMs / DAY_MS);
  const hours = Math.floor((durationMs % DAY_MS) / HOUR_MS);
  return `${days}d ${hours}h`;
}

/** What a screen reader hears, refreshed at most once a minute. */
export function describeShareRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "Sharing is stopping now";
  if (remainingMs < MINUTE_MS) return "Less than a minute left";
  const minutes = Math.round(remainingMs / MINUTE_MS);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  if (!rest) return `${hourPart} left`;
  return `${hourPart} ${rest} ${rest === 1 ? "minute" : "minutes"} left`;
}

/** What a screen reader hears for a share that runs until you stop it. */
export function describeShareElapsed(elapsedMs: number): string {
  if (elapsedMs < MINUTE_MS) return "Sharing for less than a minute";
  const minutes = Math.round(elapsedMs / MINUTE_MS);
  if (minutes < 60) {
    return `Sharing for ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.floor(minutes / 60);
  return `Sharing for ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * How much of the share is already spent, 0 to 1.
 *
 * Returns null when there is nothing to fill against — an open-ended share, or
 * a window with no measurable length.
 */
export function shareProgressRatio(
  startedAtMs: number | null,
  endsAtMs: number | null,
  nowMs: number,
): number | null {
  if (startedAtMs === null || endsAtMs === null) return null;
  const total = endsAtMs - startedAtMs;
  if (!Number.isFinite(total) || total <= 0) return null;
  const spent = (nowMs - startedAtMs) / total;
  return Math.min(1, Math.max(0, spent));
}

/** `Ends 9:04 PM` — the absolute time, for people who prefer a wall clock. */
export function formatShareEndsAt(endsAtMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(endsAtMs));
}

export function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}
