import { describe, expect, it } from "vitest";

import {
  ambiguousMatchNames,
  resolveBySpokenName,
} from "@/lib/one-location/resolve-by-spoken-name";

type Person = { id: string; name: string };

const SARAH_CHEN: Person = { id: "1", name: "Sarah Chen" };
const SARAH_LEE: Person = { id: "2", name: "Sarah Lee" };
const ABDUL: Person = { id: "3", name: "Abdul Gaffar" };
const PEOPLE = [SARAH_CHEN, SARAH_LEE, ABDUL];

describe("resolveBySpokenName", () => {
  it("matches a single person by a substring of their name", () => {
    const result = resolveBySpokenName([SARAH_CHEN, ABDUL], "sarah", (p) => p.name);
    expect(result).toEqual({ kind: "one", match: SARAH_CHEN });
  });

  it("is case-insensitive", () => {
    const result = resolveBySpokenName([SARAH_CHEN], "SARAH CHEN", (p) => p.name);
    expect(result).toEqual({ kind: "one", match: SARAH_CHEN });
  });

  it("never guesses between two or more matches", () => {
    const result = resolveBySpokenName(PEOPLE, "sarah", (p) => p.name);
    expect(result.kind).toBe("many");
    expect(result.kind === "many" && result.matches).toEqual([SARAH_CHEN, SARAH_LEE]);
  });

  it("returns none when nobody matches", () => {
    expect(resolveBySpokenName(PEOPLE, "nobody", (p) => p.name)).toEqual({ kind: "none" });
  });

  it("returns none for an empty or whitespace-only spoken name", () => {
    expect(resolveBySpokenName(PEOPLE, "", (p) => p.name)).toEqual({ kind: "none" });
    expect(resolveBySpokenName(PEOPLE, "   ", (p) => p.name)).toEqual({ kind: "none" });
  });

  it("treats a missing display name as unmatchable rather than throwing", () => {
    const nameless: Person = { id: "4", name: "" };
    const result = resolveBySpokenName([nameless], "anything", () => null);
    expect(result).toEqual({ kind: "none" });
  });

  it("matches against a separate search text but still returns the real item", () => {
    type Contact = { id: string; name: string; phone: string };
    const sarah: Contact = { id: "1", name: "Sarah Chen", phone: "***1234" };
    const result = resolveBySpokenName(
      [sarah],
      "1234",
      (c) => c.name,
      (c) => `${c.name} ${c.phone}`,
    );
    expect(result).toEqual({ kind: "one", match: sarah });
  });

  it("defaults search text to display name when none is given", () => {
    const result = resolveBySpokenName([SARAH_CHEN], "chen", (p) => p.name);
    expect(result).toEqual({ kind: "one", match: SARAH_CHEN });
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
    const mixed = [SARAH_CHEN, { id: "5", name: "" }, ABDUL];
    expect(ambiguousMatchNames(mixed, (p) => p.name)).toBe("Sarah Chen, Abdul Gaffar");
  });
});
