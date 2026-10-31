import { parseAccountPrincipal, type AccountPrincipalBinding } from "./session-owner";
import { authSessionLandingCodeFromBackendPayload, isAccountDeletionInProgressBackendPayload } from "./session-invalidation";

const ACCOUNT_DELETION_REPROBE_DEFAULT_DELAY_MS = 2_000;
const ACCOUNT_DELETION_REPROBE_MAX_DELAY_MS = 2_000;
const ACCOUNT_SESSION_STATUS_MAX_BODY_BYTES = 4_096;

type AccountSessionStatusInspection =
  | { outcome: "active"; principal: AccountPrincipalBinding }
  | { outcome: "credential_rejected" }
  | { outcome: "unavailable" }
  | { outcome: "deletion_in_progress"; response: Response }
  | {
      outcome: "terminal";
      code: "account_not_found" | "account_deleted" | "session_invalid";
    };

export function withinAccountSessionValidationBudget<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) {
    // The caller already started this request. Its later failure must stay
    // observed even though the orchestration deadline refuses its result.
    void promise.catch(() => undefined);
    return Promise.reject(
      Object.assign(new Error("Account session validation timed out."), {
        name: "TimeoutError",
      }),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(
        Object.assign(new Error("Account session validation timed out."), {
          name: "TimeoutError",
        }),
      );
    }, remainingMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function hasJsonResponseContentType(response: Response): boolean {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export async function readBoundedAccountSessionStatusBody(
  response: Response,
  deadlineMs: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > ACCOUNT_SESSION_STATUS_MAX_BODY_BYTES
  ) {
    throw new Error("Account session status response is too large.");
  }

  const payload = await withinAccountSessionValidationBudget(
    response.clone().text(),
    deadlineMs,
  );
  if (
    new TextEncoder().encode(payload).byteLength >
    ACCOUNT_SESSION_STATUS_MAX_BODY_BYTES
  ) {
    throw new Error("Account session status response is too large.");
  }
  return payload;
}

export async function inspectAccountSessionStatusResponse(
  response: Response,
  deadlineMs: number,
  expectedFirebaseUid: string,
): Promise<AccountSessionStatusInspection> {
  if (response.status === 200) {
    if (!hasJsonResponseContentType(response)) {
      return { outcome: "unavailable" };
    }
    try {
      const payload = await readBoundedAccountSessionStatusBody(
        response,
        deadlineMs,
      );
      const principal = parseAccountPrincipal(JSON.parse(payload), expectedFirebaseUid);
      return principal
        ? { outcome: "active", principal }
        : { outcome: "unavailable" };
    } catch {
      return { outcome: "unavailable" };
    }
  }

  let payload = "";
  try {
    payload = await readBoundedAccountSessionStatusBody(response, deadlineMs);
  } catch {
    // A 423 is exclusive to the session-status lifecycle lock contract. Even
    // if a broken transport prevents reading its body, releasing Vault would
    // be less safe than treating the deletion outcome as unresolved.
    if (response.status === 423) {
      return { outcome: "deletion_in_progress", response };
    }
    return { outcome: "unavailable" };
  }

  if (response.status === 401) {
    const code = authSessionLandingCodeFromBackendPayload(payload);
    return code
      ? { outcome: "terminal", code }
      : { outcome: "credential_rejected" };
  }

  if (
    response.status === 423 &&
    isAccountDeletionInProgressBackendPayload(payload)
  ) {
    return { outcome: "deletion_in_progress", response };
  }

  return { outcome: "unavailable" };
}

function accountDeletionReprobeDelayMs(response: Response): number {
  const retryAfter = response.headers.get("Retry-After");
  const retryAfterSeconds =
    retryAfter === null ? Number.NaN : Number(retryAfter);
  if (
    retryAfter !== "" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.min(
      retryAfterSeconds * 1_000,
      ACCOUNT_DELETION_REPROBE_MAX_DELAY_MS,
    );
  }
  return ACCOUNT_DELETION_REPROBE_DEFAULT_DELAY_MS;
}

export async function waitForAccountDeletionReprobe(
  response: Response,
  deadlineMs: number,
): Promise<void> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 1) {
    throw Object.assign(new Error("Account deletion re-probe timed out."), {
      name: "TimeoutError",
    });
  }

  const delayMs = Math.min(
    accountDeletionReprobeDelayMs(response),
    remainingMs - 1,
  );
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}
