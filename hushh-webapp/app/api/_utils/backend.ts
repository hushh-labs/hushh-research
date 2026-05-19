// hushh-webapp/app/api/_utils/backend.ts

const IS_HOSTED_ENV = Boolean(
  process.env.VERCEL ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.K_SERVICE
);

/**
 * Normalizes backend URLs safely.
 * Preserves subpaths (e.g., /v1) using url.href instead of url.origin.
 * Auto-corrects missing protocols and strips trailing slashes.
 */
function normalizeBackendUrl(
  rawUrl: string | undefined,
  envName: string,
  fallback: string
): string {
  let baseUrl = rawUrl || fallback;

  // Canonicalize localhost to 127.0.0.1 for server-side route fetching
  baseUrl = baseUrl.replace(/localhost/g, "127.0.0.1");

  // Protocol Auto-Correction
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = baseUrl.includes("127.0.0.1")
      ? `http://${baseUrl}`
      : `https://${baseUrl}`;
  }

  try {
    const parsedUrl = new URL(baseUrl);
    // Subpath preservation and trailing slash cleanup
    return parsedUrl.href.replace(/\/$/, "");
  } catch (_error) {
    console.error(`[Hushh Backend Contract] Error: Invalid URL structure for ${envName}: ${baseUrl}`);
    return baseUrl.replace(/\/$/, "");
  }
}

/**
 * Resolves and strictly validates a backend URL against the hosted environment contract.
 */
function resolveAndValidateUrl(
  envUrls: (string | undefined)[],
  label: string,
  fallback = "http://127.0.0.1:8000"
): string {
  // Grab the first defined URL from the fallback chain
  const rawUrl = envUrls.find(Boolean);

  // 1. Fail-fast if missing in prod
  if (IS_HOSTED_ENV && !rawUrl) {
    throw new Error(`[Hushh Backend Contract] Fail-fast: Missing ${label} origin. Refusing to boot with insecure localhost defaults. We do not guess a backend origin.`);
  }

  const url = normalizeBackendUrl(rawUrl, label, fallback);

  // 2. Fail-fast if prod resolves to localhost
  if (IS_HOSTED_ENV && url.includes("127.0.0.1")) {
    throw new Error(`[Hushh Backend Contract] Fail-fast: ${label} resolved to localhost. Refusing to boot with insecure localhost defaults.`);
  }

  return url;
}

// ============================================================================
// MODULE-LEVEL EVALUATION
// These execute immediately when the module is imported, satisfying the strict 
// CI "Fail-Fast" requirement before the server even finishes booting.
// ============================================================================

const PYTHON_API_URL = resolveAndValidateUrl(
  [
    process.env.PYTHON_API_URL,
    process.env.BACKEND_URL,
    process.env.PYTHON_BACKEND_URL,
    process.env.NEXT_PUBLIC_BACKEND_URL
  ],
  "BACKEND_URL"
);

const DEVELOPER_API_URL = resolveAndValidateUrl(
  [
    process.env.DEVELOPER_API_URL,
    process.env.NEXT_PUBLIC_DEVELOPER_API_URL,
    process.env.BACKEND_URL,
    process.env.PYTHON_BACKEND_URL
  ],
  "DEVELOPER_API_URL"
);

export function getPythonApiUrl(): string {
  return PYTHON_API_URL;
}

export function getDeveloperApiUrl(): string {
  return DEVELOPER_API_URL;
}