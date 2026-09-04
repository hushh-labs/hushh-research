import { describe, expect, it } from "vitest";

import { getKaiActionById, listKaiActions } from "@/lib/voice/kai-action-gateway";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";

/**
 * A bare or ambiguous emergency phrase ("save me", "sos", "help", "turn on
 * sos") -- resolved per the person's own stored default (open the SOS screen,
 * or go straight to trigger_sos's own confirm card) rather than the model
 * guessing between open_sos and trigger_sos.
 */
describe("location.sos_default", () => {
  const DEFAULT_ACTION = "location.sos_default";
  const OPEN = "location.open_sos";
  const TRIGGER = "location.trigger_sos";

  it("runs a local handler with no slots -- the branch is decided server-side, not spoken", () => {
    const action = getKaiActionById(DEFAULT_ACTION);
    expect(action).toBeDefined();
    expect(action?.execution_target.status).toBe("wired");
    expect(action?.execution_target.path).toBe("local_handler");
    expect(action?.execution_target.target).toBe(DEFAULT_ACTION);
    expect(action?.goal?.slot_schema ?? {}).toEqual({});
  });

  it("carries enough words that a reader can tell it defers to a stored preference", () => {
    const action = getKaiActionById(DEFAULT_ACTION);
    expect((action?.meaning || "").length).toBeGreaterThan(40);
    expect(action?.meaning ?? "").toMatch(/default/i);
  });

  it("is escortable to Location, same as open_sos and trigger_sos", () => {
    const journey = resolveNavigationJourney(DEFAULT_ACTION);
    expect(journey?.destinationRoute).toBe("/one/location");
    expect(journey?.destinationScreen).toBe("one_location");
  });

  it("shares no exact alias with open_sos or trigger_sos", () => {
    // The whole point of this action: a bare phrase like "sos" or "help" must
    // resolve to the default-respecting handler, not silently collide with
    // one of the two explicit actions it exists to sit between.
    const defaultAliases = new Set(
      (getKaiActionById(DEFAULT_ACTION)?.aliases ?? []).map((a) =>
        a.toLowerCase(),
      ),
    );
    const openAliases = new Set(
      (getKaiActionById(OPEN)?.aliases ?? []).map((a) => a.toLowerCase()),
    );
    const triggerAliases = new Set(
      (getKaiActionById(TRIGGER)?.aliases ?? []).map((a) => a.toLowerCase()),
    );
    for (const alias of defaultAliases) {
      expect(openAliases.has(alias)).toBe(false);
      expect(triggerAliases.has(alias)).toBe(false);
    }
  });

  it("open_sos and trigger_sos keep only explicit, unambiguous aliases", () => {
    // Regression: these two used to carry bare words ("sos", "emergency",
    // "help", "i need help") that were genuinely ambiguous between opening
    // the screen and sending a real alert -- exactly what sos_default now
    // exists to resolve. If either explicit action regains a bare word, the
    // ambiguity this action was built to remove comes back.
    const ambiguousWords = ["sos", "emergency", "panic", "help", "save me"];
    const openAliases = (getKaiActionById(OPEN)?.aliases ?? []).map((a) =>
      a.toLowerCase(),
    );
    const triggerAliases = (getKaiActionById(TRIGGER)?.aliases ?? []).map(
      (a) => a.toLowerCase(),
    );
    for (const word of ambiguousWords) {
      expect(openAliases).not.toContain(word);
      expect(triggerAliases).not.toContain(word);
    }
  });

  it("is registered exactly once in the gateway", () => {
    const matches = listKaiActions().filter(
      (action) => action.action_id === DEFAULT_ACTION,
    );
    expect(matches).toHaveLength(1);
  });
});
