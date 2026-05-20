import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("POST /api/vault/wrapper/delete", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    process.env.PYTHON_API_URL = "http://backend.test";
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.PYTHON_API_URL;
  });

  it("rejects body-only vault owner tokens before proxying", async () => {
    const route = await import("../../app/api/vault/wrapper/delete/route");
    const request = new NextRequest("http://localhost:3000/api/vault/wrapper/delete", {
      method: "POST",
      headers: {
        Authorization: "Bearer DEV_TOKEN",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        vaultKeyHash: "vault-hash",
        method: "generated_default_web_prf",
        wrapperId: "cred-1",
        vaultOwnerToken: "vault-owner-token",
      }),
    });

    const response = await route.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.code).toBe("VAULT_OWNER_TOKEN_REQUIRED");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards Firebase identity and vault-owner unlock proof as separate headers", async () => {
    const route = await import("../../app/api/vault/wrapper/delete/route");
    const request = new NextRequest("http://localhost:3000/api/vault/wrapper/delete", {
      method: "POST",
      headers: {
        Authorization: "Bearer DEV_TOKEN",
        "X-Hushh-Consent": "vault-owner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        vaultKeyHash: "vault-hash",
        method: "generated_default_web_prf",
        wrapperId: "cred-1",
      }),
    });

    const response = await route.POST(request);

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://backend.test/db/vault/wrapper/delete",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer DEV_TOKEN",
          "X-Hushh-Consent": "Bearer vault-owner-token",
        }),
      })
    );
  });
});
