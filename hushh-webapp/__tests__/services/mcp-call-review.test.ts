import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMcpCallReview } from "@/lib/agent/mcp-call-review";
import { ExternalConnectorService, McpCatalogAuthenticationError } from "@/lib/services/external-connector-service";
import { ApiService } from "@/lib/services/api-service";

vi.mock("@/lib/config", () => ({ BACKEND_URL: "https://backend.test" }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  apiFetch: vi.fn(), getAuthHeaders: () => ({ Authorization: "Bearer synthetic" }),
} }));

const reference = {
  kind: "mcp_call_review" as const, version: 1 as const,
  connectorId: "custom_synthetic", toolName: `mcp_${"a".repeat(40)}`,
  directiveId: `dir_${"b".repeat(32)}`, pendingHandle: `one_secret_ref:${"c".repeat(32)}`,
  expiresAt: "2099-01-01T00:00:00Z",
};
const nativeArgs = () => ({
  originalFunctionCall: { id: "original-call", name: reference.toolName, args: {} },
  toolConfirmation: { confirmed: false, payload: { ...reference } },
});
const preview = { ...reference, status: "review_required", connectorLabel: "Synthetic connector", toolLabel: "find_files", arguments: { query: "synthetic" } };
const input = () => ({
  reference, conversationId: "synthetic-thread", vaultOwnerToken: "synthetic",
  signal: new AbortController().signal, isEffectCurrent: () => true,
});
const respond = (body: unknown, status = 200) => vi.mocked(ApiService.apiFetch)
  .mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

beforeEach(() => vi.clearAllMocks());

describe("ephemeral MCP review", () => {
  const configuration = {
    version: 1 as const, connectorId: `custom_${"a".repeat(32)}`,
    revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic",
    endpoint: "https://example.com/mcp", enabled: true,
    authentication: { kind: "oauth" as const, accessToken: "synthetic-access",
      expiresAt: 4070908800, refreshToken: "synthetic-refresh" },
  };

  it("transmits only the selected transient configuration without refresh credentials", async () => {
    const selected = { ...reference, connectorId: configuration.connectorId };
    respond({ ...preview, connectorId: selected.connectorId });
    await ExternalConnectorService.reviewMcpCall({ ...input(), reference: selected, configuration });
    const body = JSON.parse(vi.mocked(ApiService.apiFetch).mock.calls[0][1]!.body as string);
    expect(body.connectorConfiguration.authentication).toEqual({
      kind: "oauth", accessToken: "synthetic-access", expiresAt: 4070908800,
    });
    expect(configuration.authentication.refreshToken).toBe("synthetic-refresh");
  });

  it("refreshes a revision-bound catalog without granting permission", async () => {
    respond({ connectorId: configuration.connectorId, configurationRevision: configuration.revision,
      status: "available", tools: [{ id: reference.toolName, name: "search_files", revision: "rev1", permission: "ask_first", ignored: "private" }] });
    const tools = await ExternalConnectorService.refreshMcpCatalog({ ...input(), configuration });
    expect(tools).toEqual([{ id: reference.toolName, name: "search_files", revision: "rev1" }]);
    expect(vi.mocked(ApiService.apiFetch).mock.calls[0][1]?.body).not.toContain("synthetic-refresh");
  });

  it("rejects another configuration's catalog", async () => {
    respond({ connectorId: configuration.connectorId, configurationRevision: "other", status: "empty", tools: [] });
    await expect(ExternalConnectorService.refreshMcpCatalog({ ...input(), configuration })).rejects.toThrow("changed");
  });

  it("distinguishes a provider credential refusal from app authentication failure", async () => {
    respond({ detail: { code: "EXTERNAL_MCP_AUTH_FAILED", message: "private provider response" } }, 401);
    await expect(ExternalConnectorService.refreshMcpCatalog({ ...input(), configuration }))
      .rejects.toBeInstanceOf(McpCatalogAuthenticationError);
    respond({ detail: "Vault owner token expired" }, 401);
    await expect(ExternalConnectorService.refreshMcpCatalog({ ...input(), configuration }))
      .rejects.not.toBeInstanceOf(McpCatalogAuthenticationError);
  });

  it("rejects a configuration for another connector before transport", async () => {
    await expect(ExternalConnectorService.reviewMcpCall({ ...input(), configuration }))
      .rejects.toThrow("configuration changed");
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
  });

  it("projects only known references and rejects another native tool", () => {
    const args = nativeArgs();
    expect(parseMcpCallReview(args)).toEqual(reference);
    args.originalFunctionCall.name = `mcp_${"d".repeat(40)}`;
    expect(parseMcpCallReview(args)).toBeNull();
    expect(parseMcpCallReview({ ...nativeArgs(), hint: "untrusted text" })).toEqual(reference);
  });

  it.each([null, [], {}, { toolConfirmation: { confirmed: true } }])("rejects malformed native review %j", (value) => {
    expect(parseMcpCallReview(value)).toBeNull();
  });

  it("rejects unsanitized private native arguments", () => {
    const args = nativeArgs();
    args.originalFunctionCall.args = { privateValue: "synthetic" };
    expect(parseMcpCallReview(args)).toBeNull();
  });

  it("fetches the original pending preview without reissuing model arguments", async () => {
    respond(preview);
    const result = await ExternalConnectorService.reviewMcpCall(input());
    expect(result.arguments).toEqual(preview.arguments);
    const [path, request] = vi.mocked(ApiService.apiFetch).mock.calls[0];
    expect(path).toBe("/api/connectors/custom_synthetic/mcp/review");
    expect(request?.cache).toBe("no-store");
    expect(JSON.parse(request!.body as string)).toEqual({
      conversationId: "synthetic-thread", toolName: reference.toolName,
      pendingHandle: reference.pendingHandle, arguments: {},
    });
  });

  it.each(["connectorId", "toolName", "directiveId", "pendingHandle", "expiresAt"])("rejects changed preview %s", async (key) => {
    respond({ ...preview, [key]: "different" });
    await expect(ExternalConnectorService.reviewMcpCall(input())).rejects.toThrow("review changed");
  });

  it("discards a late private preview after lock or account change", async () => {
    let current = true;
    vi.mocked(ApiService.apiFetch).mockImplementationOnce(async () => {
      current = false;
      return new Response(JSON.stringify(preview));
    });
    await expect(ExternalConnectorService.reviewMcpCall({ ...input(), isEffectCurrent: () => current }))
      .rejects.toThrow("vault session changed");
  });

  it("rejects expired and cancelled review before any request", async () => {
    await expect(ExternalConnectorService.reviewMcpCall({ ...input(), reference: { ...reference, expiresAt: "2000-01-01" } }))
      .rejects.toThrow("expired");
    const controller = new AbortController(); controller.abort();
    await expect(ExternalConnectorService.reviewMcpCall({ ...input(), signal: controller.signal }))
      .rejects.toThrow("expired");
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
  });

  it("confirms exact reviewed arguments and projects an ephemeral approval only", async () => {
    respond({ status: "confirmed", directiveId: reference.directiveId, receipt: "r".repeat(48), privateExtra: "never retained" });
    const result = await ExternalConnectorService.confirmMcpCall({ ...input(), reference: preview });
    expect(result).toEqual({ connectorId: reference.connectorId, toolName: reference.toolName,
      directiveId: reference.directiveId, pendingHandle: reference.pendingHandle, receipt: "r".repeat(48) });
    const body = JSON.parse(vi.mocked(ApiService.apiFetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ arguments: preview.arguments, confirmed: true, directiveId: reference.directiveId });
    expect(ApiService.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("does not expose error bodies or retry uncertain confirmation", async () => {
    respond({ detail: "private provider text" }, 503);
    await expect(ExternalConnectorService.confirmMcpCall({ ...input(), reference: preview }))
      .rejects.toThrow("No automatic retry");
    expect(ApiService.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a receipt from another directive", async () => {
    respond({ status: "confirmed", directiveId: `dir_${"d".repeat(32)}`, receipt: "r".repeat(48) });
    await expect(ExternalConnectorService.confirmMcpCall({ ...input(), reference: preview }))
      .rejects.toThrow("could not be verified");
  });
});
