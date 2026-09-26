import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ loadDomainData: vi.fn(), loadDomainSnapshot: vi.fn(), storeRuntimeSecret: vi.fn(), removeRuntimeSecret: vi.fn() }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: storage }));
import { loadCustomConnectorConfigurations, loadCustomConnectorSnapshot, saveCustomConnectorConfiguration, saveCustomConnectorOAuthResult, removeCustomConnectorConfiguration, removeInvalidCustomConnectorConfiguration, parseCustomConnectorConfiguration, projectCustomConnectorTurnConfigurations, bearerAuthorizationValue, isVaultOwnerCredential } from "@/lib/connections/custom-connector-configuration";

const access = { userId: "synthetic-owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-token" };
const confirmation = { confirmedByUser: true as const, surface: "web" as const, source: "connector_test" };
const record = {
  version: 1 as const, connectorId: `custom_${"a".repeat(32)}`,
  revision: "11111111-1111-4111-8111-111111111111",
  displayName: "Synthetic connector", endpoint: "https://example.test/mcp", enabled: true,
  authentication: { kind: "api_key" as const, header: "Authorization" as const, value: "synthetic-secret" },
};

describe("vault-backed custom connector configuration", () => {
  const oauthResult = { tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer" },
    clientInfo: { client_id: "synthetic-client", client_secret: "synthetic-client-secret", redirect_uris: ["https://app.example/return"] }, expiresAt: 4070908800 };
  it("encrypts an OAuth result only against a fresh unchanged record and strips registration from turn state", async () => {
    const domain = { connectors: { [record.connectorId]: JSON.stringify(record) } };
    storage.loadDomainSnapshot.mockResolvedValue({ data: domain });
    storage.loadDomainData.mockResolvedValue(domain);
    const saved = await saveCustomConnectorOAuthResult(access, record.connectorId, record.revision, oauthResult, confirmation, () => true);
    expect(storage.loadDomainSnapshot).toHaveBeenCalledWith({ ...access, domain: "runtime_secrets", force: true });
    expect(saved.authentication).toMatchObject({ kind: "oauth", clientInfo: oauthResult.clientInfo });
    expect(JSON.stringify(projectCustomConnectorTurnConfigurations([saved]))).not.toContain("synthetic-client");
    expect(JSON.stringify(projectCustomConnectorTurnConfigurations([saved]))).not.toContain("synthetic-refresh");
  });
  it("rejects an OAuth return when the record changed during sign-in", async () => {
    storage.loadDomainSnapshot.mockResolvedValue({ data: { connectors: { [record.connectorId]: JSON.stringify({ ...record, revision: "22222222-2222-4222-8222-222222222222" }) } } });
    await expect(saveCustomConnectorOAuthResult(access, record.connectorId, record.revision, oauthResult, confirmation, () => true)).rejects.toThrow();
    expect(storage.storeRuntimeSecret).not.toHaveBeenCalled();
  });
  it.each([null, 1])("rejects missing or expired OAuth lifetime without inventing one", async expiresAt => {
    await expect(saveCustomConnectorOAuthResult(access, record.connectorId, record.revision, { ...oauthResult, expiresAt }, confirmation, () => true)).rejects.toThrow();
    expect(storage.storeRuntimeSecret).not.toHaveBeenCalled();
  });
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
  it.each([null, {}, { connectors: {} }])("allows a fresh Chat catalog when settings are absent: %j", async data => {
    storage.loadDomainSnapshot.mockResolvedValue({ data });
    const configurations = await loadCustomConnectorConfigurations(access, true);
    expect(projectCustomConnectorTurnConfigurations(configurations)).toEqual([]);
    expect(storage.loadDomainData).not.toHaveBeenCalled();
    expect(storage.storeRuntimeSecret).not.toHaveBeenCalled();
  });
  it("does not cache a failed forced read or fall back to warm credentials", async () => {
    storage.loadDomainData.mockResolvedValue({ connectors: { [record.connectorId]: JSON.stringify(record) } });
    storage.loadDomainSnapshot.mockRejectedValueOnce(new Error("synthetic-unavailable"))
      .mockResolvedValueOnce({ data: { connectors: { [record.connectorId]: JSON.stringify(record) } } });
    await expect(loadCustomConnectorConfigurations(access, true)).rejects.toThrow("synthetic-unavailable");
    expect(await loadCustomConnectorConfigurations(access, true)).toEqual([record]);
    expect(storage.loadDomainSnapshot).toHaveBeenCalledTimes(2);
    expect(storage.loadDomainData).not.toHaveBeenCalled();
  });
  it("projects only transient access credentials without mutating vault configuration", () => {
    const oauth = { ...record, enabled: true, oauthRegistration: {
      issuer: "https://auth.example", clientId: "synthetic-client",
      clientSecret: "synthetic-registration-secret", tokenEndpointAuthMethod: "client_secret_post" as const,
    }, authentication: { kind: "oauth" as const,
      accessToken: "synthetic-access", expiresAt: 2000000000, refreshToken: "synthetic-refresh" } };
    const projected = projectCustomConnectorTurnConfigurations([oauth]);
    expect(projected[0]?.authentication).toEqual({ kind: "oauth", accessToken: "synthetic-access", expiresAt: 2000000000 });
    expect(JSON.stringify(projected)).not.toContain("synthetic-refresh");
    expect(JSON.stringify(projected)).not.toContain("synthetic-registration-secret");
    expect(JSON.stringify(projected)).not.toContain("synthetic-client");
    expect(oauth.authentication.refreshToken).toBe("synthetic-refresh");
    expect(projectCustomConnectorTurnConfigurations([{ ...oauth, enabled: false }])).toEqual([]);
  });
  it("rejects duplicate or oversized turn catalogs", () => {
    expect(() => projectCustomConnectorTurnConfigurations([record, record])).toThrow();
    expect(() => projectCustomConnectorTurnConfigurations(Array(33).fill(record))).toThrow();
  });
  it("keeps legacy records removable but never forwards or re-saves a vault-owner credential", async () => {
    for (const value of ["HCT:synthetic.signature", "Bearer HCT:synthetic.signature"]) {
      const legacy = parseCustomConnectorConfiguration({ ...record, authentication: { ...record.authentication, value } });
      expect(() => projectCustomConnectorTurnConfigurations([legacy])).toThrow();
      await expect(saveCustomConnectorConfiguration(access, legacy, confirmation, null)).rejects.toThrow();
    }
    expect(storage.storeRuntimeSecret).not.toHaveBeenCalled();
  });
  it("never forwards or saves a vault-owner credential returned as an OAuth access token", async () => {
    for (const accessToken of ["HCT:synthetic.signature", "Bearer HCT:synthetic.signature"]) {
      const legacy = parseCustomConnectorConfiguration({ ...record,
        authentication: { kind: "oauth", accessToken, expiresAt: 4070908800 } });
      expect(() => projectCustomConnectorTurnConfigurations([legacy])).toThrow();
      await expect(saveCustomConnectorConfiguration(access, legacy, confirmation, null)).rejects.toThrow();
    }
    expect(storage.storeRuntimeSecret).not.toHaveBeenCalled();
  });
  it("quarantines one unsafe sibling without hiding valid tools or exposing its contents", async () => {
    const invalidId = `custom_${"b".repeat(32)}`;
    const legacy = JSON.stringify({ ...record, connectorId: invalidId,
      authentication: { kind: "api_key", header: "Authorization", value: "HCT:synthetic.signature" } });
    storage.loadDomainSnapshot.mockResolvedValue({ data: { connectors: {
      [record.connectorId]: JSON.stringify(record), [invalidId]: legacy,
    } } });
    const snapshot = await loadCustomConnectorSnapshot(access, true);
    expect(snapshot.configurations).toEqual([record]);
    expect(snapshot.invalid).toEqual([{ connectorId: invalidId, removable: true }]);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic.signature");
    expect(projectCustomConnectorTurnConfigurations(snapshot.configurations)).toHaveLength(1);
    await removeInvalidCustomConnectorConfiguration(access, invalidId, confirmation);
    expect(storage.removeRuntimeSecret).toHaveBeenCalledWith({ ...access, confirmation,
      credentialRef: `pkm:runtime_secrets.connectors.${invalidId}`, expectedValue: legacy });
    await expect(removeInvalidCustomConnectorConfiguration(access, record.connectorId, confirmation)).rejects.toThrow();
  });
  it("fails closed on a malformed connector root or failed forced vault read", async () => {
    storage.loadDomainSnapshot.mockResolvedValueOnce({ data: { connectors: [] } })
      .mockRejectedValueOnce(new Error("vault-unavailable"));
    await expect(loadCustomConnectorSnapshot(access, true)).rejects.toThrow("Connector settings could not be read.");
    await expect(loadCustomConnectorSnapshot(access, true)).rejects.toThrow("vault-unavailable");
  });
  it("keeps exact blocked-tool fingerprints in the encrypted record and turn projection", () => {
    const blockedTool = { id: `mcp_${"b".repeat(40)}`, fingerprint: "c".repeat(64) };
    const configured = parseCustomConnectorConfiguration({ ...record, blockedTools: [blockedTool] });
    expect(projectCustomConnectorTurnConfigurations([configured])[0]?.blockedTools).toEqual([blockedTool]);
    expect(() => parseCustomConnectorConfiguration({ ...record, blockedTools: [blockedTool, blockedTool] })).toThrow();
    expect(() => parseCustomConnectorConfiguration({ ...record, blockedTools: [{ id: blockedTool.id, fingerprint: "changed" }] })).toThrow();
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

describe("bearerAuthorizationValue", () => {
  it.each([
    ["abc.def-ghi_123", "Bearer abc.def-ghi_123"],
    ["  eyJhbGciOiJIUzI1NiJ9.e30.sig  ", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig"],
    ["Bearer abc", "Bearer abc"],
    ["bearer abc", "bearer abc"],
    ["Basic dXNlcjpwYXNz", "Basic dXNlcjpwYXNz"],
    ["Token abc", "Token abc"],
  ])("normalizes %j", (value, expected) => {
    expect(bearerAuthorizationValue(value)).toBe(expected);
  });
  it("still recognizes a vault token after normalization", () => {
    expect(isVaultOwnerCredential(bearerAuthorizationValue("HCT:synthetic.signature"))).toBe(true);
  });
  it.each(["Token HCT:synthetic.signature", "  basic   hct:synthetic.signature"])(
    "refuses a vault token under any scheme %j", (value) => {
      expect(isVaultOwnerCredential(bearerAuthorizationValue(value))).toBe(true);
    });
});
