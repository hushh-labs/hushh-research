import { NextRequest } from "next/server";

import { getDeveloperApiUrl } from "@/app/api/_utils/backend";
import {
  createUpstreamHeaders,
  resolveRequestId,
  withRequestIdJson,
} from "@/app/api/_utils/request-id";
import {
  consumeLaunchProxyBudget,
  createLaunchProxyIdentityHeaders,
  isHushhTechLaunchProxyEnabled,
} from "@/app/api/products/hushh-tech/_utils/proxy-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
};

function requiredString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readBearer(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  if (!isHushhTechLaunchProxyEnabled()) {
    return withRequestIdJson(
      requestId,
      {
        detail: {
          code: "FEATURE_DISABLED",
          message: "Hushh Tech entry is not enabled.",
        },
      },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  let clientIp: string;
  try {
    const budget = await consumeLaunchProxyBudget(request, "authorize");
    if (!budget.allowed) {
      return withRequestIdJson(
        requestId,
        { detail: { code: "RATE_LIMITED", message: "Try again shortly." } },
        {
          status: 429,
          headers: { ...NO_STORE_HEADERS, "Retry-After": "60" },
        },
      );
    }
    clientIp = budget.clientIp;
  } catch {
    return withRequestIdJson(
      requestId,
      {
        detail: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Launch service unavailable.",
        },
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const bearer = readBearer(request);
  if (!bearer) {
    return withRequestIdJson(
      requestId,
      { detail: { code: "UNAUTHENTICATED", message: "Sign in required." } },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return withRequestIdJson(
      requestId,
      {
        detail: {
          code: "INVALID_LAUNCH_REQUEST",
          message: "Launch request is incomplete.",
        },
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const record = body as Record<string, unknown>;
  const audience = requiredString(record, "audience");
  const redirectUri = requiredString(record, "redirect_uri");
  const codeChallenge = requiredString(record, "code_challenge");
  const codeChallengeMethod = requiredString(record, "code_challenge_method");
  if (
    !audience ||
    !redirectUri ||
    !codeChallenge ||
    codeChallengeMethod !== "S256"
  ) {
    return withRequestIdJson(
      requestId,
      {
        detail: {
          code: "INVALID_LAUNCH_REQUEST",
          message: "Launch request is incomplete.",
        },
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const targetUrl = `${getDeveloperApiUrl()}/api/v1/products/hushh-tech/launch/authorize`;
    const proxyIdentityHeaders = await createLaunchProxyIdentityHeaders(
      targetUrl,
      clientIp,
    );
    const response = await fetch(
      targetUrl,
      {
        method: "POST",
        headers: createUpstreamHeaders(requestId, {
          Accept: "application/json",
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          ...proxyIdentityHeaders,
        }),
        body: JSON.stringify({
          audience,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
        }),
        cache: "no-store",
      },
    );
    const payload: unknown = await response.json().catch(() => null);
    if (payload === null) {
      return withRequestIdJson(
        requestId,
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "Launch service unavailable.",
          },
        },
        { status: 502, headers: NO_STORE_HEADERS },
      );
    }
    return withRequestIdJson(requestId, payload, {
      status: response.status,
      headers: NO_STORE_HEADERS,
    });
  } catch {
    return withRequestIdJson(
      requestId,
      {
        detail: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Launch service unavailable.",
        },
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
