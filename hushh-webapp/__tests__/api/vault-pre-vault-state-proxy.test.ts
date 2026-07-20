import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("POST /api/vault/pre-vault-state proxy parity", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_APP_ENV = "development";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("preserves the typed stale-journey envelope and revision fields", async () => {
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        onboardingCallbackAttemptId: "attempt-1",
        expectedOnboardingJourneyUpdatedAt: 123,
        expectedOnboardingCallbackAttemptId: "attempt-0",
      });
      return new Response(
        JSON.stringify({
          detail: {
            error: "Setup changed in another session.",
            code: "STALE_ONBOARDING_JOURNEY",
          },
        }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      );
    });
    global.fetch = upstream as typeof fetch;

    const route = await import("../../app/api/vault/pre-vault-state/route");
    const request = new NextRequest(
      "http://localhost:3000/api/vault/pre-vault-state",
      {
        method: "POST",
        body: JSON.stringify({
          userId: "test-user",
          onboardingCallbackAttemptId: "attempt-1",
          expectedOnboardingJourneyUpdatedAt: 123,
          expectedOnboardingCallbackAttemptId: "attempt-0",
        }),
      },
    );
    const response = await route.POST(request);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      detail: {
        error: "Setup changed in another session.",
        code: "STALE_ONBOARDING_JOURNEY",
      },
    });
  });
});
