import { describe, expect, it } from "vitest";
import { buildAnswerMemorySlice, nameInitial } from "@/lib/answers/answer-memory-slice";

const IDENTITY = {
  displayName: "Ankit Kumar Singh",
  email: "ankit@hushh.ai",
  photoUrl: "https://example.test/ankit.png",
};

const slice = (byScope: Record<string, unknown>, identity = IDENTITY) =>
  buildAnswerMemorySlice({
    byScope,
    sourceRevisions: Object.fromEntries(Object.keys(byScope).map((s) => [s, 7])),
    ownerIdentity: identity,
    builtAt: "2026-10-10T12:00:00.000Z",
  });

describe("the answer is written from this person's memory, not a file fetch", () => {
  it("opens with who the person is: name, initial and photo", () => {
    const document = slice({ "attr.travel.trips": { trips: [{ city: "Tokyo" }] } });
    expect(document.markdown).toContain("## Account");
    expect(document.markdown).toContain("Ankit Kumar Singh");
    expect(document.markdown).toContain("| Initial | A |");
    expect(document.markdown).toContain("https://example.test/ankit.png");
  });

  it("carries the approved areas in full, including location", () => {
    const document = slice({
      "attr.location.home": { home: { city: "Bengaluru", country: "India" } },
      "attr.travel.trips": { trips: [{ city: "Tokyo", amount: 1200 }] },
    });
    expect(document.markdown).toContain("Bengaluru");
    expect(document.markdown).toContain("India");
    expect(document.markdown).toContain("Tokyo");
    expect(document.markdown).toContain("1200");
  });

  it("merges two approved scopes of one domain into one section", () => {
    const document = slice({
      "attr.travel.trips": { trips: [{ city: "Tokyo" }] },
      "attr.travel.preferences": { preferences: { seat: "aisle" } },
    });
    // One Travel section, both approved parts present.
    expect(document.markdown.match(/## travel/gi) ?? []).toHaveLength(1);
    expect(document.markdown).toContain("Tokyo");
    expect(document.markdown).toContain("aisle");
  });

  it("contains nothing that was not approved", () => {
    // Only what the caller projected can appear: there is no second read.
    const document = slice({ "attr.travel.trips": { trips: [{ city: "Tokyo" }] } });
    expect(document.markdown).not.toContain("Bengaluru");
    expect(document.markdown).not.toContain("passport");
    expect(document.freshness.map((f) => f.domain)).toEqual(["travel"]);
  });

  it("reports the oldest revision across a domain's scopes", () => {
    const document = buildAnswerMemorySlice({
      byScope: {
        "attr.travel.trips": { trips: [{ city: "Tokyo" }] },
        "attr.travel.preferences": { preferences: { seat: "aisle" } },
      },
      // A section is only as current as its least current input.
      sourceRevisions: { "attr.travel.trips": 9, "attr.travel.preferences": 4 },
      ownerIdentity: IDENTITY,
      builtAt: "2026-10-10T12:00:00.000Z",
    });
    expect(document.freshness[0]!.contentRevision).toBe(4);
    expect(document.markdown).toContain("Revision 4");
  });

  it("works without an identity rather than failing", () => {
    const document = slice({ "attr.travel.trips": { trips: [{ city: "Tokyo" }] } }, null as never);
    expect(document.markdown).not.toContain("## Account");
    expect(document.markdown).toContain("Tokyo");
  });
});

describe("nameInitial", () => {
  it("takes the first letter, uppercased", () => {
    expect(nameInitial("ankit kumar singh")).toBe("A");
    expect(nameInitial("  Priya")).toBe("P");
  });

  it("handles a non-Latin name without mangling it", () => {
    // Array.from, not [0], so a multi-byte first character survives.
    expect(nameInitial("अंकित")).toBe("अ");
    expect(nameInitial("😀 hello")).toBe("😀");
  });

  it("returns null when there is no name to take one from", () => {
    expect(nameInitial("")).toBeNull();
    expect(nameInitial("   ")).toBeNull();
    expect(nameInitial(null)).toBeNull();
  });
});
