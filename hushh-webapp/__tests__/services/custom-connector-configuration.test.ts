import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ loadDomainData: vi.fn(), storeRuntimeSecret: vi.fn(), removeRuntimeSecret: vi.fn() }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: storage }));
import { loadCustomConnectorConfigurations, saveCustomConnectorConfiguration, removeCustomConnectorConfiguration, parseCustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";

const access = { userId: "synthetic-owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-token" };
const confirmation = { confirmedByUser: true as const, surface: "web" as const, source: "connector_test" };
const record = {
  version: 1 as const, connectorId: `custom_${"a".repeat(32)}`,
  revision: "11111111-1111-4111-8111-111111111111",
  displayName: "Synthetic connector", endpoint: "https://example.test/mcp", enabled: true,
  authentication: { kind: "api_key" as const, header: "Authorization" as const, value: "synthetic-secret" },
};

describe("vault-backed custom connector configuration", () => {
  beforeEach(() => vi.resetAllMocks());
  it("saves one encrypted record with fresh revision and explicit confirmation", async () => {
    const saved = await saveCustomConnectorConfiguration(access, record, confirmation);
    expect(saved.revision).not.toBe(record.revision);
    expect(record.revision).toBe("11111111-1111-4111-8111-111111111111");
    expect(storage.storeRuntimeSecret).toHaveBeenCalledWith({ ...access, confirmation,
      credentialRef: `pkm:runtime_secrets.connectors.${record.connectorId}`, secret: JSON.stringify(saved) });
  });
  it("reads without retaining a module-level cache", async () => {
    storage.loadDomainData.mockResolvedValueOnce({ connectors: { [record.connectorId]: JSON.stringify(record) } })
      .mockResolvedValueOnce(null);
    expect(await loadCustomConnectorConfigurations(access)).toEqual([record]);
    expect(await loadCustomConnectorConfigurations(access)).toEqual([]);
    expect(storage.loadDomainData).toHaveBeenCalledTimes(2);
  });
  it.each(["not-json", JSON.stringify({ ...record, connectorId: `custom_${"b".repeat(32)}` }), "x".repeat(32001)])(
    "rejects corrupt or mismatched stored records without echoing content", async serialized => {
      storage.loadDomainData.mockResolvedValue({ connectors: { [record.connectorId]: serialized } });
      await expect(loadCustomConnectorConfigurations(access)).rejects.toThrow("Connector settings could not be read.");
    });
  it("propagates unavailable vault reads rather than returning an empty list", async () => {
    storage.loadDomainData.mockRejectedValue(new Error("synthetic-unavailable"));
    await expect(loadCustomConnectorConfigurations(access)).rejects.toThrow("synthetic-unavailable");
  });
  it.each(["http://example.test/mcp", "https://secret@example.test/mcp", "https://example.test/mcp?token=secret", "https://example.test/mcp#fragment"])(
    "rejects unsafe endpoint syntax", endpoint => {
      expect(() => parseCustomConnectorConfiguration({ ...record, endpoint })).toThrow("Connector settings could not be read.");
    });
  it("rejects arbitrary credential headers and control characters", () => {
    expect(() => parseCustomConnectorConfiguration({ ...record, authentication: { ...record.authentication, header: "Host" } })).toThrow();
    expect(() => parseCustomConnectorConfiguration({ ...record, authentication: { ...record.authentication, value: "a\r\nb" } })).toThrow();
  });
  it("removes only the validated encrypted record", async () => {
    await removeCustomConnectorConfiguration(access, record.connectorId, confirmation);
    expect(storage.removeRuntimeSecret).toHaveBeenCalledWith({ ...access, confirmation, credentialRef: `pkm:runtime_secrets.connectors.${record.connectorId}` });
    await expect(removeCustomConnectorConfiguration(access, "__proto__.bad", confirmation)).rejects.toThrow();
    expect(storage.removeRuntimeSecret).toHaveBeenCalledTimes(1);
  });
});
