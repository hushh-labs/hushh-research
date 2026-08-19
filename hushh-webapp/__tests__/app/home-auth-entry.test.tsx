import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveUserEntryState,
  type UserEntryState,
} from "@/lib/onboarding/user-entry-state";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  resolveAfterLogin: vi.fn(),
  getIdToken: vi.fn(),
  user: { uid: "returning_user" } as { uid: string } | null,
  loading: false,
  phoneNumber: "+15555550100" as string | null,
  search: "",
  entry: null as UserEntryState | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mocks.user,
    loading: mocks.loading,
    phoneNumber: mocks.phoneNumber,
  }),
}));

vi.mock("@/lib/onboarding/onboarding-entry-context", () => ({
  useOnboardingEntry: () => ({
    entry: mocks.entry,
    activeCapability: null,
    hasVault: null,
    failed: false,
    funnelExitInFlight: false,
    beginFunnelExit: vi.fn(),
    retry: vi.fn(),
  }),
}));

vi.mock("@/lib/services/post-auth-route-service", () => ({
  PostAuthRouteService: { resolveAfterLogin: mocks.resolveAfterLogin },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: mocks.getIdToken },
}));

vi.mock("@/components/onboarding/IntroStep", () => ({
  IntroStep: () => <div>Welcome</div>,
}));
vi.mock("@/components/seo/json-ld", () => ({ JsonLd: () => null }));
vi.mock("@/lib/seo/structured-data", () => ({ buildFaqGraph: () => ({}) }));
vi.mock("@/lib/seo/faq-data", () => ({ HOME_FAQ: [] }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));
vi.mock("@/components/app-ui/native-route-marker", () => ({
  NativeRouteMarker: () => null,
}));
vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

import Home from "@/app/page";

function decision(overrides: Partial<Parameters<typeof resolveUserEntryState>[0]> = {}) {
  return resolveUserEntryState({
    environmentResolved: true,
    authResolved: true,
    userId: "returning_user",
    phoneVerified: true,
    hasVault: true,
    vaultUnlocked: true,
    setupCompleted: true,
    phoneMandateWaived: false,
    ...overrides,
  });
}

describe("authenticated root entry", () => {
  beforeEach(() => {
    mocks.replace.mockReset();
    mocks.resolveAfterLogin.mockReset();
    mocks.getIdToken.mockReset();
    mocks.user = { uid: "returning_user" };
    mocks.loading = false;
    mocks.phoneNumber = "+15555550100";
    mocks.search = "";
    mocks.entry = decision();
    mocks.getIdToken.mockResolvedValue("redacted-id-token");
    mocks.resolveAfterLogin.mockResolvedValue("/one");
  });

  it("uses the app-wide decision instead of resolving the destination a second time", async () => {
    // Landing here signed in means somebody backed onto the root. Re-deriving
    // the destination from `phoneNumber` alone — which Firebase leaves null for
    // a Google sign-in — is what used to forward-replace a fully verified
    // person onto phone verification.
    const view = render(<Home />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one"));
    expect(mocks.resolveAfterLogin).not.toHaveBeenCalled();

    view.rerender(<Home />);
    await Promise.resolve();
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });

  it("never sends a verified person to phone verification from here", async () => {
    mocks.phoneNumber = null;
    render(<Home />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
    expect(mocks.replace).not.toHaveBeenCalledWith(
      expect.stringContaining("/register-phone"),
    );
  });

  it("sends somebody who genuinely has not verified to the phone screen", async () => {
    mocks.entry = decision({ phoneVerified: false });
    render(<Home />);
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/register-phone"),
    );
  });

  it("waits rather than guessing while the decision is unresolved", async () => {
    mocks.entry = decision({ authResolved: false });
    render(<Home />);
    await Promise.resolve();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.resolveAfterLogin).not.toHaveBeenCalled();
  });

  it("still honours an explicit deep link through the post-auth resolver", async () => {
    mocks.search = "redirect=%2Fone%2Fkai";
    mocks.resolveAfterLogin.mockResolvedValue("/one/kai");
    render(<Home />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one/kai"));
    expect(mocks.resolveAfterLogin).toHaveBeenCalledTimes(1);
    expect(mocks.resolveAfterLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "returning_user",
        redirectPath: "/one/kai",
        idToken: "redacted-id-token",
        // The authoritative claim, so a deep link cannot bounce a verified
        // person either.
        phoneVerified: true,
      }),
    );
  });

  it("does not ask that resolver for the one-time setup nudge any more", async () => {
    // It only ever fired for somebody whose setup was already resolved — the
    // exact case the funnel is now closed to.
    mocks.search = "redirect=%2Fone%2Fkai";
    mocks.resolveAfterLogin.mockResolvedValue("/one/kai");
    render(<Home />);
    await waitFor(() => expect(mocks.resolveAfterLogin).toHaveBeenCalled());
    expect(mocks.resolveAfterLogin).not.toHaveBeenCalledWith(
      expect.objectContaining({ enableFirstRunSetupGate: true }),
    );
  });
});
