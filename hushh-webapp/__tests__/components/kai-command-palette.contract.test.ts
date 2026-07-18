import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/kai/kai-command-palette.tsx"),
  "utf8",
);

describe("Kai command palette contract", () => {
  it("prioritizes an explicit natural-language handoff above generated actions", () => {
    expect(source).toContain('heading="Ask One"');
    expect(source).toContain("onSelect={submitPromptSuggestion}");
    expect(source.indexOf('heading="Ask One"')).toBeLessThan(
      source.indexOf('heading="Commands"'),
    );
  });

  it("keeps command rows to one clean label without helper descriptions", () => {
    expect(source).not.toContain("const helperText");
    expect(source).not.toContain("description=\"Type a command");
  });
});
