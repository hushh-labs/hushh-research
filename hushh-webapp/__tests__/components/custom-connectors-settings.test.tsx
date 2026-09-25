import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CustomConnectorsSettings } from "@/components/agent/custom-connectors-settings";
import { loadCustomConnectorConfigurations, saveCustomConnectorConfiguration, removeCustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { ExternalConnectorService, McpCatalogAuthenticationError } from "@/lib/services/external-connector-service";
import { Capacitor } from "@capacitor/core";
import { HushhOAuthReturn, isNativeCustomConnectorReturnUri } from "@/lib/capacitor/oauth-return";
import { rememberRefreshedMcpCatalog } from "@/lib/connections/custom-mcp-catalog-handoff";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { refreshMcpCatalog: vi.fn(), privateMcpOAuth: vi.fn() },
  McpCatalogAuthenticationError: class extends Error {},
}));
vi.mock("@/lib/capacitor/oauth-return", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capacitor/oauth-return")>()),
  HushhOAuthReturn: { openAuthorization: vi.fn() },
}));

vi.mock("@/lib/connections/custom-connector-configuration", () => ({ loadCustomConnectorConfigurations: vi.fn(), saveCustomConnectorConfiguration: vi.fn(), removeCustomConnectorConfiguration: vi.fn() }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: vi.fn() } }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, size: _s, variant: _v, effect: _e, ...props }: any) => <button {...props}>{children}</button> }));
const access = { userId: "synthetic-owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-owner-token" };
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  publishValidatedAuthSessionOwner(access.userId);
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([]);
  vi.mocked(saveCustomConnectorConfiguration).mockImplementation(async (_access, record) => record);
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue([{ id: "mcp_" + "b".repeat(40), name: "search", revision: "rev1", fingerprint: "c".repeat(64), permission: "ask_first" }]);
});

it("admits only the app-owned HTTPS return for native connector sign-in", () => {
  expect(isNativeCustomConnectorReturnUri("https://one.hushh.ai/one/profile/connectors/oauth/return")).toBe(true);
  expect(isNativeCustomConnectorReturnUri("http://localhost:3001/one/profile/connectors/oauth/return")).toBe(false);
  expect(isNativeCustomConnectorReturnUri("https://one.hushh.ai.evil.example/one/profile/connectors/oauth/return")).toBe(false);
  expect(isNativeCustomConnectorReturnUri("https://one.hushh.ai/one/profile/connectors/oauth/return?code=leaked")).toBe(false);
});

it("opens native custom OAuth only after owner-bound recovery is ready", async () => {
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const }, oauthRegistration: { issuer: "https://auth.example", clientId: "synthetic-client", tokenEndpointAuthMethod: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  const callback = "https://one.hushh.ai/one/profile/connectors/oauth/return";
  vi.mocked(ExternalConnectorService.privateMcpOAuth).mockResolvedValue({ attemptId: "a".repeat(43), authorizeUrl: "https://auth.example/authorize", redirectUri: callback });
  const prepare = vi.fn().mockResolvedValue("ready");
  render(<CustomConnectorsSettings access={access} onPrepareRecovery={prepare} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Synthetic" }));
  await waitFor(() => expect(HushhOAuthReturn.openAuthorization).toHaveBeenCalledWith({
    authorizeUrl: "https://auth.example/authorize", redirectUri: callback,
    attemptId: "a".repeat(43), expectedUserId: access.userId,
  }));
  expect(prepare).toHaveBeenCalledOnce();
});

it("refuses a native callback that cannot return to this app", async () => {
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const }, oauthRegistration: { issuer: "https://auth.example", clientId: "synthetic-client", tokenEndpointAuthMethod: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.privateMcpOAuth).mockResolvedValueOnce({ attemptId: "a".repeat(43), authorizeUrl: "https://auth.example/authorize", redirectUri: "http://localhost:3001/one/profile/connectors/oauth/return" }).mockResolvedValueOnce(null);
  const prepare = vi.fn();
  render(<CustomConnectorsSettings access={access} onPrepareRecovery={prepare} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Synthetic" }));
  await waitFor(() => expect(ExternalConnectorService.privateMcpOAuth).toHaveBeenCalledTimes(2));
  expect(prepare).not.toHaveBeenCalled();
  expect(HushhOAuthReturn.openAuthorization).not.toHaveBeenCalled();
});

it("verifies tools before saving through the vault", async () => {
  render(<CustomConnectorsSettings access={access} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Add connector" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic server" } });
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://example.com/mcp" } });
  fireEvent.change(screen.getByLabelText("Authorization header (optional)"), { target: { value: "Bearer synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connector" }));
  await screen.findByText("1 tools discovered");
  expect(ExternalConnectorService.refreshMcpCatalog).toHaveBeenCalledOnce();
  expect(saveCustomConnectorConfiguration).toHaveBeenCalledOnce();
  expect(vi.mocked(saveCustomConnectorConfiguration).mock.calls[0][2]).toMatchObject({ confirmedByUser: true });
  expect(document.body.textContent).not.toContain("Bearer synthetic");
});

it("keeps a failed connection draft and does not save it", async () => {
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockRejectedValue(new Error("synthetic failure"));
  render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unreachable" } });
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://example.com/mcp" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connector" }));
  await waitFor(() => expect(ExternalConnectorService.refreshMcpCatalog).toHaveBeenCalledOnce());
  expect(saveCustomConnectorConfiguration).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Name")).toHaveValue("Unreachable");
});

it("saves an OAuth challenge only as sign-in pending, never as connected", async () => {
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockRejectedValue(new McpCatalogAuthenticationError());
  render(<CustomConnectorsSettings access={access} onPrepareRecovery={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "GitHub" } });
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://api.githubcopilot.com/mcp/" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connector" }));
  await screen.findByText("Sign in needed");
  expect(screen.getByRole("button", { name: "Sign in to GitHub" })).toBeEnabled();
  expect(screen.queryByText(/tools discovered/)).toBeNull();
});

it("does not save a rejected supplied credential as an OAuth setup", async () => {
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockRejectedValue(new McpCatalogAuthenticationError());
  render(<CustomConnectorsSettings access={access} onPrepareRecovery={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rejected" } });
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://example.com/mcp" } });
  fireEvent.change(screen.getByLabelText("Authorization header (optional)"), { target: { value: "Bearer invalid" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connector" }));
  await waitFor(() => expect(ExternalConnectorService.refreshMcpCatalog).toHaveBeenCalledOnce());
  expect(saveCustomConnectorConfiguration).not.toHaveBeenCalled();
});

it("does not enable adding when the vault catalog cannot be read", async () => {
  vi.mocked(loadCustomConnectorConfigurations).mockRejectedValue(new Error("synthetic failure"));
  render(<CustomConnectorsSettings access={access} />);
  await screen.findByText(/Could not load saved connectors/);
  expect(screen.getByRole("button", { name: "Add connector" })).toBeDisabled();
});

it("does not carry a cancelled OAuth registration into another connector", async () => {
  render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
  fireEvent.click(screen.getByText("OAuth client settings (if provided by your server)"));
  fireEvent.change(screen.getByLabelText("Authorization server issuer"), { target: { value: "https://auth.example" } });
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "old-client" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New server" } });
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://new.example/mcp" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connector" }));
  await waitFor(() => expect(saveCustomConnectorConfiguration).toHaveBeenCalledOnce());
  expect(vi.mocked(saveCustomConnectorConfiguration).mock.calls[0][1]).not.toHaveProperty("oauthRegistration");
});

it("clears a hidden client secret when switching back to public OAuth", async () => {
  render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
  fireEvent.click(screen.getByText("OAuth client settings (if provided by your server)"));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Public server" } });
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://example.com/mcp" } });
  fireEvent.change(screen.getByLabelText("Authorization server issuer"), { target: { value: "https://auth.example" } });
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "public-client" } });
  fireEvent.change(screen.getByLabelText("Token authentication"), { target: { value: "client_secret_post" } });
  fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "synthetic-secret" } });
  fireEvent.change(screen.getByLabelText("Token authentication"), { target: { value: "none" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connector" }));
  await waitFor(() => expect(saveCustomConnectorConfiguration).toHaveBeenCalledOnce());
  expect(vi.mocked(saveCustomConnectorConfiguration).mock.calls[0][1].oauthRegistration).toEqual({
    issuer: "https://auth.example", clientId: "public-client", tokenEndpointAuthMethod: "none",
  });
});

it("cancels OAuth rather than leave Chat when encrypted draft recovery is busy", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const }, oauthRegistration: {
    issuer: "https://auth.example", clientId: "synthetic-client", clientSecret: "synthetic-secret", tokenEndpointAuthMethod: "client_secret_post" as const,
  } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.privateMcpOAuth).mockResolvedValueOnce({ attemptId: "a".repeat(43), authorizeUrl: "https://auth.example/authorize" }).mockResolvedValueOnce(null);
  const prepare = vi.fn().mockResolvedValue("busy");
  render(<CustomConnectorsSettings access={access} onPrepareRecovery={prepare} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Synthetic" }));
  await waitFor(() => expect(ExternalConnectorService.privateMcpOAuth).toHaveBeenCalledTimes(2));
  expect(prepare).toHaveBeenCalledWith({ attemptId: "a".repeat(43), reason: "web_full_page", customConnector: { connectorId: record.connectorId, revision: record.revision } });
  expect(ExternalConnectorService.privateMcpOAuth).toHaveBeenNthCalledWith(1, expect.objectContaining({
    operation: "begin", payload: { revision: record.revision, endpoint: record.endpoint, registeredClient: record.oauthRegistration },
  }));
  expect(ExternalConnectorService.privateMcpOAuth).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "cancel" }));
  expect(saveCustomConnectorConfiguration).not.toHaveBeenCalled();
});

it("requires confirmation and the displayed revision before removal", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Synthetic" }));
  expect(removeCustomConnectorConfiguration).not.toHaveBeenCalled();
  expect(screen.getByText(/does not revoke access/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove connector" }));
  await waitFor(() => expect(removeCustomConnectorConfiguration).toHaveBeenCalledWith(access, record.connectorId, expect.objectContaining({ confirmedByUser: true }), record.revision, expect.any(Function)));
});

it("refreshes tools from the current vault configuration on explicit tap", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue([{ id: "mcp_" + "b".repeat(40), name: "search_files", revision: "rev1", fingerprint: "c".repeat(64), permission: "ask_first" }]);
  render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh tools for Synthetic" }));
  await screen.findByText("1 tools");
  expect(loadCustomConnectorConfigurations).toHaveBeenCalledTimes(2);
  expect(ExternalConnectorService.refreshMcpCatalog).toHaveBeenCalledWith(expect.objectContaining({ configuration: record, isEffectCurrent: expect.any(Function) }));
  expect(screen.queryByRole("button", { name: "Sign in to Synthetic" })).toBeNull();
});

it("shows the one-time catalog refreshed during OAuth return without another provider call", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "oauth" as const, accessToken: "synthetic", expiresAt: Math.floor(Date.now() / 1000) + 300 } };
  const tools = [{ id: "mcp_" + "b".repeat(40), name: "search_files", revision: "rev1", fingerprint: "c".repeat(64), permission: "ask_first" as const }];
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  rememberRefreshedMcpCatalog({ ownerUserId: access.userId, vaultEpoch: snapshotVaultSessionEpoch(),
    connectorId: record.connectorId, configurationRevision: record.revision, tools });
  render(<CustomConnectorsSettings access={access} />);
  expect(await screen.findByText("1 tools discovered")).toBeInTheDocument();
  fireEvent.click(screen.getByText("1 tools"));
  expect(screen.getByText("search_files")).toBeInTheDocument();
  expect(ExternalConnectorService.refreshMcpCatalog).not.toHaveBeenCalled();
});

it("offers OAuth only after an unauthenticated server requests it", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockRejectedValue(new McpCatalogAuthenticationError());
  render(<CustomConnectorsSettings access={access} onPrepareRecovery={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Refresh tools for Synthetic" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Sign in to Synthetic" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh tools for Synthetic" }));
  expect(await screen.findByText("Sign in needed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in to Synthetic" })).toBeEnabled();
});

it("does not send a rejected API key into OAuth", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "api_key" as const, header: "Authorization" as const, value: "synthetic" } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockRejectedValue(new McpCatalogAuthenticationError());
  render(<CustomConnectorsSettings access={access} onPrepareRecovery={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh tools for Synthetic" }));
  expect(await screen.findByText("Saved credential rejected · remove and add again")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in to Synthetic" })).toBeNull();
});

it("discards tool catalogs and pending removal when the owner changes", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue([{ id: "mcp_" + "b".repeat(40), name: "prior_owner_tool", revision: "rev1", fingerprint: "c".repeat(64), permission: "ask_first" }]);
  const view = render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh tools for Synthetic" }));
  await screen.findByText("prior_owner_tool");
  fireEvent.click(screen.getByRole("button", { name: "Remove Synthetic" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  publishValidatedAuthSessionOwner("next-owner");
  view.rerender(<CustomConnectorsSettings access={{ ...access, userId: "next-owner" }} />);
  await screen.findByRole("button", { name: "Refresh tools for Synthetic" });
  expect(screen.queryByText("prior_owner_tool")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(removeCustomConnectorConfiguration).not.toHaveBeenCalled();
});

it("blocks and re-enables one discovered tool without disabling its connector", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
  const tool = { id: "mcp_" + "b".repeat(40), name: "search_files", revision: "rev1", fingerprint: "c".repeat(64), permission: "ask_first" as const };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue([tool]);
  render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh tools for Synthetic" }));
  fireEvent.click(await screen.findByText("1 tools"));
  fireEvent.click(screen.getByRole("button", { name: "Block search_files in Synthetic" }));
  await waitFor(() => expect(saveCustomConnectorConfiguration).toHaveBeenCalledWith(
    access, { ...record, blockedTools: [{ id: tool.id, fingerprint: tool.fingerprint }] },
    expect.objectContaining({ confirmedByUser: true }), record.revision, expect.any(Function),
  ));
  expect(await screen.findByRole("button", { name: "Allow reviewed calls to search_files in Synthetic" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Block Synthetic" })).toBeNull();
});
