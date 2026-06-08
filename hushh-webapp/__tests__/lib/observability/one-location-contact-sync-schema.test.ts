import { describe, expect, it } from "vitest";

import { validateAndSanitizeEvent } from "@/lib/observability/schema";

describe("one location contact sync analytics schema", () => {
  it("accepts aggregate contact sync metadata without contact payloads", () => {
    const result = validateAndSanitizeEvent(
      "one_location_contact_signal_synced",
      {
        env: "uat",
        platform: "ios",
        event_category: "feature",
        app_version: "2.1.0",
        route_id: "one_location",
        result: "success",
        source_platform: "ios",
        contact_count_bucket: "11_50",
        matched_count: 3,
        invite_candidate_count: 21,
        phone_number: "+16505550101",
        contact_name: "Avery Stone",
        phone_last4: "0101",
      } as any,
    );

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("phone_number");
    expect(result.droppedKeys).toContain("contact_name");
    expect(result.droppedKeys).toContain("phone_last4");
    expect(result.sanitized.event_category).toBe("feature");
    expect(result.sanitized.route_id).toBe("one_location");
    expect(result.sanitized.contact_count_bucket).toBe("11_50");
    expect(result.sanitized.matched_count).toBe(3);
  });
});
