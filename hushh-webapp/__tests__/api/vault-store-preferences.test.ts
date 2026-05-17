import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  storeUserData: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  storeUserData: mocks.storeUserData,
}));

describe("POST /api/vault/store-preferences", () => {
  const originalFetch = global.fetch;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_ENV = "development";
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          valid: true,
          user_id: "firebase-user-123",
          agent_id: "vault",
          scope: "vault.owner",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    ) as typeof fetch;
    mocks.storeUserData.mockResolvedValue(true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("passes the validated vault-owner token into each PKM domain write", async () => {
    const route = await import("../../app/api/vault/store-preferences/route");
    const request = new NextRequest("http://localhost:3000/api/vault/store-preferences", {
      method: "POST",
      body: JSON.stringify({
        userId: "firebase-user-123",
        consentToken: "HCT:vault-owner-token",
        preferences: {
          preferences: {
            ciphertext: "ciphertext",
            iv: "iv",
            tag: "tag",
          },
        },
      }),
    });

    const response = await route.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(mocks.storeUserData).toHaveBeenCalledWith(
      "firebase-user-123",
      "preferences",
      "ciphertext",
      "iv",
      "tag",
      { vaultOwnerToken: "HCT:vault-owner-token" }
    );
  });

  it("does not log user ids, field names, or ciphertext while storing", async () => {
    const route = await import("../../app/api/vault/store-preferences/route");
    const request = new NextRequest("http://localhost:3000/api/vault/store-preferences", {
      method: "POST",
      body: JSON.stringify({
        userId: "firebase-user-123",
        consentToken: "HCT:vault-owner-token",
        preferences: {
          preferences: {
            ciphertext: "ciphertext",
            iv: "iv",
            tag: "tag",
          },
        },
      }),
    });

    await route.POST(request);

    const renderedLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map(String)
      .join(" ");
    expect(renderedLogs).not.toContain("firebase-user-123");
    expect(renderedLogs).not.toContain("preferences");
    expect(renderedLogs).not.toContain("ciphertext");
  });
});
