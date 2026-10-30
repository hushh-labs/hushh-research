import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";

const REQUEST_TIMEOUT_MS = 30000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(_request: NextRequest) {
  const url = `${getPythonApiUrl()}/api/app-config/review-mode`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json(
        { enabled: false, error: `Upstream status ${response.status}` },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }

    const data = await response.json();
    return NextResponse.json(data, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    clearTimeout(timeout);
    console.warn("[app-config/review-mode] fallback disabled:", error);
    return NextResponse.json(
      { enabled: false },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }
}
