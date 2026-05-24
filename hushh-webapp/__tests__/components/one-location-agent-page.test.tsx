import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseRequireAuth,
  mockUseVault,
  mockEnsureKey,
  mockRegisterKey,
  mockGetPermissionState,
  mockGetState,
  mockSyncCurrentUser,
  mockRouterPush,
  mockSearchParamsGet,
} = vi.hoisted(() => ({
  mockUseRequireAuth: vi.fn(),
  mockUseVault: vi.fn(),
  mockEnsureKey: vi.fn(),
  mockRegisterKey: vi.fn(),
  mockGetPermissionState: vi.fn(),
  mockGetState: vi.fn(),
  mockSyncCurrentUser: vi.fn(),
  mockRouterPush: vi.fn(),
  mockSearchParamsGet: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
  useSearchParams: () => ({
    get: mockSearchParamsGet,
    toString: () => "",
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: mockUseRequireAuth,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/one-location/encryption", () => ({
  ensureLocationRecipientKey: mockEnsureKey,
  encryptLocationForRecipient: vi.fn(),
  decryptLocationEnvelope: vi.fn(),
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    registerRecipientKey: mockRegisterKey,
    getPermissionState: mockGetPermissionState,
    getState: mockGetState,
    createGrant: vi.fn(),
    storeEnvelope: vi.fn(),
    captureCurrentPosition: vi.fn(),
    viewEnvelope: vi.fn(),
    revokeGrant: vi.fn(),
    requestAccess: vi.fn(),
    approveRequest: vi.fn(),
    denyRequest: vi.fn(),
    referRecipient: vi.fn(),
    createPublicInvite: vi.fn(),
    revokePublicInvite: vi.fn(),
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    syncCurrentUser: mockSyncCurrentUser,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { OneLocationAgentPageContent } from "@/app/one/location/page";

function locationState() {
  return {
    recipients: [
      {
        userId: "user_b",
        displayName: "Trusted B",
        maskedPhone: "******8012",
        phoneVerified: true,
        keyId: "key_b",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        keyAlgorithm: "ECDH-P256-AES256-GCM",
        canReceiveLocation: true,
      },
    ],
    ownerGrants: [
      {
        id: "grant_1",
        ownerUserId: "user_a",
        recipientUserId: "user_b",
        recipientDisplayName: "Trusted B",
        recipientMaskedPhone: "******8012",
        recipientKeyId: "key_b",
        status: "active",
        consentScope: "cap.location.live.view",
        capabilityScopes: ["cap.location.live.view"],
        durationHours: 1,
        expiresAt: "2026-05-20T08:00:00.000Z",
      },
    ],
    receivedGrants: [],
    requests: [],
    referrals: [],
    publicInvites: [],
    publicInviteSubmissions: [],
    capabilityScopes: [
      "cap.location.live.share",
      "cap.location.live.view",
      "cap.location.live.request",
      "cap.location.live.revoke",
      "cap.location.live.refer_request",
    ],
  };
}

describe("OneLocationAgentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet.mockReturnValue(null);
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_a",
      user: { uid: "user_a" },
    });
    mockUseVault.mockReturnValue({
      isVaultUnlocked: true,
      vaultOwnerToken: "vault-token",
    });
    mockEnsureKey.mockResolvedValue({
      keyId: "key_a",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      algorithm: "ECDH-P256-AES256-GCM",
    });
    mockRegisterKey.mockResolvedValue({});
    mockGetPermissionState.mockResolvedValue({
      state: "granted",
      precise: true,
      background: "foreground-only",
    });
    mockGetState.mockResolvedValue(locationState());
    mockSyncCurrentUser.mockResolvedValue({ user_id: "user_a" });
  });

  it("renders the One-owned encrypted location control surface", async () => {
    render(<OneLocationAgentPageContent />);

    expect(
      await screen.findByRole("heading", { name: "One Location Agent" }),
    ).toBeTruthy();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(await screen.findByText("People who can see me")).toBeTruthy();
    expect(
      screen.queryAllByText("Trusted B - ******8012").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Share Encrypted Update")).toBeTruthy();
    expect(mockRegisterKey).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      keyId: "key_a",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      algorithm: "ECDH-P256-AES256-GCM",
    });
    expect(mockSyncCurrentUser).toHaveBeenCalledWith({ uid: "user_a" });
  });

  it("shows a skeleton while the first location state refresh is loading", async () => {
    let resolveState: (value: ReturnType<typeof locationState>) => void = () =>
      undefined;
    mockGetState.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveState = resolve;
      }),
    );

    const { container } = render(<OneLocationAgentPageContent />);

    await waitFor(() => expect(mockRegisterKey).toHaveBeenCalled());
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);

    resolveState(locationState());
    await waitFor(() =>
      expect(screen.getByText("Share Encrypted Update")).toBeTruthy(),
    );
  });

  it("renders a public request-link control that does not promise public location", async () => {
    render(<OneLocationAgentPageContent />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    expect(screen.getByText("Create request link")).toBeTruthy();
    expect(screen.getByText("Public link responses")).toBeTruthy();
    expect(screen.queryByText(/public live-location link/i)).toBeNull();
    expect(screen.queryByText(/whatsapp/i)).toBeNull();
  });

  it("does not leave refresh spinning when the vault owner token is unavailable", async () => {
    mockUseVault.mockReturnValue({
      isVaultUnlocked: false,
      vaultOwnerToken: null,
    });

    render(<OneLocationAgentPageContent />);

    expect(
      await screen.findByText(
        "Unlock your vault before loading location sharing.",
      ),
    ).toBeTruthy();
    expect(mockRegisterKey).not.toHaveBeenCalled();
    expect(mockGetState).not.toHaveBeenCalled();
  });
});
