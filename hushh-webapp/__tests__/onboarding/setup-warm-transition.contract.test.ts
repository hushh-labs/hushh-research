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
    // The guard may force one bounded retry when native auth publishes the
    // user before the token provider/proxy is ready. The cached admission path
    // above still prevents a forced read on ordinary route changes.
    expect(guard).toContain("bootstrapState(userId);");
    expect(guard).toContain("force: true");
    expect(guard).toContain("cachedAdmissionAllowsCurrentRoute");
    expect(guard).toContain("OneSetupCompletionHintService.isResolved(userId)");
    expect(guard).not.toContain("primeSetupResolved");
    expect(guard).not.toContain("window.location.assign(redirectTarget)");
  });

  it("settles an unresolved reviewer fixture after unlocking an existing vault", () => {
    const bootstrap = read("components/app-ui/native-test-bootstrap.tsx");
    const setupRead = bootstrap.indexOf(
      "PreVaultUserStateService.bootstrapState",
    );
    const setupWrite = bootstrap.indexOf(
      "PreVaultUserStateService.syncKaiSetupState",
    );

    expect(setupRead).toBeGreaterThan(-1);
    expect(setupWrite).toBeGreaterThan(setupRead);
    expect(bootstrap).toContain(
      "if (!PreVaultUserStateService.isSetupResolved(setupState))",
    );
    expect(bootstrap).not.toContain("if (createdVault)");
  });

  it("keeps native flow routing in one unlocked App Router document", () => {
    const router = read("components/app-ui/native-test-router.tsx");

    expect(router).toContain('bridge.bootstrapState === "vault_unlocked"');
    expect(router).toContain("router.replace(route, { scroll: false })");
    expect(router).not.toContain("setPendingNativeRoute");
    expect(router).not.toContain("window.location.assign");
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
    // The segment-level loader is deliberately inert: setup workspaces share a
    // cached journey record, so route adapters own the cold-state wait and a
    // segment skeleton would flash on every capability switch.
    expect(loading).toContain("return null");
    expect(loading).not.toContain("RouteLoadingState");
  });
});
