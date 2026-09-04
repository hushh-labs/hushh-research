import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { ReferralService } from "@/lib/services/referral-service";
import { ApiService } from "@/lib/services/api-service";
import {
  clearPendingAttribution,
  readPendingAttribution,
  rememberPendingAttribution,
} from "@/lib/referral/pending-attribution";

/**
 * Opening a referral link, and carrying the result through sign-in.
 *
 * Two properties matter more than the happy path:
 *
 *  1. `resolve` must be unauthenticated. There is no session when a referral
 *     link is opened -- that is the entire reason the attribution is recorded
 *     server-side before sign-in. Sending a bearer token here would mean the
 *     link only works for people who are already members.
 *  2. Only the opaque id is ever stored. Keeping the slug client-side would
 *     mean trusting a value the client can edit at bind time.
 */

function stubFetch(payload: unknown, status = 200) {
  return vi.spyOn(ApiService, "apiFetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  return new Headers(headers as HeadersInit).get(name);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ReferralService.resolve", () => {
  it("is unauthenticated, because the visitor has no session yet", async () => {
    const spy = stubFetch({ status: "created", attribution_id: "att-1" });
    await ReferralService.resolve("ankit-g6z9", "/r/ankit-g6z9");

    const [path, init] = spy.mock.calls[0];
    expect(path).toBe("/api/one/referrals/resolve");
    expect(headerValue(init, "Authorization")).toBeNull();
  });

  it("sends the slug and the landing route it was opened from", async () => {
    const spy = stubFetch({ status: "created", attribution_id: "att-1" });
    await ReferralService.resolve("ankit-g6z9", "/r/ankit-g6z9");

    const body = JSON.parse(String(spy.mock.calls[0][1]?.body ?? "{}"));
    expect(body).toEqual({ slug: "ankit-g6z9", landing_route: "/r/ankit-g6z9" });
  });

  it("passes an unavailable slug through as a state, not an error", async () => {
    // An unknown, disabled or retired slug all answer the same way, and none of
    // them should look like a broken page to the person who tapped the link.
    stubFetch({ status: "unavailable" });
    await expect(ReferralService.resolve("nope-0000")).resolves.toEqual({
      status: "unavailable",
    });
  });
});

describe("ReferralService.bind", () => {
  it("carries the ID token, because binding is about the caller's own account", async () => {
    const spy = stubFetch({ status: "bound" });
    await ReferralService.bind({ idToken: "id-token-abc", attributionId: "att-1" });

    const [path, init] = spy.mock.calls[0];
    expect(path).toBe("/api/one/referrals/bind");
    expect(headerValue(init, "Authorization")).toBe("Bearer id-token-abc");
    expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
      attribution_id: "att-1",
    });
  });
});

describe("the pending attribution handle", () => {
  it("round-trips the opaque id and nothing else", () => {
    rememberPendingAttribution("att-abc-123");
    expect(readPendingAttribution()).toBe("att-abc-123");

    // Never the slug, never the referrer: the whole stored payload is the id.
    const everythingStored = JSON.stringify(window.localStorage);
    expect(everythingStored).toContain("att-abc-123");
    expect(everythingStored).not.toContain("ankit-g6z9");
  });

  it("is cleared once redeemed, so it can never be redeemed twice", () => {
    rememberPendingAttribution("att-abc-123");
    clearPendingAttribution();
    expect(readPendingAttribution()).toBeNull();
  });

  it("refuses to store an empty handle", () => {
    expect(rememberPendingAttribution("")).toBe(false);
    expect(rememberPendingAttribution("   ")).toBe(false);
    expect(readPendingAttribution()).toBeNull();
  });

  it("survives storage being unavailable rather than throwing", () => {
    // Private mode, a full quota, or a browser configured to block site data.
    // Losing the handle costs the referral; throwing would cost the sign-in.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });

    expect(rememberPendingAttribution("att-1")).toBe(false);
    expect(readPendingAttribution()).toBeNull();
    expect(() => clearPendingAttribution()).not.toThrow();

    setItem.mockRestore();
    getItem.mockRestore();
  });
});
