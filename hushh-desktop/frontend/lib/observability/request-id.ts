export const REQUEST_ID_HEADER = "x-request-id";
export const REQUEST_TIMESTAMP_HEADER = "x-request-timestamp-ms";
export const DEFAULT_MAX_CLOCK_DRIFT_MS = 60_000;
export const FUTURE_TIMESTAMP_ERROR =
  "CONSTRAINT_VIOLATION_FUTURE_TIMESTAMPS";
export const INVALID_TIMESTAMP_ERROR =
  "CONSTRAINT_VIOLATION_INVALID_TIMESTAMP";

const SAFE_REQUEST_ID_REGEX = /^[a-zA-Z0-9_.:-]{8,128}$/;

export function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function extractHeaderValue(
  headers: Headers | HeadersInit | null | undefined,
  key: string
): string | null {
  if (!headers) return null;

  if (headers instanceof Headers) {
    return headers.get(key);
  }

  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      if (String(name).toLowerCase() === key.toLowerCase()) {
        return String(value);
      }
    }
    return null;
  }

  const record = headers as Record<string, string | number | boolean | undefined>;
  for (const [name, value] of Object.entries(record)) {
    if (name.toLowerCase() === key.toLowerCase()) {
      return value === undefined ? null : String(value);
    }
  }
  return null;
}

export function sanitizeRequestId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (!SAFE_REQUEST_ID_REGEX.test(trimmed)) return null;
  return trimmed;
}

export function getOrCreateRequestId(
  headers: Headers | HeadersInit | null | undefined
): string {
  const fromHeader = sanitizeRequestId(extractHeaderValue(headers, REQUEST_ID_HEADER));
  return fromHeader || createRequestId();
}

export interface HeaderTimestampValidation {
  isSyncBlockAccepted: boolean;
  errorLabel: string | null;
}

export function validateHeaderTimestampConstraints(
  headerTimestampMs: number,
  options: {
    nowMs?: number;
    maxClockDriftMs?: number;
  } = {}
): HeaderTimestampValidation {
  const nowMs = options.nowMs ?? Date.now();
  const maxClockDriftMs =
    options.maxClockDriftMs ?? DEFAULT_MAX_CLOCK_DRIFT_MS;

  if (!Number.isFinite(headerTimestampMs)) {
    return {
      isSyncBlockAccepted: false,
      errorLabel: INVALID_TIMESTAMP_ERROR,
    };
  }

  if (headerTimestampMs > nowMs + maxClockDriftMs) {
    return {
      isSyncBlockAccepted: false,
      errorLabel: FUTURE_TIMESTAMP_ERROR,
    };
  }

  return {
    isSyncBlockAccepted: true,
    errorLabel: null,
  };
}

export function getOrCreateRequestTimestampMs(
  headers: Headers | HeadersInit | null | undefined,
  nowMs = Date.now()
): number {
  const fromHeader = extractHeaderValue(headers, REQUEST_TIMESTAMP_HEADER);
  const parsed = fromHeader ? Number(fromHeader) : Number.NaN;
  const validation = validateHeaderTimestampConstraints(parsed, { nowMs });

  return validation.isSyncBlockAccepted ? parsed : nowMs;
}
