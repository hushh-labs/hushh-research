import { describe, expect, it } from "vitest";

import {
  ambiguousMatchNames,
  joinNamesForSpeech,
  normalizeSpokenName,
  resolveSpokenNames,
  splitSpokenNames,
} from "@/lib/one-location/resolve-spoken-names";

type Person = { id: string; name: string };

const ALICE: Person = { id: "1", name: "Alice Chen" };
const BOB: Person = { id: "2", name: "Bob Lee" };
const SARAH_CHEN: Person = { id: "3", name: "Sarah Chen" };
const SARAH_LEE: Person = { id: "4", name: "Sarah Lee" };
const ANDERSON: Person = { id: "5", name: "Anderson Cole" };
const PEOPLE = [ALICE, BOB, SARAH_CHEN, SARAH_LEE, ANDERSON];

describe("normalizeSpokenName", () => {
  it("strips case, accents, and punctuation", () => {
    expect(normalizeSpokenName("Zoë O'Brien!")).toBe("zoe o brien");
  });

  it("collapses repeated whitespace left by stripped punctuation", () => {
    expect(normalizeSpokenName("Mum   &   Dad")).toBe("mum dad");
  });

  it("keeps combining marks so non-Latin scripts remain self-matching", () => {
    expect(normalizeSpokenName("परिवार")).toBe("परिवार");
  });
});

describe("splitSpokenNames", () => {
  it("returns a single-element array when there is no delimiter", () => {
    expect(splitSpokenNames("Alice")).toEqual(["Alice"]);
  });

  it("splits on a comma", () => {
    expect(splitSpokenNames("Alice, Bob")).toEqual(["Alice", "Bob"]);
  });

  it("splits on the standalone word 'and'", () => {
    expect(splitSpokenNames("Alice and Bob")).toEqual(["Alice", "Bob"]);
  });

  it("does not split inside a name that merely contains the letters 'and'", () => {
    expect(splitSpokenNames("Anderson Cole")).toEqual(["Anderson Cole"]);
  });

  it("splits on '&' and ';'", () => {
    expect(splitSpokenNames("Alice & Bob; Sarah")).toEqual(["Alice", "Bob", "Sarah"]);
  });

  it("handles three names mixing delimiters", () => {
    expect(splitSpokenNames("Alice, Bob and Sarah")).toEqual(["Alice", "Bob", "Sarah"]);
  });

  it("drops empty fragments from a trailing delimiter", () => {
    expect(splitSpokenNames("Alice, ")).toEqual(["Alice"]);
    expect(splitSpokenNames("")).toEqual([]);
    expect(splitSpokenNames("   ")).toEqual([]);
  });
});

describe("resolveSpokenNames", () => {
  it("resolves a single name exactly like the old single-name behavior", () => {
    const result = resolveSpokenNames(PEOPLE, "alice", (p) => p.name);
    expect(result).toEqual({ resolved: [ALICE], unresolved: [] });
  });

  it("resolves multiple named people from one utterance", () => {
    const result = resolveSpokenNames(PEOPLE, "Alice and Bob", (p) => p.name);
    expect(result.resolved).toEqual([ALICE, BOB]);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves what it can and reports the rest when one name is unknown", () => {
    const result = resolveSpokenNames(PEOPLE, "Alice and Rahul", (p) => p.name);
    expect(result.resolved).toEqual([ALICE]);
    expect(result.unresolved).toEqual([
      { spokenText: "Rahul", kind: "not_found" },
    ]);
  });

  it("resolves what it can and reports an ambiguous name separately", () => {
    const result = resolveSpokenNames(PEOPLE, "Alice and Sarah", (p) => p.name);
    expect(result.resolved).toEqual([ALICE]);
    expect(result.unresolved).toEqual([
      { spokenText: "Sarah", kind: "ambiguous", matches: [SARAH_CHEN, SARAH_LEE] },
    ]);
  });

  it("never guesses between two or more matches for the same spoken name", () => {
    const result = resolveSpokenNames(PEOPLE, "Sarah", (p) => p.name);
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([
      { spokenText: "Sarah", kind: "ambiguous", matches: [SARAH_CHEN, SARAH_LEE] },
    ]);
  });

  it("is case- and accent-insensitive per name", () => {
    const result = resolveSpokenNames(PEOPLE, "ALICE and bob", (p) => p.name);
    expect(result.resolved).toEqual([ALICE, BOB]);
  });

  it("does not split a real person's name containing 'and'", () => {
    const result = resolveSpokenNames(PEOPLE, "Anderson", (p) => p.name);
    expect(result).toEqual({ resolved: [ANDERSON], unresolved: [] });
  });

  it("returns nothing for an empty or whitespace-only utterance", () => {
    expect(resolveSpokenNames(PEOPLE, "", (p) => p.name)).toEqual({
      resolved: [],
      unresolved: [],
    });
    expect(resolveSpokenNames(PEOPLE, "   ", (p) => p.name)).toEqual({
      resolved: [],
      unresolved: [],
    });
  });

  it("matches against a separate search text but still returns the real item", () => {
    type Contact = { id: string; name: string; phone: string };
    const alice: Contact = { id: "1", name: "Alice Chen", phone: "***1234" };
    const result = resolveSpokenNames(
      [alice],
      "1234",
      (c) => c.name,
      (c) => `${c.name} ${c.phone}`,
    );
    expect(result).toEqual({ resolved: [alice], unresolved: [] });
  });
});

describe("ambiguousMatchNames", () => {
  it("joins matched names for a disambiguation prompt", () => {
    expect(ambiguousMatchNames([SARAH_CHEN, SARAH_LEE], (p) => p.name)).toBe(
      "Sarah Chen, Sarah Lee",
    );
  });

  it("bounds the list so a huge tie does not flood the summary", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `Person ${i}` }));
    expect(ambiguousMatchNames(many, (p) => p.name, 4).split(", ")).toHaveLength(4);
  });

  it("drops empty/missing names instead of leaving stray commas", () => {
    const mixed = [SARAH_CHEN, { id: "5", name: "" }, ANDERSON];
    expect(ambiguousMatchNames(mixed, (p) => p.name)).toBe("Sarah Chen, Anderson Cole");
  });
});

describe("joinNamesForSpeech", () => {
  it("returns a single name as-is", () => {
    expect(joinNamesForSpeech(["Alice"])).toBe("Alice");
  });

  it("joins two names with 'and', no comma", () => {
    expect(joinNamesForSpeech(["Alice", "Bob"])).toBe("Alice and Bob");
  });

  it("joins three or more names without an Oxford comma", () => {
    expect(joinNamesForSpeech(["Alice", "Bob", "Sarah"])).toBe("Alice, Bob and Sarah");
  });

  it("returns an empty string for no names", () => {
    expect(joinNamesForSpeech([])).toBe("");
  });

  it("drops empty/whitespace-only names", () => {
    expect(joinNamesForSpeech(["Alice", "  ", "Bob"])).toBe("Alice and Bob");
  });
});
