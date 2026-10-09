/** Bounded account-status HTTP reads; callers retain all identity decisions. */
const ACCOUNT_SESSION_STATUS_MAX_BODY_BYTES = 4_096;

export function withinAccountSessionValidationBudget<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) {
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
