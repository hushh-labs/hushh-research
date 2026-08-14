import { describe, expect, it } from "vitest";

import {
  consentPendingCountBucket,
  readPendingConsentCount,
} from "@/lib/services/api-service";
import { validateAndSanitizeEvent } from "@/lib/observability/schema";

/**
 * The Consent Center loads 2,574 times a month for 85 people and
 * `consent_action_submitted` has never fired once. Without a count on the load
 * event there is no way to tell whether people are ignoring decisions put in
 * front of them or opening a screen that had nothing on it -- and those call
 * for opposite work.
 *
 * These exercise the real functions. An earlier version of this file
 * re-implemented the clone logic inline and asserted on its own expression,
 * which would have stayed green if the production code were deleted outright.
 */
describe("consentPendingCountBucket", () => {
  it("uses non-overlapping ranges", () => {
    // 10 must belong to exactly one label. An earlier cut put 10 in "4_10"
    // while naming the next bucket "10_plus", so any "10 or more" rollup either
    // double-counted or dropped the ten-request cohort.
    expect(consentPendingCountBucket(0)).toBe("0");
    expect(consentPendingCountBucket(3)).toBe("1_3");
    expect(consentPendingCountBucket(4)).toBe("4_10");
    expect(consentPendingCountBucket(10)).toBe("4_10");
    expect(consentPendingCountBucket(11)).toBe("11_plus");
  });

  it("never emits an exact non-zero count", () => {
    // "1" would state precisely that this person had one request waiting, which
    // is a per-user fact about their consent activity -- in the same payload
    // where the schema denylists request ids and requester names.
    expect(consentPendingCountBucket(1)).toBe("1_3");
    expect(consentPendingCountBucket(2)).toBe("1_3");
  });
});

describe("readPendingConsentCount", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("does not consume the body the caller is about to read", async () => {
    // A body can be read once. If tracking consumed it, the Consent Center
    // would render empty for everyone.
    const response = jsonResponse({ pending: [{}, {}] });

    expect(await readPendingConsentCount(response)).toBe(2);

    const caller = (await response.json()) as { pending: unknown[] };
    expect(caller.pending).toHaveLength(2);
  });

  it("reports the degraded fallback as unknown rather than as an empty inbox", async () => {
    // The API route serves `{ pending: [], degraded: true }` with HTTP 200 when
    // the backend is unreachable. Counting that as zero pending would make
    // every outage read as "people opened a screen with nothing on it" -- the
    // precise misreading this dimension exists to prevent.
    const degraded = jsonResponse({ pending: [], degraded: true });
    expect(await readPendingConsentCount(degraded)).toBeNull();

    const genuinelyEmpty = jsonResponse({ pending: [] });
    expect(await readPendingConsentCount(genuinelyEmpty)).toBe(0);
  });

  it("returns unknown for a failed or unreadable response", async () => {
    expect(await readPendingConsentCount(jsonResponse({}, 500))).toBeNull();
    expect(
      await readPendingConsentCount(
        new Response("not json", { status: 200 }),
      ),
    ).toBeNull();
    expect(await readPendingConsentCount(jsonResponse({ pending: "x" }))).toBeNull();
  });
});

describe("consent_pending_loaded payload", () => {
  it("admits the bucket and surface, and still refuses raw request detail", () => {
    const result = validateAndSanitizeEvent("consent_pending_loaded", {
      env: "production",
      platform: "web",
      event_category: "system",
      app_version: "2.1.0",
      result: "success",
      pending_count_bucket: "1_3",
      load_surface: "screen",
      // A consent request names a real counterparty and scope; neither belongs
      // in analytics.
      requester_name: "Acme Insurance",
      request_id: "req_9f8a7b6c5d4e",
    } as never);

    expect(result.sanitized.pending_count_bucket).toBe("1_3");
    expect(result.sanitized.load_surface).toBe("screen");
    expect(result.droppedKeys).toContain("requester_name");
    expect(result.droppedKeys).toContain("request_id");
    expect(result.ok).toBe(false);
  });
});
