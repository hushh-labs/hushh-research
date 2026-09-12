"use client";

import { ONE_LOCATION_WORKFLOW_CARD_CATALOG } from "@/lib/generated/one-location-workflow-card-catalog.v1";

/**
 * Privacy boundary for Location KGS observability.
 *
 * Callers may pass a complete runtime value, but this module retains and emits
 * only fixed event ids, validated opaque correlation handles, allowlisted
 * enums/booleans/counts, and coarse duration buckets. Exact performance
 * samples are kept in a bounded RAM-only buffer for the physical-device gate;
 * they are never written to a collector, console, browser storage, or native
 * preferences by this module.
 */
export const ONE_LOCATION_TELEMETRY_SCHEMA_VERSION =
  ONE_LOCATION_WORKFLOW_CARD_CATALOG.telemetrySchemaVersion;

export const ONE_LOCATION_TELEMETRY_EVENT_IDS =
  ONE_LOCATION_WORKFLOW_CARD_CATALOG.telemetryEventIds;

export type OneLocationTelemetryEventId =
  (typeof ONE_LOCATION_TELEMETRY_EVENT_IDS)[number];

export const ONE_LOCATION_PERFORMANCE_METRICS = [
  "directive_to_card_ms",
  "card_tap_to_permission_request_ms",
  "permission_result_to_position_capture_start_ms",
] as const;

export type OneLocationPerformanceMetric =
  (typeof ONE_LOCATION_PERFORMANCE_METRICS)[number];

type OneLocationDurationBucket =
  | "under_50ms"
  | "50_99ms"
  | "100_149ms"
  | "150_249ms"
  | "250_299ms"
  | "300_399ms"
  | "400_499ms"
  | "500_999ms"
  | "1000_1999ms"
  | "2000_4999ms"
  | "5000ms_or_more";

type OneLocationTelemetryCorrelation = Partial<{
  trace_id: string;
  activation_id: string;
  voice_session_id: string;
  turn_id: string;
  context_revision: string;
  graph_revision: string;
  action_id: "workflow.setup.location";
  run_id: string;
  directive_id: string;
}>;

type LocationRunStatus =
  | "proposed"
  | "needs_input"
  | "entity_choice"
  | "interaction_required"
  | "confirmation_required"
  | "authorized"
  | "executing"
  | "settlement_received"
  | "verified_succeeded"
  | "verified_failed"
  | "paused"
  | "cancelled"
  | "expired";

type LocationCursor =
  | "location.onboarding.preflight"
  | "location.onboarding.introduction"
  | "location.onboarding.permission"
  | "location.onboarding.position"
  | "location.onboarding.place"
  | "location.onboarding.circle"
  | "location.onboarding.complete";

type OneLocationTelemetryDimensions = Partial<{
  source:
    | "start_or_resume"
    | "run_settlement"
    | "interaction_surface"
    | "device_interaction";
  lifecycle:
    | "started_or_resumed"
    | "resumed"
    | "waiting"
    | "settled"
    | "verified"
    | "paused"
    | "expired"
    | "failed";
  run_status: LocationRunStatus;
  cursor: LocationCursor;
  interaction_result: string;
  timing_metric: OneLocationPerformanceMetric;
  permission_outcome:
    | "granted"
    | "denied"
    | "restricted"
    | "services_disabled"
    | "timed_out"
    | "unavailable";
  has_directive: boolean;
}>;

export type OneLocationTelemetryEventV2 = {
  schema_version: typeof ONE_LOCATION_TELEMETRY_SCHEMA_VERSION;
  event_id: OneLocationTelemetryEventId;
  correlation: OneLocationTelemetryCorrelation;
  measurements: Partial<{
    count: number;
    duration_bucket: OneLocationDurationBucket;
  }>;
  dimensions?: OneLocationTelemetryDimensions;
};

export type OneLocationTelemetryInput = {
  eventId: unknown;
  correlation?: Record<string, unknown> | null;
  count?: unknown;
  durationMs?: unknown;
  dimensions?: Record<string, unknown> | null;
  // This boundary is intentionally permissive. Accidental private fields are
  // ignored instead of serialized.
  [key: string]: unknown;
};

type LocationProjectionTelemetryView = {
  runId: string;
  revision: number;
  graphRevision: string;
  status: LocationRunStatus;
  cursor: LocationCursor;
  directiveId: string | null;
};

type LocationResultTelemetryView = {
  run: LocationProjectionTelemetryView;
};

export type OneLocationPerformanceSummary = {
  metric: OneLocationPerformanceMetric;
  count: number;
  minimumMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maximumMs: number | null;
};

const EVENT_IDS = new Set<string>(ONE_LOCATION_TELEMETRY_EVENT_IDS);
const PERFORMANCE_METRICS = new Set<string>(ONE_LOCATION_PERFORMANCE_METRICS);
const RUN_STATUSES = new Set<string>([
  "proposed",
  "needs_input",
  "entity_choice",
  "interaction_required",
  "confirmation_required",
  "authorized",
  "executing",
  "settlement_received",
  "verified_succeeded",
  "verified_failed",
  "paused",
  "cancelled",
  "expired",
]);
const CURSORS = new Set<string>([
  "location.onboarding.preflight",
  "location.onboarding.introduction",
  "location.onboarding.permission",
  "location.onboarding.position",
  "location.onboarding.place",
  "location.onboarding.circle",
  "location.onboarding.complete",
]);
const SOURCES = new Set<string>([
  "start_or_resume",
  "run_settlement",
  "interaction_surface",
  "device_interaction",
]);
const LIFECYCLES = new Set<string>([
  "started_or_resumed",
  "resumed",
  "waiting",
  "settled",
  "verified",
  "paused",
  "expired",
  "failed",
]);
const PERMISSION_OUTCOMES = new Set<string>([
  "granted",
  "denied",
  "restricted",
  "services_disabled",
  "timed_out",
  "unavailable",
]);
const INTERACTION_RESULTS = new Set<string>(
  ONE_LOCATION_WORKFLOW_CARD_CATALOG.variants.flatMap((variant) =>
    variant.results.map((result) => result.result),
  ),
);
const RUN_ID_PATTERN = /^run_[a-z0-9]{16,96}$/u;
const DIRECTIVE_ID_PATTERN = /^locdirective_[a-z0-9]{16,96}$/u;
const GRAPH_REVISION_PATTERN = /^[a-f0-9]{16,128}$/u;
const TRACE_ID_PATTERN = /^(?:[a-f0-9]{16,64}|trace_[a-z0-9_-]{8,96})$/iu;
const ACTIVATION_ID_PATTERN = /^vact_[a-z0-9_-]{8,96}$/iu;
const VOICE_SESSION_ID_PATTERN = /^(?:voice_|gemini_live_)[a-z0-9_-]{8,128}$/iu;
const TURN_ID_PATTERN = /^vturn_[a-z0-9_-]{8,96}$/iu;
const CONTEXT_REVISION_PATTERN =
  /^(?:ctx_)?r[a-z0-9_-]{1,64}(?::r[a-z0-9_-]{1,64})?$/iu;
const MAX_COUNT = 1_000_000;
const MAX_EXACT_SAMPLES_PER_METRIC = 256;
const MAX_PENDING_MARKS = 128;

const exactSamples = new Map<OneLocationPerformanceMetric, number[]>();
const directiveResponseAt = new Map<string, number>();
const permissionTapAt = new Map<string, number>();
const permissionResultAt = new Map<string, number>();
const renderedDirectiveKeys = new Set<string>();

function monotonicNow(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

function boundedMapSet<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_PENDING_MARKS) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function boundedSetAdd(set: Set<string>, key: string): void {
  set.delete(key);
  set.add(key);
  while (set.size > MAX_PENDING_MARKS) {
    const oldest = set.values().next().value as string | undefined;
    if (!oldest) break;
    set.delete(oldest);
  }
}

function finiteDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, 60_000)
    : null;
}

function durationBucket(value: unknown): OneLocationDurationBucket | null {
  const duration = finiteDuration(value);
  if (duration === null) return null;
  if (duration < 50) return "under_50ms";
  if (duration < 100) return "50_99ms";
  if (duration < 150) return "100_149ms";
  if (duration < 250) return "150_249ms";
  if (duration < 300) return "250_299ms";
  if (duration < 400) return "300_399ms";
  if (duration < 500) return "400_499ms";
  if (duration < 1_000) return "500_999ms";
  if (duration < 2_000) return "1000_1999ms";
  if (duration < 5_000) return "2000_4999ms";
  return "5000ms_or_more";
}

function boundedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(MAX_COUNT, Math.round(value));
}

function safeValue(
  value: unknown,
  pattern: RegExp,
  maximum = 160,
): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length <= maximum && pattern.test(clean) ? clean : null;
}

function knownValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T | null {
  return typeof value === "string" && allowed.has(value) ? (value as T) : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeCorrelation(
  source: Record<string, unknown> | null | undefined,
): OneLocationTelemetryCorrelation {
  const raw = source ?? {};
  const correlation: OneLocationTelemetryCorrelation = {};
  const traceId = safeValue(raw.trace_id ?? raw.traceId, TRACE_ID_PATTERN);
  const activationId = safeValue(
    raw.activation_id ?? raw.activationId,
    ACTIVATION_ID_PATTERN,
  );
  const voiceSessionId = safeValue(
    raw.voice_session_id ?? raw.voiceSessionId,
    VOICE_SESSION_ID_PATTERN,
  );
  const turnId = safeValue(raw.turn_id ?? raw.turnId, TURN_ID_PATTERN);
  const contextRevision = safeValue(
    raw.context_revision ?? raw.contextRevision,
    CONTEXT_REVISION_PATTERN,
    192,
  );
  const graphRevision = safeValue(
    raw.graph_revision ?? raw.graphRevision,
    GRAPH_REVISION_PATTERN,
  );
  const runId = safeValue(raw.run_id ?? raw.runId, RUN_ID_PATTERN);
  const directiveId = safeValue(
    raw.directive_id ?? raw.directiveId,
    DIRECTIVE_ID_PATTERN,
  );
  if (traceId) correlation.trace_id = traceId;
  if (activationId) correlation.activation_id = activationId;
  if (voiceSessionId) correlation.voice_session_id = voiceSessionId;
  if (turnId) correlation.turn_id = turnId;
  if (contextRevision) correlation.context_revision = contextRevision;
  if (graphRevision) correlation.graph_revision = graphRevision;
  if (runId) correlation.run_id = runId;
  if (directiveId) correlation.directive_id = directiveId;
  if (raw.action_id === "workflow.setup.location") {
    correlation.action_id = "workflow.setup.location";
  }
  return correlation;
}

function normalizeDimensions(
  source: Record<string, unknown> | null | undefined,
): OneLocationTelemetryDimensions {
  const raw = source ?? {};
  const result: OneLocationTelemetryDimensions = {};
  const eventSource = knownValue<
    NonNullable<OneLocationTelemetryDimensions["source"]>
  >(raw.source, SOURCES);
  const lifecycle = knownValue<
    NonNullable<OneLocationTelemetryDimensions["lifecycle"]>
  >(raw.lifecycle, LIFECYCLES);
  const runStatus = knownValue<LocationRunStatus>(raw.run_status, RUN_STATUSES);
  const cursor = knownValue<LocationCursor>(raw.cursor, CURSORS);
  const interactionResult = knownValue<string>(
    raw.interaction_result,
    INTERACTION_RESULTS,
  );
  const timingMetric = knownValue<OneLocationPerformanceMetric>(
    raw.timing_metric,
    PERFORMANCE_METRICS,
  );
  const permissionOutcome = knownValue<
    NonNullable<OneLocationTelemetryDimensions["permission_outcome"]>
  >(raw.permission_outcome, PERMISSION_OUTCOMES);
  const hasDirective = optionalBoolean(raw.has_directive);
  if (eventSource) result.source = eventSource;
  if (lifecycle) result.lifecycle = lifecycle;
  if (runStatus) result.run_status = runStatus;
  if (cursor) result.cursor = cursor;
  if (interactionResult) result.interaction_result = interactionResult;
  if (timingMetric) result.timing_metric = timingMetric;
  if (permissionOutcome) result.permission_outcome = permissionOutcome;
  if (hasDirective !== null) result.has_directive = hasDirective;
  return result;
}

export function normalizeLocationRuntimeTelemetry(
  input: OneLocationTelemetryInput,
): OneLocationTelemetryEventV2 | null {
  const eventId = knownValue<OneLocationTelemetryEventId>(
    input.eventId,
    EVENT_IDS,
  );
  if (!eventId) return null;
  const correlation = normalizeCorrelation(input.correlation);
  // Every Location milestone needs a valid run handle. That makes dropped or
  // malformed input fail closed rather than creating uncorrelated noise.
  if (!correlation.run_id) return null;
  const count = boundedCount(input.count);
  const bucket = durationBucket(input.durationMs);
  if (count === null && bucket === null) return null;
  const measurements: OneLocationTelemetryEventV2["measurements"] = {};
  if (count !== null) measurements.count = count;
  if (bucket !== null) measurements.duration_bucket = bucket;
  const dimensions = normalizeDimensions(input.dimensions);
  return {
    schema_version: ONE_LOCATION_TELEMETRY_SCHEMA_VERSION,
    event_id: eventId,
    correlation,
    measurements,
    ...(Object.keys(dimensions).length ? { dimensions } : {}),
  };
}

export function logLocationRuntimeTelemetry(
  input: OneLocationTelemetryInput,
): boolean {
  const event = normalizeLocationRuntimeTelemetry(input);
  if (!event) return false;
  console.info("[ONE_LOCATION_TELEMETRY]", event);
  return true;
}

function projectionView(
  value: unknown,
): LocationProjectionTelemetryView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const runId = safeValue(raw.runId ?? raw.run_id, RUN_ID_PATTERN);
  const graphRevision = safeValue(
    raw.graphRevision ?? raw.graph_revision,
    GRAPH_REVISION_PATTERN,
  );
  const status = knownValue<LocationRunStatus>(raw.status, RUN_STATUSES);
  const cursor = knownValue<LocationCursor>(raw.cursor ?? raw.step, CURSORS);
  const revision = raw.revision;
  const directiveValue = raw.pendingDirective ?? raw.interaction;
  let directiveId: string | null = null;
  if (
    directiveValue &&
    typeof directiveValue === "object" &&
    !Array.isArray(directiveValue)
  ) {
    const directive = directiveValue as Record<string, unknown>;
    directiveId = safeValue(
      directive.directiveId ?? directive.directive_id,
      DIRECTIVE_ID_PATTERN,
    );
  }
  if (
    !runId ||
    !graphRevision ||
    !status ||
    !cursor ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return null;
  }
  return { runId, revision, graphRevision, status, cursor, directiveId };
}

function resultView(value: unknown): LocationResultTelemetryView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const run = projectionView(raw.run ?? value);
  return run ? { run } : null;
}

function correlationFor(
  run: LocationProjectionTelemetryView,
  directiveId = run.directiveId,
): OneLocationTelemetryCorrelation {
  return {
    graph_revision: run.graphRevision,
    action_id: "workflow.setup.location",
    run_id: run.runId,
    ...(directiveId ? { directive_id: directiveId } : {}),
  };
}

function recordExactSample(
  metric: OneLocationPerformanceMetric,
  durationMs: number,
): void {
  const clean = finiteDuration(durationMs);
  if (clean === null) return;
  const values = exactSamples.get(metric) ?? [];
  values.push(clean);
  if (values.length > MAX_EXACT_SAMPLES_PER_METRIC) {
    values.splice(0, values.length - MAX_EXACT_SAMPLES_PER_METRIC);
  }
  exactSamples.set(metric, values);
  publishLocationPerformanceEvidenceToNativeGate();
}

/**
 * Export a sanitized aggregate snapshot only to the explicit DEBUG/XCUITest
 * bridge. The injected bridge does not exist in normal builds, and both flags
 * are required so a generic UI test cannot opt into physical-gate evidence.
 */
function publishLocationPerformanceEvidenceToNativeGate(): void {
  if (typeof window === "undefined") return;
  const bridge = window.__HUSHH_NATIVE_TEST__;
  if (bridge?.enabled !== true || bridge.locationDeviceGate !== true) return;
  bridge.locationPerformanceEvidence = readLocationPerformanceEvidence().map(
    (summary) => ({ ...summary }),
  );
}

function emitProjectionState(
  run: LocationProjectionTelemetryView,
  source: "start_or_resume" | "run_settlement",
): void {
  if (run.status === "verified_succeeded") {
    logLocationRuntimeTelemetry({
      eventId: "one.location.settlement_verified",
      correlation: correlationFor(run),
      count: 1,
      dimensions: {
        source,
        lifecycle: "verified",
        run_status: run.status,
        cursor: run.cursor,
        has_directive: false,
      },
    });
    return;
  }
  if (run.status === "paused") {
    logLocationRuntimeTelemetry({
      eventId: "one.location.run_paused",
      correlation: correlationFor(run),
      count: 1,
      dimensions: {
        source,
        lifecycle: "paused",
        run_status: run.status,
        cursor: run.cursor,
        has_directive: Boolean(run.directiveId),
      },
    });
    return;
  }
  if (run.status === "expired") {
    logLocationRuntimeTelemetry({
      eventId: "one.location.run_expired",
      correlation: correlationFor(run),
      count: 1,
      dimensions: {
        source,
        lifecycle: "expired",
        run_status: run.status,
        cursor: run.cursor,
        has_directive: false,
      },
    });
    return;
  }
  if (run.status === "verified_failed" || run.status === "cancelled") {
    logLocationRuntimeTelemetry({
      eventId: "one.location.run_failed",
      correlation: correlationFor(run),
      count: 1,
      dimensions: {
        source,
        lifecycle: "failed",
        run_status: run.status,
        cursor: run.cursor,
        has_directive: false,
      },
    });
    return;
  }
  if (run.directiveId) {
    logLocationRuntimeTelemetry({
      eventId: "one.location.step_waiting",
      correlation: correlationFor(run),
      count: 1,
      dimensions: {
        source,
        lifecycle: "waiting",
        run_status: run.status,
        cursor: run.cursor,
        has_directive: true,
      },
    });
  }
}

/** Mark a parsed server response without retaining any response payload. */
export function markLocationDirectiveResponse(
  result: unknown,
  nowMs = monotonicNow(),
): void {
  const view = resultView(result);
  if (!view?.run.directiveId || finiteDuration(nowMs) === null) return;
  boundedMapSet(directiveResponseAt, view.run.directiveId, nowMs);
}

export function recordLocationRunStarted(
  result: unknown,
  options: { requestedRunId?: string | null } = {},
): void {
  const view = resultView(result);
  if (!view) return;
  logLocationRuntimeTelemetry({
    eventId: "one.location.run_started",
    correlation: correlationFor(view.run),
    count: 1,
    dimensions: {
      source: "start_or_resume",
      lifecycle: options.requestedRunId ? "resumed" : "started_or_resumed",
      run_status: view.run.status,
      cursor: view.run.cursor,
      has_directive: Boolean(view.run.directiveId),
    },
  });
  emitProjectionState(view.run, "start_or_resume");
}

export function recordLocationInteractionSettled(input: {
  previousRun: unknown;
  result: unknown;
  next: unknown;
}): void {
  const previous = projectionView(input.previousRun);
  const next = resultView(input.next);
  const interactionResult = knownValue<string>(
    input.result,
    INTERACTION_RESULTS,
  );
  if (!previous || !next || !interactionResult) return;
  logLocationRuntimeTelemetry({
    eventId: "one.location.interaction_settled",
    correlation: correlationFor(previous),
    count: 1,
    dimensions: {
      source: "run_settlement",
      lifecycle: "settled",
      run_status: next.run.status,
      cursor: next.run.cursor,
      interaction_result: interactionResult,
      has_directive: Boolean(next.run.directiveId),
    },
  });
  emitProjectionState(next.run, "run_settlement");
}

/** Called after the approved card has committed to the global surface. */
export function recordLocationInteractionRendered(
  directive: unknown,
  nowMs = monotonicNow(),
): void {
  if (!directive || typeof directive !== "object" || Array.isArray(directive)) {
    return;
  }
  const raw = directive as Record<string, unknown>;
  if (raw.authority !== "server") return;
  const run = projectionView(raw.run);
  const serverDirective = raw.serverDirective;
  if (
    !run ||
    !serverDirective ||
    typeof serverDirective !== "object" ||
    Array.isArray(serverDirective)
  ) {
    return;
  }
  const directiveId = safeValue(
    (serverDirective as Record<string, unknown>).directiveId,
    DIRECTIVE_ID_PATTERN,
  );
  if (!directiveId || finiteDuration(nowMs) === null) return;
  const renderKey = `${run.runId}:${run.revision}:${directiveId}`;
  if (renderedDirectiveKeys.has(renderKey)) return;
  boundedSetAdd(renderedDirectiveKeys, renderKey);
  const receivedAt = directiveResponseAt.get(directiveId);
  directiveResponseAt.delete(directiveId);
  const durationMs =
    receivedAt === undefined ? undefined : Math.max(0, nowMs - receivedAt);
  if (durationMs !== undefined) {
    recordExactSample("directive_to_card_ms", durationMs);
  }
  logLocationRuntimeTelemetry({
    eventId: "one.location.interaction_rendered",
    correlation: correlationFor(run, directiveId),
    count: 1,
    ...(durationMs === undefined ? {} : { durationMs }),
    dimensions: {
      source: "interaction_surface",
      lifecycle: "waiting",
      run_status: run.status,
      cursor: run.cursor,
      timing_metric: "directive_to_card_ms",
      has_directive: true,
    },
  });
}

/** Called in the real button event before dispatching its registered action. */
export function markLocationCardTap(
  directive: unknown,
  interactionResult: unknown,
  nowMs = monotonicNow(),
): void {
  if (!directive || typeof directive !== "object" || Array.isArray(directive)) {
    return;
  }
  const raw = directive as Record<string, unknown>;
  if (raw.authority !== "server") return;
  const run = projectionView(raw.run);
  const result = knownValue<string>(interactionResult, INTERACTION_RESULTS);
  const serverDirective = raw.serverDirective;
  if (
    !run ||
    !result ||
    !serverDirective ||
    typeof serverDirective !== "object" ||
    Array.isArray(serverDirective) ||
    finiteDuration(nowMs) === null
  ) {
    return;
  }
  const directiveId = safeValue(
    (serverDirective as Record<string, unknown>).directiveId,
    DIRECTIVE_ID_PATTERN,
  );
  if (!directiveId) return;
  if (result === "request_permission" || result === "retry_permission") {
    boundedMapSet(permissionTapAt, run.runId, nowMs);
  }
}

/** Called immediately before the native/browser permission API invocation. */
export function recordLocationPermissionRequestStarted(
  runValue: unknown,
  nowMs = monotonicNow(),
): void {
  const run = projectionView(runValue);
  if (!run || finiteDuration(nowMs) === null) return;
  const tappedAt = permissionTapAt.get(run.runId);
  permissionTapAt.delete(run.runId);
  if (tappedAt === undefined) return;
  const durationMs = Math.max(0, nowMs - tappedAt);
  recordExactSample("card_tap_to_permission_request_ms", durationMs);
  logLocationRuntimeTelemetry({
    eventId: "one.location.step_waiting",
    correlation: correlationFor(run),
    count: 1,
    durationMs,
    dimensions: {
      source: "device_interaction",
      lifecycle: "waiting",
      run_status: run.status,
      cursor: run.cursor,
      timing_metric: "card_tap_to_permission_request_ms",
      has_directive: Boolean(run.directiveId),
    },
  });
}

export function markLocationPermissionResultObserved(
  runValue: unknown,
  outcome: unknown,
  nowMs = monotonicNow(),
): void {
  const run = projectionView(runValue);
  const normalizedOutcome = knownValue<
    NonNullable<OneLocationTelemetryDimensions["permission_outcome"]>
  >(
    outcome === "permission_granted"
      ? "granted"
      : outcome === "permission_denied"
        ? "denied"
        : outcome === "permission_restricted"
          ? "restricted"
          : outcome,
    PERMISSION_OUTCOMES,
  );
  if (
    !run ||
    !normalizedOutcome ||
    finiteDuration(nowMs) === null ||
    normalizedOutcome !== "granted"
  ) {
    return;
  }
  boundedMapSet(permissionResultAt, run.runId, nowMs);
}

/** Called immediately before starting the first GPS fix after real grant. */
export function recordLocationPositionCaptureStarted(
  runValue: unknown,
  nowMs = monotonicNow(),
): void {
  const run = projectionView(runValue);
  if (!run || finiteDuration(nowMs) === null) return;
  const resultAt = permissionResultAt.get(run.runId);
  permissionResultAt.delete(run.runId);
  if (resultAt === undefined) return;
  const durationMs = Math.max(0, nowMs - resultAt);
  recordExactSample(
    "permission_result_to_position_capture_start_ms",
    durationMs,
  );
  logLocationRuntimeTelemetry({
    eventId: "one.location.step_waiting",
    correlation: correlationFor(run),
    count: 1,
    durationMs,
    dimensions: {
      source: "device_interaction",
      lifecycle: "waiting",
      run_status: run.status,
      cursor: run.cursor,
      timing_metric: "permission_result_to_position_capture_start_ms",
      permission_outcome: "granted",
      has_directive: Boolean(run.directiveId),
    },
  });
}

function percentile(
  values: readonly number[],
  percentileValue: number,
): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

/** Returns aggregate exact evidence without exposing or persisting raw marks. */
export function readLocationPerformanceEvidence(): readonly OneLocationPerformanceSummary[] {
  return ONE_LOCATION_PERFORMANCE_METRICS.map((metric) => {
    const values = exactSamples.get(metric) ?? [];
    const sorted = [...values].sort((left, right) => left - right);
    return {
      metric,
      count: values.length,
      minimumMs: sorted[0] ?? null,
      medianMs: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      maximumMs: sorted.at(-1) ?? null,
    };
  });
}

/** Clears only volatile measurement state (used on sign-out and in tests). */
export function clearLocationPerformanceEvidence(): void {
  exactSamples.clear();
  directiveResponseAt.clear();
  permissionTapAt.clear();
  permissionResultAt.clear();
  renderedDirectiveKeys.clear();
  publishLocationPerformanceEvidenceToNativeGate();
}
