import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";

/**
 * Location's first actions that DO something.
 *
 * Everything else on this surface opens a screen, which is why none of it
 * needed guarding: the worst a misheard sentence could do was show you the
 * wrong tab. These three change real state -- one of them tells other people
 * where you are -- so the properties below are the ones that keep a spoken
 * sentence from being able to do something the person did not ask for.
 */

const PAUSE = "location.pause_updates";
const RESUME = "location.resume_updates";
const SHARE = "location.share_selected";

describe("what a spoken Location action is allowed to do", () => {
  it("lets pausing run directly and makes resuming ask first", () => {
    // The asymmetry is the entire safety argument for pausing being direct.
    // Turning visibility OFF can only ever reduce what others can see, and
    // someone saying "hide my location" is in no position to be asked twice.
    // Turning it back ON makes them visible again to every active grant, so
    // it has to be looked at. If these two ever end up with the same policy,
    // one of them is wrong.
    expect(getKaiActionById(PAUSE)?.execution_policy).toBe("allow_direct");
    expect(getKaiActionById(RESUME)?.execution_policy).toBe("confirm_required");
  });

  it("never lets a share run without the person seeing it", () => {
    // Sharing a live location is the most consequential thing this surface
    // can do. There is no argument for allow_direct here at any point.
    expect(getKaiActionById(SHARE)?.execution_policy).toBe("confirm_required");
    expect(getKaiActionById(SHARE)?.risk_level).toBe("high");
  });

  it("gives the share a duration to say and no way to name a recipient", () => {
    const action = getKaiActionById(SHARE);
    const slots = Object.keys(action?.goal?.slot_schema || {});

    // Duration is the only thing voice supplies. WHO the share goes to comes
    // from what the person selected with their own hands in the composer.
    // A recipient slot here -- under any name -- would mean a misheard
    // sentence could send someone's live location to the wrong person, which
    // is exactly the failure this design exists to make impossible.
    expect(slots).toEqual(["duration_hours"]);
    expect(slots.join(" ")).not.toMatch(/recipient|person|contact|name|who/i);
  });

  it("offers only durations the composer itself has buttons for", () => {
    // Bounded so a spoken number cannot become an arbitrary grant length.
    const input = getKaiActionById(SHARE)?.goal?.required_inputs?.find(
      (spec) => spec.slot === "duration_hours",
    );
    expect(input?.options).toEqual(["0.25", "0.5", "1", "4", "24"]);
    // Not required: saying "share with them" keeps whatever the composer
    // already shows rather than blocking on a number the person never
    // intended to give.
    expect(input?.required).toBe(false);
  });
});

describe("how these actions can be reached", () => {
  it("keeps all three mounted-only rather than reachable by navigation", () => {
    // A `route` execution path would mean One could fire these by pushing a
    // URL from anywhere. Running them only while their screen is mounted is
    // what keeps the state they act on -- the selected recipients, the live
    // toggle -- real and in front of the person at the moment it happens.
    [PAUSE, RESUME, SHARE].forEach((actionId) => {
      const target = getKaiActionById(actionId)?.execution_target;
      expect(target?.status).toBe("wired");
      expect(target?.path).toBe("local_handler");
    });
  });

  it("does not turn any of them into a navigate-then-run journey", () => {
    // A journey navigates somewhere and then runs the action on arrival. For
    // a share that would mean One walking to Location and firing the composer
    // it found there, whatever was already selected in it. These have no
    // settlement_target for exactly that reason; this asserts the contract
    // has not quietly grown one.
    [PAUSE, RESUME, SHARE].forEach((actionId) => {
      expect(resolveNavigationJourney(actionId)).toBeNull();
    });
  });
});
