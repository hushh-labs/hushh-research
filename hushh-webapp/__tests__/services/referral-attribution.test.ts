import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRedeemReferralAttribution } from "@/lib/referral/use-redeem-referral-attribution";
import { useDailyAppActivity } from "@/lib/referral/use-daily-app-activity";

const hookAuth = vi.hoisted(() => ({ user: { uid: "owner", getIdToken: vi.fn().mockResolvedValue("id-token") } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: hookAuth.user, loading: false }) }));

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

it("preserves a pending attribution on network failure and redeems it on reconnect", async () => {
  rememberPendingAttribution("pending-id");
  const bind = vi.spyOn(ReferralService, "bind").mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "bound" });
  let unmount = () => {};
  await act(async () => { ({ unmount } = renderHook(() => useRedeemReferralAttribution())); });
  expect(readPendingAttribution()).toBe("pending-id");
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(bind).toHaveBeenCalledTimes(2);
  expect(readPendingAttribution()).toBeNull();
  unmount();
});

it("records server attendance on resume even when the device calendar is behind", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  const record = vi.spyOn(ReferralService, "recordAppOpen").mockResolvedValue({
    activity_date: "2026-10-14", timezone: "Asia/Kolkata", server_now: "2026-10-14T12:00:00Z", next_day_at: "2026-10-14T18:30:00Z",
  });
  let unmount = () => {};
  try {
    await act(async () => { ({ unmount } = renderHook(() => useDailyAppActivity(hookAuth.user as Parameters<typeof useDailyAppActivity>[0], vi.fn()))); });
    expect(record).toHaveBeenCalledTimes(1);
    // The next server day arrives while the device still reports the old recorded day.
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(record).toHaveBeenCalledTimes(2);
  } finally { unmount(); vi.useRealTimers(); }
});

it("keeps invalid server day boundaries on the bounded retry interval", async () => {
  vi.useFakeTimers();
  const record=vi.spyOn(ReferralService,"recordAppOpen").mockResolvedValue({activity_date:"2026-10-14",timezone:"Asia/Kolkata",server_now:"invalid",next_day_at:"invalid"});
  const hook=renderHook(()=>useDailyAppActivity(hookAuth.user as Parameters<typeof useDailyAppActivity>[0],vi.fn()));
  try {
    await act(async()=>{});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    expect(record).toHaveBeenCalledTimes(1);
    await act(async()=>{await vi.advanceTimersByTimeAsync(59000);});
    expect(record).toHaveBeenCalledTimes(2);
  } finally {hook.unmount();vi.useRealTimers();}
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
