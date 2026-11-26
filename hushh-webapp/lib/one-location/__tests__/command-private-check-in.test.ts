import { beforeEach, expect, it, vi } from "vitest";
import { executePrivateCheckIn, type PrivateCheckInRequest } from "../command-private-check-in";
import type { OneLocationEncryptedEnvelope, OneLocationRecipient } from "../types";

const { createGrant, encrypt } = vi.hoisted(() => ({ createGrant: vi.fn(), encrypt: vi.fn() }));
vi.mock("../service", () => ({ OneLocationService: { createGrantWithEnvelope: createGrant } }));
vi.mock("../encryption", () => ({ encryptLocationForRecipient: encrypt }));

const recipients: OneLocationRecipient[] = ["Maya", "Nina"].map((userId) => ({
  userId, displayName: userId, keyId: `key-${userId}`, phoneVerified: false, canReceiveLocation: true,
  keyAlgorithm: "ECDH-P256-AES256-GCM", publicKeyJwk: { kty: "EC" },
}));

function reviewedCheckIn(): PrivateCheckInRequest {
  const confirmedAt = new Date().toISOString();
  return {
    recipientIds: ["Maya", "Nina"], durationHours: "1", message: "At the café",
    point: { latitude: 37.77, longitude: -122.42, capturedAt: confirmedAt, sourcePlatform: "web" },
    clientOperationId: "review-operation", confirmedAt, sourceCircleId: "friends",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  encrypt.mockImplementation(async ({ recipientKeyId }) => ({ ciphertext: `sealed-${recipientKeyId}` }));
});

it("encrypts the private note and retries a lost recipient using the same operation and ciphertext", async () => {
  const request = reviewedCheckIn();
  const session = {
    ownerId: "owner", token: "owner-token", recipients, isCurrent: () => true,
    envelopeCache: new Map<string, OneLocationEncryptedEnvelope>(),
  };
  createGrant.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({});
  await expect(executePrivateCheckIn({ ...session, request })).resolves.toEqual({
    succeededRecipientIds: ["Maya"], failedRecipientIds: ["Nina"],
  });
  expect(encrypt).toHaveBeenCalledWith(expect.objectContaining({
    point: { ...request.point, checkIn: { message: "At the café" } },
  }));
  const failed = createGrant.mock.calls[1][0];
  expect(failed).toMatchObject({
    recipientUserId: "Nina", clientOperationId: request.clientOperationId, confirmedAt: request.confirmedAt,
    reason: "check_in", shareKind: "check_in", sourceCircleId: "friends",
  });
  expect(JSON.stringify(failed)).not.toContain("At the café");
  await expect(executePrivateCheckIn({ ...session, request: { ...request, recipientIds: ["Nina"] } })).resolves.toEqual({
    succeededRecipientIds: ["Nina"], failedRecipientIds: [],
  });
  expect(encrypt).toHaveBeenCalledTimes(2);
  expect(createGrant.mock.calls[2][0].envelope).toBe(failed.envelope);
  expect(createGrant.mock.calls[2][0].clientOperationId).toBe(failed.clientOperationId);
});

it("requires a fresh reviewed point before encrypting or creating any grant", async () => {
  const request = reviewedCheckIn();
  request.point.capturedAt = new Date(Date.now() - 61_000).toISOString();
  await expect(executePrivateCheckIn({
    ownerId: "owner", token: "owner-token", request, recipients,
    isCurrent: () => true, envelopeCache: new Map(),
  })).rejects.toThrow("Refresh and review your location");
  expect(encrypt).not.toHaveBeenCalled();
  expect(createGrant).not.toHaveBeenCalled();
});
