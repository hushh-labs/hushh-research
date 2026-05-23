export interface TimestampedTelemetryRecord {
  id: string;
  timestamp: string;
}

function toTimestampMs(packet: TimestampedTelemetryRecord): number {
  const timestampMs = Date.parse(packet.timestamp);
  return Number.isFinite(timestampMs)
    ? timestampMs
    : Number.POSITIVE_INFINITY;
}

export function orderTelemetryChronologically<
  T extends TimestampedTelemetryRecord,
>(packets: readonly T[] | null | undefined): T[] {
  if (!Array.isArray(packets)) return [];

  return [...packets].sort((left, right) => {
    const timestampDelta = toTimestampMs(left) - toTimestampMs(right);
    if (timestampDelta !== 0) return timestampDelta;
    return left.id.localeCompare(right.id);
  });
}

export function keepLatestTelemetryStates<T extends TimestampedTelemetryRecord>(
  packets: readonly T[] | null | undefined
): T[] {
  const latestById = new Map<string, T>();

  for (const packet of orderTelemetryChronologically(packets)) {
    latestById.set(packet.id, packet);
  }

  return Array.from(latestById.values());
}
