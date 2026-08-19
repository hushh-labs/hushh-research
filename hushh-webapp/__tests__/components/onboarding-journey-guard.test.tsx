import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingJourneyGuard } from "@/components/onboarding/onboarding-journey-guard";
import {
  resolveUserEntryState,
  type UserEntryState,
} from "@/lib/onboarding/user-entry-state";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/one",
  entry: null as UserEntryState | null,
  activeCapability: null as string | null,
  failed: false,
  funnelExitInFlight: false,
  retry: vi.fn(),
}));

// App Router hands back a stable router; an unstable identity would re-run the
// guard's effect for reasons that have nothing to do with the decision.
const stableRouter = { push: mocks.push, replace: mocks.replace };

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => stableRouter,
}));

vi.mock("@/lib/onboarding/onboarding-entry-context", () => ({
  useOnboardingEntry: () => ({
    entry: mocks.entry,
    activeCapability: mocks.activeCapability,
    hasVault: null,
    failed: mocks.failed,
    funnelExitInFlight: mocks.funnelExitInFlight,
    beginFunnelExit: vi.fn(),
    retry: mocks.retry,
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
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock("@/lib/auth/use-session-chrome-suppression", () => ({
  useSessionChromeSuppression: () => undefined,
}));

/**
 * Build a real decision rather than hand-writing one, so a change to the
 * resolver that would break the guard shows up here instead of passing against
 * a fixture that no longer matches what the app produces.
 */
function decisionFor(
  step: "booting" | "auth" | "phone_auth" | "vault_setup" | "one_setup" | "main_app",
): UserEntryState {
  const base = {
    environmentResolved: true,
    authResolved: true,
    userId: "user-1" as string | null,
    phoneVerified: true as boolean | null,
    hasVault: true as boolean | null,
    vaultUnlocked: true,
    setupCompleted: true as boolean | null,
    phoneMandateWaived: false,
  };
  const byStep = {
    booting: { ...base, authResolved: false },
    auth: { ...base, userId: null },
    phone_auth: { ...base, phoneVerified: false },
    vault_setup: { ...base, setupCompleted: false, vaultUnlocked: false, hasVault: false },
    one_setup: { ...base, setupCompleted: false },
    main_app: base,
  } as const;
  const state = resolveUserEntryState(byStep[step]);
  expect(state.step).toBe(step);
  return state;
}

function renderAt(pathname: string, step: Parameters<typeof decisionFor>[0]) {
  mocks.pathname = pathname;
  mocks.entry = decisionFor(step);
  return render(
    <OnboardingJourneyGuard>
      <p>route content</p>
    </OnboardingJourneyGuard>,
  );
}

describe("OnboardingJourneyGuard", () => {
  beforeEach(() => {
    mocks.push.mockReset();
    mocks.replace.mockReset();
    mocks.retry.mockReset();
    mocks.activeCapability = null;
    mocks.failed = false;
    mocks.funnelExitInFlight = false;
    mocks.pathname = "/one";
    mocks.entry = null;
  });

  describe("nothing renders from a guess", () => {
    it("holds every private route while the decision is unresolved", () => {
      renderAt("/one/location", "booting");
      expect(screen.queryByText("route content")).toBeNull();
      expect(mocks.replace).not.toHaveBeenCalled();
    });

    it("does not redirect while the decision is unresolved", () => {
      renderAt("/one/setup", "booting");
      expect(mocks.replace).not.toHaveBeenCalled();
    });

    it("lets public reading surfaces through without waiting on anything", () => {
      renderAt("/blog/some-post", "booting");
      expect(screen.getByText("route content")).toBeTruthy();
    });
  });

  describe("the funnel is one-way", () => {
    it.each([
      ["/login"],
      ["/register-phone"],
      ["/getting-started"],
      ["/one/setup"],
    ])("sends a finished person off %s and into the app", (route) => {
      renderAt(route, "main_app");
      expect(mocks.replace).toHaveBeenCalledWith("/one");
      expect(screen.queryByText("route content")).toBeNull();
    });

    it("never leaves a funnel screen in history when it moves somebody", () => {
      renderAt("/register-phone", "main_app");
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it("catches the trailing-slash shape the native shell serves", () => {
      renderAt("/register-phone/", "main_app");
      expect(mocks.replace).toHaveBeenCalledWith("/one");
    });

    it("catches the static-export index document too", () => {
      renderAt("/one/setup/index.html", "main_app");
      expect(mocks.replace).toHaveBeenCalledWith("/one");
    });

    it("moves somebody mid-funnel to their own step, not to the app", () => {
      renderAt("/register-phone", "one_setup");
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup");
    });

    it("leaves somebody alone on the step they are actually on", () => {
      renderAt("/register-phone", "phone_auth");
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(screen.getByText("route content")).toBeTruthy();
    });

    it("lets a signed-out visitor reach sign-in", () => {
      renderAt("/login", "auth");
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(screen.getByText("route content")).toBeTruthy();
    });
  });

  describe("setup admission", () => {
    it("holds a product route until the funnel is finished", () => {
      renderAt("/one/location", "one_setup");
      expect(mocks.replace).toHaveBeenCalledWith(
        "/one/setup?return_to=%2Fone%2Flocation",
      );
      expect(screen.queryByText("route content")).toBeNull();
    });

    it("keeps the query when it sends somebody back to setup", () => {
      mocks.pathname = "/one/location";
      mocks.entry = decisionFor("one_setup");
      window.history.replaceState({}, "", "/one/location?view=people");
      render(
        <OnboardingJourneyGuard>
          <p>route content</p>
        </OnboardingJourneyGuard>,
      );
      expect(mocks.replace).toHaveBeenCalledWith(
        "/one/setup?return_to=%2Fone%2Flocation%3Fview%3Dpeople",
      );
      window.history.replaceState({}, "", "/");
    });

    it("admits the setup hub while the funnel is still running", () => {
      renderAt("/one/setup", "one_setup");
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(screen.getByText("route content")).toBeTruthy();
    });

    it("admits the Connections step of setup", () => {
      renderAt("/one/setup/connections", "one_setup");
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(screen.getByText("route content")).toBeTruthy();
    });

    it("admits the capability the record says is mid-setup", () => {
      mocks.activeCapability = "location";
      renderAt("/one/setup/location", "one_setup");
      expect(mocks.replace).not.toHaveBeenCalled();
    });

    it("still gates the Location workspace when only Location is done", () => {
      // Finishing one capability is not finishing setup. Only the hub's own
      // Finish action ends the funnel.
      mocks.activeCapability = "location";
      renderAt("/one/location", "one_setup");
      expect(mocks.replace).toHaveBeenCalledWith(
        "/one/setup?return_to=%2Fone%2Flocation",
      );
    });

    it("keeps the investor-preferences wizard reachable after the funnel ends", () => {
      renderAt("/one/setup/finance", "main_app");
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(screen.getByText("route content")).toBeTruthy();
    });

    it("keeps that wizard's import terminal reachable too", () => {
      renderAt("/one/setup/finance/import", "main_app");
      expect(mocks.replace).not.toHaveBeenCalled();
    });

    it.each([
      ["/one/setup/gmail", "/one/gmail"],
      ["/one/setup/location", "/one/location"],
      ["/one/setup/calendar", "/one/calendar"],
      ["/one/setup/email", "/one/kyc"],
      ["/one/setup/ria", "/ria/onboarding"],
      ["/one/setup/connected-systems", "/one/connected-systems"],
    ])(
      "sends a capability handoff to that capability's own workspace, not home: %s",
      (route, workspace) => {
        renderAt(route, "main_app");
        expect(mocks.replace).toHaveBeenCalledWith(workspace);
        expect(screen.queryByText("route content")).toBeNull();
      },
    );

    it("catches the trailing-slash shape of a capability handoff too", () => {
      renderAt("/one/setup/gmail/", "main_app");
      expect(mocks.replace).toHaveBeenCalledWith("/one/gmail");
    });

    it("still sends the bare setup hub home — it names no capability to hand off to", () => {
      renderAt("/one/setup", "main_app");
      expect(mocks.replace).toHaveBeenCalledWith("/one");
    });

    it("still sends the Connections step home — it configures the account, not a capability", () => {
      renderAt("/one/setup/connections", "main_app");
      expect(mocks.replace).toHaveBeenCalledWith("/one");
    });

    it("labels a capability handoff honestly instead of claiming to return to setup", () => {
      renderAt("/one/setup/gmail", "main_app");
      expect(screen.getByText("Opening...")).toBeTruthy();
      expect(screen.queryByText("Returning to setup...")).toBeNull();
    });

    it("stands aside while the hub is committing its own completion", () => {
      // Completion is written durably before the hub navigates, so for a frame
      // the decision says "finished" while the person is still on the hub.
      // Ejecting there unmounts the hub before it can move — and only the hub
      // knows the destination is sometimes the portfolio-import step.
      mocks.funnelExitInFlight = true;
      renderAt("/one/setup", "main_app");
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(screen.getByText("route content")).toBeTruthy();
    });

    it("does not let that hand-off keep any other route open", () => {
      mocks.funnelExitInFlight = true;
      renderAt("/register-phone", "main_app");
      expect(mocks.replace).toHaveBeenCalledWith("/one");
    });
  });

  describe("a broken record never traps anybody", () => {
    it("keeps Profile reachable so sign-out and deletion stay available", () => {
      mocks.failed = true;
      renderAt("/one/profile/security", "booting");
      expect(screen.getByText("route content")).toBeTruthy();
    });

    it("offers a retry and a way to Profile when the record cannot be read", () => {
      mocks.failed = true;
      // A failed read is exactly the case where the decision stays unresolved,
      // so the recovery UI has to win over the loader or nobody ever sees it.
      renderAt("/one/location", "booting");
      screen.getByText("Retry").click();
      expect(mocks.retry).toHaveBeenCalled();
      expect(screen.getByText("Open profile")).toBeTruthy();
    });
  });
});
