// app/api/vault/status/route.ts

/**
 * Vault Status API - Token-Enforced Metadata
 *
 * GET endpoint for checking domain activity status without fetching encrypted data.
 * Returns domain activity metadata (e.g. Kai and PKM domains).
 * Proxies to Python backend /db/vault/status
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";

export const dynamic = "force-dynamic";

const PYTHON_API_URL = getPythonApiUrl();
const hotGet = createHotGetJsonCache({
  freshTtlMs: 30 * 1000,
  staleTtlMs: 5 * 60 * 1000,
});

async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  const raw = await request.text().catch(() => "");
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildCacheKey(userId: string, firebaseAuthHeader: string): string {
  return `${userId}:${firebaseAuthHeader}`;
}

async function proxyVaultStatus(params: {
  userId: string;
  consentToken: string;
  firebaseAuthHeader: string;
}) {
  const response = await fetch(`${PYTHON_API_URL}/db/vault/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: params.firebaseAuthHeader,
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      userId: params.userId,
      consentToken: params.consentToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[API] Backend error:", response.status, errorText);
    return {
      status: response.status,
      payload: { error: "Backend error", details: errorText },
    };
  }

  return {
    status: response.status,
    payload: await response.json(),
  };
}

async function handleStatusRequest(params: {
  userId: string | null;
  consentToken: string | null;
  firebaseAuthHeader: string | null;
}) {
  if (!params.firebaseAuthHeader) {
    return NextResponse.json(
      { error: "Missing Authorization header (Firebase ID token required)" },
      { status: 401 }
    );
  }

  if (!params.userId || !params.consentToken) {
    return NextResponse.json(
      { error: "userId and consentToken are required" },
      { status: 400 }
    );
  }

  const hotCacheKey = buildCacheKey(params.userId, params.firebaseAuthHeader);
  const cached = hotGet.read(hotCacheKey);
  if (cached) {
    return NextResponse.json(cached.payload, { status: cached.status });
  }

  const existing = hotGet.getInflight(hotCacheKey);
  if (existing) {
    const deduped = await existing;
    return NextResponse.json(deduped.payload, { status: deduped.status });
  }

  try {
    const load = proxyVaultStatus({
      userId: params.userId,
      consentToken: params.consentToken,
      firebaseAuthHeader: params.firebaseAuthHeader,
    });
    hotGet.setInflight(hotCacheKey, load);
    const result = await load;

    if (result.status < 500) {
      hotGet.write(hotCacheKey, result);
    } else {
      const stale = hotGet.read(hotCacheKey, { allowStale: true });
      if (stale) {
        return NextResponse.json(stale.payload, { status: stale.status });
      }
    }

    return NextResponse.json(result.payload, { status: result.status });
  } catch (error) {
    console.error("[API] Vault status fetch error:", error);
    const stale = hotGet.read(hotCacheKey, { allowStale: true });
    if (stale) {
      return NextResponse.json(stale.payload, { status: stale.status });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  } finally {
    hotGet.clearInflight(hotCacheKey);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  return handleStatusRequest({
    userId: searchParams.get("userId"),
    consentToken: searchParams.get("consentToken"),
    firebaseAuthHeader: request.headers.get("authorization"),
  });
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody(request);
  return handleStatusRequest({
    userId: typeof body.userId === "string" ? body.userId : null,
    consentToken: typeof body.consentToken === "string" ? body.consentToken : null,
    firebaseAuthHeader: request.headers.get("authorization"),
  });
}
