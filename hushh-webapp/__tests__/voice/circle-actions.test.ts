import { describe, expect, it } from "vitest";

import {
  matchCircleByName,
  normalizeSpokenName,
} from "@/app/one/location/page";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

/**
 * Circle membership over voice.
 *
 * The matcher is tiered rather than a substring scan because circle membership
 * decides who keeps seeing the person's live location. Resolving "family" to
 * "Extended family trip" while a circle literally called "Family" exists would
 * silently edit the wrong group, and the person would be told it worked.
 */
describe("matchCircleByName", () => {
  const circles = [
    { name: "Family" },
    { name: "Extended family trip" },
    { name: "Work" },
  ];

  it("prefers an exact name over a longer name that contains it", () => {
    const { match, ambiguous } = matchCircleByName(circles, "family");
    expect(match?.name).toBe("Family");
    expect(ambiguous).toEqual([]);
  });

  it("ignores case, accents and punctuation", () => {
    const accented = [{ name: "Café crew" }];
    expect(matchCircleByName(accented, "cafe crew").match?.name).toBe(
      "Café crew",
    );
    expect(matchCircleByName([{ name: "Mum & Dad" }], "mum dad").match?.name).toBe(
      "Mum & Dad",
    );
  });

  it("matches a whole word inside a longer circle name", () => {
    expect(matchCircleByName(circles, "trip").match?.name).toBe(
      "Extended family trip",
    );
  });

  it("reports ambiguity instead of picking by array order", () => {
    const twins = [{ name: "Book club" }, { name: "Book club 2" }];
    const { match, ambiguous } = matchCircleByName(twins, "book");
    expect(match).toBeNull();
    expect(ambiguous.map((circle) => circle.name)).toEqual([
      "Book club",
      "Book club 2",
    ]);
  });

  it("returns nothing for an unknown or empty name", () => {
    expect(matchCircleByName(circles, "golf").match).toBeNull();
    expect(matchCircleByName(circles, "   ").match).toBeNull();
    expect(matchCircleByName([], "family").match).toBeNull();
  });

  it("normalizes names written in a non-Latin script instead of erasing them", () => {
    // An ASCII-only normalizer would reduce these to "" and make every circle
    // collapse into the same empty key, matching whichever sorted first.
    expect(normalizeSpokenName("परिवार")).toBe("परिवार");
    expect(matchCircleByName([{ name: "परिवार" }], "परिवार").match?.name).toBe(
      "परिवार",
    );
  });
});

describe("circle actions are authored and wired", () => {
  const expected = [
    ["location.create_circle", ["name"]],
    ["location.add_to_circle", ["person", "circle"]],
    ["location.remove_from_circle", ["person", "circle"]],
  ] as const;

  it.each(expected)("%s runs a local handler", (actionId) => {
    const action = getKaiActionById(actionId);
    expect(action).toBeDefined();
    expect(action?.execution_target.status).toBe("wired");
    // A local_handler target is what routes the settlement back to the page
    // handler; a route target would only navigate and never do the work.
    expect(action?.execution_target.path).toBe("local_handler");
    expect(action?.execution_target.target).toBe(actionId);
  });

  it.each(expected)("%s declares its slots", (actionId, slots) => {
    const goal = getKaiActionById(actionId)?.goal;
    expect(goal).toBeDefined();
    expect(Object.keys(goal?.slot_schema ?? {}).sort()).toEqual([...slots].sort());
  });

  it("asks for the person before the circle, and never requires the circle", () => {
    // A single circle needs no naming, so requiring it would stall the common
    // case behind a question with one possible answer.
    for (const actionId of ["location.add_to_circle", "location.remove_from_circle"]) {
      const inputs = getKaiActionById(actionId)?.goal?.required_inputs ?? [];
      const person = inputs.find((input) => input.slot === "person");
      const circle = inputs.find((input) => input.slot === "circle");
      expect(person?.required).toBe(true);
      expect(circle?.required).toBe(false);
    }
  });

  it("keeps the navigate-only create-circle action separate from the acting one", () => {
    // Both exist on purpose: one opens the screen, one creates the circle
    // outright. They must not collapse into the same id or the same target.
    const opener = getKaiActionById("location.open_create_circle");
    const actor = getKaiActionById("location.create_circle");
    expect(opener?.execution_target.path).toBe("route");
    expect(actor?.execution_target.path).toBe("local_handler");
    expect(opener?.label).not.toBe(actor?.label);
  });
});
