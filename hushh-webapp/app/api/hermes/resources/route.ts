import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";
import { resolveRequestId, withRequestIdJson } from "@/app/api/_utils/request-id";

/**
 * What the machine running Puppy One has left: the model answering, the models
 * resident in memory, the headroom the machine has tonight, and whether its
 * scheduled work is landing.
 *
 * Server-side only, exactly like the status route: the loopback bearer key is
 * host remote-code-execution and stays on this side of the boundary. The
 * browser only ever talks to our own origin.
 *
 * "Not configured" and "not reachable" are ordinary states, not errors. A
 * machine without Hermes running is the common case, and a 500 would make it
 * look broken.
 *
 * The gateway's payload is passed through section by section, unaltered. It
 * OMITS a section whose probe could not answer, and an omission is itself
 * information: it means that reading could not be taken, not that it is zero.
 * Defaulting one here would invent a fact about the owner's machine.
 */
export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const config = resolveHermesBridgeConfig();
  if (!config) {
    return withRequestIdJson(
      requestId,
      {
        configured: false,
        reason: "not_configured",
        message:
          "Set HERMES_API_SERVER_KEY to read the machine Puppy One runs on.",
      },
      { status: 200 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.baseUrl}/api/hussh-one/resources`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      // Longer than the status probe: this endpoint reads disk, power and the
      // model host, any of which can be slow on a machine that is busy. Still
      // bounded, so a wedged probe cannot hold a route handler open.
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // A closed loopback port is the normal "agent not running" case.
    return withRequestIdJson(
      requestId,
      { configured: true, reachable: false },
      { status: 200 },
    );
  }

  if (!upstream.ok) {
    return withRequestIdJson(
      requestId,
      { configured: true, reachable: false },
      { status: 200 },
    );
  }

  const payload = await upstream.json().catch(() => null);
  const sections =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  // The envelope flags are written LAST on purpose. `configured` and
  // `reachable` describe this bridge, not the gateway, so a payload carrying
  // either key must not be able to overwrite our own answer about it.
  return withRequestIdJson(
    requestId,
    { ...sections, configured: true, reachable: true },
    { status: 200 },
  );
}
