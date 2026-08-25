const DEVELOPMENT_SLOW_REQUEST_TIMEOUT_MS = 75_000;

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRuntimeEnvironment(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_ENV,
    process.env.APP_RUNTIME_PROFILE,
    process.env.ENVIRONMENT,
    process.env.NODE_ENV,
  ];

  for (const value of candidates) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) {
      return normalized;
    }
  }

  return "development";
}

function isDevelopmentRuntime(): boolean {
  const environment = resolveRuntimeEnvironment();
  return (
    environment === "development" ||
    environment === "dev" ||
    environment === "local" ||
    environment === "local-uatdb"
  );
}

export function resolveSlowRequestTimeoutMs(
  defaultMs: number,
  options?: {
    developmentFloorMs?: number;
    overrideEnvKey?: string;
  }
): number {
  const safeDefaultMs =
    Number.isFinite(defaultMs) && defaultMs > 0
      ? Math.round(defaultMs)
      : DEVELOPMENT_SLOW_REQUEST_TIMEOUT_MS;
  const override = parsePositiveInteger(
    process.env[options?.overrideEnvKey || "HUSHH_SLOW_REQUEST_TIMEOUT_MS"]
  );

  if (override !== null) {
    return override;
  }

  if (isDevelopmentRuntime()) {
    return Math.max(
      safeDefaultMs,
      options?.developmentFloorMs || DEVELOPMENT_SLOW_REQUEST_TIMEOUT_MS
    );
  }

  return safeDefaultMs;
}

/**
 * Node's AbortSignal.timeout rejects fetch with `TimeoutError`, while some
 * browser/runtime implementations use `AbortError`. Treat both as a timeout
 * so server-side proxy routes can apply their bounded retry consistently.
 */
export function isRequestTimeoutError(error: unknown): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name || "")
      : "";
  return name === "AbortError" || name === "TimeoutError";
}
