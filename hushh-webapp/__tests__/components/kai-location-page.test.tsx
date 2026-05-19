import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LocationContact,
  LocationLatestPoint,
  LocationOwnerState,
  LocationShare,
} from "@/lib/location-sharing/types";

const {
  approveAccessRequestMock,
  buildMapsUrlsMock,
  buildSharedLocationUrlMock,
  copyLocationUrlMock,
  createContactMock,
  createShareMock,
  denyAccessRequestMock,
  getFreshLocationPointMock,
  getLocationSharingErrorMessageMock,
  getOwnerStateMock,
  issueUpdateSessionMock,
  isLocationApiUnavailableMock,
  revokeContactMock,
  revokeShareMock,
  shareOrCopyLocationUrlMock,
  startLiveUpdatesMock,
  stopActiveSharesMock,
  stopLiveUpdatesMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  approveAccessRequestMock: vi.fn(),
  buildMapsUrlsMock: vi.fn(() => ({
    apple: "https://maps.apple.com/?ll=12.9716,77.5946",
    google: "https://www.google.com/maps?q=12.9716%2C77.5946",
    osmEmbed: "https://www.openstreetmap.org/export/embed.html?bbox=77.58,12.96,77.60,12.98",
  })),
  buildSharedLocationUrlMock: vi.fn((token: string) => `http://localhost/location/shared?token=${token}`),
  copyLocationUrlMock: vi.fn(),
  createContactMock: vi.fn(),
  createShareMock: vi.fn(),
  denyAccessRequestMock: vi.fn(),
  getFreshLocationPointMock: vi.fn(),
  getLocationSharingErrorMessageMock: vi.fn((error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback
  ),
  getOwnerStateMock: vi.fn(),
  issueUpdateSessionMock: vi.fn(),
  isLocationApiUnavailableMock: vi.fn(() => false),
  revokeContactMock: vi.fn(),
  revokeShareMock: vi.fn(),
  shareOrCopyLocationUrlMock: vi.fn(),
  startLiveUpdatesMock: vi.fn(),
  stopActiveSharesMock: vi.fn(),
  stopLiveUpdatesMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: { uid: "owner-1" },
    loading: false,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultOwnerToken: "vault-owner-token",
    isVaultUnlocked: true,
  }),
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

vi.mock("@/lib/location-sharing/service", () => ({
  buildMapsUrls: buildMapsUrlsMock,
  buildSharedLocationUrl: buildSharedLocationUrlMock,
  buildWhatsAppShareUrl: (url: string) => `https://wa.me/?text=${encodeURIComponent(url)}`,
  copyLocationUrl: copyLocationUrlMock,
  getFreshLocationPoint: getFreshLocationPointMock,
  getLocationSharingErrorMessage: getLocationSharingErrorMessageMock,
  isLocationApiUnavailable: isLocationApiUnavailableMock,
  shareOrCopyLocationUrl: shareOrCopyLocationUrlMock,
  KaiLocationSharingService: {
    approveAccessRequest: approveAccessRequestMock,
    createContact: createContactMock,
    createShare: createShareMock,
    denyAccessRequest: denyAccessRequestMock,
    getOwnerState: getOwnerStateMock,
    issueUpdateSession: issueUpdateSessionMock,
    revokeContact: revokeContactMock,
    revokeShare: revokeShareMock,
    startLiveUpdates: startLiveUpdatesMock,
    stopActiveShares: stopActiveSharesMock,
    stopLiveUpdates: stopLiveUpdatesMock,
  },
}));

const contact: LocationContact = {
  id: "contact-1",
  ownerUserId: "owner-1",
  displayName: "Mom",
  tier: "family",
  status: "active",
  autoApprove: true,
  createdAt: "2026-05-19T10:00:00.000Z",
  updatedAt: "2026-05-19T10:00:00.000Z",
  revokedAt: null,
};

const point: LocationLatestPoint = {
  ownerUserId: "owner-1",
  latitude: 12.9716,
  longitude: 77.5946,
  accuracyM: 8,
  headingDeg: null,
  speedMps: null,
  capturedAt: "2026-05-19T10:05:00.000Z",
  sourcePlatform: "web",
  updatedAt: "2026-05-19T10:05:00.000Z",
};

const share: LocationShare = {
  id: "share-1",
  ownerUserId: "owner-1",
  contactId: "contact-1",
  contactDisplayName: "Mom",
  contactTier: "family",
  contactAutoApprove: true,
  status: "active",
  liveMode: true,
  expiresAt: "2026-05-20T10:05:00.000Z",
  createdAt: "2026-05-19T10:05:00.000Z",
  updatedAt: "2026-05-19T10:05:00.000Z",
  lastViewedAt: null,
  deactivatedAt: null,
  revokedAt: null,
};

function ownerState(overrides: Partial<LocationOwnerState> = {}): LocationOwnerState {
  return {
    contacts: [contact],
    shares: [],
    accessRequests: [],
    latest: point,
    limits: { family: 3, friend: 7 },
    ...overrides,
  };
}

describe("KaiLocationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOwnerStateMock.mockResolvedValue(ownerState());
    getFreshLocationPointMock.mockResolvedValue(point);
    createShareMock.mockImplementation(async () => {
      getOwnerStateMock.mockResolvedValue(ownerState({ shares: [share] }));
      return { share, token: "raw-location-token", latest: point };
    });
    issueUpdateSessionMock.mockResolvedValue({
      token: "update-token",
      expiresAt: "2026-05-19T11:05:00.000Z",
      endpointPath: "/api/kai/location/updates",
    });
    shareOrCopyLocationUrlMock.mockRejectedValue(new Error("share unavailable in jsdom"));
    stopActiveSharesMock.mockImplementation(async () => {
      getOwnerStateMock.mockResolvedValue(ownerState({ shares: [] }));
      return { shares: [], stoppedCount: 1 };
    });
    startLiveUpdatesMock.mockResolvedValue({ active: true, mode: "web" });
    stopLiveUpdatesMock.mockResolvedValue(undefined);
  });

  it(
    "creates a live location link, exposes it for messaging, starts updates, and stops access",
    async () => {
      const { default: KaiLocationPage } = await import("@/app/kai/location/page");

      render(<KaiLocationPage />);

      await expect(screen.findByText("Mom")).resolves.toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /share/i }));

      await waitFor(() => {
        expect(createShareMock).toHaveBeenCalledWith(
          expect.objectContaining({
            vaultOwnerToken: "vault-owner-token",
            contactId: "contact-1",
            durationHours: 1,
            liveMode: true,
            point,
          })
        );
      });
      await waitFor(() => {
        expect(startLiveUpdatesMock).toHaveBeenCalledWith({
          updateToken: "update-token",
          endpointPath: "/api/kai/location/updates",
        });
      });

      const urlInput = await screen.findByDisplayValue(
        "http://localhost/location/shared?token=raw-location-token"
      );
      expect(urlInput).toBeTruthy();
      expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /whatsapp/i })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /stop sharing/i }));

      await waitFor(() => {
        expect(stopActiveSharesMock).toHaveBeenCalledWith("vault-owner-token");
        expect(stopLiveUpdatesMock).toHaveBeenCalled();
      });
      await expect(screen.findByText("No active location shares.")).resolves.toBeTruthy();
    },
    60_000
  );
});
