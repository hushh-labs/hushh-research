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

function stubFetch(payload: unknown = { joined_count: 0 }) {
  return vi.spyOn(ApiService, "apiFetch").mockImplementation(async () =>
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
  it("estimates challenge transit without counting server processing twice", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(5000);
    stubFetch({ active: true, server_processing_ms: 3000, server_now: "2026-10-16T10:00:00Z" });
    const result = await ReferralService.getChallenge({ idToken: "owner" });
    expect(result.received_at_monotonic).toBe(5000);
    expect(result.estimated_transit_ms).toBe(500);
    expect(result.server_now).toBe("2026-10-16T10:00:00Z");
    now.mockRestore();
  });
  it("rejects a stale server contract instead of guessing joined referrals or Coins", async () => {
    const spy = stubFetch({qualified_count:0,in_progress_count:2});
    await expect(ReferralService.getSummary({idToken:"owner"})).rejects.toThrow("Joined referral totals");
    spy.mockRestore();
    stubFetch({points:50,coins:0});
    await expect(ReferralService.getPoints({idToken:"owner"})).rejects.toThrow("Lifetime Coins");
  });
  it("rejects inherited circles and sends an explicit dashboard visit signal", async () => {
    const spy=stubFetch({circle_id:"genealogy",rank:7,teams:[{rank:7}]});
    await expect(ReferralService.getCircleSelection({idToken:"owner"})).rejects.toThrow("membership is unavailable");
    await expect(ReferralService.getCircleLeaderboard({idToken:"owner"})).rejects.toThrow("standings are unavailable");
    await ReferralService.recordAppOpen({idToken:"owner"});
    const [,init]=spy.mock.calls.at(-1)!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({surface:"referral_dashboard"});
  });
  it("revokes the presented referral link with authenticated owner authority", async () => {
    const payload = { slug: "new-link", link_open_count: 0, qualified_count: 3 };
    const spy = stubFetch(payload);
    await expect(ReferralService.rotateShareLink({ idToken: "owner-token", slug: "old-link" })).resolves.toEqual(payload);
    const [path, init] = spy.mock.calls[0];
    expect(path).toBe("/api/one/referrals/rotate");
    expect(init?.method).toBe("POST");
    expect(headerValue(init, "Authorization")).toBe("Bearer owner-token");
    expect(JSON.parse(String(init?.body))).toEqual({ slug: "old-link" });
  });
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
      joined_count: 5,
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
