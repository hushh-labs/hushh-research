import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ loadDomainData: vi.fn(), loadDomainSnapshot: vi.fn(), storeRuntimeSecret: vi.fn(), removeRuntimeSecret: vi.fn() }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: storage }));
import { loadCustomConnectorConfigurations, saveCustomConnectorConfiguration, removeCustomConnectorConfiguration, parseCustomConnectorConfiguration, projectCustomConnectorTurnConfigurations } from "@/lib/connections/custom-connector-configuration";

const access = { userId: "synthetic-owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-token" };
const confirmation = { confirmedByUser: true as const, surface: "web" as const, source: "connector_test" };
const record = {
  version: 1 as const, connectorId: `custom_${"a".repeat(32)}`,
  revision: "11111111-1111-4111-8111-111111111111",
  displayName: "Synthetic connector", endpoint: "https://example.test/mcp", enabled: true,
  authentication: { kind: "api_key" as const, header: "Authorization" as const, value: "synthetic-secret" },
};

describe("vault-backed custom connector configuration", () => {
  it("rejects a lock during preparation before starting the encrypted write", async () => {
    let current = true;
    storage.loadDomainData.mockImplementationOnce(async () => { current = false; return null; });
    await expect(saveCustomConnectorConfiguration(access, record, confirmation, null, () => current)).rejects.toThrow();
    expect(storage.storeRuntimeSecret).not.toHaveBeenCalled();
  });
  it("forces a coherent snapshot for invocation and confirmation instead of warm credentials", async () => {
    storage.loadDomainSnapshot.mockResolvedValue({ data: { connectors: { [record.connectorId]: JSON.stringify(record) } } });
    expect(await loadCustomConnectorConfigurations(access, true)).toEqual([record]);
    expect(storage.loadDomainSnapshot).toHaveBeenCalledWith({ ...access, domain: "runtime_secrets", force: true });
    expect(storage.loadDomainData).not.toHaveBeenCalled();
  });
  it("projects only transient access credentials without mutating vault configuration", () => {
    const oauth = { ...record, enabled: true, authentication: { kind: "oauth" as const,
      accessToken: "synthetic-access", expiresAt: 2000000000, refreshToken: "synthetic-refresh" } };
    const projected = projectCustomConnectorTurnConfigurations([oauth]);
    expect(projected[0]?.authentication).toEqual({ kind: "oauth", accessToken: "synthetic-access", expiresAt: 2000000000 });
    expect(JSON.stringify(projected)).not.toContain("synthetic-refresh");
    expect(oauth.authentication.refreshToken).toBe("synthetic-refresh");
    expect(projectCustomConnectorTurnConfigurations([{ ...oauth, enabled: false }])).toEqual([]);
  });
  it("rejects duplicate or oversized turn catalogs", () => {
    expect(() => projectCustomConnectorTurnConfigurations([record, record])).toThrow();
    expect(() => projectCustomConnectorTurnConfigurations(Array(33).fill(record))).toThrow();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    storage.loadDomainData.mockResolvedValue(null);
  });
  it("saves one encrypted record with fresh revision and explicit confirmation", async () => {
    const saved = await saveCustomConnectorConfiguration(access, record, confirmation, null);
    expect(saved.revision).not.toBe(record.revision);
    expect(record.revision).toBe("11111111-1111-4111-8111-111111111111");
    expect(storage.storeRuntimeSecret).toHaveBeenCalledWith({ ...access, confirmation,
      credentialRef: `pkm:runtime_secrets.connectors.${record.connectorId}`, secret: JSON.stringify(saved), expectedValue: null });
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
    storage.loadDomainData.mockResolvedValue({ connectors: { [record.connectorId]: JSON.stringify(record) } });
    await removeCustomConnectorConfiguration(access, record.connectorId, confirmation, record.revision);
    expect(storage.removeRuntimeSecret).toHaveBeenCalledWith({ ...access, confirmation, credentialRef: `pkm:runtime_secrets.connectors.${record.connectorId}`, expectedValue: JSON.stringify(record) });
    await expect(removeCustomConnectorConfiguration(access, "__proto__.bad", confirmation, record.revision)).rejects.toThrow();
    expect(storage.removeRuntimeSecret).toHaveBeenCalledTimes(1);
  });
  it.each([[], 4, "corrupt", false])("rejects malformed roots instead of claiming no connectors", async root => {
    storage.loadDomainData.mockResolvedValue(root);
    await expect(loadCustomConnectorConfigurations(access)).rejects.toThrow("Connector settings could not be read.");
    await expect(saveCustomConnectorConfiguration(access, record, confirmation, null)).rejects.toThrow();
    expect(storage.storeRuntimeSecret).not.toHaveBeenCalled();
  });
  it("rejects stale edits and removals before writing", async () => {
    storage.loadDomainData.mockResolvedValue({ connectors: { [record.connectorId]: JSON.stringify(record) } });
    await expect(saveCustomConnectorConfiguration(access, record, confirmation, null)).rejects.toThrow("This connector changed.");
    await expect(removeCustomConnectorConfiguration(access, record.connectorId, confirmation, "stale")).rejects.toThrow("This connector changed.");
    expect(storage.storeRuntimeSecret).not.toHaveBeenCalled();
    expect(storage.removeRuntimeSecret).not.toHaveBeenCalled();
  });
});
