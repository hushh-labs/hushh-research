import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/gmail/gmail-nudges-section.tsx"),
  "utf8",
);

describe("Gmail inbox nudge loading contract", () => {
  it("uses accessible placeholders until the background nudge request settles", () => {
    expect(source).toContain("function NudgeListSkeleton");
    expect(source).toContain("aria-label={`Loading ${label}`}");
    expect(source).toContain("<NudgeListSkeleton label={eyebrow.toLowerCase()} />");
  });
});
