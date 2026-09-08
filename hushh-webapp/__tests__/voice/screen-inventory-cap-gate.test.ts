/**
 * A screen that outgrows the context cap must say how it wants to be ranked.
 *
 * When a surface declares more cap-competing actions than
 * ACTION_ID_SCREEN_SEGMENT_CAP, the excess is dropped before the model ever
 * sees it, and a dropped local handler comes back from the relay as
 * `action_unavailable` -- indistinguishable from a broken feature. Location
 * shipped for months in exactly that state: 18 of its 52 actions invisible,
 * every circle verb among them.
 *
 * Raising the cap bought headroom, not immunity. This gate fails the build the
 * next time a surface crosses the line without declaring, through
 * SUBVIEW_ACTION_BOOST, which handlers matter on which subview. It is a
 * deliberately cheap structural check -- it asserts the declaration exists,
 * not that the ranking is good.
 */

import { describe, expect, it } from "vitest";

import { listKaiActions } from "@/lib/voice/kai-action-gateway";
import {
  ACTION_ID_SCREEN_SEGMENT_CAP,
  SUBVIEW_ACTION_BOOST,
} from "@/lib/voice/screen-context-builder";

/** Mirrors prioritizeAvailableActionIds: route actions never take a slot. */
function competesForASlot(action: {
  execution_target: { status: string; path?: string };
}): boolean {
  return (
    action.execution_target.status === "wired" &&
    action.execution_target.path !== "route"
  );
}

describe("screen inventory cap gate", () => {
  const byScreen = new Map<string, string[]>();
  for (const action of listKaiActions()) {
    if (!competesForASlot(action)) continue;
    for (const screen of action.reachability.screens) {
      byScreen.set(screen, [...(byScreen.get(screen) ?? []), action.action_id]);
    }
  }

  it("has a non-empty inventory to check", () => {
    // Without this the whole file passes vacuously if the gateway fails to
    // load -- the failure mode that made the original bug invisible.
    expect(byScreen.size).toBeGreaterThan(5);
  });

  it("requires boost coverage from any screen that outgrows the cap", () => {
    const uncovered: string[] = [];
    for (const [screen, actionIds] of byScreen) {
      if (actionIds.length <= ACTION_ID_SCREEN_SEGMENT_CAP) continue;
      const hasBoost = Object.keys(SUBVIEW_ACTION_BOOST).some(
        (key) => key.split(":")[0] === screen,
      );
      if (!hasBoost) uncovered.push(`${screen} (${actionIds.length} actions)`);
    }
    expect(
      uncovered,
      "These screens declare more cap-competing actions than the context can " +
        "carry and do not declare any SUBVIEW_ACTION_BOOST entry, so which " +
        "actions survive is decided by declaration order. Add boost entries " +
        "naming the handlers that matter per subview: " +
        uncovered.join(", "),
    ).toEqual([]);
  });

  it("reports current headroom so the next crossing is not a surprise", () => {
    const worst = [...byScreen.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )[0];
    expect(worst).toBeDefined();
    // Not an assertion about the number itself -- only that the gate above is
    // measuring something real and the cap has not silently been outgrown.
    expect(worst[1].length).toBeLessThanOrEqual(ACTION_ID_SCREEN_SEGMENT_CAP);
  });
});
