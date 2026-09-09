import { describe, expect, it } from "vitest";

import {
  extractSpokenEntity,
  parseLocalDuration,
  resolveLocalEntity,
} from "@/lib/voice/local-entity-resolvers";

describe("local governed entity resolvers", () => {
  it("resolves a unique entity without exposing its data to a provider", () => {
    expect(
      resolveLocalEntity("family", [
        { id: "circle-1", label: "Family" },
        { id: "circle-2", label: "Friends" },
      ]),
    ).toMatchObject({ status: "unique", value: { id: "circle-1" } });
  });

  it("requires clarification for multiple matches and recovers for no match", () => {
    expect(
      resolveLocalEntity("sam", [
        { id: "contact-1", label: "Sam Lee" },
        { id: "contact-2", label: "Sam Patel" },
      ]).status,
    ).toBe("ambiguous");
    expect(resolveLocalEntity("nobody", []).status).toBe("not_found");
  });

  it.each([
    ["15 minutes", 15],
    ["half an hour", 30],
    ["2 hours", 120],
    ["one day", 1440],
  ])("normalizes %s", (spoken, minutes) => {
    expect(parseLocalDuration(spoken)?.minutes).toBe(minutes);
  });

  it("extracts only a bounded spoken slot", () => {
    expect(extractSpokenEntity("create a circle called Family", ["called"])).toBe(
      "family",
    );
    expect(extractSpokenEntity("called Family", ["called"])).toBe("family");
  });
});
