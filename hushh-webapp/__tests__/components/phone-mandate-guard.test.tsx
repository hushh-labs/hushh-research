import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";

const { replace, checkVaultMock, refreshCurrentUserIdentityMock } = vi.hoisted(() => ({
  replace: vi.fn(),
  checkVaultMock: vi.fn(),
  refreshCurrentUserIdentityMock: vi.fn(),
}));

let pathnameValue = "/profile";
let searchValue = "";
let authValue: {
  user: { uid: string } | null;
  loading: boolean;
  phoneNumber: string | null;
} = {
  user: { uid: "user-1" },
  loading: false,
  phoneNumber: null,
};

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
  useRouter: () => ({
    replace,
  }),
  useSearchParams: () => new URLSearchParams(searchValue),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => authValue,
}));

// Return the resolved hostname synchronously so the localhost bypass is
// deterministic from the first render. Non-localhost environments are still
// distinguished by NEXT_PUBLIC_APP_ENV (uat vs development), so this does not
// affect the non-bypass test cases.
vi.mock("@/lib/hooks/use-hostname", () => ({
  useHostname: () => "localhost",
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: checkVaultMock,
    // Cold cache by default so the guard falls through to the async checkVault
    // mock, preserving the existing test expectations.
    peekVaultPresence: () => null,
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    refreshCurrentUserIdentity: refreshCurrentUserIdentityMock,
    hasVerifiedPhone: (identity: { phone_verified?: boolean } | null | undefined) =>
      identity?.phone_verified === true,
    // Cold cache so the guard performs its async identity read via getIdentitySwr,
    // which here resolves from the same refresh mock the tests drive.
    peekCachedIdentity: () => null,
    getIdentitySwr: async () => ({
      identity: await refreshCurrentUserIdentityMock(),
      isStale: false,
    }),
  },
}));

describe("PhoneMandateGuard", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    replace.mockReset();
    checkVaultMock.mockReset();
    refreshCurrentUserIdentityMock.mockReset();
    refreshCurrentUserIdentityMock.mockResolvedValue(null);
    pathnameValue = "/profile";
    searchValue = "";
    authValue = {
      user: { uid: "user-1" },
      loading: false,
      phoneNumber: null,
    };
  });

  it("redirects no-vault users without a phone number to the phone mandate", async () => {
    checkVaultMock.mockResolvedValue(false);

    render(
      <PhoneMandateGuard exemptVaultUsers>
        <div>profile content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/register-phone?redirect=%2Fprofile");
    });
  });

  it("keeps existing vault users on exempt routes even without a phone number", async () => {
    authValue = {
      user: { uid: "user-2" },
      loading: false,
      phoneNumber: null,
    };
    checkVaultMock.mockResolvedValue(true);

    render(
      <PhoneMandateGuard exemptVaultUsers>
        <div>profile content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(screen.getByText("profile content")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not redirect users who already have a verified phone number", async () => {
    authValue = {
      user: { uid: "user-3" },
      loading: false,
      phoneNumber: "+16505550101",
    };
    checkVaultMock.mockResolvedValue(false);
    refreshCurrentUserIdentityMock.mockResolvedValue({
      phone_verified: true,
      phone_number: "+16505550101",
    });

    render(
      <PhoneMandateGuard>
        <div>kai content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(screen.getByText("kai content")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects users when backend phone verification is false even if Firebase has a phone", async () => {
    authValue = {
      user: { uid: "user-verified-in-firebase-only" },
      loading: false,
      phoneNumber: "+16505550101",
    };
    checkVaultMock.mockResolvedValue(false);
    refreshCurrentUserIdentityMock.mockResolvedValue({
      phone_verified: false,
      phone_number: "+16505550101",
    });

    render(
      <PhoneMandateGuard>
        <div>kai content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/register-phone?redirect=%2Fprofile");
    });
  });

  it("does not redirect users with a backend-verified phone claim", async () => {
    authValue = {
      user: { uid: "user-4" },
      loading: false,
      phoneNumber: null,
    };
    checkVaultMock.mockResolvedValue(false);
    refreshCurrentUserIdentityMock.mockResolvedValue({
      phone_verified: true,
      phone_number: "+16505550101",
    });

    render(
      <PhoneMandateGuard>
        <div>kai content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(screen.getByText("kai content")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps RIA onboarding reachable without asking for phone verification again", async () => {
    pathnameValue = "/ria/onboarding";
    authValue = {
      user: { uid: "ria-user" },
      loading: false,
      phoneNumber: null,
    };
    checkVaultMock.mockResolvedValue(false);

    render(
      <PhoneMandateGuard>
        <div>ria onboarding content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(screen.getByText("ria onboarding content")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not bypass phone verification for localhost UAT users", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    checkVaultMock.mockResolvedValue(false);

    render(
      <PhoneMandateGuard exemptVaultUsers>
        <div>profile content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/register-phone?redirect=%2Fprofile");
    });
  });
});
