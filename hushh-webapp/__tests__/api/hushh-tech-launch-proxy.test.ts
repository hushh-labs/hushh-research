import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const proxyGuard = vi.hoisted(() => ({
  counts: new Map<string, number>(),
}));

vi.mock("@/app/api/_utils/backend", () => ({
  getDeveloperApiUrl: () => "http://developer-backend.test",
}));

vi.mock("redis", () => ({
  createClient: () => ({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn(async (_script: string, options: { keys: string[] }) => {
      const key = options.keys[0] ?? "";
      const count = (proxyGuard.counts.get(key) ?? 0) + 1;
      proxyGuard.counts.set(key, count);
      return count;
    }),
  }),
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getIdTokenClient() {
      return {
        getRequestHeaders: async () =>
          new Headers({ Authorization: "Bearer google-service-identity" }),
      };
    }
  },
}));

import { POST as authorize } from "@/app/api/products/hushh-tech/launch/authorize/route";
import { POST as exchange } from "@/app/api/products/hushh-tech/launch/exchange/route";

const AUTHORIZE_PATH =
  "http://localhost:3000/api/products/hushh-tech/launch/authorize";
const EXCHANGE_PATH =
  "http://localhost:3000/api/products/hushh-tech/launch/exchange";

function authorizeRequest(
  body: Record<string, unknown>,
  authorization = "Bearer firebase-id-token",
  clientIp = "203.0.113.20",
) {
  return new NextRequest(AUTHORIZE_PATH, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "X-Forwarded-For": clientIp,
    },
    body: JSON.stringify(body),
  });
}

function exchangeRequest(
  body: Record<string, unknown>,
  clientIp = "203.0.113.20",
) {
  return new NextRequest(EXCHANGE_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": clientIp,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(globalThis.fetch).mockReset();
  proxyGuard.counts.clear();
  process.env.HUSHH_DEPLOY_ENV = "test";
  process.env.HUSSH_TECH_CLIENT_ENABLED = "true";
  process.env.HUSSH_TECH_PROXY_AUDIENCE = "http://developer-backend.test";
  process.env.RATE_LIMIT_STORAGE_URI = "redis://127.0.0.1:6379";
  delete process.env.HUSSH_TECH_FRONTEND_TRUSTED_PROXY_HOPS;
});

describe("Hushh Tech launch proxies", () => {
  it("forwards only the authorize contract with the Firebase bearer", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        code: "launch-code",
        expires_in: 60,
        audience: "hushh-tech-uat",
        redirect_uri: "https://uat.hushhtech.com/callback",
      }),
    );

    const response = await authorize(
      authorizeRequest({
        audience: "hushh-tech-uat",
        redirect_uri: "https://uat.hushhtech.com/callback",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        state: "browser-only-state",
        extra: "not-forwarded",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(url).toBe(
      "http://developer-backend.test/api/v1/products/hushh-tech/launch/authorize",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer firebase-id-token");
    expect(headers.get("X-Hushh-Proxy-Authorization")).toBe(
      "Bearer google-service-identity",
    );
    expect(headers.get("X-Hushh-Tech-Client-IP")).toBe("203.0.113.20");
    expect(JSON.parse(String(init?.body))).toEqual({
      audience: "hushh-tech-uat",
      redirect_uri: "https://uat.hushhtech.com/callback",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
  });

  it("rejects authorize calls without a Firebase bearer", async () => {
    const response = await authorize(
      authorizeRequest(
        {
          audience: "hushh-tech-uat",
          redirect_uri: "https://uat.hushhtech.com/callback",
          code_challenge: "a".repeat(43),
          code_challenge_method: "S256",
        },
        "",
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      detail: { code: "UNAUTHENTICATED" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects non-S256 authorize input before the backend", async () => {
    const response = await authorize(
      authorizeRequest({
        audience: "hushh-tech-uat",
        redirect_uri: "https://uat.hushhtech.com/callback",
        code_challenge: "a".repeat(43),
        code_challenge_method: "plain",
      }),
    );

    expect(response.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("forwards the exchange contract without forwarding browser authorization", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({ firebase_custom_token: "custom-token", expires_in: 60 }),
    );

    const response = await exchange(
      exchangeRequest({
        code: "launch-code",
        verifier: "v".repeat(43),
        audience: "hushh-tech-uat",
        redirect_uri: "https://uat.hushhtech.com/callback",
        authorization: "not-forwarded",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      firebase_custom_token: "custom-token",
      expires_in: 60,
    });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(url).toBe(
      "http://developer-backend.test/api/v1/products/hushh-tech/launch/exchange",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Hushh-Proxy-Authorization")).toBe(
      "Bearer google-service-identity",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      code: "launch-code",
      verifier: "v".repeat(43),
      audience: "hushh-tech-uat",
      redirect_uri: "https://uat.hushhtech.com/callback",
    });
  });

  it("fails closed when an exchange field is missing", async () => {
    const response = await exchange(
      exchangeRequest({
        code: "launch-code",
        audience: "hushh-tech-uat",
        redirect_uri: "https://uat.hushhtech.com/callback",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      detail: { code: "INVALID_EXCHANGE_REQUEST" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not expose a non-JSON upstream response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("firebase_custom_token=raw-secret", { status: 503 }),
    );

    const response = await exchange(
      exchangeRequest({
        code: "launch-code",
        verifier: "v".repeat(43),
        audience: "hushh-tech-uat",
        redirect_uri: "https://uat.hushhtech.com/callback",
      }),
    );

    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload).toMatchObject({ detail: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(JSON.stringify(payload)).not.toContain("raw-secret");
  });

  it("limits one edge visitor without throttling a second visitor", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      Response.json({ code: "launch-code" }),
    );
    const body = {
      audience: "hushh-tech-uat",
      redirect_uri: "https://uat.hushhtech.com/callback",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    };

    const attacker = await Promise.all(
      Array.from({ length: 31 }, () =>
        authorize(authorizeRequest(body, undefined, "203.0.113.90")),
      ),
    );
    const bystander = await authorize(
      authorizeRequest(body, undefined, "203.0.113.91"),
    );

    expect(attacker.slice(0, 30).every((response) => response.status === 200)).toBe(
      true,
    );
    expect(attacker[30]?.status).toBe(429);
    expect(bystander.status).toBe(200);
  });

  it("uses the rightmost edge IP and ignores a caller-added left entry", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({ code: "launch-code" }),
    );
    await authorize(
      authorizeRequest(
        {
          audience: "hushh-tech-uat",
          redirect_uri: "https://uat.hushhtech.com/callback",
          code_challenge: "a".repeat(43),
          code_challenge_method: "S256",
        },
        undefined,
        "192.0.2.1, 203.0.113.92",
      ),
    );

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect((init?.headers as Headers).get("X-Hushh-Tech-Client-IP")).toBe(
      "203.0.113.92",
    );
  });
});
