import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

vi.mock("@/lib/services/one-kyc-service", () => ({
  OneKycService: {
    getClientConnector: vi.fn(),
    registerClientConnector: vi.fn(),
  },
}));

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { OneKycService } from "@/lib/services/one-kyc-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

import { KYC_CONNECTOR_WRAPPING_ALG, OneKycClientZkService, type KycClientConnectorPrivateRecord } from "@/lib/services/one-kyc-client-zk-service";

const connector: KycClientConnectorPrivateRecord = {
  connector_key_id: "one-kyc-test",
  connector_public_key: "public-key",
  connector_private_key: "private-key",
  connector_private_key_format: "pkcs8",
  connector_wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
  public_key_fingerprint: "fingerprint",
  created_at: "2026-05-04T00:00:00.000Z",
};

describe("vault-backed connector key history", () => {
  it("retains exact historical private keys in encrypted PKM across rotation and never generates a key on a missing historical read", async () => {
    const rotated = { ...connector, connector_key_id: "one-kyc-next", connector_public_key: "next-public" };
    let stored: Record<string, unknown> = { active: connector, schema_version: 1 };
    vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockImplementation(async input => {
      const result = await input.build({ currentDomainData: stored } as never);
      stored = result.domainData;
      return { success: true, saveState: "saved" } as never;
    });
    await OneKycClientZkService.storeConnector({ userId: "user_1", vaultKey: "vault", vaultOwnerToken: "owner", connector: rotated });
    vi.mocked(PkmDomainResourceService.getStaleFirst).mockImplementation(async () => ({ data: stored }) as never);
    const parameters = { userId: "user_1", vaultKey: "vault", vaultOwnerToken: "owner" };
    expect(await OneKycClientZkService.readStoredConnector({ ...parameters, keyId: connector.connector_key_id })).toEqual(connector);
    expect(await OneKycClientZkService.readStoredConnector(parameters)).toEqual(rotated);
    vi.mocked(OneKycService.registerClientConnector).mockClear();
    expect(await OneKycClientZkService.readStoredConnector({ ...parameters, keyId: "lost-key" })).toBeNull();
    expect(OneKycService.registerClientConnector).not.toHaveBeenCalled();
    await expect(OneKycClientZkService.storeConnector({ ...parameters, connector: { ...connector, connector_public_key: "substituted" } })).rejects.toThrow("identity changed");
  });
});
