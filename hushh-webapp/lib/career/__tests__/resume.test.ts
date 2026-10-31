import { describe, expect, it } from "vitest";

import { normalizeResume, resumeToText, splitName } from "@/lib/career/resume";

// The resume is the owner's data: what the extractor returns is coerced into a
// bounded shape (no unsafe links, capped fields), and what an application sends
// is exactly a rendering of what they reviewed, within the careers limit.

describe("career resume", () => {
  it("coerces extractor output into a bounded resume and drops unsafe links", () => {
    const r = normalizeResume({
      name: "  Ada Lovelace ",
      skills: ["Math", "", 42],
      experience: [{ title: "Analyst", organization: "Engine Co", highlights: ["Notes on the engine"] }, "junk"],
      links: [{ label: "Site", url: "javascript:alert(1)" }, { label: "GitHub", url: "https://github.com/ada" }],
    });
    expect(r.name).toBe("Ada Lovelace");
    expect(r.skills).toEqual(["Math"]); // blanks and non-text values are dropped
    expect(r.experience).toHaveLength(1);
    expect(r.links).toEqual([{ label: "GitHub", url: "https://github.com/ada" }]);
  });

  it("renders exactly the reviewed resume, capped at the careers limit", () => {
    const r = normalizeResume({
      name: "Ada Lovelace",
      experience: [{ title: "Analyst", organization: "Engine Co", start: "1842", end: "1843", highlights: ["Wrote Note G"] }],
      skills: ["Mathematics"],
      summary: "x".repeat(2000),
    });
    const text = resumeToText(r);
    expect(text).toContain("Analyst, Engine Co (1842 – 1843)");
    expect(text).toContain("- Wrote Note G");
    expect(text.length).toBeLessThanOrEqual(20000);
    expect(splitName("Ada King Lovelace")).toEqual({ first: "Ada", last: "King Lovelace" });
  });
});
