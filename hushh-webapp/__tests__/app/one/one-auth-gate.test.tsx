import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it.each(["/one/profile/account", "/one/profile/payouts"])("shows only an advisory popup return while an unmatched cold %s stays vault-gated", (path) => {
    mocks.pathname = path;
    window.history.replaceState({}, "", mocks.pathname + "?commerceReturn=1&commerceAttemptId=opaque_attempt_12345");
    const cold = render(<OneAuthGate><div>private payment information</div></OneAuthGate>);
    expect(screen.getByTestId("vault-lock-guard")).toBeTruthy();
    cold.unmount();
    window.localStorage.setItem("one_commerce_popup_v1:opaque_attempt_12345", JSON.stringify({ attemptId: "opaque_attempt_12345", purpose: "onboarding", expiresAt: Date.now() + 60000 }));
    vi.spyOn(window, "close").mockImplementation(() => undefined);
    render(<OneAuthGate><div>private payment information</div></OneAuthGate>);
    expect(screen.queryByText("private payment information")).toBeNull();
    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.getByText(/Return to your original One window/)).toBeTruthy();
  });

  it.each(["/one/profile/connectors/oauth/return", "/one/setup/cloud/azure/return"])("lets the exact %s callback own Firebase completion without a popup vault", (path) => {
    mocks.pathname = path;
    render(<OneAuthGate><div>connector callback</div></OneAuthGate>);
    expect(screen.getByText("connector callback")).toBeTruthy();
    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.queryByTestId("phone-mandate-guard")).toBeNull();
  });

  it.each(["/one/profile/connectors", "/one/profile/connectors/oauth/return/extra", "/one/setup/cloud/azure/return/extra", "/one/profile/security/devices/authorize/extra", "/one/profile/security/devices"])("retains hard authority for %s", pathname => {
    mocks.pathname=pathname;
    render(<OneAuthGate><div>protected connection management</div></OneAuthGate>);
    expect(screen.getByTestId("vault-lock-guard")).toBeTruthy();
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

  it("lets the exact device approval shell own sign-in and setup readiness", () => {
    mocks.pathname = "/one/profile/security/devices/authorize";

    render(
      <OneAuthGate>
        <div>trusted device approval</div>
      </OneAuthGate>,
    );

    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.queryByTestId("phone-mandate-guard")).toBeNull();
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

  it("admits public invite presentation; the page and API guard the actual claim", () => {
    mocks.pathname = "/one/location/invite/circle-token";

    render(
      <OneAuthGate>
        <div>circle invite</div>
      </OneAuthGate>,
    );

    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.queryByTestId("phone-mandate-guard")).toBeNull();
  });
});
