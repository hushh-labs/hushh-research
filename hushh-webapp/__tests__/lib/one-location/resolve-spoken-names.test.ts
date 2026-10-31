import { describe, expect, it } from "vitest";

import {
  joinNamesForSpeech,
  normalizeSpokenName,
  resolveSpokenNames,
  splitSpokenNames,
} from "@/lib/one-location/resolve-spoken-names";

type Person = { id: string; name: string };

function person(id: string, name: string): Person {
  return { id, name };
}

const byName = (item: Person) => item.name;

describe("resolveSpokenNames", () => {
  it("resolves a clean substring match", () => {
    const candidates = [person("1", "Sarah Chen"), person("2", "Priya Singh")];
    const result = resolveSpokenNames(candidates, "Sarah", byName);
    expect(result.resolved.map((r) => r.id)).toEqual(["1"]);
    expect(result.unresolved).toEqual([]);
  });

  it("still prefers an exact substring match over any fuzzy candidate", () => {
    // "Ankit" is an exact substring hit on candidate 1; fuzzy must never run
    // once substring already found something, so candidate 2 ("Ankeet") is
    // never even considered here.
    const candidates = [person("1", "Ankit Kumar"), person("2", "Ankeet Rao")];
    const result = resolveSpokenNames(candidates, "Ankit", byName);
    expect(result.resolved.map((r) => r.id)).toEqual(["1"]);
  });

  describe("fuzzy fallback", () => {
    it("matches a one-letter-off mishearing when substring finds nothing", () => {
      // "Nilesh" is not a substring of "Neelesh Hushh - 1" (missing the
      // second e), so this only resolves through the fuzzy fallback.
      const candidates = [person("1", "Neelesh Hushh - 1")];
      const result = resolveSpokenNames(candidates, "Nilesh", byName);
      expect(result.resolved.map((r) => r.id)).toEqual(["1"]);
      expect(result.unresolved).toEqual([]);
    });

    it("matches an insertion-style mishearing (Ankeet for Ankit)", () => {
      const candidates = [person("1", "Ankit Kumar")];
      const result = resolveSpokenNames(candidates, "Ankeet", byName);
      expect(result.resolved.map((r) => r.id)).toEqual(["1"]);
    });

    it("reports ambiguous, not a guess, when a fuzzy match is close to more than one person", () => {
      const candidates = [person("1", "Ankit Kumar"), person("2", "Ankeet Rao")];
      // "Anket" is one edit from both "Ankit" and "Ankeet" -- neither should
      // be silently preferred, so this must surface both as a choice, the
      // exact same shape a substring collision already produces.
      const result = resolveSpokenNames(candidates, "Anket", byName);
      expect(result.resolved).toEqual([]);
      expect(result.unresolved).toEqual([
        {
          spokenText: "Anket",
          kind: "ambiguous",
          matches: expect.arrayContaining([
            expect.objectContaining({ id: "1" }),
            expect.objectContaining({ id: "2" }),
          ]),
        },
      ]);
    });

    it("never fuzzy-matches short names, where a one-edit slip reaches too many unrelated people", () => {
      const candidates = [person("1", "Amy Chen"), person("2", "Ivy Park")];
      const result = resolveSpokenNames(candidates, "Amy", byName);
      // Exact substring hit on "Amy" -- included to show the floor applies
      // to the FALLBACK, not to real matches.
      expect(result.resolved.map((r) => r.id)).toEqual(["1"]);

      const noMatch = resolveSpokenNames(candidates, "Emy", byName);
      // "Emy" is one edit from "Amy", but "Amy" is only 3 letters -- under
      // the 4-letter floor, so this must stay not_found rather than guess.
      expect(noMatch.resolved).toEqual([]);
      expect(noMatch.unresolved).toEqual([{ spokenText: "Emy", kind: "not_found" }]);
    });

    it("stays not_found when nothing is close enough, fuzzy included", () => {
      const candidates = [person("1", "Sarah Chen"), person("2", "Priya Singh")];
      const result = resolveSpokenNames(candidates, "Zachary", byName);
      expect(result.resolved).toEqual([]);
      expect(result.unresolved).toEqual([
        { spokenText: "Zachary", kind: "not_found" },
      ]);
    });

    it("applies fuzzy independently per name in a multi-person turn", () => {
      const candidates = [person("1", "Neelesh Hushh - 1"), person("2", "Priya Singh")];
      const result = resolveSpokenNames(candidates, "Nilesh and Priya", byName);
      expect(result.resolved.map((r) => r.id).sort()).toEqual(["1", "2"]);
      expect(result.unresolved).toEqual([]);
    });
  });
});

describe("splitSpokenNames", () => {
  it("returns a single-element array with no delimiter", () => {
    expect(splitSpokenNames("Sarah")).toEqual(["Sarah"]);
  });

  it("splits on comma, ampersand, semicolon, and the word and", () => {
    expect(splitSpokenNames("Alice, Bob & Carol; Dana and Erin")).toEqual([
      "Alice",
      "Bob",
      "Carol",
      "Dana",
      "Erin",
    ]);
  });
});

describe("normalizeSpokenName", () => {
  it("strips case, accents, and punctuation", () => {
    // The apostrophe becomes a space, not nothing -- it is stripped by the
    // same [^\p{L}\p{N}\p{M}\s] rule that turns "Mum & Dad" into two words,
    // not one squashed-together word.
    expect(normalizeSpokenName("Renée O'Brien")).toBe("renee o brien");
  });
});

describe("joinNamesForSpeech", () => {
  it("joins without an Oxford comma", () => {
    expect(joinNamesForSpeech(["Alice", "Bob", "Sarah"])).toBe("Alice, Bob and Sarah");
    expect(joinNamesForSpeech(["Alice", "Bob"])).toBe("Alice and Bob");
    expect(joinNamesForSpeech(["Alice"])).toBe("Alice");
  });
});
