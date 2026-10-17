import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  getPurchase: vi.fn(), preparePurchase: vi.fn(), stagePurchase: vi.fn(),
  build: vi.fn(), current: vi.fn(),
}));
vi.mock("@/lib/services/scope-commerce-service", () => ({ ScopeCommerceService: ports }));
vi.mock("@/lib/consent/export-builder", () => ({ buildConsentExportForScope: ports.build }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: ports.current }));
vi.mock("@/lib/consent/export-envelope-v2", () => ({
  buildConsentExportAadV2: async (value: unknown) => ({ value, recipient_key_fingerprint: "fingerprint" }),
  canonicalConsentExportAad: () => new Uint8Array(), canonicalConsentExportJson: () => new Uint8Array(),
  buildConsentExportEnvelopeSubmissionV2: async (value: unknown) => value,
}));
vi.mock("@/lib/vault/export-encrypt", () => ({
  generateExportKey: async () => "synthetic-key", encryptForExport: async () => ({ ciphertext: "sealed", iv: "iv", tag: "tag" }),
  wrapExportKeyForConnector: async () => ({ wrappedExportKey: "wrapped", wrappedKeyIv: "iv", wrappedKeyTag: "tag", senderPublicKey: "public", wrappingAlg: "X25519", connectorKeyId: "key" }),
}));
import { prepareAndStagePaidScopeExport } from "@/lib/consent/scope-commerce-export";

const params = { purchaseId: "purchase", userId: "owner", vaultKey: "synthetic", vaultOwnerToken: "synthetic-owner" };
const acknowledgement = { version: 1 as const, binding: "a".repeat(64), acknowledged: true as const };

describe("paid owner export authority", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.current.mockReturnValue(true);
    ports.getPurchase.mockResolvedValue({ machineScope: "attr.food.preferences.*" });
    ports.build.mockResolvedValue({ payload: {}, sourceContentRevision: 1, sourceManifestRevision: 2 });
    ports.preparePurchase.mockResolvedValue({ machineScope: "attr.food.preferences.*", preparationId: "prep", exportId: "export", exportRevision: 1,
      startsAtMs: Date.now() + 60000, expiresAtMs: Date.now() + 120000, buyerAppId: "app", grantId: "grant", scopeHandle: "handle",
      connectorPublicKey: "public", connectorKeyId: "key", recipientKeyFingerprint: "fingerprint" });
    ports.stagePurchase.mockResolvedValue({ status: "armed" });
  });

  it("forwards the explicit reviewed cost binding unchanged to preparation and staging", async () => {
    await prepareAndStagePaidScopeExport({ ...params, negativeNetAcknowledgement: acknowledgement });
    expect(ports.preparePurchase.mock.calls[0][1]).toEqual({ sourceRevisions: { contentRevision: 1, manifestRevision: 2 }, negative_net_acknowledgement: acknowledgement });
    expect(ports.stagePurchase.mock.calls[0][1].negative_net_acknowledgement).toEqual(acknowledgement);
    expect(ports.stagePurchase.mock.calls[0][1].envelope).not.toHaveProperty("negative_net_acknowledgement");
  });

  it("never invents acknowledgement and stops staging when the owner vault session changes", async () => {
    await prepareAndStagePaidScopeExport(params);
    expect(ports.preparePurchase.mock.calls[0][1]).not.toHaveProperty("negative_net_acknowledgement");
    expect(ports.stagePurchase.mock.calls[0][1]).not.toHaveProperty("negative_net_acknowledgement");
    ports.stagePurchase.mockClear();
    ports.preparePurchase.mockImplementationOnce(async () => {
      ports.current.mockReturnValue(false);
      return {};
    });
    await expect(prepareAndStagePaidScopeExport({ ...params, negativeNetAcknowledgement: acknowledgement })).rejects.toThrow("Unlock your vault again");
    expect(ports.stagePurchase).not.toHaveBeenCalled();
  });
});
