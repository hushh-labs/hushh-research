import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseAuth,
  mockUseVault,
  mockUseParams,
  mockRouterPush,
  mockResolveCircleInvite,
  mockClaimCircleInvite,
  mockBootstrapKey,
  mockSyncCurrentUser,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseVault: vi.fn(),
  mockUseParams: vi.fn(),
  mockRouterPush: vi.fn(),
  mockResolveCircleInvite: vi.fn(),
  mockClaimCircleInvite: vi.fn(),
  mockBootstrapKey: vi.fn(),
  mockSyncCurrentUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: mockUseParams,
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("@/lib/one-location/key-bootstrap", () => ({
  bootstrapCurrentUserLocationRecipientKey: mockBootstrapKey,
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    resolveCircleInvite: mockResolveCircleInvite,
    claimCircleInvite: mockClaimCircleInvite,
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    hasVerifiedPhone: (identity: { phone_verified?: boolean } | null | undefined) =>
      identity?.phone_verified === true,
    syncCurrentUser: mockSyncCurrentUser,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import OneLocationCircleInvitePageClient from "@/app/one/location/invite/[token]/page-client";
import { ApiError } from "@/lib/services/api-client";

function invitePayload() {
  return {
    id: "invite_123",
    ownerUserId: "owner_123",
    ownerLabel: "hushh Social",
    status: "active",
    durationHours: 24,
    message: "Join me on One.",
    createdAt: "2026-06-20T10:00:00.000Z",
    expiresAt: "2026-06-21T10:00:00.000Z",
  };
}

describe("OneLocationCircleInvitePageClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({ token: "invite_token_123" });
    mockUseAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_123",
      user: { uid: "user_123" },
    });
    mockUseVault.mockReturnValue({
      isVaultUnlocked: true,
      vaultOwnerToken: "vault_owner_token",
    });
    mockResolveCircleInvite.mockResolvedValue({ invite: invitePayload() });
    mockBootstrapKey.mockResolvedValue(undefined);
    mockSyncCurrentUser.mockResolvedValue({ user_id: "user_123", phone_verified: true });
    mockClaimCircleInvite.mockResolvedValue({
      invite: invitePayload(),
      connection: { id: "connection_123" },
    });
  });

  it("routes signed-in vault-locked users to the shared Profile vault flow", async () => {
    mockUseVault.mockReturnValue({
      isVaultUnlocked: false,
      vaultOwnerToken: null,
    });

    render(<OneLocationCircleInvitePageClient />);

    const vaultLink = await screen.findByRole("link", { name: /Continue to Vault/i });
    expect(vaultLink.getAttribute("href")).toBe(
      "/profile?panel=security&unlock_vault=1&return_to=%2Fone%2Flocation%2Finvite%2Finvite_token_123",
    );

    expect(mockRouterPush).not.toHaveBeenCalledWith(
      "/one/location?circleInviteToken=invite_token_123",
    );
  });

  it("turns phone-required claim failures into a verify-phone CTA", async () => {
    mockClaimCircleInvite.mockRejectedValue(
      new ApiError("Verify your phone number before joining One Network.", 409, {
        detail: {
          code: "LOCATION_PHONE_VERIFICATION_REQUIRED",
          message: "Verify your phone number before joining One Network.",
        },
      }),
    );

    render(<OneLocationCircleInvitePageClient />);

    fireEvent.click(await screen.findByRole("button", { name: /Accept Invite/i }));

    expect(
      await screen.findByText("Verify your phone number before joining One Network."),
    ).toBeTruthy();
    const verifyLink = screen.getByRole("link", { name: /Verify phone to continue/i });
    expect(verifyLink.getAttribute("href")).toBe(
      "/register-phone?redirect=%2Fone%2Flocation%2Finvite%2Finvite_token_123",
    );
    await waitFor(() => expect(mockRouterPush).not.toHaveBeenCalled());
  });

  it("routes signed-in users without a verified phone to phone verification before vault handoff", async () => {
    mockUseVault.mockReturnValue({
      isVaultUnlocked: false,
      vaultOwnerToken: null,
    });
    mockSyncCurrentUser.mockResolvedValue({
      user_id: "user_123",
      phone_verified: false,
    });

    render(<OneLocationCircleInvitePageClient />);

    const verifyLink = await screen.findByRole("link", {
      name: /Verify phone to continue/i,
    });
    expect(verifyLink.getAttribute("href")).toBe(
      "/register-phone?redirect=%2Fone%2Flocation%2Finvite%2Finvite_token_123",
    );
    expect(screen.queryByRole("link", { name: /Continue to Vault/i })).toBeNull();
    expect(mockClaimCircleInvite).not.toHaveBeenCalled();
  });
});
