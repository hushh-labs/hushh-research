import { NextResponse } from "next/server";

type ProxyRequestOptions = {
  url: string;
  options?: RequestInit;
  timeoutMs?: number;
  timeoutMessage?: string;
};

export async function proxyRequest({
  url,
  options = {},
  timeoutMs = 20_000,
  timeoutMessage = "Upstream request timed out",
}: ProxyRequestOptions) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const payload = await response
      .json()
      .catch(async () => ({
        detail: await response.text().catch(() => ""),
      }));

    return NextResponse.json(payload, {
      status: response.status,
    });
  } catch (error) {
    console.error("[PROXY_REQUEST_ERROR]", error);

    if (error instanceof Error && error.name === "TimeoutError") {
      return NextResponse.json(
        { error: timeoutMessage },
        { status: 504 }
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}