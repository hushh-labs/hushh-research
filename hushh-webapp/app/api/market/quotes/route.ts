import { NextRequest, NextResponse } from "next/server";
import { fetchPythonApi } from "@/app/api/_utils/backend";

export const dynamic = "force-dynamic";

/** Same public quote contract on web and native; no owner credentials forwarded. */
export async function GET(request: NextRequest) {
  const symbols = request.nextUrl.searchParams.get("symbols") || "";
  if (!symbols || symbols.length > 1024) {
    return NextResponse.json({ error: "Invalid symbols" }, { status: 400 });
  }
  try {
    const response = await fetchPythonApi(`/api/market/quotes?${new URLSearchParams({ symbols })}`, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      cache: "no-store",
    });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Quotes are temporarily unavailable" }, { status: 503 });
  }
}
