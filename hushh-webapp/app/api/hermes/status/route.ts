/**
 * GET /api/hermes/status — is the operator's Hermes reachable, and which
 * registered trusted device is it?
 *
 * Returns registration truth and live machine truth together so the UI can
 * distinguish "enrolled but asleep" from "running but not enrolled".
 */

import { NextResponse, type NextRequest } from "next/server";

import { guardHermesRequest } from "../_guard";
import { getHermesBridgeStatus } from "@/lib/hermes/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = await guardHermesRequest(request);
  if (!guard.ok) return guard.response;

  // getHermesBridgeStatus never throws for an unreachable Hermes — being
  // offline is an expected state the UI renders, not an error condition.
  const bridge = await getHermesBridgeStatus();
  return NextResponse.json(bridge, {
    headers: { "Cache-Control": "no-store" },
  });
}
