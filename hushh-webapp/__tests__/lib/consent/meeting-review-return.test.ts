import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearMeetingReviewOAuthReturn,
  markMeetingReviewOAuthReturn,
  meetingReviewReturnHref,
  readMeetingReviewOAuthReturn,
} from "@/lib/consent/meeting-review-return";

const KEY = "one_meeting_review_oauth_return_v1";

describe("meeting review OAuth return context", () => {
  afterEach(() => { window.localStorage.clear(); vi.useRealTimers(); });

  it("remembers one request for the owner who started it, and reads it without consuming it", () => {
    markMeetingReviewOAuthReturn("owner-a", "request_0123456789");
    expect(readMeetingReviewOAuthReturn("owner-a")).toEqual({ requestId: "request_0123456789" });
    expect(readMeetingReviewOAuthReturn("owner-a")).toEqual({ requestId: "request_0123456789" });
  });

  it("is invisible to another owner, to a signed-out reader and after clearing", () => {
    markMeetingReviewOAuthReturn("owner-a", "request_0123456789");
    expect(readMeetingReviewOAuthReturn("owner-b")).toBeNull();
    expect(readMeetingReviewOAuthReturn(null)).toBeNull();
    clearMeetingReviewOAuthReturn();
    expect(readMeetingReviewOAuthReturn("owner-a")).toBeNull();
  });

  it("expires so a stale context cannot steer a later authorization", () => {
    vi.useFakeTimers();
    markMeetingReviewOAuthReturn("owner-a", "request_0123456789");
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(readMeetingReviewOAuthReturn("owner-a")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(readMeetingReviewOAuthReturn("owner-a")).toBeNull();
  });

  it.each(["", "short", "has space in it", "../../etc/passwd", "x".repeat(129), "req?id=1&evil=2"])(
    "refuses to store a request id that is not an opaque id: %j",
    requestId => {
      markMeetingReviewOAuthReturn("owner-a", requestId);
      expect(window.localStorage.getItem(KEY)).toBeNull();
    },
  );

  it("never trusts tampered or malformed storage", () => {
    window.localStorage.setItem(KEY, "{broken");
    expect(readMeetingReviewOAuthReturn("owner-a")).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ ownerId: "owner-a", requestId: "https://evil.example/x", savedAt: Date.now() }));
    expect(readMeetingReviewOAuthReturn("owner-a")).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ ownerId: "owner-a", requestId: "request_0123456789", savedAt: Date.now() + 60_000 }));
    expect(readMeetingReviewOAuthReturn("owner-a")).toBeNull();
  });

  it("stores only owner, opaque id and time", () => {
    markMeetingReviewOAuthReturn("owner-a", "request_0123456789");
    expect(Object.keys(JSON.parse(window.localStorage.getItem(KEY)!)).sort()).toEqual(["ownerId", "requestId", "savedAt"]);
  });

  it("returns to the Feed-opened pending review for that exact request, with no private content", () => {
    const href = meetingReviewReturnHref("request_0123456789");
    const url = new URL(href, "https://one.example");
    expect(url.searchParams.get("requestId")).toBe("request_0123456789");
    expect(url.searchParams.get("from")).toBe("/one/feed");
    expect([...url.searchParams.keys()].every(key => ["tab", "requestId", "from"].includes(key))).toBe(true);
  });
});
