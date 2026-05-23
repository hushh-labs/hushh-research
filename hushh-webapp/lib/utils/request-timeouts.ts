// lib/utils/request-timeouts.ts

const DEVELOPMENT_SLOW_REQUEST_TIMEOUT_MS = 75_000;

/**
 * Strict type definition for supported runtime environments.
 * Prevents logic errors from typos in environment strings.
 */
type RuntimeEnv = 'development' | 'production' | 'test' | 'staging' | 'dev' | 'local-uatdb' | 'uat';

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves the current runtime environment by checking common environment variables.
 * Prioritizes custom app environment variables over generic NODE_ENV.
 */
function resolveRuntimeEnvironment(): RuntimeEnv {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_ENV,
    process.env.ENVIRONMENT,
    process.env.APP_RUNTIME_PROFILE,
    process.env.NODE_ENV,
  ];

  for (const value of candidates) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) {
      return normalized as RuntimeEnv;
    }
  }

  return "development";
}

/**
 * Helper to determine if the current environment should be treated as a local 
 * or development instance for timeout relaxation.
 */
export function isDevelopmentRuntime(): boolean {
  const environment = resolveRuntimeEnvironment();
  const devEnvs: RuntimeEnv[] = ["development", "dev", "local-uatdb"];
  return devEnvs.includes(environment);
}

/**
 * Resolves a timeout value based on the runtime environment.
 * In development, timeouts are often relaxed to account for local debugging or cold starts.
 */
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

  // Check for an explicit override via environment variables
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