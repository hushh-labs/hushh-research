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

    expect(admission).toContain("getCachedBootstrapState?.(userId)");
    expect(admission).toContain(
      "cachedJourney ??\n          (await PreVaultUserStateService.bootstrapState(userId))",
    );
    expect(admission).toContain("await PreVaultUserStateService.bootstrapState(userId)");
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

  it("fails closed instead of mutating an unresolved reviewer setup fixture", () => {
    const bootstrap = read("components/app-ui/native-test-bootstrap.tsx");
    const setupRead = bootstrap.indexOf(
      "PreVaultUserStateService.bootstrapState",
    );

    expect(setupRead).toBeGreaterThan(-1);
    expect(bootstrap).toContain(
      "if (!PreVaultUserStateService.isSetupResolved(setupState))",
    );
    expect(bootstrap).toContain(
      "native audit will not mutate onboarding state",
    );
    expect(bootstrap).toContain(
      "native audit will not create one",
    );
    expect(bootstrap).not.toContain(
      "PreVaultUserStateService.syncKaiSetupState",
    );
    expect(bootstrap).not.toContain("VaultService.createVault(");
  });

  it("keeps the native test vault bootstrap continuous while auth context publishes", () => {
    const bootstrap = read("components/app-ui/native-test-bootstrap.tsx");

    expect(bootstrap).toContain(
      "await AuthService.signOut().catch(() => undefined)",
    );
    expect(bootstrap).toContain("setBootstrapUser(authenticatedUser)");
    expect(bootstrap).toContain(
      "nativeTestBootstrapUser ??\n      AuthService.getCurrentUser()",
    );
    expect(bootstrap).toContain("AuthService.restoreNativeSession()");
    expect(bootstrap).toContain(
      "PreVaultUserStateService.bootstrapState(vaultUser.uid)",
    );
    expect(bootstrap).toContain("if (!setupState.hasVault)");
    expect(bootstrap).not.toContain("VaultService.checkVault(vaultUser.uid)");
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

  it("keeps Finance import open after root setup is skipped and resumes its terminal", () => {
    const coordinator = read(
      "components/onboarding/setup/setup-capability-coordinator.tsx",
    );
    const financeImport = read(
      "app/one/setup/finance/import/finance-import-onboarding-setup-client.tsx",
    );

    expect(financeImport).toContain('journeyMode: "auto"');
    expect(financeImport).toContain("resumeReadinessFromCallback: true");
    expect(coordinator).toContain("PreVaultUserStateService.settleOnboardingCapability");
    expect(coordinator).toContain("resolveSetupCapabilityJourneyMode");
    expect(coordinator).toContain("resolveSetupCapabilityReturnTarget");
    expect(coordinator).toContain("hasExplicitIncompleteSetup");
    expect(coordinator).toContain("setCallbackReadiness(true)");
  });

  it("lets resolved Finance re-entry start Plaid without setup callback writes", () => {
    const flow = read("components/kai/kai-flow.tsx");
    const plaidConnect = flow.slice(
      flow.indexOf("const handleConnectPlaid"),
      flow.indexOf("useEffect(() => {\n    if (!resumePlaidAfterVault)"),
    );

    expect(flow).toContain("function isActiveFinanceSetupJourney");
    expect(plaidConnect).toContain("let shouldSettleSetupSource = false;");
    expect(plaidConnect).toContain("if (isActiveFinanceSetupJourney(journey))");
    expect(plaidConnect).toContain(
      "} else if (!PreVaultUserStateService.isSetupResolved(journey))",
    );
    expect(plaidConnect).toContain(
      "Resolved-root re-entry is explicit user intent",
    );
    expect(plaidConnect).toContain("returnPath: shouldSettleSetupSource");
    expect(plaidConnect).toContain(
      "if (onSetupSourceSettled && !shouldSettleSetupSource)",
    );
  });

  it("does not send an unconfirmed Finance source choice to Kai", () => {
    const flow = read("components/kai/kai-flow.tsx");
    const settlement = flow.slice(
      flow.indexOf("const finishFinanceSetupIfActive"),
      flow.indexOf("const {\n    data: financialResource"),
    );

    expect(settlement).toContain("Finance setup could not be confirmed");
    expect(settlement).toContain("return true;");
  });
});
