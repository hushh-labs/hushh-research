/**
 * Server-only configuration for the local Hermes bridge.
 *
 * The Hermes api_server listens on loopback and is guarded by a bearer key that
 * is effectively host remote-code-execution. That key must never reach the
 * browser, so every call goes through a Next route handler running on the same
 * machine: the key is read here, server-side, and the loopback request is made
 * from the server. The browser only ever talks to our own origin.
 *
 * This is why the bridge is localhost-only today. A cloud-hosted One cannot
 * reach a loopback service on your Mac; that requires the outbound rendezvous
 * described in the One x Hermes live-bridge design, which is not built yet.
 */

export interface HermesBridgeConfig {
  baseUrl: string;
  apiKey: string;
}

/** Default loopback address of the Hermes api_server. */
export const HERMES_DEFAULT_BASE_URL = "http://127.0.0.1:8642";

/**
 * Resolve the bridge config, or null when it is not configured.
 *
 * Returning null (rather than throwing) lets the surface render a calm
 * "not connected" state instead of an error: a machine without Hermes running
 * is a normal condition, not a failure.
 */
export function resolveHermesBridgeConfig(): HermesBridgeConfig | null {
  const apiKey = (process.env.HERMES_API_SERVER_KEY || "").trim();
  if (!apiKey) return null;
  const baseUrl = (
    process.env.HERMES_API_SERVER_URL || HERMES_DEFAULT_BASE_URL
  ).trim();
  // Loopback only. The bridge exists to reach a service on THIS machine; a
  // non-loopback target would mean forwarding a host-RCE key to some other
  // host, which is never the intent and is refused rather than trusted.
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}
