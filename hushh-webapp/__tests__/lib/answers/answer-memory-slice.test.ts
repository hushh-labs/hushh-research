import { describe, expect, it } from "vitest";
import { buildAnswerMemorySlice } from "@/lib/answers/answer-memory-slice";

const slice = (byScope: Record<string, unknown>) =>
  buildAnswerMemorySlice({
    byScope,
    sourceRevisions: Object.fromEntries(Object.keys(byScope).map((s) => [s, 7])),
    builtAt: "2026-10-10T12:00:00.000Z",
  });

describe("the answer is written from this person's memory, not a file fetch", () => {
  it("contains only approved facts and source metadata, with no account context", () => {
    const document = slice({ "attr.travel.trips": { trips: [{ city: "Tokyo" }] } });
    expect(document.markdown).not.toContain("## Account");
    expect(document.markdown).not.toContain("| Email |");
    expect(document.markdown).not.toContain("| Picture |");
    expect(document.markdown).toContain("Tokyo");
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
      builtAt: "2026-10-10T12:00:00.000Z",
    });
    expect(document.freshness[0]!.contentRevision).toBe(4);
    expect(document.markdown).toContain("Revision 4");
  });

  it("works without an identity rather than failing", () => {
    const document = slice({ "attr.travel.trips": { trips: [{ city: "Tokyo" }] } });
    expect(document.markdown).not.toContain("## Account");
    expect(document.markdown).toContain("Tokyo");
  });
});
