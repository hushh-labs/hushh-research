/**
 * Hussh One Hermes bridge — server-only configuration.
 *
 * SECURITY CONTRACT (read before changing anything here):
 *
 * 1. The Hermes API key is a machine-owner credential. It is read from the
 *    server environment and MUST NEVER be returned to the browser, embedded in
 *    a page payload, or logged. Nothing in this module is exported to client
 *    components; route handlers call Hermes server-side and return only
 *    already-shaped, key-free data.
 * 2. The bridge is OFF unless explicitly enabled. This is a local-development
 *    lane: a deployed environment has no route to a person's laptop, so an
 *    accidentally-enabled bridge could only ever point somewhere it should not.
 * 3. Only loopback hosts are accepted. A non-loopback base URL would turn this
 *    into an SSRF primitive reachable through an authenticated app route.
 */

import "server-only";

/** Default bind of the Hermes gateway API server. */
const DEFAULT_BASE_URL = "http://127.0.0.1:8642";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface HermesBridgeConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  /** Populated when the bridge is unusable, for operator-facing diagnostics. */
  disabledReason: string | null;
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Reject anything that is not loopback. Hermes runs on the operator's own
 * machine; a remote host here would mean the app is proxying authenticated
 * requests to an arbitrary destination.
 */
export function isLoopbackBaseUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

export function resolveHermesBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): HermesBridgeConfig {
  const baseUrl = (env.HERMES_LOCAL_BASE_URL || DEFAULT_BASE_URL).trim();
  const apiKey = (env.HERMES_LOCAL_API_KEY || "").trim();

  if (!truthy(env.HERMES_LOCAL_BRIDGE_ENABLED)) {
    return {
      enabled: false,
      baseUrl,
      apiKey: "",
      disabledReason:
        "The Hermes bridge is off. Set HERMES_LOCAL_BRIDGE_ENABLED=true for local development.",
    };
  }

  if (!isLoopbackBaseUrl(baseUrl)) {
    return {
      enabled: false,
      baseUrl,
      apiKey: "",
      disabledReason:
        "HERMES_LOCAL_BASE_URL must point at a loopback address; the Hermes bridge only reaches this machine.",
    };
  }

  if (!apiKey) {
    return {
      enabled: false,
      baseUrl,
      apiKey: "",
      disabledReason:
        "HERMES_LOCAL_API_KEY is not set. Copy API_SERVER_KEY from the Hermes profile env.",
    };
  }

  return { enabled: true, baseUrl, apiKey, disabledReason: null };
}

/** Where the local Hermes profile records its trusted-device enrollment. */
export function resolveHermesProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.HERMES_HOME || "").trim();
  if (explicit) return explicit;
  const home = (env.HOME || env.USERPROFILE || "").trim();
  return home ? `${home}/.hermes` : ".hermes";
}
