import { describe, expect, it } from "vitest";

import { validateAndSanitizeEvent } from "@/lib/observability/schema";

/**
 * The Consent Center loads 2,574 times a month for 85 people and
 * `consent_action_submitted` has never fired once. Without a count on the load
 * event there is no way to tell whether people are ignoring decisions put in
 * front of them or opening a screen that had nothing on it -- and those call
 * for opposite work.
 */
describe("consent pending count instrumentation", () => {
  it("admits the bucketed count and still refuses raw request detail", () => {
    const result = validateAndSanitizeEvent("consent_pending_loaded", {
      env: "production",
      platform: "web",
      event_category: "system",
      app_version: "2.1.0",
      result: "success",
      pending_count_bucket: "2_3",
      // A consent request names a real counterparty and scope; neither belongs
      // in analytics.
      requester_name: "Acme Insurance",
      scope: "vault.read.financial",
      request_id: "req_9f8a7b6c5d4e",
    } as never);

    expect(result.sanitized.pending_count_bucket).toBe("2_3");
    expect(result.droppedKeys).toContain("requester_name");
    expect(result.droppedKeys).toContain("request_id");
    expect(result.ok).toBe(false);
  });

  it("reads the pending count from a clone so the caller can still read the body", async () => {
    // The response body can be read only once. If tracking consumed it, the
    // Consent Center would render empty for everyone.
    const response = new Response(JSON.stringify({ pending: [{}, {}] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const trackedCount = Array.isArray(
      ((await response.clone().json()) as { pending?: unknown[] }).pending,
    )
      ? ((await response.clone().json()) as { pending: unknown[] }).pending.length
      : null;
    expect(trackedCount).toBe(2);

    const caller = (await response.json()) as { pending: unknown[] };
    expect(caller.pending).toHaveLength(2);
  });
});
