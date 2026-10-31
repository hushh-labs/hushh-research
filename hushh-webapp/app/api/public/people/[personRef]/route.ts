import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  props: { params: Promise<{ personRef: string }> },
) {
  const { personRef } = await props.params;
  const response = await fetch(
    `${getPythonApiUrl()}/api/public/people/${encodeURIComponent(personRef)}`,
    { cache: "no-store", signal: AbortSignal.timeout(15_000) },
  ).catch(() => null);
  if (!response) {
    return Response.json(
      { detail: "Person profile is unavailable." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
