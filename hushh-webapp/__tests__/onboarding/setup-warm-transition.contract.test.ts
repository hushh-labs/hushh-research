import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("setup warm-transition contract", () => {
  it("uses cached bootstrap state before an initial setup-route request", () => {
    const coordinator = read(
      "components/onboarding/setup/setup-capability-coordinator.tsx",
    );
    const admission = coordinator.slice(0, coordinator.indexOf("const settle"));

    expect(admission).toContain("getCachedBootstrapState?.(user.uid)");
    expect(admission).toContain(
      "cachedJourney ??\n          (await PreVaultUserStateService.bootstrapState(user.uid))",
    );
    expect(admission).not.toContain("force: true");
  });

  it("does not block every route change on a forced onboarding admission check", () => {
    const guard = read("components/onboarding/onboarding-journey-guard.tsx");

    expect(guard).toContain("getCachedBootstrapState?.(userId)");
    expect(guard).not.toContain("force: true");
    expect(guard).toContain("cachedAdmissionAllowsCurrentRoute");
  });

  it("prefetches static setup workspaces and uses onboarding cold-fallback geometry", () => {
    const tile = read("components/onboarding/setup/capability-setup-tile.tsx");
    const coordinator = read(
      "components/onboarding/setup/setup-capability-coordinator.tsx",
    );
    const loading = read("app/one/setup/loading.tsx");

    expect(tile).toContain("router.prefetch(href)");
    expect(tile).toContain("onPointerEnter={prefetchRoute}");
    expect(tile).toContain("onTouchStart={prefetchRoute}");
    expect(coordinator).toContain('surface="onboarding"');
    expect(loading).toContain('surface="onboarding"');
  });
});
