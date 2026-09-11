"use client";

/**
 * The only browser-side event shape permitted for Agent One realtime voice.
 *
 * This is intentionally a *normalizer*, not an analytics convenience helper.
 * Voice callers can hand it untrusted runtime values, but its output contains
 * only a fixed metric, opaque correlation ids, allowlisted enum dimensions,
 * bounded counts, and a coarse duration bucket. In particular, this module
 * must never serialize a transcript, audio, route/query, slot, entity value,
 * credential, provider payload, or raw error message.
 *
 * Exact latency evidence belongs in the dedicated device benchmark artifact;
 * browser telemetry uses buckets so routine observability cannot become a
 * second store of sensitive session detail.
 */
export const ONE_VOICE_TELEMETRY_SCHEMA_VERSION =
  "one.voice_telemetry.v2" as const;

/** Kept stable for existing console/collector subscribers. */
export const ONE_VOICE_TELEMETRY_EVENT = "kai_voice_metric" as const;

export const ONE_VOICE_TELEMETRY_METRICS = [
  "voice_tap",
  "voice_turn_delegated_to_agent",
  "voice_confirmation_rendered",
  "voice_inventory_truncated",
  "time_to_capture_ms",
  "native_time_to_first_pcm_ms",
  "native_pcm_backpressure_frames",
  "relay_accepted_ms",
  "provider_ready_ms",
  "runtime_context_ready_ms",
  "relay_socket_error",
  "relay_socket_closed",
  "voice_go_away_received",
  "browser_action_settled",
  "model_turn_to_first_audio_ms",
  // Reserved, explicit v2 milestones. New callers must use one of these
  // names rather than creating action- or provider-specific metric strings.
  "voice_activation",
  "voice_first_pcm",
  "voice_candidate_retrieval",
  "voice_speech_endpoint",
  "voice_first_audio",
  "voice_action_proposed",
  "voice_action_settled",
] as const;

export type OneVoiceTelemetryMetric =
  (typeof ONE_VOICE_TELEMETRY_METRICS)[number];

type OneVoiceDurationBucket =
  | "under_50ms"
  | "50_99ms"
  | "100_149ms"
  | "150_249ms"
  | "250_299ms"
  | "300_399ms"
  | "400_749ms"
  | "750_1499ms"
  | "1500_2999ms"
  | "3000_4999ms"
  | "5000ms_or_more";

type OneVoiceMetricKind = "count" | "duration" | "close_code";

const METRIC_KIND: Record<OneVoiceTelemetryMetric, OneVoiceMetricKind> = {
  voice_tap: "count",
  voice_turn_delegated_to_agent: "count",
  voice_confirmation_rendered: "count",
  voice_inventory_truncated: "count",
  time_to_capture_ms: "duration",
  native_time_to_first_pcm_ms: "duration",
  native_pcm_backpressure_frames: "count",
  relay_accepted_ms: "duration",
  provider_ready_ms: "duration",
  runtime_context_ready_ms: "duration",
  relay_socket_error: "count",
  relay_socket_closed: "close_code",
  voice_go_away_received: "count",
  browser_action_settled: "count",
  model_turn_to_first_audio_ms: "duration",
  voice_activation: "count",
  voice_first_pcm: "duration",
  voice_candidate_retrieval: "count",
  voice_speech_endpoint: "count",
  voice_first_audio: "duration",
  voice_action_proposed: "count",
  voice_action_settled: "count",
};

export type OneVoiceTelemetryCorrelation = Partial<{
  trace_id: string;
  activation_id: string;
  voice_session_id: string;
  turn_id: string;
  context_revision: string;
  graph_revision: string;
}>;

type OneVoiceTelemetryDimensions = Partial<{
  provider: "gemini_live";
  input_source: "browser_pcm" | "ios_native_pcm";
  speech_provider:
    | "apple_speech"
    | "fluid_audio"
    | "browser_speech"
    | "sherpa_onnx"
    | "local_runtime"
    | "other";
  activation_source:
    | "foreground_warm"
    | "foreground_wake"
    | "tap"
    | "siri_app_shortcut"
    | "action_button"
    | "recovery";
  entrypoint: "native_final" | "siri_initial_request" | "tap";
  phase: "pre_relay" | "relay_accepted" | "provider_ready" | "context_accepted";
  protocol: "legacy_setup_complete" | "one_live_readiness.v2";
  outcome: "succeeded" | "started" | "blocked" | "invalid" | "failed" | "noop";
  close_class: "normal" | "policy" | "protocol" | "network" | "provider" | "other";
  on_device: boolean;
  clean: boolean;
}>;

export type OneVoiceTelemetryEventV2 = {
  schema_version: typeof ONE_VOICE_TELEMETRY_SCHEMA_VERSION;
  event: typeof ONE_VOICE_TELEMETRY_EVENT;
  metric: OneVoiceTelemetryMetric;
  correlation: OneVoiceTelemetryCorrelation;
  measurements: Partial<{
    count: number;
    duration_bucket: OneVoiceDurationBucket;
  }>;
  dimensions?: OneVoiceTelemetryDimensions;
  counts?: Partial<
    Record<"declared_count" | "retained_count" | "dropped_count", number>
  >;
};

/**
 * Deliberately loose input: this boundary has to be safe even when a caller
 * accidentally passes an Error, an endpoint response, or a whole action
 * payload. `normalizeVoiceMetric` only ever returns the checked type above.
 */
export type VoiceMetricPayload = {
  metric: string;
  value: unknown;
  turnId?: unknown;
  correlation?: Record<string, unknown> | null;
  tags?: Record<string, unknown> | null;
};

const METRIC_NAMES = new Set<string>(ONE_VOICE_TELEMETRY_METRICS);
const MAX_COUNT = 1_000_000;

function createOpaqueId(prefix: "vturn" | "vact"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  const random = Math.random().toString(16).slice(2, 10);
  return `${prefix}_${Date.now().toString(16)}${random}`;
}

export function createVoiceTurnId(): string {
  return createOpaqueId("vturn");
}

export function createVoiceActivationId(): string {
  return createOpaqueId("vact");
}

function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean || null;
}

function isOpaqueTurnId(value: string): boolean {
  return /^vturn_[a-z0-9]{8,128}$/i.test(value);
}

function isOpaqueActivationId(value: string): boolean {
  return /^vact_[a-z0-9]{8,128}$/i.test(value);
}

function isOpaqueVoiceSessionId(value: string): boolean {
  return /^gemini_live_[a-z0-9-]{8,128}$/i.test(value);
}

function isTraceId(value: string): boolean {
  return /^(?:[a-f0-9]{16,64}|trace_[a-z0-9_-]{8,128})$/i.test(value);
}

function isContextRevision(value: string): boolean {
  return /^(?:ctx_)?r[a-z0-9]{1,32}(?::r[a-z0-9]{1,32})?$/i.test(value);
}

function isGraphRevision(value: string): boolean {
  return /^[a-f0-9]{8,128}$/i.test(value);
}

function normalizeCorrelationValue(
  key: keyof OneVoiceTelemetryCorrelation,
  value: unknown,
): string | null {
  const clean = safeString(value);
  if (!clean) return null;
  switch (key) {
    case "turn_id":
      return isOpaqueTurnId(clean) ? clean : null;
    case "activation_id":
      return isOpaqueActivationId(clean) ? clean : null;
    case "voice_session_id":
      return isOpaqueVoiceSessionId(clean) ? clean : null;
    case "trace_id":
      return isTraceId(clean) ? clean : null;
    case "context_revision":
      return isContextRevision(clean) ? clean : null;
    case "graph_revision":
      return isGraphRevision(clean) ? clean : null;
  }
}

function readCorrelation(input: VoiceMetricPayload): OneVoiceTelemetryCorrelation | null {
  const raw: Record<string, unknown> = {
    ...(input.correlation ?? {}),
    // Compatibility aliases are deliberately explicit; arbitrary tag names
    // cannot become correlation fields.
    ...(input.tags ?? {}),
    ...(input.turnId === undefined ? {} : { turn_id: input.turnId }),
  };
  const aliases: ReadonlyArray<readonly [string, keyof OneVoiceTelemetryCorrelation]> = [
    ["trace_id", "trace_id"],
    ["traceId", "trace_id"],
    ["activation_id", "activation_id"],
    ["activationId", "activation_id"],
    ["voice_session_id", "voice_session_id"],
    ["voiceSessionId", "voice_session_id"],
    ["session_id", "voice_session_id"],
    ["sessionId", "voice_session_id"],
    ["turn_id", "turn_id"],
    ["turnId", "turn_id"],
    ["context_revision", "context_revision"],
    ["contextRevision", "context_revision"],
    ["graph_revision", "graph_revision"],
    ["graphRevision", "graph_revision"],
  ];
  const correlation: OneVoiceTelemetryCorrelation = {};
  for (const [sourceKey, targetKey] of aliases) {
    if (correlation[targetKey]) continue;
    const normalized = normalizeCorrelationValue(targetKey, raw[sourceKey]);
    if (normalized) correlation[targetKey] = normalized;
  }
  // A metric without an opaque per-turn link cannot be correlated safely.
  return correlation.turn_id ? correlation : null;
}

function normalizeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_COUNT, Math.max(0, Math.round(value)));
}

function durationBucket(value: unknown): OneVoiceDurationBucket | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value < 50) return "under_50ms";
  if (value < 100) return "50_99ms";
  if (value < 150) return "100_149ms";
  if (value < 250) return "150_249ms";
  if (value < 300) return "250_299ms";
  if (value < 400) return "300_399ms";
  if (value < 750) return "400_749ms";
  if (value < 1_500) return "750_1499ms";
  if (value < 3_000) return "1500_2999ms";
  if (value < 5_000) return "3000_4999ms";
  return "5000ms_or_more";
}

function classifyCloseCode(value: unknown): OneVoiceTelemetryDimensions["close_class"] {
  switch (value) {
    case 1000:
      return "normal";
    case 1002:
    case 1003:
      return "protocol";
    case 1008:
      return "policy";
    case 1006:
      return "network";
    case 1011:
    case 1012:
    case 1013:
      return "provider";
    default:
      return "other";
  }
}

function knownEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function normalizeSpeechProvider(value: unknown): OneVoiceTelemetryDimensions["speech_provider"] | null {
  const provider = safeString(value)?.toLowerCase();
  if (!provider) return null;
  if (provider === "apple_speech") return "apple_speech";
  if (provider === "fluid_audio") return "fluid_audio";
  if (provider === "browser_speech") return "browser_speech";
  if (provider.includes("sherpa")) return "sherpa_onnx";
  if (provider.includes("local") || provider.includes("onnx")) return "local_runtime";
  return "other";
}

function normalizeDimensions(
  tags: Record<string, unknown> | null | undefined,
): OneVoiceTelemetryDimensions {
  const source = tags ?? {};
  const dimensions: OneVoiceTelemetryDimensions = {};
  const provider = knownEnum(source.provider, ["gemini_live"] as const);
  if (provider) dimensions.provider = provider;
  const inputSource = knownEnum(
    source.input_source,
    ["browser_pcm", "ios_native_pcm"] as const,
  );
  if (inputSource) dimensions.input_source = inputSource;
  const speechProvider = normalizeSpeechProvider(source.speech_provider);
  if (speechProvider) dimensions.speech_provider = speechProvider;
  const activationSource = knownEnum(
    source.activation_source,
    [
      "foreground_warm",
      "foreground_wake",
      "tap",
      "siri_app_shortcut",
      "action_button",
      "recovery",
    ] as const,
  );
  if (activationSource) dimensions.activation_source = activationSource;
  // `source` is a legacy name. It is intentionally mapped only to this small
  // fixed entrypoint set rather than copied as free-form text.
  const entrypoint = knownEnum(
    source.entrypoint ?? source.source,
    ["native_final", "siri_initial_request", "tap"] as const,
  );
  if (entrypoint) dimensions.entrypoint = entrypoint;
  const phase = knownEnum(
    source.phase,
    ["pre_relay", "relay_accepted", "provider_ready", "context_accepted"] as const,
  );
  if (phase) dimensions.phase = phase;
  const protocol = knownEnum(
    source.protocol,
    ["legacy_setup_complete", "one_live_readiness.v2"] as const,
  );
  if (protocol) dimensions.protocol = protocol;
  const outcome = knownEnum(
    source.outcome,
    ["succeeded", "started", "blocked", "invalid", "failed", "noop"] as const,
  );
  if (outcome) dimensions.outcome = outcome;
  if (typeof source.on_device === "boolean") dimensions.on_device = source.on_device;
  if (typeof source.clean === "boolean") dimensions.clean = source.clean;
  return dimensions;
}

function normalizeSupplementalCounts(
  tags: Record<string, unknown> | null | undefined,
): OneVoiceTelemetryEventV2["counts"] | undefined {
  const source = tags ?? {};
  const aliases: ReadonlyArray<readonly [string, "declared_count" | "retained_count" | "dropped_count"]> = [
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
    const value = normalizeCount(source[sourceKey]);
    if (value !== null) counts[targetKey] = value;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/**
 * Converts a permissive call-site payload into the exact v2 wire shape, or
 * returns null when the metric/correlation is not trustworthy. Unknown tags
 * are silently discarded rather than stringified into telemetry.
 */
export function normalizeVoiceMetric(
  payload: VoiceMetricPayload,
): OneVoiceTelemetryEventV2 | null {
  if (!METRIC_NAMES.has(payload.metric)) return null;
  const metric = payload.metric as OneVoiceTelemetryMetric;
  const correlation = readCorrelation(payload);
  if (!correlation) return null;
  const kind = METRIC_KIND[metric];
  const measurements: OneVoiceTelemetryEventV2["measurements"] = {};
  const dimensions = normalizeDimensions(payload.tags);
  if (kind === "duration") {
    const bucket = durationBucket(payload.value);
    if (!bucket) return null;
    measurements.duration_bucket = bucket;
  } else if (kind === "close_code") {
    measurements.count = 1;
    dimensions.close_class = classifyCloseCode(payload.value);
  } else {
    const count = normalizeCount(payload.value);
    if (count === null) return null;
    measurements.count = count;
  }
  const counts = normalizeSupplementalCounts(payload.tags);

  return {
    schema_version: ONE_VOICE_TELEMETRY_SCHEMA_VERSION,
    event: ONE_VOICE_TELEMETRY_EVENT,
    metric,
    correlation,
    measurements,
    ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    ...(counts ? { counts } : {}),
  };
}

/**
 * Emits only a normalized v2 event. `false` means the input was rejected and
 * nothing was logged; callers must never treat telemetry delivery as action
 * success/failure.
 */
export function logVoiceMetric(payload: VoiceMetricPayload): boolean {
  const event = normalizeVoiceMetric(payload);
  if (!event) return false;
  console.info("[KAI_VOICE_METRIC]", event);
  return true;
}
