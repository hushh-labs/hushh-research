const DEFAULT_TIMEOUT_MS = 10_000;

export function createTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

export function isRequestTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name || "") : "";
  return name === "AbortError" || name === "TimeoutError";
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  if (init.signal) {
    return fetch(input, init);
  }
  return fetch(input, {
    ...init,
    signal: createTimeoutSignal(timeoutMs),
  });
}
