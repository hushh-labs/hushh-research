import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { fetchWithTimeout } from "@/lib/api/request-timeout";

const REQUEST_TIMEOUT_MS = 8000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(_request: NextRequest) {
  const url = `${getPythonApiUrl()}/api/app-config/review-mode`;

  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      return NextResponse.json(
        { enabled: false, error: `Upstream status ${response.status}` },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }

    const data = await response.json();
    return NextResponse.json(data, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.warn("[app-config/review-mode] fallback disabled:", error);
    return NextResponse.json(
      { enabled: false },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }
}
