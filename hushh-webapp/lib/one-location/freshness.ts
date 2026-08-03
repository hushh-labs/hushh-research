/**
 * Classify how fresh a received location point is. "live" while within the
 * stale threshold (a device is actively publishing), "paused" once it lapses
 * (e.g. the sender closed the app and no device is publishing). agoLabel is a
 * compact human string for the recipient's badge.
 */
export function liveFreshness(
  capturedAtISO: string,
  nowMs: number,
  staleThresholdMs: number,
): { state: "live" | "paused"; agoLabel: string } {
  const capturedMs = Date.parse(capturedAtISO);
  const deltaMs = Math.max(0, nowMs - capturedMs);
  const seconds = Math.round(deltaMs / 1000);
  const agoLabel =
    seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
  return {
    state: deltaMs <= staleThresholdMs ? "live" : "paused",
    agoLabel,
  };
}

/**
 * Preview semantics for both continuous live streams and fixed Check-In
 * snapshots. A Check-In remains a valid place for its grant duration; it does
 * not become "paused" merely because no tracking heartbeat follows it.
 */
export function locationPreviewFreshness(params: {
  capturedAtISO: string;
  nowMs: number;
  staleThresholdMs: number;
  fixedCheckIn: boolean;
}): { state: "check_in" | "live" | "paused"; agoLabel: string } {
  const freshness = liveFreshness(
    params.capturedAtISO,
    params.nowMs,
    params.staleThresholdMs,
  );
  return {
    state: params.fixedCheckIn ? "check_in" : freshness.state,
    agoLabel: freshness.agoLabel,
  };
}
