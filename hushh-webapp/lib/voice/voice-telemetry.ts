"use client";

/**
 * Privacy-safe command telemetry. This module records only bounded counts and
 * opaque turn ids; it never records audio, transcripts, provider payloads, or
 * action inputs. The existing schema/event names stay stable for collectors.
 */
export const ONE_VOICE_TELEMETRY_SCHEMA_VERSION =
  "one.voice_telemetry.v2" as const;
export const ONE_VOICE_TELEMETRY_EVENT = "kai_voice_metric" as const;
export const ONE_VOICE_TELEMETRY_METRICS = [
  "voice_inventory_truncated",
] as const;

export type OneVoiceTelemetryMetric =
  (typeof ONE_VOICE_TELEMETRY_METRICS)[number];

export type OneVoiceTelemetryEventV2 = {
  schema_version: typeof ONE_VOICE_TELEMETRY_SCHEMA_VERSION;
  event: typeof ONE_VOICE_TELEMETRY_EVENT;
  metric: OneVoiceTelemetryMetric;
  correlation: { turn_id: string };
  measurements: { count: number };
  counts?: Partial<
    Record<"declared_count" | "retained_count" | "dropped_count", number>
  >;
};

export type VoiceMetricPayload = {
  metric: string;
  value: unknown;
  turnId?: unknown;
  correlation?: Record<string, unknown> | null;
  tags?: Record<string, unknown> | null;
};

const MAX_COUNT = 1_000_000;
const METRIC_NAMES = new Set<string>(ONE_VOICE_TELEMETRY_METRICS);

function createOpaqueId(prefix: "vturn"): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `${prefix}_${Date.now().toString(16)}${Math.random()
    .toString(16)
    .slice(2, 10)}`;
}

export function createVoiceTurnId(): string {
  return createOpaqueId("vturn");
}

function normalizeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_COUNT, Math.max(0, Math.round(value)));
}

function normalizeTurnId(value: unknown): string | null {
  return typeof value === "string" && /^vturn_[a-z0-9]{8,128}$/i.test(value)
    ? value
    : null;
}

function supplementalCounts(
  tags: Record<string, unknown> | null | undefined,
): OneVoiceTelemetryEventV2["counts"] | undefined {
  const source = tags ?? {};
  const aliases: ReadonlyArray<
    readonly [string, "declared_count" | "retained_count" | "dropped_count"]
  > = [
    ["declared_count", "declared_count"],
    ["declared", "declared_count"],
    ["retained_count", "retained_count"],
    ["kept", "retained_count"],
    ["dropped_count", "dropped_count"],
    ["dropped", "dropped_count"],
  ];
  const counts: NonNullable<OneVoiceTelemetryEventV2["counts"]> = {};
  for (const [sourceKey, targetKey] of aliases) {
    if (counts[targetKey] !== undefined) continue;
    const count = normalizeCount(source[sourceKey]);
    if (count !== null) counts[targetKey] = count;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

export function normalizeVoiceMetric(
  payload: VoiceMetricPayload,
): OneVoiceTelemetryEventV2 | null {
  if (!METRIC_NAMES.has(payload.metric)) return null;
  const turnId = normalizeTurnId(
    payload.turnId ??
      payload.correlation?.turn_id ??
      payload.correlation?.turnId,
  );
  const count = normalizeCount(payload.value);
  if (!turnId || count === null) return null;
  return {
    schema_version: ONE_VOICE_TELEMETRY_SCHEMA_VERSION,
    event: ONE_VOICE_TELEMETRY_EVENT,
    metric: payload.metric as OneVoiceTelemetryMetric,
    correlation: { turn_id: turnId },
    measurements: { count },
    ...(supplementalCounts(payload.tags)
      ? { counts: supplementalCounts(payload.tags) }
      : {}),
  };
}

/** Telemetry delivery never controls a command result. */
export function logVoiceMetric(payload: VoiceMetricPayload): boolean {
  const event = normalizeVoiceMetric(payload);
  if (!event) return false;
  console.info("[ONE_COMMAND_METRIC]", event);
  return true;
}
