import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";

/**
 * Sending a check-in over voice.
 *
 * page.tsx cannot reach the check-in draft directly -- the recipient
 * selection, duration and message all live as local state inside the
 * CheckInFlow component. So unlike every other acting Location action, this
 * one takes no slots and does not resolve anything itself: it only works
 * while Check-In is already open, and it sends exactly the draft already on
 * screen. It must never carry a settlement_target, or One could "send the
 * check-in" from somewhere that never had a draft to send.
 */
describe("location.send_check_in", () => {
  const SEND = "location.send_check_in";

  it("runs a local handler with no slots to resolve", () => {
    const action = getKaiActionById(SEND);
    expect(action).toBeDefined();
    expect(action?.execution_target.status).toBe("wired");
    expect(action?.execution_target.path).toBe("local_handler");
    expect(action?.execution_target.target).toBe(SEND);
    expect(Object.keys(action?.goal?.slot_schema ?? {})).toEqual([]);
  });

  it("is confirm_required, matching every other action that shares a live location", () => {
    const action = getKaiActionById(SEND);
    expect(action?.execution_policy).toBe("confirm_required");
    expect(action?.risk_level).toBe("high");
  });

  it("has no navigation escort -- it must already be standing on Check-In", () => {
    // Escorting here would mean One could open Check-In and fire whatever
    // draft happened to be seeded, which is exactly the "walked to Location
    // and fired the composer at whoever was still selected" failure the
    // share action guards against the same way.
    expect(resolveNavigationJourney(SEND)).toBeNull();
  });

  it("is mounted-only, never reachable by pushing a URL", () => {
    expect(getKaiActionById(SEND)?.reachability.routes).toEqual([
      "/one/location",
    ]);
    expect(getKaiActionById(SEND)?.reachability.screens).toEqual([
      "one_location",
    ]);
  });

  it("shares no alias with the unrelated nearby check-in actions on the same screen", () => {
    // Two different features -- this one sends the private, encrypted
    // check-in draft already on screen; the nearby actions search public
    // places -- happen to share the words "check in" and both live on
    // /one/location. Both can be available at once (a private recipient
    // already selected AND a nearby place already resolved), so an identical
    // alias here is a real ambiguity, not one screen-scoping resolves away.
    // Caught once already: "confirm the check in" pointed at both this
    // action and location.confirm_nearby_check_in.
    const nearbyActionIds = [
      "location.nearby_check_in",
      "location.confirm_nearby_check_in",
      "location.checkout_nearby",
    ];
    const sendAliases = new Set(
      (getKaiActionById(SEND)?.aliases ?? []).map((a) => a.toLowerCase()),
    );
    for (const actionId of nearbyActionIds) {
      const aliases = getKaiActionById(actionId)?.aliases ?? [];
      for (const alias of aliases) {
        expect(sendAliases.has(alias.toLowerCase())).toBe(false);
      }
    }
  });
});
