import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("boot surface brand mark", () => {
  it("hands off from the native splash with the canonical mark at the same size", () => {
    const source = readFileSync(
      join(process.cwd(), "components/app-ui/boot-surface.tsx"),
      "utf8",
    );
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    const glyphRule = css.match(/\.boot-mark-glyph\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(source).toContain("HushhMark");
    expect(source).not.toContain("🤫");
    expect(glyphRule).toContain("inset: 0");
    expect(glyphRule).not.toContain("font-size");
    expect(glyphRule).not.toContain("translate");
  });
});
