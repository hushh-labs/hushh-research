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
 * These assertions are the other half of that pair, in the same shape the
 * `phone-width geometry QA reported` block in `app/connect/page-client.test.tsx`
 * already uses.
 */
/** The value of a `const NAME = "…";` class string, by name. */
function classNameConstant(source: string, name: string): string {
  const declared = source.indexOf(`const ${name} =`);
  if (declared < 0) throw new Error(`${name} is not declared`);
  const opens = source.indexOf('"', declared);
  const closes = source.indexOf('";', opens + 1);
  if (opens < 0 || closes < 0) {
    throw new Error(`${name} is not a single string constant`);
  }
  return source.slice(opens + 1, closes);
}

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

  it("paints both pinned bands opaque", () => {
    // 15% of a roster row is still a roster row. At `bg-background/85` names and
    // avatars read through the strips and through the search field as they
    // scroll past — reported from a phone as "the contact list is scrolling
    // behind the header".
    //
    // Read off the two constants rather than the whole file: the docblocks above
    // them quote the value this replaced, and a bare `toContain` over the source
    // would keep failing on the explanation for its own fix.
    for (const name of [
      "CONNECT_STICKY_HEADER_CLASSNAME",
      "CONNECT_STICKY_SEARCH_CLASSNAME",
    ]) {
      expect(classNameConstant(source, name)).not.toMatch(/bg-background\//);
    }
  });

  it("continues the header's material up over the top mask's fade tail", () => {
    // The header pins at `--top-shell-live-height`, which is the mask's LAST
    // VISIBLE pixel — so the `--top-fade-active` band directly above it is
    // chrome at the top and clear glass at the bottom, and rows crossed it in
    // plain sight between the bar and the strips. A fixture cannot hold this:
    // it is a band the component draws outside its own box.
    expect(source).toContain("before:bottom-full");
    expect(source).toContain("before:bg-background");
    expect(source).toContain(
      "data-[pinned=true]:before:h-[calc(var(--top-fade-active,0px)+1px)]",
    );
  });

  it("gives the cover a height only while the header is really pinned", () => {
    // At rest the header sits `--page-header-section-gap` below the page title —
    // 10px at this page's compact density — so an unconditional 22px cover would
    // sit on "Connect" rather than on the mask's tail. The sentinel is what says
    // which of the two states the header is in; the header itself cannot, since
    // once pinned it never leaves the scrollport.
    expect(source).toContain("stickyPinSentinelRef");
    expect(source).toContain("new IntersectionObserver");
    expect(source).toContain("rootMargin: `-${pinnedAt}px 0px 0px 0px`");
  });
});
