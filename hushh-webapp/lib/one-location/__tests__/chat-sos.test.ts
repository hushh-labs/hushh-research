// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { loadChatSosActiveReview, loadChatSosReview, sendChatSos, stopChatSos } from "../chat-sos";
import { loadSosIncident } from "../sos-incident";
import type { OneLocationGrant, OneLocationRecipient } from "../types";

const { service, location } = vi.hoisted(() => ({
  service: {
    getState: vi.fn(),
    getSmsRecipientRoster: vi.fn(),
    captureCurrentPosition: vi.fn(),
    createGrant: vi.fn(),
    storeEnvelope: vi.fn(),
    sendSosEmails: vi.fn(),
    revokeGrant: vi.fn(),
  },
  location: { generation: 0 },
}));

vi.mock("../service", () => ({ OneLocationService: service }));
vi.mock("../location-bus", () => ({ LocationBus: { getAccountGeneration: () => location.generation } }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onOneLocationStateMutated: vi.fn() } }));
vi.mock("../encryption", () => ({ encryptLocationForRecipient: vi.fn(async () => ({ ciphertext: "opaque" })) }));

const session = { ownerId: "owner", token: "owner-token" };

function recipient(userId: string): OneLocationRecipient {
  return {
    userId, displayName: userId, phoneVerified: false, canReceiveLocation: true,
    keyId: `key-${userId}`, keyAlgorithm: "ECDH-P256-AES256-GCM", publicKeyJwk: { kty: "EC" },
  };
}

function grant(userId: string, shareKind = "sos"): OneLocationGrant {
  return {
    id: `grant-${userId}-${shareKind}`, ownerUserId: session.ownerId, recipientUserId: userId,
    recipientKeyId: `key-${userId}`, status: "active", consentScope: "location.live", capabilityScopes: [],
    durationHours: 8, shareKind,
  };
}

function roster(...recipients: OneLocationRecipient[]) {
  return { smsContactUserIds: recipients.map((person) => person.userId), recipients };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  location.generation = 0;
  service.getState.mockResolvedValue({ ownerGrants: [] });
  service.getSmsRecipientRoster.mockResolvedValue(roster(recipient("Maya")));
  service.captureCurrentPosition.mockImplementation(async () => ({
    latitude: 37.777, longitude: -122.411, capturedAt: new Date().toISOString(), sourcePlatform: "web",
  }));
});

it("keeps review read-only and requires a new confirmation when the authoritative audience changes", async () => {
  const review = await loadChatSosReview(session);
  expect(service.captureCurrentPosition).not.toHaveBeenCalled();
  service.getSmsRecipientRoster.mockResolvedValue(roster(recipient("Maya"), recipient("Nina")));
  await expect(sendChatSos({ ...session, review })).rejects.toThrow("emergency contacts changed");
  expect(service.createGrant).not.toHaveBeenCalled();
  expect(service.sendSosEmails).not.toHaveBeenCalled();
});

it("does not send a reviewed alert after the owner session generation changes", async () => {
  const review = await loadChatSosReview(session);
  service.captureCurrentPosition.mockImplementationOnce(async () => {
    location.generation += 1;
    return { latitude: 37.777, longitude: -122.411, capturedAt: new Date().toISOString(), sourcePlatform: "web" };
  });
  await expect(sendChatSos({ ...session, review })).rejects.toThrow("Location session changed");
  expect(service.createGrant).not.toHaveBeenCalled();
});

it("keeps unknown and failed publication distinct and retains a partial alert for stop and email fallback", async () => {
  service.getSmsRecipientRoster.mockResolvedValue(roster(recipient("Maya"), recipient("Nina")));
  service.createGrant.mockImplementation(async ({ recipientUserId }) => grant(recipientUserId));
  service.storeEnvelope.mockImplementation(async ({ grantId }) => {
    if (grantId === "grant-Nina-sos") throw new Error("could not store");
    return { recipientAlerted: null };
  });
  service.sendSosEmails.mockResolvedValue({ emailed: 1, withoutEmail: ["Nina"] });

  const review = await loadChatSosReview(session);
  const result = await sendChatSos({ ...session, review });
  expect(service.captureCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({ fresh: true, requireMeasurement: true }));
  expect(service.storeEnvelope).toHaveBeenCalledWith(expect.objectContaining({ envelope: expect.objectContaining({ metadata: { precision: "precise" } }) }));
  expect(result.delivery).toEqual([
    { userId: "Maya", displayName: "Maya", alerted: null },
    { userId: "Nina", displayName: "Nina", alerted: false, failed: true },
  ]);
  expect(result).toMatchObject({ emailed: 1, withoutEmail: ["Nina"], error: expect.any(String) });
  expect(service.sendSosEmails).toHaveBeenCalledWith(expect.objectContaining({ grantIds: ["grant-Maya-sos", "grant-Nina-sos"] }));
  expect(loadSosIncident(session.ownerId)?.grantIds).toEqual(result.incident.grantIds);
});

it("allows Stop during email fallback and preserves the primary receipt if email fails", async () => {
  const maya = grant("Maya");
  service.createGrant.mockResolvedValue(maya);
  service.storeEnvelope.mockResolvedValue({ recipientAlerted: true });
  let rejectEmail!: (error: Error) => void;
  service.sendSosEmails.mockReturnValue(new Promise((_, reject) => { rejectEmail = reject; }));
  const onPublished = vi.fn();
  const review = await loadChatSosReview(session);
  const delivery = sendChatSos({ ...session, review, onPublished });
  await vi.waitFor(() => expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({
    incident: expect.objectContaining({ grantIds: [maya.id] }),
    delivery: [{ userId: "Maya", displayName: "Maya", alerted: true }],
  })));

  service.getState.mockResolvedValue({ ownerGrants: [maya] });
  service.revokeGrant.mockResolvedValue({ id: maya.id, status: "revoked" });
  const active = await loadChatSosActiveReview(session);
  await expect(stopChatSos({ ...session, review: active })).resolves.toEqual({ revoked: [maya.id], unresolved: [] });
  const mayEmail = service.sendSosEmails.mock.calls[0]?.[0].isEffectCurrent;
  expect(mayEmail?.()).toBe(false);
  rejectEmail(new Error("mail unavailable"));
  await expect(delivery).resolves.toMatchObject({
    delivery: [{ userId: "Maya", displayName: "Maya", alerted: true }],
    emailed: 0, emailError: "Email fallback could not be verified.",
  });
});

it("reviews new SOS grants before revocation and retains only failed revocations for retry", async () => {
  const maya = grant("Maya");
  const nina = grant("Nina");
  const regular = grant("Maya", "live");
  service.getSmsRecipientRoster.mockRejectedValue(new Error("roster unavailable"));
  service.getState.mockResolvedValue({ ownerGrants: [maya, regular] });
  const old = await loadChatSosActiveReview(session);
  service.getState.mockResolvedValue({ ownerGrants: [maya, nina, regular] });
  await expect(stopChatSos({ ...session, review: old })).rejects.toThrow("active alert changed");
  expect(service.revokeGrant).not.toHaveBeenCalled();

  const review = await loadChatSosActiveReview(session);
  service.revokeGrant.mockResolvedValueOnce({ id: maya.id, status: "revoked" }).mockRejectedValueOnce(new Error("offline"));
  await expect(stopChatSos({ ...session, review })).resolves.toEqual({ revoked: [maya.id], unresolved: [nina.id] });
  expect(loadSosIncident(session.ownerId)?.grantIds).toEqual([nina.id]);
  service.getState.mockResolvedValue({ ownerGrants: [nina, regular] });
  service.revokeGrant.mockResolvedValueOnce({ id: nina.id, status: "revoked" });
  await expect(stopChatSos({ ...session, review: await loadChatSosActiveReview(session) })).resolves.toEqual({ revoked: [nina.id], unresolved: [] });
  expect(loadSosIncident(session.ownerId)).toBeNull();
  expect(service.getSmsRecipientRoster).not.toHaveBeenCalled();
  expect(service.revokeGrant).not.toHaveBeenCalledWith({ vaultOwnerToken: session.token, grantId: regular.id });
});
