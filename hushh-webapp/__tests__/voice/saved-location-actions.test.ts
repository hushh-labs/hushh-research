import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

/**
 * Saving and deleting places over voice.
 *
 * Saving writes to a persistent list the person did not open a screen to see;
 * deleting removes one of those entries outright. Both are wired local
 * handlers rather than route escorts, same discipline as every other Location
 * action that changes real state instead of just opening a screen.
 */
describe("saved-location actions are authored and wired", () => {
  const expected = [
    ["location.save_current_location", ["label"]],
    ["location.delete_saved_location", ["label"]],
  ] as const;

  it.each(expected)("%s runs a local handler", (actionId) => {
    const action = getKaiActionById(actionId);
    expect(action).toBeDefined();
    expect(action?.execution_target.status).toBe("wired");
    expect(action?.execution_target.path).toBe("local_handler");
    expect(action?.execution_target.target).toBe(actionId);
  });

  it.each(expected)("%s declares its slots", (actionId, slots) => {
    const goal = getKaiActionById(actionId)?.goal;
    expect(goal).toBeDefined();
    expect(Object.keys(goal?.slot_schema ?? {}).sort()).toEqual([...slots].sort());
  });

  it("requires a name to save, but not to delete", () => {
    // Saving with no name would silently invent a label. Deleting can fall
    // back to "the only saved place" the same way circle/person actions do,
    // so it stays askable without forcing a name every time.
    const saveInput = getKaiActionById(
      "location.save_current_location",
    )?.goal?.required_inputs?.find((input) => input.slot === "label");
    const deleteInput = getKaiActionById(
      "location.delete_saved_location",
    )?.goal?.required_inputs?.find((input) => input.slot === "label");
    expect(saveInput?.required).toBe(true);
    expect(deleteInput?.required).toBe(false);
  });

  it("treats deleting a saved place as destructive and confirmed", () => {
    const action = getKaiActionById("location.delete_saved_location");
    expect(action?.execution_policy).toBe("confirm_required");
    expect(action?.risk_level).toBe("high");
    // Long enough to be a sentence about consequences, since the confirm
    // card reads this string straight from the contract.
    expect((action?.meaning || "").length).toBeGreaterThan(40);
  });

  it("keeps both actions scoped to the Location surface", () => {
    for (const [actionId] of expected) {
      const action = getKaiActionById(actionId);
      expect(action?.reachability.routes).toEqual(["/one/location"]);
      expect(action?.reachability.screens).toEqual(["one_location"]);
    }
  });
});
