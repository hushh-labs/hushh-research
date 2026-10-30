import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

  it("keeps the full route envelope at 150ms with no transition delay", () => {
    const driver = readFileSync(
      join(process.cwd(), "lib/morphy-ux/hooks/use-route-transition.ts"),
      "utf8",
    );
    const styles = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    expect(driver).toContain("const EXIT_MS = 60");
    expect(driver).toContain("const ENTER_MS = 90");
    expect(styles).toContain("--motion-route-exit-duration: 60ms");
    expect(styles).toContain("--motion-route-enter-duration: 90ms");
    expect(styles).toContain("var(--motion-route-exit-duration)");
    expect(styles).toContain("var(--motion-route-enter-duration)");
    expect(styles).not.toMatch(/--motion-route-(?:exit|enter)-duration:[^;]+;[^\n]*delay/);
  });
});
