import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  getPurchase: vi.fn(), preparePurchase: vi.fn(), stagePurchase: vi.fn(),
  build: vi.fn(), current: vi.fn(),
  getDomainSnapshot: vi.fn(), decryptDomainSnapshot: vi.fn(),
  refreshVaultConnections: vi.fn(),
}));
vi.mock("@/lib/services/scope-commerce-service", () => ({ ScopeCommerceService: ports }));
vi.mock("@/lib/consent/export-builder", () => ({ buildConsentExportForScope: ports.build }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getDomainSnapshot: ports.getDomainSnapshot,
    decryptDomainSnapshot: ports.decryptDomainSnapshot,
  },
}));
vi.mock("@/lib/kai/plaid-vault/vault-sync", () => ({
  hasVaultConnections: (financial: Record<string, unknown> | null | undefined) =>
    Boolean(financial?.connections_v1 && Object.keys(financial.connections_v1 as object).length > 0),
  refreshVaultConnections: ports.refreshVaultConnections,
}));
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
    expect(ports.preparePurchase.mock.calls[0][1]).toEqual({ sourceRevisions: { contentRevision: 1, manifestRevision: 2 }, negative_net_acknowledgement: acknowledgement, activate_immediately: true });
    expect(ports.stagePurchase.mock.calls[0][1].activate_on_stage).toBe(true);
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

  it("refreshes live Plaid connections before projecting and staging attr.financial paid exports", async () => {
    const financialData = {
      connections_v1: {
        item_live: { item_id: "item_live", institution_name: "First Platypus Bank", status: "connected", access_token: "access-sandbox-1" },
      },
    };
    ports.getPurchase.mockResolvedValue({ machineScope: "attr.financial.summary.*" });
    ports.getDomainSnapshot.mockResolvedValue({ domain: "financial", contentRevision: 3, manifestRevision: 3 });
    ports.decryptDomainSnapshot.mockResolvedValue(financialData);
    ports.refreshVaultConnections.mockResolvedValue({ refreshed: 1, needsRelink: [], failed: 0, saved: true });
    ports.preparePurchase.mockResolvedValue({ machineScope: "attr.financial.summary.*", preparationId: "prep", exportId: "export", exportRevision: 1,
      startsAtMs: Date.now() + 60000, expiresAtMs: Date.now() + 120000, buyerAppId: "app", grantId: "grant", scopeHandle: "handle",
      connectorPublicKey: "public", connectorKeyId: "key", recipientKeyFingerprint: "fingerprint" });
    await prepareAndStagePaidScopeExport(params);
    expect(ports.refreshVaultConnections).toHaveBeenCalledWith(expect.objectContaining({
      userId: params.userId,
      force: true,
      financial: financialData,
    }));
    expect(ports.build).toHaveBeenCalledWith(expect.objectContaining({
      scope: "attr.financial.summary.*",
    }));
  });

  it("fails closed without building or staging when real-time Plaid refresh requires relink", async () => {
    const financialData = {
      connections_v1: {
        item_relink: { item_id: "item_relink", institution_name: "First Platypus Bank", status: "needs_relink", access_token: "access-sandbox-2" },
      },
    };
    ports.getPurchase.mockResolvedValue({ machineScope: "attr.financial.summary.*" });
    ports.getDomainSnapshot.mockResolvedValue({ domain: "financial", contentRevision: 3, manifestRevision: 3 });
    ports.decryptDomainSnapshot.mockResolvedValue(financialData);
    ports.refreshVaultConnections.mockResolvedValue({ refreshed: 0, needsRelink: ["item_relink"], failed: 0, saved: false });
    await expect(prepareAndStagePaidScopeExport(params)).rejects.toThrow("Reconnect or refresh your linked bank");
    expect(ports.build).not.toHaveBeenCalled();
    expect(ports.stagePurchase).not.toHaveBeenCalled();
  });
});
