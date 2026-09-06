import fs from "node:fs";
import path from "node:path";

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingJourneyGuard } from "@/components/onboarding/onboarding-journey-guard";
import {
  clearSetupIntent,
  markSetupIntent,
} from "@/lib/services/one-setup-intent";

const {
  push,
  replace,
  bootstrapStateMock,
  getCachedBootstrapStateMock,
  isPersistentSetupResolvedMock,
  isOnboardingAdmissionExemptRouteMock,
  authState,
  retrySessionVerification,
  signOut,
} = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  bootstrapStateMock: vi.fn(),
  getCachedBootstrapStateMock: vi.fn(),
  isPersistentSetupResolvedMock: vi.fn(),
  isOnboardingAdmissionExemptRouteMock: vi.fn(),
  authState: {
    user: { uid: "journey-user" } as { uid: string } | null,
    loading: false,
    sessionVerificationRequired: false,
  },
  retrySessionVerification: vi.fn(),
  signOut: vi.fn(),
}));

let pathnameValue = "/one/setup";

// App Router returns a stable router instance; an unstable identity would
// spuriously re-run the guard effect (its deps include `router`).
const stableRouter = { push, replace };

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
  useRouter: () => stableRouter,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    ...authState,
    retrySessionVerification,
    signOut,
  }),
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <p>{label}</p>,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: {
    ONE_SETUP: "/one/setup",
    ONE_SETUP_FINANCE: "/one/setup/finance",
    ONE_HOME: "/one",
    PROFILE: "/one/profile",
  },
  buildOneSetupRoute: ({ returnTo }: { returnTo: string }) =>
    `/one/setup?return_to=${encodeURIComponent(returnTo)}`,
  isCapabilityOnboardingRoute: () => false,
  isOnboardingAdmissionExemptRoute: isOnboardingAdmissionExemptRouteMock,
  normalizeStaticExportPathname: (pathname: string) =>
    pathname.replace(/\/index\.html$/i, "").replace(/\/+$/, "") || "/",

  isOneSetupRoute: (pathname: string) =>
    pathname.replace(/\/index\.html$/i, "").replace(/\/+$/, "") ===
    "/one/setup",
  isOneSetupSurfaceRoute: (pathname: string) =>
    pathname === "/one/setup" ||
    pathname === "/one/setup/connections" ||
    pathname === "/one/setup/finance",
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: bootstrapStateMock,
    getCachedBootstrapState: getCachedBootstrapStateMock,
    isSetupResolved: (state: { setupCompleted?: boolean | null }) =>
      state.setupCompleted === true,
  },
}));

vi.mock("@/lib/services/one-setup-completion-hint-service", () => ({
  OneSetupCompletionHintService: {
    isResolved: isPersistentSetupResolvedMock,
    // Native-durable rehydration mirrors the positive latch: on web (test env)
    // it resolves to the current latch value, so an unresolved user still falls
    // through to the network bootstrap path these cases assert.
    hydrateFromNative: vi.fn(async () => isPersistentSetupResolvedMock()),
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
    push.mockReset();
    replace.mockReset();
    bootstrapStateMock.mockReset();
    getCachedBootstrapStateMock.mockReset();
    isPersistentSetupResolvedMock.mockReset();
    isPersistentSetupResolvedMock.mockReturnValue(false);
    isOnboardingAdmissionExemptRouteMock.mockReset();
    isOnboardingAdmissionExemptRouteMock.mockReturnValue(false);
    authState.user = { uid: "journey-user" };
    authState.loading = false;
    authState.sessionVerificationRequired = false;
    retrySessionVerification.mockReset();
    signOut.mockReset();
    pathnameValue = "/one/setup";
    window.history.replaceState(null, "", "/one/setup");
    clearSetupIntent();
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

  it("admits a returning user synchronously from the positive setup latch", async () => {
    pathnameValue = "/one";
    getCachedBootstrapStateMock.mockReturnValue(null);
    isPersistentSetupResolvedMock.mockReturnValue(true);

    render(
      <OnboardingJourneyGuard>
        <div>one home</div>
      </OnboardingJourneyGuard>,
    );

    expect(screen.getByText("one home")).toBeTruthy();
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

  it("ejects a dismissed user who reaches a setup surface", async () => {
    // Post-onboarding, any setup arrival is ejected — the root flow is one-time.
    pathnameValue = "/one/setup";
    isPersistentSetupResolvedMock.mockReturnValue(true); // dismissed
    clearSetupIntent();

    render(
      <OnboardingJourneyGuard>
        <div>hub</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one");
    });
    expect(screen.queryByText("hub")).toBeNull();
  });

  it("ejects a stale deliberate setup intent after onboarding resolves", async () => {
    pathnameValue = "/one/setup";
    isPersistentSetupResolvedMock.mockReturnValue(true); // dismissed
    markSetupIntent();

    render(
      <OnboardingJourneyGuard>
        <div>hub</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/one");
    });
    expect(screen.queryByText("hub")).toBeNull();
  });

  it("admits unfinished Finance setup after root onboarding resolves", async () => {
    pathnameValue = "/one/setup/finance";
    window.history.replaceState(null, "", pathnameValue);
    isPersistentSetupResolvedMock.mockReturnValue(true);

    render(
      <OnboardingJourneyGuard>
        <div>finance setup</div>
      </OnboardingJourneyGuard>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("finance setup")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
  });

  it("admits a setup surface during first onboarding (not dismissed)", async () => {
    pathnameValue = "/one/setup";
    isPersistentSetupResolvedMock.mockReturnValue(false); // not dismissed
    getCachedBootstrapStateMock.mockReturnValue(null);

    render(
      <OnboardingJourneyGuard>
        <div>hub</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(screen.getByText("hub")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("gates the Location workspace until overall setup is finished, even when Location is done", async () => {
    // Completing the Location capability alone must NOT unlock the main
    // Location workspace. The user still has to return to /one/setup and
    // finish setup (which requires Connections). Direct navigation to
    // /one/location while setup is unresolved is redirected back to setup.
    pathnameValue = "/one/location";
    window.history.replaceState(null, "", pathnameValue);
    getCachedBootstrapStateMock.mockReturnValue({
      ...incompleteSetupState(),
      setupCapabilityIds: ["location"],
    });

    render(
      <OnboardingJourneyGuard>
        <div>location workspace</div>
      </OnboardingJourneyGuard>,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/one/setup?return_to=%2Fone%2Flocation",
      );
    });
    expect(screen.queryByText("location workspace")).toBeNull();
  });

  it("does not replace a Connect-origin person profile with setup or One home", async () => {
    pathnameValue = "/people/person-ref-scoped";
    window.history.replaceState(
      null,
      "",
      "/people/person-ref-scoped?from=/one/connect",
    );
    isOnboardingAdmissionExemptRouteMock.mockReturnValue(true);
    getCachedBootstrapStateMock.mockReturnValue(null);

    render(
      <OnboardingJourneyGuard>
        <div>person profile</div>
      </OnboardingJourneyGuard>,
    );

    expect(screen.getByText("person profile")).toBeTruthy();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("admits the canonical setup hub even when setup is incomplete", async () => {
    pathnameValue = "/one/setup";
    bootstrapStateMock.mockResolvedValue(incompleteSetupState());
    getCachedBootstrapStateMock.mockReturnValue(null);

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

  it("admits Connections as a root-setup navigation surface", async () => {
    pathnameValue = "/one/setup/connections";
    window.history.replaceState(null, "", pathnameValue);
    getCachedBootstrapStateMock.mockReturnValue(incompleteSetupState());

    render(
      <OnboardingJourneyGuard>
        <div>connections choice</div>
      </OnboardingJourneyGuard>,
    );

    expect(screen.getByText("connections choice")).toBeTruthy();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("retries one transient bootstrap failure with a forced read", async () => {
    vi.useFakeTimers();
    pathnameValue = "/one";
    window.history.replaceState(null, "", "/one");
    getCachedBootstrapStateMock.mockReturnValue(null);
    bootstrapStateMock
      .mockRejectedValueOnce(new Error("token provider not ready"))
      .mockResolvedValueOnce({ setupCompleted: true });

    const view = render(
      <OnboardingJourneyGuard>
        <div>one home</div>
      </OnboardingJourneyGuard>,
    );

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(screen.getByText("one home")).toBeTruthy();
    expect(bootstrapStateMock).toHaveBeenNthCalledWith(1, "journey-user");
    expect(bootstrapStateMock).toHaveBeenNthCalledWith(2, "journey-user", {
      force: true,
    });
    view.unmount();
    vi.useRealTimers();
  });

  it("keeps setup recovery reachable after a persistent bootstrap failure", async () => {
    vi.useFakeTimers();
    pathnameValue = "/one";
    window.history.replaceState(null, "", "/one");
    getCachedBootstrapStateMock.mockReturnValue(null);
    bootstrapStateMock.mockRejectedValue(new Error("bootstrap unavailable"));

    const view = render(
      <OnboardingJourneyGuard>
        <div>one home</div>
      </OnboardingJourneyGuard>,
    );

    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(screen.getByText("Reconnect to continue securely")).toBeTruthy();
    expect(screen.queryByText(/unable to verify setup progress/i)).toBeNull();
    fireEvent.click(screen.getByText("Sign out"));
    expect(signOut).toHaveBeenCalledWith({ skipFcmCleanup: true });
    fireEvent.click(screen.getByText("Try again"));
    view.unmount();
    vi.useRealTimers();
  });

  it("preserves a query-bearing route in one idempotent setup redirect", async () => {
    pathnameValue = "/one/location";
    window.history.replaceState(null, "", "/one/location?tab=family");
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

  it("settles a Capacitor trailing-slash setup navigation without a false error", async () => {
    vi.useFakeTimers();
    pathnameValue = "/one";
    window.history.replaceState(null, "", "/one");
    bootstrapStateMock.mockResolvedValue(incompleteSetupState());
    getCachedBootstrapStateMock.mockReturnValue(null);
    replace.mockImplementation(() => {
      window.history.replaceState(null, "", "/one/setup/");
    });

    const view = render(
      <OnboardingJourneyGuard>
        <div>one home</div>
      </OnboardingJourneyGuard>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.getByText("one home")).toBeTruthy();
    expect(
      screen.queryByText("Unable to open setup. Please retry."),
    ).toBeNull();
    view.unmount();
    vi.useRealTimers();
  });

  it("clears a failed redirect target so Retry can navigate again", async () => {
    vi.useFakeTimers();
    pathnameValue = "/one";
    window.history.replaceState(null, "", "/one");
    bootstrapStateMock.mockResolvedValue(incompleteSetupState());
    getCachedBootstrapStateMock.mockReturnValue(null);

    const view = render(
      <OnboardingJourneyGuard>
        <div>one home</div>
      </OnboardingJourneyGuard>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(3600);
    });
    expect(screen.getByText("Reconnect to continue securely")).toBeTruthy();
    expect(screen.queryByText(/unable to open setup/i)).toBeNull();
    expect(replace).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByText("Try again"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(replace).toHaveBeenCalledTimes(3);

    view.unmount();
    vi.useRealTimers();
  });

  it("holds private routes behind app-wide session verification recovery", () => {
    pathnameValue = "/one";
    window.history.replaceState(null, "", pathnameValue);
    authState.sessionVerificationRequired = true;

    render(
      <OnboardingJourneyGuard>
        <div>private account information</div>
      </OnboardingJourneyGuard>,
    );

    expect(screen.getByText("Reconnect to continue securely")).toBeTruthy();
    expect(screen.queryByText("private account information")).toBeNull();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Try again"));
    expect(retrySessionVerification).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Sign out"));
    expect(signOut).toHaveBeenCalledWith({ skipFcmCleanup: true });
  });

  it("keeps setup recovery inside the App Router", () => {
    const source = read("components/onboarding/onboarding-journey-guard.tsx");

    expect(source).toContain("SETUP_REDIRECT_RETRY_MS");
    expect(source).toContain("SETUP_REDIRECT_FAILURE_MS");
    expect(source).toContain("router.replace(redirectTarget)");
    expect(source).not.toContain("window.location.assign(redirectTarget)");
  });
});
