import fs from "node:fs";
import path from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/one",
  routerReplace: vi.fn(),
  bootstrapState: vi.fn(),
  auth: {
    user: { uid: "user-1" },
    loading: false,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({
    replace: mocks.routerReplace,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => (
    <div data-testid="hushh-loader">{label}</div>
  ),
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: mocks.bootstrapState,
    isSetupResolved: (state: { setupCompleted?: boolean | null }) =>
      state?.setupCompleted === true,
  },
}));

import { OnboardingJourneyGuard } from "@/components/onboarding/onboarding-journey-guard";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

function incompleteSetupState() {
  return {
    userId: "user-1",
    setupCompleted: false,
    onboardingJourneyVersion: 1,
    onboardingPhase: "setup_hub",
    onboardingActiveCapability: null,
  };
}

describe("OnboardingJourneyGuard", () => {
  beforeEach(() => {
    mocks.pathname = "/one";
    mocks.routerReplace.mockReset();
    mocks.bootstrapState.mockReset();
    mocks.auth = {
      user: { uid: "user-1" },
      loading: false,
    };
    window.history.replaceState(null, "", "/one");
  });

  it("redirects an explicitly incomplete One journey to the setup hub", async () => {
    mocks.bootstrapState.mockResolvedValue(incompleteSetupState());

    render(
      <OnboardingJourneyGuard>
        <div>one home</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith(
        "/one/setup?return_to=%2Fone",
      );
    });
    expect(screen.getByTestId("hushh-loader").textContent).toBe(
      "Returning to setup...",
    );
  });

  it("admits the canonical setup hub even when setup is incomplete", async () => {
    mocks.pathname = "/one/setup";
    window.history.replaceState(null, "", "/one/setup?return_to=%2Fone");
    mocks.bootstrapState.mockResolvedValue(incompleteSetupState());

    render(
      <OnboardingJourneyGuard>
        <div>setup hub</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(screen.getByText("setup hub")).toBeTruthy();
    });
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("keeps a hard setup fallback when App Router navigation does not commit", () => {
    const source = read("components/onboarding/onboarding-journey-guard.tsx");

    expect(source).toContain("SETUP_REDIRECT_WATCHDOG_MS");
    expect(source).toContain("router.replace(setupRoute)");
    expect(source).toContain("window.location.pathname !== ROUTES.ONE_SETUP");
    expect(source).toContain("window.location.assign(setupRoute)");
  });
});
