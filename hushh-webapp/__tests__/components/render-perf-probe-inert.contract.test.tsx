// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/one",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));

import { RenderPerfProbe } from "@/components/app-ui/render-perf-probe";

/**
 * A production session must pay nothing for the probe: no sampler chunk, no
 * listeners, no global. The sampler is reachable only through a dynamic
 * import behind the enablement check.
 */
describe("RenderPerfProbe is inert by default", () => {
  it("never statically imports the sampler", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../components/app-ui/render-perf-probe.tsx"),
      "utf8",
    );
    const staticImports = source.match(/^import (?!type )[^\n]*frame-pacing[^\n]*$/gm) ?? [];
    expect(staticImports).toEqual([]);
    expect(source).toMatch(/await import\("@\/lib\/perf\/frame-pacing"\)/);
  });

  it("installs nothing when no signal is present", async () => {
    const addListener = vi.spyOn(document, "addEventListener");
    render(<RenderPerfProbe />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.__hushhPerf).toBeUndefined();
    const registered = addListener.mock.calls.map(([name]) => name);
    expect(registered).not.toContain("pointerdown");
    expect(registered).not.toContain("scroll");
    expect(document.querySelector('[data-testid="hushh-perf-status"]')).toBeNull();
  });
});
