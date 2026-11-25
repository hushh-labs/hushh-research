export type AppEnvironment = "development" | "uat" | "production";

function normalizeEnvironment(raw: string | undefined | null): AppEnvironment | null {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === "staging") return "uat";
  if (normalized === "dev") return "development";
  if (normalized === "development" || normalized === "uat" || normalized === "production") {
    return normalized;
  }
  return null;
}

export function resolveAppEnvironment(): AppEnvironment {
  const explicit = normalizeEnvironment(process.env.NEXT_PUBLIC_APP_ENV);
  if (explicit) return explicit;

  const observabilityFallback = normalizeEnvironment(process.env.NEXT_PUBLIC_OBSERVABILITY_ENV);
  if (observabilityFallback) return observabilityFallback;

  const legacyFallback = normalizeEnvironment(process.env.NEXT_PUBLIC_ENVIRONMENT_MODE);
  if (legacyFallback) return legacyFallback;

  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/** Console diagnostics need an explicit build identity, with no fallback. */
export function resolveDiagnosticEnvironment(): "development" | "uat" | null {
  const environment = normalizeEnvironment(process.env.NEXT_PUBLIC_APP_ENV);
  if (environment !== "development" && environment !== "uat") return null;
  const otherDeclarations = [
    process.env.NEXT_PUBLIC_OBSERVABILITY_ENV,
    process.env.NEXT_PUBLIC_ENVIRONMENT_MODE,
  ];
  return otherDeclarations.every(value => !value?.trim() || normalizeEnvironment(value) === environment)
    ? environment : null;
}

