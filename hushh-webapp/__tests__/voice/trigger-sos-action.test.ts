import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";

/**
 * Sending an SOS alert over voice.
 *
 * The highest-consequence action on this surface: a misheard "yes" here
 * dispatches a real emergency alert, with a location share and an email
 * fallback, to real people. It gets the strictest treatment on Location --
 * the same explicit, tappable confirmation card as removing an emergency
 * contact, never a spoken confirmation alone.
 */
describe("location.trigger_sos", () => {
  const TRIGGER = "location.trigger_sos";

  it("runs a local handler with an optional free-text note slot", () => {
    const action = getKaiActionById(TRIGGER);
    expect(action).toBeDefined();
    expect(action?.execution_target.status).toBe("wired");
    expect(action?.execution_target.path).toBe("local_handler");
    expect(action?.execution_target.target).toBe(TRIGGER);
    expect(Object.keys(action?.goal?.slot_schema ?? {})).toEqual(["note"]);
    const noteInput = action?.goal?.required_inputs?.find(
      (input) => input.slot === "note",
    );
    expect(noteInput?.required).toBe(false);
  });

  it("is allow_direct and high risk, so the handler's own tap-only card is the sole gate", () => {
    // Not confirm_required: that generic gate accepts a spoken yes (unless
    // the person opted into hard-tap confirmation everywhere), and would
    // have settled here before the handler's own confirmed check ever ran --
    // an extra, redundant spoken step ahead of the tap this action must
    // always require. allow_direct means the handler's own VOICE_CONFIRM_DATA_KEY
    // card, which only a tap can settle, is the only confirmation that exists.
    const action = getKaiActionById(TRIGGER);
    expect(action?.execution_policy).toBe("allow_direct");
    expect(action?.risk_level).toBe("high");
  });

  it("carries enough words to explain the consequence on a confirm card", () => {
    // The voice confirm card reads `meaning` straight from the contract, so
    // an empty or token string would remove someone from an emergency alert
    // flow while looking identical to a real warning.
    const action = getKaiActionById(TRIGGER);
    expect((action?.meaning || "").length).toBeGreaterThan(40);
  });

  it("is escortable to Location, same as stopping an SOS", () => {
    // Unlike a share (which depends on an on-screen selection), sending an
    // SOS has no such precondition -- it should be reachable by voice from
    // wherever the person is, exactly like `location.stop_sos` already is.
    const journey = resolveNavigationJourney(TRIGGER);
    expect(journey?.destinationRoute).toBe("/one/location");
    expect(journey?.destinationScreen).toBe("one_location");
  });

  it("is mounted-only, never reachable by pushing a URL directly", () => {
    expect(getKaiActionById(TRIGGER)?.reachability.routes).toEqual([
      "/one/location",
    ]);
    expect(getKaiActionById(TRIGGER)?.reachability.screens).toEqual([
      "one_location",
    ]);
  });
});
