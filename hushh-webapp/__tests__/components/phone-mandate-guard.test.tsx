import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import {
  resolveUserEntryState,
  type UserEntryState,
} from "@/lib/onboarding/user-entry-state";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: "/one/location",
  search: "",
  entry: null as UserEntryState | null,
  hasVault: null as boolean | null,
}));

const stableRouter = { replace: mocks.replace };

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => stableRouter,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("@/lib/onboarding/onboarding-entry-context", () => ({
  useOnboardingEntry: () => ({
    entry: mocks.entry,
    activeCapability: null,
    hasVault: mocks.hasVault,
    failed: false,
    retry: vi.fn(),
  }),
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <p>{label}</p>,
}));

vi.mock("@/lib/auth/use-session-chrome-suppression", () => ({
  useSessionChromeSuppression: () => undefined,
}));

function decision(overrides: {
  environmentResolved?: boolean;
  authResolved?: boolean;
  userId?: string | null;
  phoneVerified?: boolean | null;
  phoneMandateWaived?: boolean;
}): UserEntryState {
  return resolveUserEntryState({
    environmentResolved: true,
    authResolved: true,
    userId: "user-1",
    phoneVerified: true,
    hasVault: true,
    vaultUnlocked: true,
    setupCompleted: true,
    phoneMandateWaived: false,
    ...overrides,
  });
}

function renderGuard(props: { exemptVaultUsers?: boolean } = {}) {
  return render(
    <PhoneMandateGuard exemptVaultUsers={props.exemptVaultUsers}>
      <p>protected content</p>
    </PhoneMandateGuard>,
  );
}

describe("PhoneMandateGuard", () => {
  beforeEach(() => {
    mocks.replace.mockReset();
    mocks.pathname = "/one/location";
    mocks.search = "";
    mocks.hasVault = null;
    mocks.entry = decision({});
  });

  it("sends somebody whose step is phone verification to the phone screen", () => {
    mocks.entry = decision({ phoneVerified: false });
    renderGuard();
    expect(mocks.replace).toHaveBeenCalledWith(
      "/register-phone?redirect=%2Fone%2Flocation",
    );
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("carries the query of the route it interrupted", () => {
    mocks.entry = decision({ phoneVerified: false });
    mocks.search = "view=people";
    renderGuard();
    expect(mocks.replace).toHaveBeenCalledWith(
      "/register-phone?redirect=%2Fone%2Flocation%3Fview%3Dpeople",
    );
  });

  it("does not send the phone screen to itself", () => {
    mocks.entry = decision({ phoneVerified: false });
    mocks.pathname = "/register-phone";
    renderGuard();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText("protected content")).toBeTruthy();
  });

  it("recognises the trailing-slash phone route the native shell serves", () => {
    mocks.entry = decision({ phoneVerified: false });
    mocks.pathname = "/register-phone/";
    renderGuard();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("leaves a verified person alone", () => {
    renderGuard();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText("protected content")).toBeTruthy();
  });

  it("shows no loader on a warm transition for a verified person", () => {
    // A loader here was a visible flash on every navigation into Profile.
    renderGuard();
    expect(screen.queryByText("Checking session...")).toBeNull();
  });

  it("waits for the host before deciding, so localhost is never read as remote", () => {
    mocks.entry = decision({ environmentResolved: false });
    renderGuard();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("asks for nothing when the phone step does not apply", () => {
    // Localhost development, the native route-audit bridge, and the adviser
    // claim route all waive it.
    mocks.entry = decision({ phoneVerified: false, phoneMandateWaived: true });
    renderGuard();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText("protected content")).toBeTruthy();
  });

  it("keeps an established lock owner inside Profile without a phone", () => {
    // Profile is where sign-out and account deletion live. An account that
    // already owns a lock must never be shut out of it.
    mocks.entry = decision({ phoneVerified: false });
    mocks.hasVault = true;
    renderGuard({ exemptVaultUsers: true });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText("protected content")).toBeTruthy();
  });

  it("does not extend that exemption to an account with no lock", () => {
    mocks.entry = decision({ phoneVerified: false });
    mocks.hasVault = false;
    renderGuard({ exemptVaultUsers: true });
    expect(mocks.replace).toHaveBeenCalled();
  });

  it("does not extend it while lock ownership is still unknown", () => {
    mocks.entry = decision({ phoneVerified: false });
    mocks.hasVault = null;
    renderGuard({ exemptVaultUsers: true });
    expect(mocks.replace).toHaveBeenCalled();
  });

  it("hands an anonymous visitor to the route's own sign-in gate", () => {
    mocks.entry = decision({ userId: null });
    renderGuard();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText("protected content")).toBeTruthy();
  });

  it("replaces rather than pushes, so the phone screen leaves no history entry", () => {
    mocks.entry = decision({ phoneVerified: false });
    renderGuard();
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });
});
