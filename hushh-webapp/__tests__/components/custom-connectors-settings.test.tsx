import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CustomConnectorsSettings } from "@/components/agent/custom-connectors-settings";
import { loadCustomConnectorConfigurations, saveCustomConnectorConfiguration, removeCustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { Capacitor } from "@capacitor/core";
import { HushhOAuthReturn, isNativeCustomConnectorReturnUri } from "@/lib/capacitor/oauth-return";
vi.mock("@/lib/services/external-connector-service", () => ({ ExternalConnectorService: { refreshMcpCatalog: vi.fn(), privateMcpOAuth: vi.fn() } }));
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
});

it("admits only the app-owned HTTPS return for native connector sign-in", () => {
  expect(isNativeCustomConnectorReturnUri("https://one.hushh.ai/one/profile/connectors/oauth/return")).toBe(true);
  expect(isNativeCustomConnectorReturnUri("http://localhost:3001/one/profile/connectors/oauth/return")).toBe(false);
  expect(isNativeCustomConnectorReturnUri("https://one.hushh.ai.evil.example/one/profile/connectors/oauth/return")).toBe(false);
  expect(isNativeCustomConnectorReturnUri("https://one.hushh.ai/one/profile/connectors/oauth/return?code=leaked")).toBe(false);
});

it("opens native custom OAuth only after owner-bound recovery is ready", async () => {
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
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
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.privateMcpOAuth).mockResolvedValueOnce({ attemptId: "a".repeat(43), authorizeUrl: "https://auth.example/authorize", redirectUri: "http://localhost:3001/one/profile/connectors/oauth/return" }).mockResolvedValueOnce(null);
  const prepare = vi.fn();
  render(<CustomConnectorsSettings access={access} onPrepareRecovery={prepare} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Synthetic" }));
  await waitFor(() => expect(ExternalConnectorService.privateMcpOAuth).toHaveBeenCalledTimes(2));
  expect(prepare).not.toHaveBeenCalled();
  expect(HushhOAuthReturn.openAuthorization).not.toHaveBeenCalled();
});

it("saves through the vault with explicit confirmation and no connected claim", async () => {
  render(<CustomConnectorsSettings access={access} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Add connector" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic server" } });
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://example.com/mcp" } });
  fireEvent.change(screen.getByLabelText("Authorization header (optional)"), { target: { value: "Bearer synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connector" }));
  await screen.findByText("Saved · connection not verified");
  expect(saveCustomConnectorConfiguration).toHaveBeenCalledOnce();
  expect(vi.mocked(saveCustomConnectorConfiguration).mock.calls[0][2]).toMatchObject({ confirmedByUser: true });
  expect(document.body.textContent).not.toContain("Bearer synthetic");
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
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue([{ id: "tool", name: "search_files", revision: "rev1" }]);
  render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh tools for Synthetic" }));
  await screen.findByText("1 tools · Ask first");
  expect(loadCustomConnectorConfigurations).toHaveBeenCalledTimes(2);
  expect(ExternalConnectorService.refreshMcpCatalog).toHaveBeenCalledWith(expect.objectContaining({ configuration: record, isEffectCurrent: expect.any(Function) }));
});

it("discards tool catalogs and pending removal when the owner changes", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue([{ id: "tool", name: "prior_owner_tool", revision: "rev1" }]);
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

it("blocks a connector with its exact revision without invoking provider discovery", async () => {
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic", endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" as const } };
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([record]);
  render(<CustomConnectorsSettings access={access} />);
  fireEvent.click(await screen.findByRole("button", { name: "Block Synthetic" }));
  await screen.findByText("Blocked for new turns");
  expect(saveCustomConnectorConfiguration).toHaveBeenCalledWith(access, { ...record, enabled: false }, expect.objectContaining({ confirmedByUser: true }), record.revision, expect.any(Function));
  expect(screen.getByRole("button", { name: "Refresh tools for Synthetic" })).toBeDisabled();
  expect(ExternalConnectorService.refreshMcpCatalog).not.toHaveBeenCalled();
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([{ ...record, enabled: false }]);
  fireEvent.click(screen.getByRole("button", { name: "Enable Synthetic" }));
  await screen.findByText("Saved · connection not verified");
  expect(saveCustomConnectorConfiguration).toHaveBeenLastCalledWith(access, record, expect.objectContaining({ confirmedByUser: true }), record.revision, expect.any(Function));
  expect(ExternalConnectorService.refreshMcpCatalog).not.toHaveBeenCalled();
});
