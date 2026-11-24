import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { resolveRouteTransitionDirection } from "@/lib/morphy-ux/hooks/use-route-transition";

describe("shared route transition contract", () => {
  it("uses one provider-mounted synchronous History observer for every pathname change", () => {
    const driver = readFileSync(
      join(process.cwd(), "lib/morphy-ux/hooks/use-route-transition.ts"),
      "utf8",
    );
    const providers = readFileSync(join(process.cwd(), "app/providers.tsx"), "utf8");

    expect(providers).toContain("useRouteTransition();");
    expect(providers).not.toContain("usePageEnterAnimation");
    expect(providers).not.toContain("ensureMorphyGsapReady");
    expect(driver).toContain("window.history.pushState = wrap");
    expect(driver).toContain("window.history.replaceState = wrap");
    expect(driver).toContain("if (routePathname(resolved.pathname) === routePathname(window.location.pathname))");
    expect(driver).toContain('setRouteState("pending")');
    expect(driver).toContain('return original(data, unused, url ?? "")');
    expect(driver).not.toContain(
      'beginRouteTransition(target, () => original(data, unused, url ?? ""))',
    );
  });

  it("adds tab-body clearance through the shared shell token instead of route spacers", () => {
    const providers = readFileSync(join(process.cwd(), "app/providers.tsx"), "utf8");

    expect(providers).toContain('"--page-top-local-offset": topShellMetrics.hasTabs');
    expect(providers).not.toContain('calc(${routeLayout.pageTopLocalOffset || "0px"} + 12px)');
  });

  it("drives fluid Native View Transitions with pinned shell chrome and Apple HIG motion tokens", () => {
    const driver = readFileSync(
      join(process.cwd(), "lib/morphy-ux/hooks/use-route-transition.ts"),
      "utf8",
    );
    const styles = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(driver).toContain("startViewTransition");
    expect(driver).toContain("resolveRouteTransitionDirection");
    expect(driver).toContain("const EXIT_MS = 60");
    expect(driver).toContain("const ENTER_MS = 220");
    expect(styles).toContain("--motion-route-exit-duration: 60ms");
    expect(styles).toContain("--motion-route-enter-duration: 220ms");
    expect(styles).toContain("--motion-route-tab-duration: 220ms");
    expect(styles).toContain("--motion-route-push-duration: 260ms");
    expect(styles).toContain("--motion-route-pop-duration: 240ms");
    expect(styles).toContain("view-transition-name: app-top-shell");
    expect(styles).toContain("view-transition-name: app-bottom-shell");
    expect(styles).toContain("var(--motion-route-exit-duration)");
    expect(styles).toContain("var(--motion-route-enter-duration)");
    expect(styles).not.toMatch(/--motion-route-(?:exit|enter)-duration:[^;]+;[^\n]*delay/);
  });

  it("classifies peer tabs, drill-down pushes, and inverse pops accurately", () => {
    expect(resolveRouteTransitionDirection("/", "/one", "tap")).toBe("tab-forward");
    expect(resolveRouteTransitionDirection("/one", "/one/connect", "tap")).toBe("tab-forward");
    expect(resolveRouteTransitionDirection("/one/feed", "/one", "tap")).toBe("tab-back");
    expect(resolveRouteTransitionDirection("/one", "/one/files", "tap")).toBe("push");
    expect(resolveRouteTransitionDirection("/one/connect", "/one/connect/person", "tap")).toBe("push");
    expect(resolveRouteTransitionDirection("/one/files", "/one", "native_back")).toBe("pop");
    expect(resolveRouteTransitionDirection("/one/connect/person", "/one/connect", "popstate")).toBe("pop");
    expect(resolveRouteTransitionDirection("/one/files", "/one", "tap")).toBe("pop");
  });
});
