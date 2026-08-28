import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

/**
 * Checking out of a nearby check-in over voice (#6110).
 *
 * checkoutNearby() takes no place id -- there is only ever one active
 * check-in to end, so unlike confirm_nearby_check_in this action needs no
 * slot resolution at all. Its handler (nearby-check-in-sheet.tsx) adds the
 * "must actually be checked in" guard itself, since the click-driven Check
 * out button only ever renders when that's already true.
 */
describe("location.checkout_nearby", () => {
  const CHECKOUT = "location.checkout_nearby";

  it("runs a local handler with no slots to resolve", () => {
    const action = getKaiActionById(CHECKOUT);
    expect(action).toBeDefined();
    expect(action?.execution_target.status).toBe("wired");
    expect(action?.execution_target.path).toBe("local_handler");
    expect(action?.execution_target.target).toBe(CHECKOUT);
    expect(Object.keys(action?.goal?.slot_schema ?? {})).toEqual([]);
  });

  it("is low risk and allow_direct -- ending your own presence needs no confirmation", () => {
    const action = getKaiActionById(CHECKOUT);
    expect(action?.execution_policy).toBe("allow_direct");
    expect(action?.risk_level).toBe("low");
  });

  it("is reachable from Location's hub, map, and check-in screens", () => {
    expect(getKaiActionById(CHECKOUT)?.reachability.screens).toEqual(
      expect.arrayContaining([
        "one_location",
        "one_location_map",
        "one_location_check_in",
      ]),
    );
  });
});
