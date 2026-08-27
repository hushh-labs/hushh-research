import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

/**
 * A source contract, deliberately — and the one place in this change where that
 * is the right tool rather than a cop-out.
 *
 * The geometry Connect's pinned header and search row have to satisfy is held
 * by `e2e/connect-sticky-header.layout.spec.ts`, which renders and measures
 * them. What a rendered fixture cannot hold is which offsets the COMPONENT
 * hands the browser — a fixture only ever contains what its author put there.
 * These three assertions are the other half of that pair, in the same shape the
 * `phone-width geometry QA reported` block in `app/connect/page-client.test.tsx`
 * already uses.
 */
describe("connect sticky header contract", () => {
  const source = read("app/connect/page-client.tsx");

  it("pins the strips and the search row at two different offsets", () => {
    // Together they would fix a control to the top of a screen whose first list
    // it does not filter: this field searches the directory, and `My
    // connections` is above it.
    expect(source).toContain(
      "sticky top-[var(--top-shell-live-height,0px)] z-20",
    );
    expect(source).toContain(
      "sticky top-[calc(var(--top-shell-live-height,0px)+var(--connect-sticky-header-height,0px))]",
    );
  });

  it("measures the header rather than assuming a height for it", () => {
    // The header is one strip on Circles and two everywhere else, and a strip's
    // height moves with the type scale. A literal offset is right at exactly
    // one width and one surface.
    expect(source).toContain("--connect-sticky-header-height");
    expect(source).toContain("new ResizeObserver(publish)");
  });
});
