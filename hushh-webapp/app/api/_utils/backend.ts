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

/**
 * Normalizes environment variable strings into CanonicalEnvironment types.
 */
function normalizeEnvironment(
  value: string | undefined | null
): CanonicalEnvironment | null {
  const normalized = String(value || "").trim().toLowerCase();

  const envMap: Record<string, CanonicalEnvironment> = {
    "development": "development",
    "local": "development",
    "local-uatdb": "development",
    "uat": "uat",
    "uat-remote": "uat",
    "production": "production",
    "prod": "production",
    "prod-remote": "production",
  };

  return envMap[normalized] || null;
}

/**
 * Resolves the current application environment.
 */
function resolveEnvironment(): CanonicalEnvironment {
  return (
    normalizeEnvironment(process.env.NEXT_PUBLIC_APP_ENV) ||
    normalizeEnvironment(process.env.ENVIRONMENT) ||
    normalizeEnvironment(process.env.APP_RUNTIME_PROFILE) ||
    (process.env.NODE_ENV === "production" ? "production" : "development")
  );
}

/**
 * Validates and cleans URL strings.
 * Ensures no trailing slashes and handles missing protocols.
 */
function normalizeUrl(value: string | undefined): string | null {
  let text = String(value || "").trim();
  if (!text) return null;

  // Ensure protocol exists for URL constructor
  if (!text.startsWith("http://") && !text.startsWith("https://")) {
    text = `http://${text}`;
  }

  try {
    const url = new URL(text);
    // Return origin + pathname to support subpath APIs, but remove trailing slash
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Checks if the code is executing in a managed cloud environment.
 */
function isHostedServerRuntime(): boolean {
  return Boolean(
    process.env.K_SERVICE ||            // Google Cloud Run
    process.env.K_REVISION ||           // Google Cloud Run
    process.env.GOOGLE_CLOUD_PROJECT || // GCP
    process.env.VERCEL                  // Vercel
  );
}

/**
 * Detects if a URL points to a local loopback address.
 */
function isLocalhostUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Standardizes 'localhost' to '127.0.0.1' for internal networking consistency.
 */
function canonicalizeLocalOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return value;
  }
}

/**
 * Iterates through possible environment keys to find a valid URL.
 */
function resolveConfiguredOrigin(keys: string[]): string | null {
  for (const key of keys) {
    const resolved = normalizeUrl(process.env[key]);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Core logic to enforce backend URL requirements based on the environment.
 */
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
        `[Hushh] Hosted ${environment} runtime resolved ${params.label} to localhost. ` +
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
    `[Hushh] Missing ${params.label} for ${environment} route handlers. ` +
    `Set ${params.runtimeKeys.join(" or ")} explicitly; hosted runtimes do not guess a backend origin.`
  );
}

/**
 * Public API for the primary Python backend.
 */
export function getPythonApiUrl(): string {
  return requireBackendOrigin({
    label: "backend origin",
    runtimeKeys: ["PYTHON_API_URL", "BACKEND_URL"],
    localHintKeys: ["NEXT_PUBLIC_BACKEND_URL"],
  });
}

/**
 * Public API for the Developer portal backend.
 */
export function getDeveloperApiUrl(): string {
  return requireBackendOrigin({
    label: "developer backend origin",
    runtimeKeys: ["DEVELOPER_API_URL", "BACKEND_URL"],
    localHintKeys: ["NEXT_PUBLIC_DEVELOPER_API_URL", "NEXT_PUBLIC_BACKEND_URL"],
  });
}