import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("Morphy expressive content-enter contract", () => {
  it("uses the route-enter expression for async component mounts", () => {
    const source = read("lib/morphy-ux/hooks/use-page-enter.ts");

    expect(source).toContain("semantic layout/component mount");
    expect(source).toContain("{ opacity: 0, y: 8 }");
    expect(source).toContain("duration: pageEnterDurationMs / 1000");
    expect(source).toContain("stagger: 0.014");
    expect(source).not.toContain("pageEnterDurationMs / 1400");
  });

  it("keeps controlled pager panels free of content-enter motion", () => {
    const swipeViews = read("components/app-ui/swipe-views.tsx");

    expect(swipeViews).toContain('data-no-auto-fade="true"');
    expect(swipeViews).not.toContain('data-morphy-enter="true"');
    expect(swipeViews).not.toContain('className="motion-step-enter"');
  });

  it("keeps the CSS utility aligned with the GSAP route-enter tokens", () => {
    const css = read("app/globals.css");

    expect(css).toContain("Standard Morphy expressive content enter");
    expect(css).toContain(
      "animation: app-step-enter var(--motion-page-enter-duration)",
    );
    expect(css).toContain("var(--motion-ease-emphasized) both");
    expect(css).toContain("transform: translateY(8px)");
  });
});
