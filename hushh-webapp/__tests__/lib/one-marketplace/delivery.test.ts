import { beforeEach, expect, it, vi } from "vitest";
import type { MarketplaceRequest } from "@/lib/one-marketplace/service";

const mocks = vi.hoisted(() => ({ get: vi.fn(), stored: vi.fn(), decrypt: vi.fn(), legacy: vi.fn(), current: vi.fn(), preview: vi.fn() }));
vi.mock("@/lib/one-marketplace/service", () => ({ OneMarketplaceService: { getDelivery: mocks.get } }));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: { readStoredConnector: mocks.stored, decryptScopedExport: mocks.decrypt } }));
vi.mock("@/lib/one-marketplace/encryption", () => ({ decryptMarketplaceEnvelope: mocks.legacy }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: mocks.current }));
vi.mock("@/lib/profile/pkm-section-preview", () => ({ buildPkmSectionPreviewPresentation: mocks.preview }));
import { openMarketplaceDelivery, openMarketplaceDeliveryPresentations } from "@/lib/one-marketplace/delivery";

beforeEach(() => { vi.resetAllMocks(); mocks.current.mockReturnValue(true); mocks.preview.mockReturnValue({ title: "Approved information" }); });
const params = { request: { id: "request", domain: "food", metadata: { commercial_required: true } } as MarketplaceRequest,
  userId: "owner", vaultKey: "memory-only", vaultOwnerToken: "owner-token" };

it("rejects paid legacy envelopes and stops connector access after vault lock, while retaining verified v2 reads", async () => {
  mocks.get.mockResolvedValueOnce({ envelope: { ciphertext: "legacy" } });
  await expect(openMarketplaceDelivery(params)).rejects.toThrow("verified v2");
  expect(mocks.legacy).not.toHaveBeenCalled();

  const encryptedExport = { export_envelope: { version: 2, aad: { machine_scope: "attr.food.preferences.*" } } };
  mocks.get.mockImplementationOnce(async () => { mocks.current.mockReturnValue(false); return { encryptedExport }; });
  await expect(openMarketplaceDelivery(params)).rejects.toThrow("Unlock your vault again");
  expect(mocks.stored).not.toHaveBeenCalled();
  expect(mocks.decrypt).not.toHaveBeenCalled();

  mocks.current.mockReturnValue(true);
  mocks.get.mockResolvedValueOnce({ encryptedExport });
  mocks.stored.mockResolvedValueOnce({ connector_key_id: "existing" });
  mocks.decrypt.mockResolvedValueOnce({ food: { preferences: "approved" } });
  await expect(openMarketplaceDelivery(params)).resolves.toEqual({ title: "Approved information" });
  expect(mocks.stored).toHaveBeenCalledWith({ userId: "owner", vaultKey: "memory-only", vaultOwnerToken: "owner-token" });
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("keeps all packet details through the paid v2 boundary and refuses malformed packets", async () => {
  mocks.get.mockResolvedValueOnce({ envelope: { ciphertext: "legacy" } });
  await expect(openMarketplaceDeliveryPresentations(params)).rejects.toThrow("verified v2");
  expect(mocks.legacy).not.toHaveBeenCalled();

  const encryptedExport = { export_envelope: { version: 2, aad: { machine_scope: "packet:fixture" } } };
  mocks.get.mockResolvedValue({ encryptedExport });
  mocks.stored.mockResolvedValue({ connector_key_id: "existing" });
  mocks.preview.mockImplementation((part) => ({ title: part.permissionLabel }));
  const packet = {
    kind: "pkm_packet", title: "Fixture packet", deliveredAt: "2099-01-01T00:00:00Z",
    parts: [
      { domain: "food", scope: "attr.food.preferences.*", label: "Food preferences", payload: { food: { preferences: "synthetic" } } },
      { domain: "work", scope: "attr.work.skills.*", label: "Work skills", payload: { work: { skills: "synthetic" } } },
    ],
    missing: [{ domain: "travel", label: "Travel preferences" }],
  };
  mocks.decrypt.mockResolvedValueOnce(packet);
  await expect(openMarketplaceDeliveryPresentations(params)).resolves.toEqual({
    presentations: [{ title: "Food preferences" }, { title: "Work skills" }],
    missing: ["Travel preferences"],
  });
  expect(mocks.preview).toHaveBeenNthCalledWith(1, expect.objectContaining({ domain: "food", topLevelScopePath: "preferences", value: { preferences: "synthetic" } }));
  expect(mocks.preview).toHaveBeenNthCalledWith(2, expect.objectContaining({ domain: "work", topLevelScopePath: "skills", value: { skills: "synthetic" } }));
  expect(mocks.legacy).not.toHaveBeenCalled();

  mocks.decrypt.mockResolvedValueOnce({ ...packet, missing: undefined });
  await expect(openMarketplaceDeliveryPresentations(params)).rejects.toThrow("delivered information is invalid");
  mocks.decrypt.mockResolvedValueOnce({ ...packet, parts: [null] });
  await expect(openMarketplaceDeliveryPresentations(params)).rejects.toThrow("delivered information is invalid");
  expect(mocks.preview).toHaveBeenCalledTimes(2);
});
