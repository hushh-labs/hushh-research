import { describe, expect, it } from "vitest";
import { ONE_LOCATION_JOURNEY_ACTIONS } from "@/lib/observability/events";
import { validateAndSanitizeEvent } from "@/lib/observability/schema";

describe("governed observability string values", () => {
  it.each(ONE_LOCATION_JOURNEY_ACTIONS)(
    "preserves the governed One Location action %s",
    (action) => {
      const result = validateAndSanitizeEvent("one_location_journey_action", {
        env: "uat",
        platform: "web",
        event_category: "feature",
        app_version: "2.1.0",
        route_id: "one_location",
        action,
        result: "success",
        entry_surface: "location_hub",
        target_type: "person",
      });

      expect(result.ok).toBe(true);
      expect(result.droppedKeys).toEqual([]);
      expect(result.sanitized.action).toBe(action);
    },
  );

  it("still drops an undeclared opaque One Location action", () => {
    const result = validateAndSanitizeEvent("one_location_journey_action", {
      env: "uat",
      platform: "web",
      event_category: "feature",
      app_version: "2.1.0",
      route_id: "one_location",
      action: "opaque_runtime_action_4n6x8p2q7z",
      result: "success",
      entry_surface: "location_hub",
      target_type: "person",
    } as any);

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("action");
    expect(result.sanitized.action).toBeUndefined();
  });

});
