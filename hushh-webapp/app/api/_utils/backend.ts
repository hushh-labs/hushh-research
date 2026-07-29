// hushh-webapp/app/api/_utils/backend.ts

const IS_HOSTED_ENV = Boolean(
  process.env.VERCEL || 
  process.env.GOOGLE_CLOUD_PROJECT || 
  process.env.K_SERVICE
);

// 1. Hosted Environment Fail-Fast Contract (Module Level)
// The CI integration test requires this boundary to be verified immediately upon module load.
// We do not guess a backend origin.
// If the backend origin is missing in prod/preview, the server refuses to boot.

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

  // 2. Protocol Auto-Correction
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = baseUrl.includes("127.0.0.1")
      ? `http://${baseUrl}`
      : `https://${baseUrl}`;
  }

  try {
    const parsedUrl = new URL(baseUrl);
    // 3. Subpath preservation and trailing slash cleanup
    return parsedUrl.href.replace(/\/$/, "");
  } catch (_error) {
    console.error(`[Hushh Backend Contract] Error: Invalid URL structure for ${envName}: ${baseUrl}`);
    return baseUrl.replace(/\/$/, "");
  }
}

export function getPythonApiUrl(): string {
  const envUrl = process.env.PYTHON_API_URL || process.env.BACKEND_URL || process.env.PYTHON_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL;
  
  if (IS_HOSTED_ENV && !envUrl) {
    throw new Error("[Hushh Backend Contract] Fail-fast: Missing backend origin. Refusing to boot with insecure localhost defaults. We do not guess a backend origin.");
  }

  const url = normalizeBackendUrl(
    envUrl,
    "BACKEND_URL",
    "http://127.0.0.1:8000"
  );

  if (IS_HOSTED_ENV && url.includes("127.0.0.1")) {
    throw new Error("[Hushh Backend Contract] Fail-fast: resolved backend origin to localhost. Refusing to boot with insecure localhost defaults.");
  }

  return url;
}

export function getDeveloperApiUrl(): string {
  const envUrl = process.env.DEVELOPER_API_URL || process.env.NEXT_PUBLIC_DEVELOPER_API_URL || process.env.BACKEND_URL || process.env.PYTHON_BACKEND_URL;
  return normalizeBackendUrl(
    envUrl,
    "DEVELOPER_API_URL",
    "http://127.0.0.1:8000"
  );
}