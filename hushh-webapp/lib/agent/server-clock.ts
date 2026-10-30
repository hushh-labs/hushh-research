/**
 * The server decides when a review expires, so time left must be measured on the
 * server's clock, not a device clock that may be minutes off. The offset is
 * learned from the `Date` header of review responses (1s resolution) and is
 * ignored when absent (for example a cross-origin native call) or implausible.
 */
const MAX_PLAUSIBLE_OFFSET_MS = 24 * 60 * 60 * 1000;

let offsetMs = 0;
let offsetLearned = false;

/** `Date` truncates to whole seconds, so assume the midpoint of that second. */
export function observeServerDate(
  header: string | null | undefined,
  receivedAt: number = Date.now(),
): void {
  const server = header ? Date.parse(header) : Number.NaN;
  if (!Number.isFinite(server)) return;
  const offset = server + 500 - receivedAt;
  if (Math.abs(offset) > MAX_PLAUSIBLE_OFFSET_MS) return;
  offsetMs = offset;
  offsetLearned = true;
}

/** Now on the server's clock, falling back to this device's until one is observed. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** Whether a server date has been observed; until then `serverNow()` is only the device clock. */
export function hasServerClockOffset(): boolean {
  return offsetLearned;
}

export function resetServerClock(): void {
  offsetMs = 0;
  offsetLearned = false;
}
