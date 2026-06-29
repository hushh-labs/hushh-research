import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/one/location",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
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
    mocks.pathname = "/one/location/request/public-token";

    render(
      <OneAuthGate>
        <div>shared location</div>
      </OneAuthGate>,
    );

    expect(screen.getByText("shared location")).toBeTruthy();
    expect(screen.queryByTestId("vault-lock-guard")).toBeNull();
    expect(screen.queryByTestId("phone-mandate-guard")).toBeNull();
  });

  it("keeps private One routes behind the vault + phone login guards", () => {
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
