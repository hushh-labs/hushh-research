// hushh-webapp/app/api/_utils/backend.ts
//
// Single source of truth for where Next.js route handlers proxy backend traffic.
//
// Contract:
// - Local development may default to 127.0.0.1:8000 when no explicit backend origin is set.
// - Hosted runtimes must receive an explicit backend origin via runtime env.
// - Server-side route handlers must fail fast instead of silently falling back to production.

type CanonicalEnvironment = "development" | "uat" | "production";

const LOCAL_DEFAULT = "http://127.0.0.1:8000";

function normalizeUrl(value: string | undefined): string | null {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

function normalizeEnvironment(
  value: string | undefined | null
): CanonicalEnvironment | null {
  const normalized = String(value || "").trim().toLowerCase();
  switch (normalized) {
    case "development":
    case "uat":
    case "production":
      return normalized;
    case "local":
      return "development";
    case "prod":
      return "production";
    case "local-uatdb":
      return "development";
    case "uat-remote":
      return "uat";
    case "prod-remote":
      return "production";
    default:
      return null;
  }
}

function resolveEnvironment(): CanonicalEnvironment {
  return (
    normalizeEnvironment(process.env.NEXT_PUBLIC_APP_ENV) ||
    normalizeEnvironment(process.env.ENVIRONMENT) ||
    normalizeEnvironment(process.env.APP_RUNTIME_MODE) ||
    normalizeEnvironment(process.env.APP_RUNTIME_PROFILE) ||
    (process.env.NODE_ENV === "production" ? "production" : "development")
  );
}

function isHostedServerRuntime(): boolean {
  return Boolean(
    process.env.K_SERVICE ||
      process.env.K_REVISION ||
      process.env.GOOGLE_CLOUD_PROJECT
  );
}

function isLocalhostUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function canonicalizeLocalOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "localhost") {
      return value;
    }
    url.hostname = "127.0.0.1";
    return url.origin;
  } catch {
    return value;
  }
}

function resolveConfiguredOrigin(keys: string[]): string | null {
  for (const key of keys) {
    const resolved = normalizeUrl(process.env[key]);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function requireBackendOrigin(params: {
  label: string;
  runtimeKeys: string[];
  localHintKeys: string[];
}): string {
  const environment = resolveEnvironment();
  const hosted = isHostedServerRuntime();
  const runtimeOrigin = resolveConfiguredOrigin(params.runtimeKeys);

  if (runtimeOrigin) {
    if (hosted && isLocalhostUrl(runtimeOrigin)) {
      throw new Error(
        `[backend] Hosted ${environment} runtime resolved ${params.label} to localhost. ` +
          `Set ${params.runtimeKeys.join(" or ")} explicitly for this deployment.`
      );
    }
    return hosted ? runtimeOrigin : canonicalizeLocalOrigin(runtimeOrigin);
  }

  const localHint = resolveConfiguredOrigin(params.localHintKeys);
  if (!hosted) {
    if (localHint) {
      return canonicalizeLocalOrigin(localHint);
    }
    if (environment === "development") {
      return LOCAL_DEFAULT;
    }
  }

  throw new Error(
    `[backend] Missing ${params.label} for ${environment} route handlers. ` +
      `Set ${params.runtimeKeys.join(" or ")} explicitly; hosted runtimes do not guess a backend origin.`
  );
}

export function getPythonApiUrl(): string {
  return requireBackendOrigin({
    label: "backend origin",
    runtimeKeys: ["PYTHON_API_URL", "BACKEND_URL"],
    localHintKeys: ["NEXT_PUBLIC_BACKEND_URL"],
  });
}

export function getDeveloperApiUrl(): string {
  return requireBackendOrigin({
    label: "developer backend origin",
    runtimeKeys: ["DEVELOPER_API_URL", "BACKEND_URL"],
    localHintKeys: ["NEXT_PUBLIC_DEVELOPER_API_URL", "NEXT_PUBLIC_BACKEND_URL"],
  });
}
