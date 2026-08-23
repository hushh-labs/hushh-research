// app/api/one/referrals/events/route.ts

/**
 * Referral SSE proxy.
 *
 * This route exists because the catch-all `/api/one/[...path]` proxy reads its
 * upstream response to completion and re-serialises it as JSON. A stream sent
 * through it does not fail -- it silently arrives as `{}` with status 200, so
 * the screen simply never updates and nothing appears in the console. Every
 * streaming surface in this app therefore gets its own route that hands the
 * upstream body straight back, which is exactly what the consent events proxy
 * does.
 *
 * The stream is scoped by the caller's token, not by anything in the URL, so
 * there is no user id here to point at somebody else.
 */

import { NextRequest, NextResponse } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const upstream = await fetch(`${getPythonApiUrl()}/api/one/referrals/events`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        Authorization: authorization,
      },
    });

    if (!upstream.ok || !upstream.body) {
      // A failure here must not look like a broken tab: the panel keeps its
      // polling fallback, so it degrades from live to slow, never to blank.
      return NextResponse.json(
        { error: "Referral event stream unavailable" },
        { status: upstream.status || 502 },
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        // Tells any buffering proxy in front of us to stop buffering. Without
        // it a stream can be held until it is long enough to be worth
        // forwarding, which for a doorbell is forever.
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Referral event stream unavailable" },
      { status: 502 },
    );
  }
}
