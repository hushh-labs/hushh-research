import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

/** The value of a `const NAME = "...";` class string, by name. */
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

  it("pins tabs to the solid chrome edge and search beneath them", () => {
    expect(source).toContain(
      "sticky top-[var(--top-shell-mask-solid-height,0px)] z-20",
    );
    expect(source).toContain(
      "sticky top-[calc(var(--top-shell-mask-solid-height,0px)+var(--connect-sticky-header-height,0px))]",
    );
  });

  it("measures the tab header rather than assuming a responsive height", () => {
    expect(source).toContain("--connect-sticky-header-height");
    expect(source).toContain("new ResizeObserver(publish)");
  });

  it("paints both sticky bands opaque", () => {
    for (const name of [
      "CONNECT_STICKY_HEADER_CLASSNAME",
      "CONNECT_STICKY_SEARCH_CLASSNAME",
    ]) {
      expect(classNameConstant(source, name)).not.toMatch(/bg-background\//);
    }
  });

  it("uses the tab surface itself as the fade-tail cover without a JS race", () => {
    expect(
      classNameConstant(source, "CONNECT_STICKY_HEADER_CLASSNAME"),
    ).not.toContain("before:");
    expect(source).not.toContain("stickyPinSentinelRef");
    expect(source).not.toContain('data-pinned="false"');
  });
});
