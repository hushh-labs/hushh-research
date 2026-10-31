import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FinanceSetupPage from "@/app/one/setup/kai/page";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const setup = vi.hoisted(() => ({
  user: { uid: "synthetic-owner" }, owner: "synthetic-owner", router: { replace: vi.fn() },
  query: new URLSearchParams(), save: vi.fn(), bootstrap: vi.fn(), sync: vi.fn(), error: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => setup.router, usePathname: () => "/one/setup/finance", useSearchParams: () => setup.query }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: setup.user, userId: setup.owner, loading: false }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: false, vaultKey: null, vaultOwnerToken: null }) }));
vi.mock("@/lib/testing/native-test", () => ({ useNativeTestConfig: () => ({ enabled: false }) }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: () => undefined }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: setup.error } }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/services/onboarding-route-cookie", () => ({ setOnboardingRequiredCookie: vi.fn(), setOnboardingFlowActiveCookie: vi.fn() }));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: { checkVault: async () => false } }));
vi.mock("@/lib/services/kai-profile-service", () => ({ KaiProfileService: {}, computeRiskScore: () => 3, mapRiskProfile: () => "balanced", resolveKaiOnboardingCompletion: () => ({ completed: false }) }));
vi.mock("@/lib/services/pre-vault-onboarding-service", () => ({ PreVaultOnboardingService: { load: async () => null, saveDraft: setup.save } }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { bootstrapState: setup.bootstrap, syncOnboardingJourney: setup.sync, isSetupResolved: () => false } }));
vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({ useSetupCapabilityCoordinator: () => ({ isReady: true }), SetupCapabilityLoading: () => null, SetupCapabilityTerminalFooter: () => null }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: () => null }));
vi.mock("@/components/kai/onboarding/kai-invite-handshake", () => ({ KaiInviteHandshake: () => null }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: () => null }));

afterEach(() => { cleanup(); publishValidatedAuthSessionOwner(null); });

describe("Finance setup preference continuation", () => {
  const answers = { investment_horizon: "short_term", drawdown_response: "stay", volatility_preference: "moderate" };
  const journey = { onboardingActiveCapability: "finance", onboardingPhase: "capability_setup", onboardingJourneyUpdatedAt: "synthetic-v1" };
  beforeEach(() => {
    vi.clearAllMocks(); setup.owner = "synthetic-owner";
    publishValidatedAuthSessionOwner(setup.owner);
    setup.bootstrap.mockReset().mockResolvedValue(journey);
    setup.sync.mockReset().mockResolvedValue(journey);
    setup.save.mockReset().mockResolvedValue({ answers, risk_score: 3, risk_profile: "balanced" });
  });
  async function fill() {
    await screen.findByRole("heading", { name: "Your investment preferences" });
    expect(screen.getAllByRole("radiogroup")).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: "Less than 3 years" }));
    fireEvent.click(screen.getByRole("radio", { name: "Stay invested and review the situation" }));
    fireEvent.click(screen.getByRole("radio", { name: "Moderate ups and downs for better returns" }));
    await waitFor(() => expect(setup.save).toHaveBeenCalledTimes(3));
  }
  it("saves once for touch and concurrent voice, then enters import through the fresh journey CAS", async () => {
    let finish!: (value: object) => void;
    render(createElement(FinanceSetupPage)); await fill();
    setup.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
    await waitFor(() => expect(setup.save).toHaveBeenCalledTimes(4));
    await act(async () => {
      expect((await resolveLocalOnboardingHandler("kai.setup.launch_dashboard")!({})).status).toBe("blocked");
    });
    expect(setup.sync).not.toHaveBeenCalled(); expect(setup.router.replace).not.toHaveBeenCalled();
    await act(async () => { finish({ answers }); });
    await waitFor(() => expect(setup.router.replace).toHaveBeenCalledWith("/one/setup/finance/import"));
    expect(setup.save).toHaveBeenCalledTimes(4);
    expect(setup.save).toHaveBeenLastCalledWith("synthetic-owner", { answers, risk_score: 3, risk_profile: "balanced" });
    expect(setup.sync).toHaveBeenCalledWith({ userId: "synthetic-owner", phase: "capability_setup", activeCapability: "finance", callbackState: "none", expectedJourneyUpdatedAt: "synthetic-v1" });
    expect(screen.queryByText("Continue Finance Setup")).toBeNull();
  });
  it.each(["save", "CAS", "other capability"])("keeps a %s refusal retryable without navigating", async failure => {
    if (failure === "CAS") setup.sync.mockRejectedValueOnce(new Error("synthetic CAS refusal"));
    render(createElement(FinanceSetupPage)); await fill();
    if (failure === "save") setup.save.mockRejectedValueOnce(new Error("synthetic save refusal"));
    if (failure === "other capability") setup.bootstrap.mockResolvedValueOnce({ ...journey, onboardingActiveCapability: "gmail" });
    await act(async () => {
      expect((await resolveLocalOnboardingHandler("kai.setup.launch_dashboard")!({})).status).toBe("failed");
    });
    expect(setup.router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    if (failure !== "CAS") expect(setup.sync).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true })); });
    await waitFor(() => expect(setup.router.replace).toHaveBeenCalledWith("/one/setup/finance/import"));
  });
  it.each(["owner change", "same-owner sign-out", "vault lock"])("does not advance a pending save after %s", async retirement => {
    let finish!: (value: object) => void;
    const view = render(createElement(FinanceSetupPage)); await fill();
    setup.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
    await waitFor(() => expect(setup.save).toHaveBeenCalledTimes(4));
    if (retirement === "owner change") {
      setup.owner = "synthetic-next-owner"; publishValidatedAuthSessionOwner(setup.owner);
      view.rerender(createElement(FinanceSetupPage));
    } else if (retirement === "same-owner sign-out") {
      publishValidatedAuthSessionOwner(null); publishValidatedAuthSessionOwner(setup.owner);
    } else advanceVaultSessionEpoch();
    await act(async () => { finish({ answers }); });
    expect(setup.sync).not.toHaveBeenCalled(); expect(setup.router.replace).not.toHaveBeenCalled();
    expect(setup.error).not.toHaveBeenCalled();
  });
});

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
    expect(guard).toContain("bootstrapState(userId)");
    expect(guard).toContain("withAdmissionTimeout(");
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

  // Owner-admitted auth handoff and delayed native restoration are exercised
  // against NativeTestBootstrap in native-test-bootstrap-retry.test.tsx and
  // native-test-bootstrap-persisted-session.test.tsx. A source-string fallback
  // assertion here would require bypassing that application's owner admission.

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
    expect(plaidConnect).toContain("sealVaultPlaidConnection({");
    expect(plaidConnect).toContain("vaultOwnerToken: effectiveVaultOwnerToken");
    // Ordinary resolved-root re-entry still bypasses setup settlement, but a
    // pending invitation must remain on the import's explicit terminal.
    expect(plaidConnect).toMatch(
      /if\s*\(\s*onSetupSourceSettled\s*&&\s*!shouldSettleSetupSource\s*&&\s*!hasSetupContinuation\s*\)/,
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
