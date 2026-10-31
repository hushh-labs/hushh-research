import { describe, expect, it } from "vitest";

import {
  CONTACT_LIST_CONTROLS_THRESHOLD,
  contactQueryIsActive,
  filterByContactQuery,
  matchesContactQuery,
  normalizeSearchText,
  peoplePillLabel,
  shouldRevealListControls,
  shouldVirtualizeList,
  sortByContactMode,
} from "@/lib/one-location/contact-picker-controls";

describe("conditional list controls", () => {
  it("stays hidden for a list that fits on one screen", () => {
    expect(shouldRevealListControls(0)).toBe(false);
    expect(shouldRevealListControls(4)).toBe(false);
    expect(shouldRevealListControls(CONTACT_LIST_CONTROLS_THRESHOLD)).toBe(false);
  });

  it("appears once the list outgrows a screenful", () => {
    expect(shouldRevealListControls(CONTACT_LIST_CONTROLS_THRESHOLD + 1)).toBe(true);
    expect(shouldRevealListControls(100)).toBe(true);
  });

  it("stays put once revealed, however far the list shrinks", () => {
    // The defect this guards: removing people one at a time from a 12-person
    // list must not yank the search field out from under a half-typed query
    // the moment the eleventh goes.
    expect(shouldRevealListControls(3, true)).toBe(true);
    expect(shouldRevealListControls(0, true)).toBe(true);
  });

  it("virtualizes on the same boundary it reveals controls on", () => {
    expect(shouldVirtualizeList(CONTACT_LIST_CONTROLS_THRESHOLD)).toBe(false);
    expect(shouldVirtualizeList(CONTACT_LIST_CONTROLS_THRESHOLD + 1)).toBe(true);
  });
});

describe("search", () => {
  it("finds a name through case and accents", () => {
    expect(normalizeSearchText("  RenÉe  ")).toBe("renee");
    expect(matchesContactQuery("Renée Dubois", "renee")).toBe(true);
    expect(matchesContactQuery("Renée Dubois", "DUBOIS")).toBe(true);
  });

  it("matches terms in any order, so a remembered first and last name works", () => {
    // The real shape of a query: people type the names they remember, not the
    // middle one they do not.
    expect(matchesContactQuery("Ankit Kumar Singh", "ankit singh")).toBe(true);
    expect(matchesContactQuery("Ankit Kumar Singh", "singh ankit")).toBe(true);
    expect(matchesContactQuery("Ankit Kumar Singh", "ankit gupta")).toBe(false);
  });

  it("treats an empty or whitespace query as no filter at all", () => {
    expect(contactQueryIsActive("   ")).toBe(false);
    const people = [{ name: "Aarav" }, { name: "Maya" }];
    expect(filterByContactQuery(people, "  ", (p) => p.name)).toHaveLength(2);
  });

  it("filters a roster down to the matching people", () => {
    const people = [
      { name: "Aarav Shah" },
      { name: "Maya Chen" },
      { name: "Neelesh Meena" },
    ];
    expect(
      filterByContactQuery(people, "ee", (p) => p.name).map((p) => p.name),
    ).toEqual(["Neelesh Meena"]);
  });

  it("returns a copy rather than the original array", () => {
    const people = [{ name: "Aarav" }];
    expect(filterByContactQuery(people, "", (p) => p.name)).not.toBe(people);
  });
});

describe("sort", () => {
  const people = [
    { name: "Maya Chen" },
    { name: "aarav shah" },
    { name: "Neelesh Meena" },
  ];

  it("leaves the caller's own order alone by default", () => {
    // "Suggested" is the directory's recommendation ranking; offering sorting
    // must not silently discard it.
    expect(sortByContactMode(people, "default", (p) => p.name).map((p) => p.name)).toEqual([
      "Maya Chen",
      "aarav shah",
      "Neelesh Meena",
    ]);
  });

  it("sorts case-insensitively in both directions", () => {
    expect(sortByContactMode(people, "name-asc", (p) => p.name).map((p) => p.name)).toEqual([
      "aarav shah",
      "Maya Chen",
      "Neelesh Meena",
    ]);
    expect(sortByContactMode(people, "name-desc", (p) => p.name).map((p) => p.name)).toEqual([
      "Neelesh Meena",
      "Maya Chen",
      "aarav shah",
    ]);
  });

  it("never mutates the input", () => {
    const original = [...people];
    sortByContactMode(people, "name-asc", (p) => p.name);
    expect(people).toEqual(original);
  });
});

describe("pill label", () => {
  it("counts people the way a person would say it", () => {
    expect(peoplePillLabel(0)).toBe("0 people added");
    expect(peoplePillLabel(1)).toBe("1 person added");
    expect(peoplePillLabel(12)).toBe("12 people added");
  });
});
