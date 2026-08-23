import { describe, expect, it, vi, afterEach } from "vitest";

import { ReferralService } from "@/lib/services/referral-service";
import { ApiService } from "@/lib/services/api-service";

/**
 * The request itself, not the component that triggers it.
 *
 * This file exists because of a real defect. The panel's component test mocks
 * `ReferralService.getSummary` outright, so it stayed green while the shipped
 * service sent no Authorization header at all and every load on UAT answered
 * 401 -- rendered to the user as "Unable to load". A mocked collaborator cannot
 * test the collaborator.
 *
 * So this asserts one layer lower: what actually goes out on the wire.
 */

function stubFetch(payload: unknown = {}) {
  return vi.spyOn(ApiService, "apiFetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  return new Headers(headers as HeadersInit).get(name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReferralService.getSummary", () => {
  it("carries the caller's Firebase ID token as a bearer token", async () => {
    const spy = stubFetch();
    await ReferralService.getSummary({ idToken: "id-token-abc" });

    const [, init] = spy.mock.calls[0];
    expect(headerValue(init, "Authorization")).toBe("Bearer id-token-abc");
  });

  it("asks the referral summary endpoint, through the One proxy", async () => {
    const spy = stubFetch();
    await ReferralService.getSummary({ idToken: "t" });

    const [path, init] = spy.mock.calls[0];
    expect(path).toBe("/api/one/referrals/summary");
    expect(init?.method).toBe("GET");
  });

  it("returns the server's payload untouched", async () => {
    const payload = {
      slug: "ankit-7k4m",
      link: "https://uat.one.hushh.ai/r/ankit-7k4m",
      qualified_count: 3,
      in_progress_count: 2,
      under_review_count: 0,
      required_active_minutes: 15,
      new_users_only: true,
      referrals: [],
    };
    stubFetch(payload);

    // No client-side derivation, no defaulting, no recomputation: whatever the
    // server decided is what the screen is handed.
    await expect(ReferralService.getSummary({ idToken: "t" })).resolves.toEqual(
      payload,
    );
  });

  it("never puts the token anywhere but the Authorization header", async () => {
    const spy = stubFetch();
    await ReferralService.getSummary({ idToken: "secret-token" });

    const [path, init] = spy.mock.calls[0];
    expect(path).not.toContain("secret-token");
    expect(String(init?.body ?? "")).not.toContain("secret-token");
  });
});
