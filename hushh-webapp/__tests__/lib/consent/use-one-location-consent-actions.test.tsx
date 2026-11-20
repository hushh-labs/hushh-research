import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  approveRequest: vi.fn(),
  captureCurrentPosition: vi.fn(),
  storeEnvelope: vi.fn(),
  encryptLocationForRecipient: vi.fn(),
  trackOneLocationJourneyAction: vi.fn(),
  dispatchConsentStateChanged: vi.fn(),
  onActionComplete: vi.fn(),
  toastPromise: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { promise: mocks.toastPromise, error: vi.fn() },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ getVaultOwnerToken: () => "vault-owner-token" }),
}));

vi.mock("@/lib/consent/consent-events", () => ({
  dispatchConsentStateChanged: mocks.dispatchConsentStateChanged,
}));

vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: mocks.encryptLocationForRecipient,
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: mocks.getState,
    approveRequest: mocks.approveRequest,
    captureCurrentPosition: mocks.captureCurrentPosition,
    storeEnvelope: mocks.storeEnvelope,
  },
}));

vi.mock("@/lib/observability/location-events", () => ({
  trackOneLocationJourneyAction: mocks.trackOneLocationJourneyAction,
}));

import { useOneLocationConsentActions } from "@/lib/consent/use-one-location-consent-actions";

const entry = {
  id: "one_location_request:request-1",
  request_id: "request-1",
  metadata: { request_source: "one_location_access_request" },
};

describe("useOneLocationConsentActions fulfilment telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getState.mockResolvedValue({
      requests: [{ id: "request-1", requesterUserId: "requester-1" }],
      recipients: [
        {
          userId: "requester-1",
          keyId: "recipient-key-1",
          publicKeyJwk: { kty: "EC" },
        },
      ],
    });
    mocks.approveRequest.mockResolvedValue({ grant: { id: "grant-1" } });
    mocks.captureCurrentPosition.mockResolvedValue({ latitude: 1, longitude: 2 });
    mocks.encryptLocationForRecipient.mockResolvedValue({ ciphertext: "encrypted" });
    mocks.storeEnvelope.mockResolvedValue(undefined);
  });

  it("records success only after the encrypted location update is stored", async () => {
    const { result } = renderHook(() =>
      useOneLocationConsentActions({
        userId: "owner-1",
        onActionComplete: mocks.onActionComplete,
      }),
    );

    await act(async () => {
      await result.current.handleApprove(entry, 4);
    });

    expect(mocks.storeEnvelope).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-owner-token",
      grantId: "grant-1",
      envelope: { ciphertext: "encrypted" },
    });
    expect(mocks.trackOneLocationJourneyAction).toHaveBeenCalledWith({
      action: "location_request_fulfilled",
      targetType: "person",
    });
    expect(mocks.onActionComplete).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith({
      action: "approve",
      requestId: "request-1",
      scope: undefined,
      source: "one_location_consent_actions",
    });
  });

  it("records an error and does not announce completion when publication fails", async () => {
    const publicationError = new Error("encrypted update publication failed");
    mocks.storeEnvelope.mockRejectedValueOnce(publicationError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() =>
      useOneLocationConsentActions({
        userId: "owner-1",
        onActionComplete: mocks.onActionComplete,
      }),
    );

    await act(async () => {
      await expect(result.current.handleApprove(entry, 4)).rejects.toThrow(
        "encrypted update publication failed",
      );
    });

    expect(mocks.trackOneLocationJourneyAction).toHaveBeenCalledWith({
      action: "location_request_fulfilled",
      result: "error",
      targetType: "person",
    });
    expect(mocks.onActionComplete).not.toHaveBeenCalled();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
