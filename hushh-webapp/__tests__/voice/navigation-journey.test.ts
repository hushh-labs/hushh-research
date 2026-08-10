import { describe, expect, it } from "vitest";

import { getKaiActionById, listKaiActions } from "@/lib/voice/kai-action-gateway";
import {
  firstMissingRequiredSlot,
  resolveJourneyPlan,
  resolveJourneyPlanForGoal,
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
    // from the backend's, one side offers a journey the other refuses -- so
    // this list must be changed together with the relay's
    // `_navigation_journey_definition`, and the same set is asserted there.
    //
    // The setup entries appeared once the route resolver stopped requiring a
    // `route.` name prefix. Nothing named `route.*` opens /one/setup/location;
    // `setup.open_location` does, and it navigates exactly the same way. While
    // the prefix was the test, every setup screen looked unreachable and every
    // action on one looked like a dead end.
    const journeys = listKaiActions()
      .map((action) => action.action_id)
      .filter((actionId) => resolveNavigationJourney(actionId) !== null)
      .sort();

    // Location's two acting actions joined the set when they were authored
    // with a settlement_target. They are the first journeys whose destination
    // action changes device state rather than opening a preview, and they are
    // deliberately the only two Location has: `location.share_selected` is
    // left out, because escorting a share would mean arriving at the composer
    // and firing it at whoever was still selected in it.
    expect(journeys).toEqual([
      "analysis.start",
      "location.pause_updates",
      "location.resume_updates",
      // Escorted because selecting someone sends nothing. Asked from another
      // screen it was simply unavailable, which broke "share my location with
      // Sarah" from anywhere but Location. `location.share_selected` is still
      // deliberately absent: arriving and FIRING is the thing that must not
      // happen unattended.
      "location.select_share_recipient",
      "setup.finish_connected_systems",
      "setup.finish_connections",
      "setup.finish_email",
      "setup.finish_finance",
      "setup.finish_location",
      "setup.finish_ria",
      "setup.skip_connected_systems",
      "setup.skip_email",
      "setup.skip_finance",
      "setup.skip_location",
      "setup.skip_ria",
    ]);
  });

  it("never turns a route action into a journey to itself", () => {
    expect(resolveNavigationJourney("route.kai_analysis")).toBeNull();
  });

  it("never turns a route-executing action into a journey to itself", () => {
    // `location.open_now` navigates to /one/location, which `route.one_location`
    // also opens -- so the naive lookup paired them into a journey that walks
    // to the destination and then runs the action that walks there. The name
    // prefix is not what disqualifies an action; executing by navigation is.
    const action = getKaiActionById("location.open_now");
    expect(action?.execution_target).toMatchObject({
      path: "route",
      target: "/one/location",
    });
    expect(resolveNavigationJourney("location.open_now")).toBeNull();
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

/**
 * Batch approval: a journey's steps are all known before it starts, so the
 * person approves a named list once instead of tapping through it step by
 * step. What the approval may cover is the part that has to stay honest.
 */
describe("journey approval plans", () => {
  it("enumerates every step before anything runs", () => {
    const plan = resolveJourneyPlan("analysis.start");

    expect(plan).toBeTruthy();
    expect(plan!.goalId).toBe("goal.analysis.start_debate");
    expect(plan!.steps.map((step) => step.actionId)).toEqual([
      "route.kai_analysis",
      "analysis.start",
    ]);
    // Shown as labels, because a list nobody can read is worse security with
    // better ergonomics.
    expect(plan!.steps.every((step) => step.label.length > 0)).toBe(true);
  });

  it("covers only the steps that can honestly be approved in advance", () => {
    const plan = resolveJourneyPlan("analysis.start");

    expect(plan!.batchableActionIds).toEqual([
      "route.kai_analysis",
      "analysis.start",
    ]);
  });

  it("never pre-approves an action that needs its own confirmation", () => {
    // confirm_required exists to make someone look at that action, and
    // trusted_activation_required needs a real gesture at the moment it runs.
    // Neither can be satisfied by a promise made earlier.
    const risky = listKaiActions().filter(
      (action) =>
        action.execution_policy !== "allow_direct" ||
        action.activation_policy === "trusted_activation_required",
    );
    expect(risky.length).toBeGreaterThan(0);

    const preApproved = new Set(
      listKaiActions()
        .flatMap((action) => resolveJourneyPlan(action.action_id)?.batchableActionIds ?? []),
    );

    risky.forEach((action) => {
      expect(preApproved.has(action.action_id)).toBe(false);
    });
  });

  it("finds the plan from the goal, not from the step it is currently on", () => {
    // The relay's FIRST directive for a journey is its navigation step, so it
    // arrives as goal.analysis.start_debate carrying route.kai_analysis. A
    // route action is never a journey in its own right, so resolving by that
    // action id found nothing and the card showed a single step instead of
    // the plan -- the batch approval silently degraded to the old behaviour.
    expect(resolveJourneyPlan("route.kai_analysis")).toBeNull();

    const plan = resolveJourneyPlanForGoal("goal.analysis.start_debate");
    expect(plan).toBeTruthy();
    expect(plan!.steps.map((step) => step.actionId)).toEqual([
      "route.kai_analysis",
      "analysis.start",
    ]);
  });

  it("has no plan for an unknown goal", () => {
    expect(resolveJourneyPlanForGoal("goal.does.not.exist")).toBeNull();
    expect(resolveJourneyPlanForGoal("")).toBeNull();
  });

  it("has no plan for an action that is not a journey", () => {
    expect(resolveJourneyPlan("route.kai_analysis")).toBeNull();
    expect(resolveJourneyPlan("analysis.confirm_preview")).toBeNull();
  });
});
