import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/one/location",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "user_1" }, loading: false }),
}));

vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: ReactNode }) => (
    <div data-testid="vault-lock-guard">{children}</div>
  ),
}));

vi.mock("@/components/auth/phone-mandate-guard", () => ({
  PhoneMandateGuard: ({ children }: { children: ReactNode }) => (
    <div data-testid="phone-mandate-guard">{children}</div>
  ),
}));

// OneAuthGate only composes the guard chain; OneOnboardingGuard's internal
// router/auth/vault wiring is exercised by its own suite, so stub it to a
// passthrough here to keep this test focused on the composition contract.
vi.mock("@/components/kai/onboarding/kai-onboarding-guard", () => ({
  OneOnboardingGuard: ({ children }: { children: ReactNode }) => (
    <div data-testid="one-onboarding-guard">{children}</div>
  ),
}));

import { OneAuthGate } from "@/app/one/one-auth-gate";

describe("OneAuthGate", () => {
  beforeEach(() => {
    mocks.pathname = "/one/location";
  });

  it("renders public temporary location links without the login guards", () => {
    mocks.pathname = "/one/location/view/public-token";

    render(
      <OneAuthGate>
        <div>shared location</div>
      </OneAuthGate>,
    );

    expect(screen.getByText("shared location")).toBeTruthy();
    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.queryByTestId("phone-mandate-guard")).toBeNull();
  });

  it("keeps the pre-rename link path public too", () => {
    // Links minted before the page moved to /view still carry /request. If
    // this prefix stopped being public they would land on /login instead of
    // on the forwarder that takes them to the right page — which is exactly
    // what a recipient with no Hushh account cannot get past.
    mocks.pathname = "/one/location/request/public-token";

    render(
      <OneAuthGate>
        <div>legacy shared location</div>
      </OneAuthGate>,
    );

    expect(screen.getByText("legacy shared location")).toBeTruthy();
    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.queryByTestId("phone-mandate-guard")).toBeNull();
  });

  it("uses the default vault gate for private Location routes", () => {
    mocks.pathname = "/one/location";

    render(
      <OneAuthGate>
        <div>private one surface</div>
      </OneAuthGate>,
    );

    expect(screen.getByTestId("vault-lock-guard")).toBeTruthy();
    expect(screen.getByTestId("phone-mandate-guard")).toBeTruthy();
    expect(screen.getByText("private one surface")).toBeTruthy();
  });

  it.each(["/one/profile", "/one/connect", "/one/connected-systems"])(
    "uses the hard vault gate for %s",
    (pathname) => {
      mocks.pathname = pathname;

      render(
        <OneAuthGate>
          <div>private one surface</div>
        </OneAuthGate>,
      );

      expect(screen.getByTestId("vault-lock-guard")).toBeTruthy();
      expect(screen.getByTestId("phone-mandate-guard")).toBeTruthy();
    },
  );

  it("keeps the Gmail OAuth callback signed-in-gated without requiring an in-memory vault key", () => {
    mocks.pathname = "/one/profile/gmail/oauth/return";

    render(
      <OneAuthGate>
        <div>oauth callback</div>
      </OneAuthGate>,
    );

    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.getByTestId("phone-mandate-guard")).toBeTruthy();
    expect(screen.getByText("oauth callback")).toBeTruthy();
  });

  it("shows the Calendar connection workspace after OAuth without reopening the vault", () => {
    mocks.pathname = "/one/calendar";

    render(
      <OneAuthGate>
        <div>calendar connection</div>
      </OneAuthGate>,
    );

    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.getByTestId("phone-mandate-guard")).toBeTruthy();
    expect(screen.getByText("calendar connection")).toBeTruthy();
  });

  it("lets a signed-in user approve a trusted device without unlocking the browser vault", () => {
    mocks.pathname = "/one/profile/security/devices/authorize";

    render(
      <OneAuthGate>
        <div>trusted device approval</div>
      </OneAuthGate>,
    );

    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.getByTestId("phone-mandate-guard")).toBeTruthy();
    expect(screen.getByText("trusted device approval")).toBeTruthy();
  });

  it.each([
    "/one/setup",
    "/one/setup/connections",
    "/one/setup/location",
    "/one/setup/finance",
  ])(
    "keeps the resumable setup surface signed-in-gated without the hard vault gate for %s",
    (pathname) => {
      mocks.pathname = pathname;

      render(
        <OneAuthGate>
          <div>resumable setup</div>
        </OneAuthGate>,
      );

      expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
      expect(screen.getByTestId("phone-mandate-guard")).toBeTruthy();
      expect(screen.getByText("resumable setup")).toBeTruthy();
    },
  );

  it("keeps circle-invite claim links guarded because claiming needs an account", () => {
    mocks.pathname = "/one/location/invite/circle-token";

    render(
      <OneAuthGate>
        <div>circle invite</div>
      </OneAuthGate>,
    );

    expect(screen.getByTestId("vault-lock-guard")).toBeTruthy();
    expect(screen.getByTestId("phone-mandate-guard")).toBeTruthy();
  });
});
