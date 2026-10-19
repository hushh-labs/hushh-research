import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("Profile sheet motion boundary", () => {
  it("slides the pane's sheet on transform and opacity only", () => {
    // tw-animate's shared enter/exit keyframes also animate `filter`; the
    // sheet surface uses its own keyframes so the slide stays off that path.
    const css = read("app/globals.css");
    const keyframes = ["sheet-surface-enter", "sheet-surface-exit"].map(
      (name) => {
        const start = css.indexOf(`@keyframes ${name} {`);
        expect(start, name).toBeGreaterThan(-1);
        return css.slice(start, css.indexOf("\n}\n", start));
      },
    );
    for (const block of keyframes) {
      expect(block).toContain("transform: translate3d(");
      expect(block).toContain("opacity:");
      expect(block).not.toContain("filter");
    }
    expect(css).toMatch(
      /\[data-slot="sheet-content"\]\[data-state="open"\] \{\s+animation-name: sheet-surface-enter;/,
    );
    expect(css).toMatch(
      /\[data-slot="sheet-content"\]\[data-state="closed"\] \{\s+animation-name: sheet-surface-exit;/,
    );
  });
});
