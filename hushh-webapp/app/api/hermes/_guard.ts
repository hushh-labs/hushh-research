/**
 * Shared guard for the Hermes bridge routes.
 *
 * Every route is owner-only. The Hermes machine is the operator's own computer
 * and the bridge can run agent turns on it, so an unauthenticated route here
 * would be remote code execution wearing a friendly name. The bridge is also
 * off by default (see lib/hermes/config.ts) — this guard reports that as a
 * clean 503 rather than a failure, because "not configured" is the normal
 * state everywhere except a developer's laptop.
 */

import { NextResponse, type NextRequest } from "next/server";

import { validateFirebaseToken } from "@/lib/auth/validate";
import { resolveHermesBridgeConfig } from "@/lib/hermes/config";

export interface GuardSuccess {
  ok: true;
  userId: string;
}

export interface GuardFailure {
  ok: false;
  response: NextResponse;
}

export type GuardResult = GuardSuccess | GuardFailure;

function bearerFrom(request: NextRequest): string | null {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

export async function guardHermesRequest(request: NextRequest): Promise<GuardResult> {
  const config = resolveHermesBridgeConfig();
  if (!config.enabled) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "hermes_bridge_disabled", message: config.disabledReason },
        { status: 503 },
      ),
    };
  }

  const token = bearerFrom(request);
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "unauthorized", message: "Sign in to reach Hermes." },
        { status: 401 },
      ),
    };
  }

  const validation = await validateFirebaseToken(token);
  if (!validation.valid || !validation.userId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "unauthorized", message: validation.error || "Invalid session." },
        { status: 401 },
      ),
    };
  }

  return { ok: true, userId: validation.userId };
}

/** Map a bridge failure onto a status code without leaking internals. */
export function hermesErrorResponse(cause: unknown): NextResponse {
  const message =
    cause instanceof Error ? cause.message : "Hermes is unavailable right now.";
  const reachability =
    cause && typeof cause === "object" && "reachability" in cause
      ? String((cause as { reachability: unknown }).reachability)
      : "offline";

  const status =
    reachability === "disabled" ? 503 : reachability === "unauthorized" ? 502 : 502;

  return NextResponse.json({ error: "hermes_unavailable", reachability, message }, { status });
}
