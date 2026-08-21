/**
 * GET /api/hermes/jobs — the scheduled (cron) jobs on the operator's Hermes.
 *
 * Read-only by design. Hermes owns job mutation behind its own authenticated
 * API; surfacing pause/resume/run through the app is a deliberate later step,
 * because those change what the machine does rather than what the app shows.
 */

import { NextResponse, type NextRequest } from "next/server";

import { guardHermesRequest, hermesErrorResponse } from "../_guard";
import { listHermesJobs } from "@/lib/hermes/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = await guardHermesRequest(request);
  if (!guard.ok) return guard.response;

  try {
    const jobs = await listHermesJobs();
    return NextResponse.json(
      { jobs, count: jobs.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return hermesErrorResponse(cause);
  }
}
