import { describe, expect, it } from "vitest";

import { getKaiActionById, listKaiActions } from "@/lib/voice/kai-action-gateway";
import {
  firstMissingRequiredSlot,
  resolveJourneySlots,
  resolveNavigationJourney,
} from "@/lib/voice/navigation-journey";

/**
 * The browser half of the navigate-then-execute journey. It used to be a
 * literal `analysis.start` in four places, so the app could walk exactly one
 * cross-screen journey however many the contracts declared.
 */
describe("navigation journeys", () => {
  it("resolves the analysis journey entirely from its contract", () => {
    expect(resolveNavigationJourney("analysis.start")).toEqual({
      goalId: "goal.analysis.start_debate",
      destinationRoute: "/one/kai?tab=analysis",
      destinationScreen: "kai_analysis",
      navigationActionId: "route.kai_analysis",
      label: "Open stock analysis preview",
    });
  });

  it("stays in lockstep with the relay's own predicate", () => {
    // Both halves read the same generated contract. If this set ever differs
    // from the backend's, one side will offer a journey the other refuses.
    const journeys = listKaiActions()
      .map((action) => action.action_id)
      .filter((actionId) => resolveNavigationJourney(actionId) !== null)
      .sort();

    expect(journeys).toEqual(["analysis.start"]);
  });

  it("never turns a route action into a journey to itself", () => {
    expect(resolveNavigationJourney("route.kai_analysis")).toBeNull();
  });

  it("refuses a destination with no wired navigation action", () => {
    // setup.open_email authors the shape, but no route.* action opens
    // /one/setup/email -- One would have no generated way to walk it.
    expect(resolveNavigationJourney("setup.open_email")).toBeNull();
  });

  it("carries only contract-declared slots, normalized by the named resolver", () => {
    const action = getKaiActionById("analysis.start");
    expect(action).toBeTruthy();

    expect(
      resolveJourneySlots(action!, { symbol: " nvda ", smuggled: "ignore me" }),
    ).toEqual({ symbol: "NVDA", pickSource: "default" });
  });

  it("prompts with the contract's own wording for a missing required slot", () => {
    const action = getKaiActionById("analysis.start");

    expect(firstMissingRequiredSlot(action!, {})).toEqual({
      slot: "symbol",
      prompt: "Which stock should I analyze?",
    });
    // pickSource declares a default, so it is never treated as missing.
    expect(firstMissingRequiredSlot(action!, { symbol: "NVDA" })).toBeNull();
  });
});
