import { describe, expect, it } from "vitest";

import { LOCATION_VOICE_ACTIONS } from "@/app/one/location/page";
import { listKaiActionsForSurface } from "@/lib/voice/kai-action-gateway";

/**
 * LOCATION_VOICE_ACTIONS used to be a hand-typed 23-entry list that drifted
 * out of sync with the real contract three times (#6080, #6106-#6112). It is
 * now derived from listKaiActionsForSurface at module scope, so this test
 * recomputes the expected set from the same gateway data the array itself
 * reads from -- if a future edit narrows or widens the filter without
 * meaning to, this fails instead of silently drifting again.
 */
describe("LOCATION_VOICE_ACTIONS stays in sync with the generated gateway", () => {
  const CHECKOUT_NEARBY = "location.checkout_nearby";

  const expectedIds = new Set(
    listKaiActionsForSurface({ screen: "one_location" })
      .filter(
        (action) =>
          action.execution_target.status === "wired" &&
          (action.execution_target.path === "local_handler" ||
            action.execution_target.path === "route") &&
          action.execution_policy !== "manual_only" &&
          action.action_id !== CHECKOUT_NEARBY,
      )
      .map((action) => action.action_id),
  );

  it("publishes exactly the wired local_handler/route actions for one_location", () => {
    const publishedIds = new Set(LOCATION_VOICE_ACTIONS.map((action) => action.actionId));
    expect(publishedIds).toEqual(expectedIds);
  });

  it("is not trivially small -- guards against the filter silently matching nothing", () => {
    // Regression guard: a typo'd screen name or an over-narrow filter would
    // make expectedIds (and therefore this equality check) pass vacuously
    // against an empty published array. 30+ is the count found when this
    // derivation was written; any future drop below it deserves a look even
    // though the equality check above would already catch a mismatch.
    expect(LOCATION_VOICE_ACTIONS.length).toBeGreaterThan(25);
  });

  it("deliberately excludes location.checkout_nearby -- it has no voice handler yet", () => {
    // Wired in the contract, but its UI calls OneLocationService.checkoutNearby()
    // directly with no useLocalOnboardingActionHandler registration anywhere.
    // Publishing it would offer something guaranteed to fail. See the
    // exclusion comment above LOCATION_VOICE_ACTIONS_EXCLUDE_IDS in page.tsx.
    expect(LOCATION_VOICE_ACTIONS.some((action) => action.actionId === CHECKOUT_NEARBY)).toBe(
      false,
    );
    // And confirm it's excluded because it's really wired-but-handlerless,
    // not because it fell out of the surface's reachability entirely --
    // otherwise this test would pass for the wrong reason.
    const contractEntry = listKaiActionsForSurface({ screen: "one_location" }).find(
      (action) => action.action_id === CHECKOUT_NEARBY,
    );
    expect(contractEntry?.execution_target.status).toBe("wired");
  });

  it("carries a short, non-empty purpose derived from the contract's meaning", () => {
    for (const action of LOCATION_VOICE_ACTIONS) {
      expect(action.purpose.length, `${action.actionId} has an empty purpose`).toBeGreaterThan(0);
    }
  });

  it("includes actions that were unreachable before this fix (#6106-#6112)", () => {
    // These were entirely absent from the old hand-typed array -- not merely
    // losing a SUBVIEW_ACTION_BOOST ranking tiebreak, as originally assumed.
    const REGRESSION_IDS = [
      "location.approve_request",
      "location.decline_request",
      "location.trigger_sos",
      "location.stop_sos",
      "location.create_circle",
      "location.accept_circle_invite",
      "location.decline_circle_invite",
    ];
    const publishedIds = new Set(LOCATION_VOICE_ACTIONS.map((action) => action.actionId));
    for (const id of REGRESSION_IDS) {
      expect(publishedIds.has(id), `${id} still missing from LOCATION_VOICE_ACTIONS`).toBe(true);
    }
  });
});
