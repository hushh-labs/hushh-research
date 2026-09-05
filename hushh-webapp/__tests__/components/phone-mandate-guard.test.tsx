import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";

const {
  replace,
  checkVaultMock,
  refreshCurrentUserIdentityMock,
  peekVaultPresenceMock,
  peekCachedIdentityMock,
  cacheSubscribeMock,
  bootstrapStateMock,
  getCachedBootstrapStateMock,
  retrySessionVerificationMock,
  signOutMock,
} = vi.hoisted(() => ({
  replace: vi.fn(),
  checkVaultMock: vi.fn(),
  refreshCurrentUserIdentityMock: vi.fn(),
  peekVaultPresenceMock: vi.fn(),
  peekCachedIdentityMock: vi.fn(),
  cacheSubscribeMock: vi.fn(),
  bootstrapStateMock: vi.fn(),
  getCachedBootstrapStateMock: vi.fn(),
  retrySessionVerificationMock: vi.fn(),
  signOutMock: vi.fn(),
}));

let pathnameValue = "/one/profile";
let searchValue = "";
let hostnameValue: string | null = "localhost";
let authValue: {
  user: { uid: string } | null;
  loading: boolean;
  phoneNumber: string | null;
  retrySessionVerification: () => Promise<void>;
  sessionVerificationRequired: boolean;
  signOut: () => Promise<void>;
} = {
  user: { uid: "user-1" },
  loading: false,
  phoneNumber: null,
  retrySessionVerification: retrySessionVerificationMock,
  sessionVerificationRequired: false,
  signOut: signOutMock,
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

vi.mock("@/lib/hooks/use-hostname", () => ({
  useHostname: () => hostnameValue,
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: checkVaultMock,
    // Legacy cache fallback only. New cold admission uses the shared bootstrap.
    peekVaultPresence: peekVaultPresenceMock,
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    refreshCurrentUserIdentity: refreshCurrentUserIdentityMock,
    hasVerifiedPhone: (identity: { phone_verified?: boolean } | null | undefined) =>
      identity?.phone_verified === true,
    // Identity is retained solely as a legacy fallback when bootstrap has no
    // verified-phone hint.
    peekCachedIdentity: peekCachedIdentityMock,
    getIdentitySwr: async (user: { uid?: string } | null | undefined) => {
      const cached = user?.uid ? peekCachedIdentityMock(user.uid) : null;
      return {
        identity: cached?.data ?? (await refreshCurrentUserIdentityMock()),
        isStale: cached?.isStale ?? false,
      };
    },
  },
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: bootstrapStateMock,
    getCachedBootstrapState: getCachedBootstrapStateMock,
  },
}));

vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: () => ({ subscribe: cacheSubscribeMock }),
  },
  CACHE_KEYS: {
    VAULT_CHECK: (userId: string) => `vault_check_${userId}`,
    ACCOUNT_IDENTITY: (userId: string) => `account_identity_${userId}`,
    PRE_VAULT_BOOTSTRAP: (userId: string) => `pre_vault_bootstrap_${userId}`,
  },
}));

describe("PhoneMandateGuard", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    replace.mockReset();
    checkVaultMock.mockReset();
    refreshCurrentUserIdentityMock.mockReset();
    peekVaultPresenceMock.mockReset();
    peekCachedIdentityMock.mockReset();
    cacheSubscribeMock.mockReset();
    bootstrapStateMock.mockReset();
    getCachedBootstrapStateMock.mockReset();
    retrySessionVerificationMock.mockReset();
    signOutMock.mockReset();
    retrySessionVerificationMock.mockResolvedValue(undefined);
    signOutMock.mockResolvedValue(undefined);
    refreshCurrentUserIdentityMock.mockResolvedValue(null);
    peekVaultPresenceMock.mockReturnValue(null);
    peekCachedIdentityMock.mockReturnValue(null);
    cacheSubscribeMock.mockReturnValue(() => {});
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      phoneVerified: false,
    });
    getCachedBootstrapStateMock.mockReturnValue(null);
    pathnameValue = "/one/profile";
    searchValue = "";
    hostnameValue = "localhost";
    authValue = {
      user: { uid: "user-1" },
      loading: false,
      phoneNumber: null,
      retrySessionVerification: retrySessionVerificationMock,
      sessionVerificationRequired: false,
      signOut: signOutMock,
    };
  });

  it("redirects no-vault users without a phone number to the phone mandate", async () => {
    render(
      <PhoneMandateGuard exemptVaultUsers>
        <div>profile content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/register-phone?redirect=%2Fone%2Fprofile");
    });
    expect(bootstrapStateMock).toHaveBeenCalledTimes(1);
    expect(checkVaultMock).not.toHaveBeenCalled();
    expect(refreshCurrentUserIdentityMock).not.toHaveBeenCalled();
  });

  it("recognizes the Capacitor trailing-slash phone route without redirecting to itself", async () => {
    pathnameValue = "/register-phone/";

    render(
      <PhoneMandateGuard>
        <div>phone verification content</div>
      </PhoneMandateGuard>,
    );

    await waitFor(() => {
      expect(screen.getByText("phone verification content")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps existing vault users on exempt routes even without a phone number", async () => {
    authValue = {
      user: { uid: "user-2" },
      loading: false,
      phoneNumber: null,
      retrySessionVerification: retrySessionVerificationMock,
      sessionVerificationRequired: false,
      signOut: signOutMock,
    };
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      phoneVerified: false,
    });

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

  it("keeps a warm Profile transition visible without a mandate loader flash", () => {
    getCachedBootstrapStateMock.mockReturnValue({
      hasVault: true,
      phoneVerified: true,
    });

    render(
      <PhoneMandateGuard exemptVaultUsers>
        <div>profile content</div>
      </PhoneMandateGuard>,
    );

    expect(screen.getByText("profile content")).toBeTruthy();
    expect(
      screen.queryByText("Checking phone requirement..."),
    ).toBeNull();
    expect(checkVaultMock).not.toHaveBeenCalled();
    expect(refreshCurrentUserIdentityMock).not.toHaveBeenCalled();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
  });

  it("hides a cached Profile surface while native session liveness is unverified", () => {
    getCachedBootstrapStateMock.mockReturnValue({
      hasVault: true,
      phoneVerified: true,
    });
    authValue = {
      ...authValue,
      sessionVerificationRequired: true,
    };

    render(
      <PhoneMandateGuard exemptVaultUsers>
        <div>cached private profile</div>
      </PhoneMandateGuard>,
    );

    expect(
      screen.getByRole("heading", { name: "Reconnect to continue securely" }),
    ).toBeTruthy();
    expect(screen.queryByText("cached private profile")).toBeNull();
    expect(bootstrapStateMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(retrySessionVerificationMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("uses a late shared-bootstrap cache write without waiting for duplicate checks", async () => {
    let cacheListener:
      | ((event: { type: "set"; key: string }) => void)
      | undefined;
    cacheSubscribeMock.mockImplementation(
      (listener: (event: { type: "set"; key: string }) => void) => {
        cacheListener = listener;
        return () => {};
      },
    );
    bootstrapStateMock.mockImplementation(() => new Promise(() => {}));

    render(
      <PhoneMandateGuard exemptVaultUsers>
        <div>profile content</div>
      </PhoneMandateGuard>,
    );

    expect(screen.getByText("Checking phone requirement...")).toBeTruthy();

    getCachedBootstrapStateMock.mockReturnValue({
      hasVault: true,
      phoneVerified: true,
    });
    cacheListener?.({ type: "set", key: "pre_vault_bootstrap_user-1" });

    await waitFor(() => {
      expect(screen.getByText("profile content")).toBeTruthy();
    });
  });

  it("does not redirect users who already have a verified phone number", async () => {
    authValue = {
      user: { uid: "user-3" },
      loading: false,
      phoneNumber: "+16505550101",
      retrySessionVerification: retrySessionVerificationMock,
      sessionVerificationRequired: false,
      signOut: signOutMock,
    };
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

  it("does not redirect users with a backend-verified phone claim", async () => {
    authValue = {
      user: { uid: "user-4" },
      loading: false,
      phoneNumber: null,
      retrySessionVerification: retrySessionVerificationMock,
      sessionVerificationRequired: false,
      signOut: signOutMock,
    };
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      phoneVerified: true,
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
      retrySessionVerification: retrySessionVerificationMock,
      sessionVerificationRequired: false,
      signOut: signOutMock,
    };
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

  it("keeps localhost development users in the app without requiring phone verification", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    render(
      <PhoneMandateGuard exemptVaultUsers>
        <div>profile content</div>
      </PhoneMandateGuard>
    );

    await waitFor(() => {
      expect(screen.getByText("profile content")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
    expect(checkVaultMock).not.toHaveBeenCalled();
    expect(refreshCurrentUserIdentityMock).not.toHaveBeenCalled();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
  });

  it("waits for the client hostname before deciding the localhost phone mandate", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    hostnameValue = null;
    const view = render(
      <PhoneMandateGuard>
        <div>setup content</div>
      </PhoneMandateGuard>,
    );

    expect(screen.getByText("Checking phone requirement...")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
    expect(checkVaultMock).not.toHaveBeenCalled();
    expect(refreshCurrentUserIdentityMock).not.toHaveBeenCalled();

    hostnameValue = "localhost";
    view.rerender(
      <PhoneMandateGuard>
        <div>setup content</div>
      </PhoneMandateGuard>,
    );

    await waitFor(() => {
      expect(screen.getByText("setup content")).toBeTruthy();
    });
    expect(replace).not.toHaveBeenCalled();
    expect(bootstrapStateMock).not.toHaveBeenCalled();
    expect(checkVaultMock).not.toHaveBeenCalled();
    expect(refreshCurrentUserIdentityMock).not.toHaveBeenCalled();
  });
});
