import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("POST /api/vault/wrapper/delete", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    process.env.PYTHON_API_URL = "http://backend.test";
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as typeof fetch;

    vi.doMock("@/lib/config", () => ({
      isDevelopment: () => true,
    }));
    vi.doMock("@/lib/auth/validate", () => ({
      validateFirebaseToken: vi.fn().mockResolvedValue({ valid: true }),
    }));
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

  // ── Missing parameters (400 Bad Request) ───────────────────────────────────

  it("returns 400 when required fields are missing from body", async () => {
    const route = await import("../../app/api/vault/wrapper/delete/route");
    const request = new NextRequest("http://localhost:3000/api/vault/wrapper/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Hushh-Consent": "vault-owner-token",
      },
      body: JSON.stringify({
        userId: "user-1",
        // vaultKeyHash is missing
        method: "generated_default_web_prf",
      }),
    });

    const response = await route.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/Missing required wrapper delete fields/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Upstream Non-OK Responses ──────────────────────────────────────────────

  it("propagates non-OK response status and error payloads directly from upstream", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Wrapper ID not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    ) as typeof fetch;

    const route = await import("../../app/api/vault/wrapper/delete/route");
    const request = new NextRequest("http://localhost:3000/api/vault/wrapper/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Hushh-Consent": "vault-owner-token",
      },
      body: JSON.stringify({
        userId: "user-1",
        vaultKeyHash: "vault-hash",
        method: "generated_default_web_prf",
        wrapperId: "bad-cred-id",
      }),
    });

    const response = await route.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload).toEqual({ error: "Wrapper ID not found" });
  });

  // ── Production Auth validation check ───────────────────────────────────────

  it("returns 401 AUTH_INVALID in production when Firebase token validation fails", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "production";

    vi.doMock("@/lib/config", () => ({
      isDevelopment: () => false,
    }));
    vi.doMock("@/lib/auth/validate", () => ({
      validateFirebaseToken: vi.fn().mockResolvedValue({ valid: false, error: "Token expired" }),
    }));

    const { validateFirebaseToken } = await import("@/lib/auth/validate");
    vi.mocked(validateFirebaseToken).mockResolvedValue({ valid: false, error: "Token expired" });

    const route = await import("../../app/api/vault/wrapper/delete/route");
    const request = new NextRequest("http://localhost:3000/api/vault/wrapper/delete", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-firebase-token",
        "X-Hushh-Consent": "vault-owner-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        vaultKeyHash: "vault-hash",
        method: "generated_default_web_prf",
      }),
    });

    const response = await route.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.code).toBe("AUTH_INVALID");
    expect(payload.error).toMatch(/Authentication failed/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Client Version Header propagation ──────────────────────────────────────

  it("propagates client version header when provided in request", async () => {
    const route = await import("../../app/api/vault/wrapper/delete/route");
    const request = new NextRequest("http://localhost:3000/api/vault/wrapper/delete", {
      method: "POST",
      headers: {
        "X-Hushh-Consent": "vault-owner-token",
        "x-hushh-client-version": "3.1.2",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        vaultKeyHash: "vault-hash",
        method: "generated_default_web_prf",
      }),
    });

    const response = await route.POST(request);

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-hushh-client-version": "3.1.2",
        }),
      })
    );
  });
});

