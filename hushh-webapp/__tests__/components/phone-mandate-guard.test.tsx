import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";

const { replace, checkVaultMock } = vi.hoisted(() => ({
  replace: vi.fn(),
  checkVaultMock: vi.fn(),
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

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: checkVaultMock,
  },
}));

describe("PhoneMandateGuard", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    replace.mockReset();
    checkVaultMock.mockReset();
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

  it("keeps localhost development users in the app without requiring phone verification", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    checkVaultMock.mockResolvedValue(false);

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
  });
});
