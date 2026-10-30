import { describe, expect, it } from "vitest";
import {
  ageFromDateOfBirth,
  readLabelledSoulFacts,
  soulFactKey,
} from "@/lib/pkm/soul-labelled-facts";

describe("the labelled facts inside Soul.md", () => {
  it("reads the labelled bullets the identity intake writes, and nothing else", () => {
    const facts = readLabelledSoulFacts(
      [
        "# Soul.md",
        "",
        "## Facts",
        "",
        "- Legal name: Smirthika Dharmalingam",
        "- Date of birth: 1998-03-14",
        "- Sex: female",
        // Ordinary prose is not a recorded fact, however confident it sounds.
        "- She is probably about thirty",
        "- Prefers window seats",
        "",
      ].join("\n"),
    );

    expect(facts.get("legal name")?.value).toBe("Smirthika Dharmalingam");
    expect(facts.get("date of birth")?.value).toBe("1998-03-14");
    expect(facts.get("sex")?.value).toBe("female");
    expect(facts.size).toBe(3);
  });

  it("never reads a pasted code sample as the person", () => {
    const facts = readLabelledSoulFacts(
      ["## Facts", "", "```", "- Sex: not-a-real-person", "```", "", "- Sex: male", ""].join("\n"),
    );
    expect(facts.get("sex")?.value).toBe("male");
    expect(facts.size).toBe(1);
  });

  it("takes the latest bullet, because a correction is appended not rewritten", () => {
    const facts = readLabelledSoulFacts(
      ["- Legal name: Old Name", "- Legal name: Corrected Name"].join("\n"),
    );
    expect(facts.get("legal name")?.value).toBe("Corrected Name");
  });

  it("addresses a label the same way however it was capitalised", () => {
    expect(soulFactKey("  Date Of  Birth :")).toBe("date of birth");
  });
});

describe("age is worked out, never recorded and never guessed", () => {
  it("counts whole years, and only after the birthday has passed", () => {
    const now = new Date("2026-03-13T00:00:00Z");
    // The day before: still 27.
    expect(ageFromDateOfBirth("1998-03-14", now)).toBe(27);
    expect(ageFromDateOfBirth("1998-03-13", now)).toBe(28);
    expect(ageFromDateOfBirth("1998-03-12", now)).toBe(28);
  });

  it("handles a 29 February birth date in a common year", () => {
    expect(ageFromDateOfBirth("2000-02-29", new Date("2026-02-28T00:00:00Z"))).toBe(25);
    expect(ageFromDateOfBirth("2000-02-29", new Date("2026-03-01T00:00:00Z"))).toBe(26);
  });

  it.each([
    ["an impossible date", "2023-02-30"],
    ["a future date", "2099-01-01"],
    ["free text", "about thirty"],
    ["nothing", ""],
    ["absent", null],
  ])("refuses to produce an age from %s", (_label, value) => {
    // A wrong age is a wrong answer, not a missing one.
    expect(ageFromDateOfBirth(value, new Date("2026-03-13T00:00:00Z"))).toBeNull();
  });
});
