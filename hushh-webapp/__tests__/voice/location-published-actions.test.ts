import { describe, expect, it } from "vitest";

import { LOCATION_VOICE_ACTIONS } from "@/app/one/location/page";
import { listKaiActionsForSurface } from "@/lib/voice/kai-action-gateway";
import {
  LOCATION_VOICE_ACTIONS_EXCLUDE_IDS,
  deriveLocationVoiceActions,
} from "@/lib/voice/location-voice-actions";

// Mirrors PUBLISHABLE_EXECUTION_PATHS in location-voice-actions.ts.
// `control` is in the set: agent-action-runtime dispatches it through the
// same handler registry as `local_handler`, so a control action with a
// handler runs like a local one. Leaving it out silently dropped
// location.find_contacts from every Location screen.
const PUBLISHABLE_PATHS = new Set(["local_handler", "route", "control"]);

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
          PUBLISHABLE_PATHS.has(action.execution_target.path) &&
          action.execution_policy !== "manual_only" &&
          !LOCATION_VOICE_ACTIONS_EXCLUDE_IDS.has(action.action_id),
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

  it("includes location.checkout_nearby, which executes backend-direct", () => {
    // Was excluded on the mistaken reading that no local handler meant the
    // action was broken. It is in BACKEND_DIRECT_ACTION_IDS -- it mutates
    // server-side and never needed a frontend registration at all.
    expect(LOCATION_VOICE_ACTIONS_EXCLUDE_IDS.has(CHECKOUT_NEARBY)).toBe(false);
    expect(LOCATION_VOICE_ACTIONS.some((action) => action.actionId === CHECKOUT_NEARBY)).toBe(
      true,
    );
  });

  it("publishes control-path actions, not just local_handler and route", () => {
    // location.find_contacts is execution_target.path "control". It was wired,
    // given a handler, and made visible in the gateway -- and still never
    // offered on any Location screen, because the publish filter admitted only
    // two of the three runnable paths. The action existed, worked, and was
    // silently never suggested.
    const FIND_CONTACTS = "location.find_contacts";
    const contract = listKaiActionsForSurface({ screen: "one_location" }).find(
      (action) => action.action_id === FIND_CONTACTS,
    );
    expect(contract?.execution_target.status).toBe("wired");
    expect(contract?.execution_target.path).toBe("control");
    expect(LOCATION_VOICE_ACTIONS.some((action) => action.actionId === FIND_CONTACTS)).toBe(
      true,
    );
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

/**
 * Location's map and check-in routes (app/one/location/map/page.tsx,
 * app/one/location/check-in/page.tsx) are separate route files from the hub
 * (app/one/location/page.tsx) -- the only file that published voice metadata
 * for any Location screen until now. Navigating to either route left voice
 * with zero proactively-offered actions even though the handlers for
 * location.nearby_check_in / location.confirm_nearby_check_in
 * (nearby-check-in-sheet.tsx) are live there. These tests pin the exact
 * derived set for each screen against the real gateway data, the same way
 * the hub's own set is pinned above.
 */
describe("deriveLocationVoiceActions stays in sync for the map and check-in screens", () => {
  const CHECKOUT_NEARBY = "location.checkout_nearby";

  function expectedIdsFor(screen: string): Set<string> {
    return new Set(
      listKaiActionsForSurface({ screen })
        .filter(
          (action) =>
            action.execution_target.status === "wired" &&
            PUBLISHABLE_PATHS.has(action.execution_target.path) &&
            action.execution_policy !== "manual_only" &&
            !LOCATION_VOICE_ACTIONS_EXCLUDE_IDS.has(action.action_id),
        )
        .map((action) => action.action_id),
    );
  }

  it("one_location_map publishes exactly the wired local_handler/route actions for that screen", () => {
    const actions = deriveLocationVoiceActions("one_location_map");
    const publishedIds = new Set(actions.map((action) => action.actionId));
    expect(publishedIds).toEqual(expectedIdsFor("one_location_map"));
    // Pinned exact set, not just a diff against the gateway: catches a
    // gateway change that silently narrows this screen's reachability too.
    expect(publishedIds).toEqual(
      new Set([
        "location.open_check_in",
        "location.open_map",
        "location.nearby_check_in",
        "location.confirm_nearby_check_in",
        "location.checkout_nearby",
      ]),
    );
  });

  it("one_location_check_in publishes exactly the wired local_handler/route actions for that screen", () => {
    const actions = deriveLocationVoiceActions("one_location_check_in");
    const publishedIds = new Set(actions.map((action) => action.actionId));
    expect(publishedIds).toEqual(expectedIdsFor("one_location_check_in"));
    expect(publishedIds).toEqual(
      new Set([
        "location.nearby_check_in",
        "location.confirm_nearby_check_in",
        "location.checkout_nearby",
      ]),
    );
  });

  it("includes location.checkout_nearby on both screens now that it has a real handler", () => {
    for (const screen of ["one_location_map", "one_location_check_in"]) {
      const actions = deriveLocationVoiceActions(screen);
      expect(
        actions.some((action) => action.actionId === CHECKOUT_NEARBY),
        `${screen} should publish ${CHECKOUT_NEARBY}`,
      ).toBe(true);
    }
  });
});
