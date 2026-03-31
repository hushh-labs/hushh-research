const DEVELOPMENT_SLOW_REQUEST_TIMEOUT_MS = 75_000;

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRuntimeEnvironment(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_ENV,
    process.env.ENVIRONMENT,
    process.env.APP_RUNTIME_PROFILE,
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
