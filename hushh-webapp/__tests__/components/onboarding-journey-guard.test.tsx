import fs from "node:fs";
import path from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingJourneyGuard } from "@/components/onboarding/onboarding-journey-guard";

const { replace, bootstrapStateMock, getCachedBootstrapStateMock } = vi.hoisted(
  () => ({
    replace: vi.fn(),
    bootstrapStateMock: vi.fn(),
    getCachedBootstrapStateMock: vi.fn(),
  }),
);

let pathnameValue = "/one/setup";
let searchValue = "";

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(searchValue),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "journey-user" }, loading: false }),
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <p>{label}</p>,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: { ONE_SETUP: "/one/setup" },
  buildOneSetupRoute: ({ returnTo }: { returnTo: string }) =>
    `/one/setup?return_to=${encodeURIComponent(returnTo)}`,
  isCapabilityOnboardingRoute: () => false,
  isOnboardingAdmissionExemptRoute: () => false,
  isOneSetupSurfaceRoute: (pathname: string) => pathname === "/one/setup",
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: bootstrapStateMock,
    getCachedBootstrapState: getCachedBootstrapStateMock,
    isSetupResolved: (state: { setupCompleted?: boolean | null }) =>
      state.setupCompleted === true,
  },
}));

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

function incompleteSetupState() {
  return {
    setupCompleted: false,
    onboardingJourneyVersion: 1,
    onboardingPhase: "setup_hub",
    onboardingActiveCapability: null,
  };
}

describe("OnboardingJourneyGuard", () => {
  beforeEach(() => {
    replace.mockReset();
    bootstrapStateMock.mockReset();
    getCachedBootstrapStateMock.mockReset();
    pathnameValue = "/one/setup";
    searchValue = "";
  });

  it("admits a cached setup route without a bootstrap request or checking churn", async () => {
    getCachedBootstrapStateMock.mockReturnValue(incompleteSetupState());

    render(
      <OnboardingJourneyGuard>
        <div>setup hub</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(screen.getByText("setup hub")).toBeTruthy();
    });
    expect(screen.queryByText("Checking setup...")).toBeNull();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects an explicitly incomplete One journey to the setup hub", async () => {
    pathnameValue = "/one";
    bootstrapStateMock.mockResolvedValue(incompleteSetupState());
    getCachedBootstrapStateMock.mockReturnValue(null);

    render(
      <OnboardingJourneyGuard>
        <div>one home</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one/setup?return_to=%2Fone");
    });
    expect(screen.getByText("Returning to setup...")).toBeTruthy();
  });

  it("admits the canonical setup hub even when setup is incomplete", async () => {
    pathnameValue = "/one/setup";
    bootstrapStateMock.mockResolvedValue(incompleteSetupState());
    getCachedBootstrapStateMock.mockReturnValue(incompleteSetupState());

    render(
      <OnboardingJourneyGuard>
        <div>setup hub</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(screen.getByText("setup hub")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("preserves a query-bearing route in one idempotent setup redirect", async () => {
    pathnameValue = "/one/location";
    searchValue = "tab=family";
    bootstrapStateMock.mockResolvedValue(incompleteSetupState());
    getCachedBootstrapStateMock.mockReturnValue(null);

    const view = render(
      <OnboardingJourneyGuard>
        <div>location workspace</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/one/setup?return_to=%2Fone%2Flocation%3Ftab%3Dfamily",
      );
    });
    view.rerender(
      <OnboardingJourneyGuard>
        <div>location workspace</div>
      </OnboardingJourneyGuard>,
    );
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("keeps a hard setup fallback when App Router navigation does not commit", () => {
    const source = read("components/onboarding/onboarding-journey-guard.tsx");

    expect(source).toContain("SETUP_REDIRECT_WATCHDOG_MS");
    expect(source).toContain("router.replace(redirectTarget)");
    expect(source).toContain("window.location.pathname !== ROUTES.ONE_SETUP");
    expect(source).toContain("window.location.assign(redirectTarget)");
  });
});
