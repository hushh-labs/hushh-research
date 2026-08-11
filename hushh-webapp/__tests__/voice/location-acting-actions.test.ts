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

describe("saying a person's name", () => {
  const SELECT = "location.select_share_recipient";

  it("selects someone rather than sending to them", () => {
    // The whole reason naming a person is safe here. Selecting is visible and
    // reversible: a misheard name becomes a wrong face on screen, in front of
    // someone who can see it, instead of a live location already delivered.
    // The send stays a separate, confirmed action.
    expect(getKaiActionById(SELECT)?.risk_level).toBe("low");
    expect(getKaiActionById(SELECT)?.execution_policy).toBe("allow_direct");
    expect(getKaiActionById(SHARE)?.execution_policy).toBe("confirm_required");
  });

  it("takes the spoken name and nothing that identifies an account", () => {
    // The slot carries what the person said out loud, which the model already
    // heard. It must never carry a user id: that would mean the model had been
    // given a contact list to resolve names against, and the live-context
    // boundary strips `selected_entity` / `primary_entity` server-side
    // precisely because surfaces fill them with real names and addresses.
    // Matching happens in the browser, against the list it already holds.
    const slots = Object.keys(
      getKaiActionById(SELECT)?.goal?.slot_schema || {},
    );
    expect(slots).toEqual(["person"]);
    expect(slots.join(" ")).not.toMatch(/user_?id|account|email|phone|key/i);
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

  it("walks someone to Location before pausing or resuming", () => {
    // "Hide my location" is worth nothing if the answer is "open Location
    // first". Both carry a settlement_target, so One navigates there and then
    // performs the action as one plan the person approved once -- rather than
    // reporting the surface as unreachable from wherever they happen to be.
    [PAUSE, RESUME].forEach((actionId) => {
      const journey = resolveNavigationJourney(actionId);
      expect(journey?.destinationRoute).toBe("/one/location");
      expect(journey?.destinationScreen).toBe("one_location");
      // Resolved from the contract, never named in code, and preferring the
      // `route.*` escort over `location.open_now`: both open /one/location,
      // but only `route.one_location` is in the browser's global-navigation
      // set, so it is the one guaranteed to be offered from any screen.
      expect(journey?.navigationActionId).toBe("route.one_location");
    });
  });

  it("escorts the pick to the composer, not to Location's front door", () => {
    // Asked from anywhere but Location this was `action_unavailable`, so
    // "share my location with Sarah" only worked if you were already
    // standing on the right screen. Selecting is safe to escort: it ticks a
    // name on a composer and nothing leaves the device.
    //
    // The destination has to be the composer itself. Escorting to
    // /one/location landed on the surface's front door, where the recipient
    // search box is not mounted -- so the journey arrived, the handler had
    // nothing to type into, and the match never happened. Observed live: One
    // opened Location home and then talked about a recipient it had never
    // actually resolved.
    const journey = resolveNavigationJourney("location.select_share_recipient");
    expect(journey?.destinationScreen).toBe("one_location");
    expect(journey?.destinationRoute).toBe("/one/location?action=share");
    // Resolved from the contract by matching that route, never named in code.
    expect(journey?.navigationActionId).toBe("location.open_share");
  });

  it("refuses to escort a share the same way", () => {
    // The identical treatment would mean One walking to Location and firing
    // the composer it found on arrival, at whoever happened to still be
    // selected in it. A share must begin where the person can already see who
    // it is going to, so this one deliberately has no settlement_target.
    expect(resolveNavigationJourney(SHARE)).toBeNull();
  });
});
