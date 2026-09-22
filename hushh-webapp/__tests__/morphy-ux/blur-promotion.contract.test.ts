import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Glass surfaces must not be blanket-promoted to compositor layers.
 *
 * A single `[class*="backdrop-blur"] { transform: translate3d(0,0,0);
 * will-change: transform }` rule once pinned every one of the ~170 blur
 * occurrences (all 27 glass button variants included) for the life of the
 * page, and the ambient chrome masks carried `will-change: backdrop-filter`.
 * On WKWebView each held layer costs memory and a backdrop readback per
 * frame. backdrop-filter already creates a stacking context and a containing
 * block, so no surface needs the transform for correctness; a surface that
 * measurably flickers gets `translateZ(0)` on its own rule.
 */

const css = fs.readFileSync(
  path.resolve(__dirname, "../../app/globals.css"),
  "utf8",
);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("blur layer promotion", () => {
  const rules = stripComments(css);

  it("has no attribute-wildcard selector that promotes glass to a layer", () => {
    const wildcardBlocks = [
      ...rules.matchAll(/\[class\*=["']backdrop-blur[^\]]*\]\s*\{([^}]*)\}/g),
    ];
    for (const block of wildcardBlocks) {
      expect(block[1], block[0]).not.toMatch(/will-change|translate3d|translateZ/);
    }
  });

  it("never declares will-change for backdrop-filter", () => {
    expect(rules).not.toMatch(/will-change\s*:[^;]*backdrop-filter/);
  });
});
