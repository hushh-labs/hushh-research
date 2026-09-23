// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/one",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));

import { RenderPerfProbe } from "@/components/app-ui/render-perf-probe";
import { RenderPerfProfiler } from "@/components/app-ui/render-perf-profiler";
import { hasRenderCommitSink, reportRenderCommit, setRenderCommitSink } from "@/lib/perf/render-commit-sink";

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

  it("the Profiler wrapper adds no element and forwards nothing while the probe is off", () => {
    expect(hasRenderCommitSink()).toBe(false);
    const { container } = render(
      <RenderPerfProfiler>
        <span data-testid="child">hello</span>
      </RenderPerfProfiler>,
    );
    // A Profiler is transparent in the DOM: the child is the only node.
    expect(container.childNodes).toHaveLength(1);
    expect(container.firstElementChild?.getAttribute("data-testid")).toBe("child");
    // Without a sink a commit report is a null check.
    expect(() => reportRenderCommit("update", 12, 20, 100)).not.toThrow();
    expect(window.__hushhPerf).toBeUndefined();
  });

  it("forwards commits only to an installed sink, and stops when it is cleared", () => {
    const seen: number[] = [];
    setRenderCommitSink((commit) => seen.push(commit.actual_ms));
    reportRenderCommit("mount", 7, 9, 1);
    setRenderCommitSink(null);
    reportRenderCommit("update", 11, 13, 2);
    expect(seen).toEqual([7]);
  });
});
