/**
 * POST /api/hermes/chat — the relay: natural language in, Hermes's answer out.
 *
 * This is the one route that makes the machine *act*, so it is the one with the
 * strictest posture: owner-only (guard), bounded prompt length (client), and a
 * single turn per call. Hermes reports agent failures in-band with HTTP 200, so
 * `failed` is surfaced explicitly instead of being rendered as an answer.
 */

import { NextResponse, type NextRequest } from "next/server";

import { guardHermesRequest, hermesErrorResponse } from "../_guard";
import { runHermesTurn } from "@/lib/hermes/client";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const guard = await guardHermesRequest(request);
  if (!guard.ok) return guard.response;

  let body: { prompt?: unknown; sessionId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Expected JSON." },
      { status: 400 },
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    return NextResponse.json(
      { error: "invalid_prompt", message: "A prompt is required." },
      { status: 400 },
    );
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;

  try {
    const result = await runHermesTurn(prompt, { sessionId });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return hermesErrorResponse(cause);
  }
}
