/**
 * Canonical browser contract for terminal Firebase session invalidation.
 *
 * Keep this payload deliberately small and enumerated. A backend or Firebase
 * error message must never be forwarded into the login URL or shown directly
 * to the user.
 */
export const AUTH_SESSION_INVALIDATED_EVENT =
  "auth-session-invalidated" as const;

export const AUTH_SESSION_NOTICE_QUERY_PARAM = "auth_notice" as const;

/**
 * Ephemeral localStorage mailbox used only to notify already-open sibling tabs.
 * The publisher removes the value immediately, so this is never a persisted
 * authentication/session store.
 */
export const AUTH_SESSION_SIBLING_TAB_STORAGE_KEY =
  "hushh:auth-session-invalidation:v1" as const;

export const AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE =
  "AUTH_ACCOUNT_NOT_FOUND" as const;

export const AUTH_ACCOUNT_DELETION_IN_PROGRESS_BACKEND_CODE =
  "AUTH_ACCOUNT_DELETION_IN_PROGRESS" as const;

export const ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE =
  "We couldn't confirm whether account deletion finished. For your security, we signed you out and won't retry it automatically. Please check your connection before signing in again.";

export const AUTH_SESSION_INVALIDATION_CODES = [
  "account_not_found",
  "account_deleted",
  "account_deletion_uncertain",
  "session_invalid",
] as const;

export type AuthSessionInvalidationCode =
  (typeof AUTH_SESSION_INVALIDATION_CODES)[number];

/** Codes that can be inferred from a credential/backend response alone. */
export type AuthCredentialInvalidationCode = Exclude<
  AuthSessionInvalidationCode,
  "account_deleted" | "account_deletion_uncertain"
>;

type BackendAccountLifecycleCode =
  | typeof AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE
  | typeof AUTH_ACCOUNT_DELETION_IN_PROGRESS_BACKEND_CODE;

export type AuthSessionInvalidationDetail = Readonly<{
  code: AuthSessionInvalidationCode;
  path?: string;
  /** Scope delayed cross-tab signals so they cannot sign out another account. */
  userId?: string;
}>;

export type AuthSessionLandingNotice = Readonly<{
  code: AuthSessionInvalidationCode;
  message: string;
  toastId: string;
}>;

type SearchParamsReader = Pick<URLSearchParams, "get" | "toString">;

const LOGIN_PATH = "/login";
const MAX_BACKEND_PAYLOAD_DEPTH = 6;
const MAX_BACKEND_PAYLOAD_NODES = 64;
const MAX_BACKEND_PAYLOAD_ENTRIES = 32;
const MAX_STRINGIFIED_PAYLOAD_LENGTH = 16_384;
const MAX_FIREBASE_ERROR_CAUSE_DEPTH = 4;
const MAX_FIREBASE_ERROR_FIELD_LENGTH = 2_048;
const SIBLING_TAB_SIGNAL_VERSION = 1;
const SIBLING_TAB_SIGNAL_TTL_MS = 30_000;
const SIBLING_TAB_SIGNAL_FUTURE_SKEW_MS = 5_000;
const MAX_RECENT_SIBLING_TAB_SIGNALS = 64;
const recentSiblingTabSignals = new Map<string, number>();

type SiblingTabInvalidationEnvelope = Readonly<{
  version: typeof SIBLING_TAB_SIGNAL_VERSION;
  eventId: string;
  occurredAtMs: number;
  detail: AuthSessionInvalidationDetail;
}>;

const FIREBASE_TRANSIENT_MARKERS = [
  "network-request-failed",
  "network-error",
  "network-unavailable",
  "request-timeout",
  "timed-out",
  "timeout",
  "deadline-exceeded",
  "offline",
] as const;

const FIREBASE_ACCOUNT_NOT_FOUND_MARKERS = [
  "user-not-found",
  "no-user-record",
  "may-have-been-deleted",
  "account-not-found",
] as const;

const FIREBASE_INVALID_SESSION_MARKERS = [
  "user-disabled",
  "invalid-user-token",
  // This can also follow password and other major account changes. Only the
  // backend tombstone or a true user-not-found error may claim deletion.
  "user-token-expired",
  "token-expired",
  "token-has-expired",
  "token-revoked",
  "token-has-been-revoked",
  "credential-no-longer-valid",
  "credential-is-no-longer-valid",
] as const;

const LANDING_NOTICES: Record<
  AuthSessionInvalidationCode,
  AuthSessionLandingNotice
> = {
  account_not_found: {
    code: "account_not_found",
    message: "Account not found. Redirecting you to login screen.",
    toastId: "auth-session-account-not-found",
  },
  account_deleted: {
    code: "account_deleted",
    message: "Account deleted. You have been securely signed out.",
    toastId: "auth-session-account-deleted",
  },
  account_deletion_uncertain: {
    code: "account_deletion_uncertain",
    message: ACCOUNT_DELETION_OUTCOME_UNCERTAIN_MESSAGE,
    toastId: "auth-session-account-deletion-uncertain",
  },
  session_invalid: {
    code: "session_invalid",
    message: "Your session is no longer valid. Please sign in again.",
    toastId: "auth-session-invalid",
  },
};

export function isAuthSessionInvalidationCode(
  value: unknown,
): value is AuthSessionInvalidationCode {
  return (
    typeof value === "string" &&
    AUTH_SESSION_INVALIDATION_CODES.some((candidate) => candidate === value)
  );
}

export function getAuthSessionLandingNotice(
  value: unknown,
): AuthSessionLandingNotice | null {
  return isAuthSessionInvalidationCode(value) ? LANDING_NOTICES[value] : null;
}

/**
 * Find the backend's terminal account-lifecycle code through the shapes used
 * by both `fetch().json()` and CapacitorHttp (`{ data: ... }`). Traversal is
 * deliberately bounded and cycle-safe because this sits on an error path and
 * must tolerate malformed or unexpectedly large payloads.
 *
 * Callers remain responsible for applying this only to an authentication
 * failure response (normally HTTP 401); payload classification alone must not
 * turn an otherwise successful response into a sign-out.
 */
function accountLifecycleCodeFromBackendPayload(
  payload: unknown,
): BackendAccountLifecycleCode | null {
  const seen = new WeakSet<object>();
  let remainingNodes = MAX_BACKEND_PAYLOAD_NODES;

  const visit = (
    value: unknown,
    depth: number,
  ): BackendAccountLifecycleCode | null => {
    if (depth > MAX_BACKEND_PAYLOAD_DEPTH || remainingNodes <= 0) return null;
    remainingNodes -= 1;

    if (
      value === AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE ||
      value === AUTH_ACCOUNT_DELETION_IN_PROGRESS_BACKEND_CODE
    ) {
      return value;
    }

    if (typeof value === "string") {
      const candidate = value.trim();
      if (
        candidate.length === 0 ||
        candidate.length > MAX_STRINGIFIED_PAYLOAD_LENGTH ||
        (!candidate.startsWith("{") && !candidate.startsWith("["))
      ) {
        return null;
      }

      try {
        return visit(JSON.parse(candidate) as unknown, depth + 1);
      } catch {
        return null;
      }
    }

    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);

    let children: unknown[];
    try {
      children = Array.isArray(value)
        ? value.slice(0, MAX_BACKEND_PAYLOAD_ENTRIES)
        : Object.values(value).slice(0, MAX_BACKEND_PAYLOAD_ENTRIES);
    } catch {
      return null;
    }

    for (const child of children) {
      const code = visit(child, depth + 1);
      if (code) return code;
    }
    return null;
  };

  return visit(payload, 0);
}

export function authSessionInvalidationCodeFromBackendPayload(
  payload: unknown,
): AuthCredentialInvalidationCode | null {
  return accountLifecycleCodeFromBackendPayload(payload) ===
    AUTH_ACCOUNT_NOT_FOUND_BACKEND_CODE
    ? "account_not_found"
    : null;
}

/**
 * Match the backend's lifecycle-lock response without relying on prose. While
 * this state is present, callers must keep authenticated UI shielded and
 * either re-probe or fail closed; a Firebase refresh alone cannot prove that
 * the deletion transaction rolled back.
 */
export function isAccountDeletionInProgressBackendPayload(
  payload: unknown,
): boolean {
  return (
    accountLifecycleCodeFromBackendPayload(payload) ===
    AUTH_ACCOUNT_DELETION_IN_PROGRESS_BACKEND_CODE
  );
}

function normalizedFirebaseErrorField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, MAX_FIREBASE_ERROR_FIELD_LENGTH)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function includesAnyMarker(
  fields: readonly string[],
  markers: readonly string[],
): boolean {
  return fields.some((field) =>
    markers.some((marker) => field.includes(marker)),
  );
}

/**
 * Classify only terminal Firebase identity failures. Network, timeout, and
 * unknown failures intentionally remain unclassified so an offline device is
 * never signed out as though its account were deleted.
 */
export function authSessionInvalidationCodeFromFirebaseError(
  error: unknown,
): AuthCredentialInvalidationCode | null {
  const seen = new WeakSet<object>();
  const fields: string[] = [];
  let current: unknown = error;

  for (
    let depth = 0;
    current != null && depth <= MAX_FIREBASE_ERROR_CAUSE_DEPTH;
    depth += 1
  ) {
    if (typeof current === "string") {
      fields.push(normalizedFirebaseErrorField(current));
      break;
    }

    if (typeof current !== "object" || seen.has(current)) break;
    seen.add(current);

    try {
      const candidate = current as {
        code?: unknown;
        message?: unknown;
        name?: unknown;
        cause?: unknown;
      };
      fields.push(
        normalizedFirebaseErrorField(candidate.code),
        normalizedFirebaseErrorField(candidate.message),
        normalizedFirebaseErrorField(candidate.name),
      );
      current = candidate.cause;
    } catch {
      break;
    }
  }

  const meaningfulFields = fields.filter(Boolean);
  if (includesAnyMarker(meaningfulFields, FIREBASE_TRANSIENT_MARKERS)) {
    return null;
  }
  if (includesAnyMarker(meaningfulFields, FIREBASE_ACCOUNT_NOT_FOUND_MARKERS)) {
    return "account_not_found";
  }
  if (includesAnyMarker(meaningfulFields, FIREBASE_INVALID_SESSION_MARKERS)) {
    return "session_invalid";
  }
  return null;
}

export function readAuthSessionLandingNotice(
  searchParams: Pick<SearchParamsReader, "get">,
): AuthSessionLandingNotice | null {
  return getAuthSessionLandingNotice(
    searchParams.get(AUTH_SESSION_NOTICE_QUERY_PARAM),
  );
}

export function buildLoginRouteWithAuthSessionNotice(
  code: AuthSessionInvalidationCode,
): string {
  const params = new URLSearchParams({
    [AUTH_SESSION_NOTICE_QUERY_PARAM]: code,
  });
  return `${LOGIN_PATH}?${params.toString()}`;
}

function siblingTabEventId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Notify other open documents after the backend confirms full account
 * deletion. The browser does not emit a `storage` event back to the document
 * that performed the write, so the deleting tab remains the owner of its
 * success toast and orderly local sign-out.
 */
export function publishAccountDeletionToSiblingTabs(userId: string): boolean {
  const normalizedUserId = String(userId || "").trim();
  if (typeof window === "undefined" || !normalizedUserId) return false;

  const envelope: SiblingTabInvalidationEnvelope = {
    version: SIBLING_TAB_SIGNAL_VERSION,
    eventId: siblingTabEventId(),
    occurredAtMs: Date.now(),
    detail: {
      code: "account_not_found",
      path: "account_deleted_in_sibling_tab",
      userId: normalizedUserId,
    },
  };

  try {
    window.localStorage.setItem(
      AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
      JSON.stringify(envelope),
    );
    window.localStorage.removeItem(AUTH_SESSION_SIBLING_TAB_STORAGE_KEY);
    return true;
  } catch {
    // Storage can be disabled by browser privacy policy. Account deletion and
    // local sign-out must still complete; other devices retain API/refresh
    // invalidation as their authoritative fallback.
    return false;
  }
}

/** Parse only the bounded, versioned signal owned by this module. */
export function authSessionInvalidationFromSiblingTabStorageEvent(
  event: Pick<StorageEvent, "key" | "newValue">,
): AuthSessionInvalidationDetail | null {
  if (
    event.key !== AUTH_SESSION_SIBLING_TAB_STORAGE_KEY ||
    typeof event.newValue !== "string" ||
    event.newValue.length === 0 ||
    event.newValue.length > MAX_STRINGIFIED_PAYLOAD_LENGTH
  ) {
    return null;
  }

  try {
    const envelope = JSON.parse(
      event.newValue,
    ) as Partial<SiblingTabInvalidationEnvelope>;
    const detail = envelope.detail;
    const userId = String(detail?.userId || "").trim();
    const eventId = String(envelope.eventId || "").trim();
    const now = Date.now();
    if (
      envelope.version !== SIBLING_TAB_SIGNAL_VERSION ||
      !eventId ||
      eventId.length > 128 ||
      typeof envelope.occurredAtMs !== "number" ||
      !Number.isFinite(envelope.occurredAtMs) ||
      envelope.occurredAtMs < now - SIBLING_TAB_SIGNAL_TTL_MS ||
      envelope.occurredAtMs > now + SIBLING_TAB_SIGNAL_FUTURE_SKEW_MS ||
      detail?.code !== "account_not_found" ||
      !userId
    ) {
      return null;
    }

    for (const [seenEventId, seenAtMs] of recentSiblingTabSignals) {
      if (seenAtMs < now - SIBLING_TAB_SIGNAL_TTL_MS) {
        recentSiblingTabSignals.delete(seenEventId);
      }
    }
    if (recentSiblingTabSignals.has(eventId)) return null;
    if (recentSiblingTabSignals.size >= MAX_RECENT_SIBLING_TAB_SIGNALS) {
      const oldestEventId = recentSiblingTabSignals.keys().next().value;
      if (typeof oldestEventId === "string") {
        recentSiblingTabSignals.delete(oldestEventId);
      }
    }
    recentSiblingTabSignals.set(eventId, now);

    return {
      code: "account_not_found",
      path: "account_deleted_in_sibling_tab",
      userId,
    };
  } catch {
    return null;
  }
}

/** Remove only the one-shot notice while preserving a safe redirect intent. */
export function loginRouteWithoutAuthSessionNotice(
  searchParams: SearchParamsReader,
): string {
  const next = new URLSearchParams(searchParams.toString());
  next.delete(AUTH_SESSION_NOTICE_QUERY_PARAM);
  const query = next.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}

/**
 * Publish a typed invalidation signal to the single auth-session owner.
 * Returns false during SSR, where there is no browser event target.
 */
export function dispatchAuthSessionInvalidated(
  detail: AuthSessionInvalidationDetail,
): boolean {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return false;
  }

  window.dispatchEvent(
    new CustomEvent<AuthSessionInvalidationDetail>(
      AUTH_SESSION_INVALIDATED_EVENT,
      { detail },
    ),
  );
  return true;
}
