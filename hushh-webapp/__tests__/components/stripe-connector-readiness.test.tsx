import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CustomConnectorsSettings } from "@/components/agent/custom-connectors-settings";
import { StripeConnectorReadiness } from "@/components/agent/stripe-connector-readiness";
import { loadCustomConnectorConfigurations, loadCustomConnectorSnapshot, saveCustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { ExternalConnectorService, McpCatalogAuthenticationError } from "@/lib/services/external-connector-service";
import { Capacitor } from "@capacitor/core";
import { HushhOAuthReturn } from "@/lib/capacitor/oauth-return";
import { rememberRefreshedMcpCatalog } from "@/lib/connections/custom-mcp-catalog-handoff";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { dispatchPkmDomainChanged } from "@/lib/pkm/pkm-domain-change-events";
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { refreshMcpCatalog: vi.fn(), verifyStripeAccount: vi.fn(), privateMcpOAuth: vi.fn() },
  McpCatalogAuthenticationError: class extends Error {},
}));
vi.mock("@/lib/capacitor/oauth-return", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capacitor/oauth-return")>()),
  HushhOAuthReturn: { openAuthorization: vi.fn() },
}));

vi.mock("@/lib/connections/custom-connector-configuration", async (importOriginal) => {
  const loadCustomConnectorConfigurations = vi.fn();
  return {
    loadCustomConnectorConfigurations,
    bearerAuthorizationValue: (await importOriginal<typeof import("@/lib/connections/custom-connector-configuration")>()).bearerAuthorizationValue,
    isVaultOwnerCredential: (value: string) => /^(?:\S+\s+)?HCT:/i.test(value.trim()),
    loadCustomConnectorSnapshot: vi.fn(async (...args) => ({
      configurations: await loadCustomConnectorConfigurations(...args),
      invalid: [],
    })),
    saveCustomConnectorConfiguration: vi.fn(),
    removeCustomConnectorConfiguration: vi.fn(),
    removeInvalidCustomConnectorConfiguration: vi.fn(),
  };
});
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: vi.fn() } }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, size, variant: _v, effect: _e, ...props }: any) => <button data-size={size} {...props}>{children}</button> }));
const access = { userId: "synthetic-owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-owner-token" };
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  publishValidatedAuthSessionOwner(access.userId);
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([]);
  vi.mocked(loadCustomConnectorSnapshot).mockImplementation(async (ownerAccess) => ({
    configurations: await loadCustomConnectorConfigurations(ownerAccess), invalid: [],
  }));
  vi.mocked(saveCustomConnectorConfiguration).mockImplementation(async (_access, record) => record);
  vi.mocked(ExternalConnectorService.verifyStripeAccount).mockResolvedValue({ toolingConnected: true,
    accountVerified: false, environmentVerified: false, accountToolsAvailable: false,
    capability: "documentation_only", nextStep: "authenticated_account_contract_required",
    managementPath: "/one/profile/connectors", verificationState: "unsupported" });
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue([{ id: "mcp_" + "b".repeat(40), name: "search", revision: "rev1", fingerprint: "c".repeat(64), permission: "ask_first" }]);
});

it("starts owner Stripe OAuth only on a human tap and keeps account verification unavailable", async () => {
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockRejectedValue(new McpCatalogAuthenticationError());
  vi.mocked(ExternalConnectorService.privateMcpOAuth).mockResolvedValue({ attemptId: "a".repeat(43),
    authorizeUrl: "https://access.stripe.com/mcp/oauth2/authorize", redirectUri: "https://one.hushh.ai/one/profile/connectors/oauth/return" });
  const prepare = vi.fn().mockResolvedValue("ready");
  render(<StripeConnectorReadiness access={access} onPrepareRecovery={prepare} />);
  expect(screen.getByRole("status")).toHaveTextContent("Stripe account and balance tools still need verification");
  expect(ExternalConnectorService.privateMcpOAuth).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Connect or reconnect Stripe tools" }));
  await waitFor(() => expect(HushhOAuthReturn.openAuthorization).toHaveBeenCalledOnce());
  const saved = vi.mocked(saveCustomConnectorConfiguration).mock.calls[0];
  expect(saved[0]).toEqual(access);
  expect(saved[1]).toMatchObject({ endpoint: "https://mcp.stripe.com", authentication: { kind: "none" } });
  expect(saved[2]).toMatchObject({ confirmedByUser: true, source: "connector_settings" });
  expect(ExternalConnectorService.privateMcpOAuth).toHaveBeenCalledWith(expect.objectContaining({
    operation: "begin", payload: expect.objectContaining({ endpoint: "https://mcp.stripe.com" }),
  }));
  expect(document.body.textContent).not.toContain(access.vaultOwnerToken);
});

it.each([
  "https://mcp.stripe.com/mcp/?alias=owner",
  "https://mcp.stripe.com./mcp",
  "https://mcp\u3002stripe.com/mcp",
  "https://mcp.stripe\uff0ecom/mcp",
  "https://mcp.stripe.com\uff61/mcp",
])("reconnects saved Stripe OAuth alias %s without a second owner definition", async (endpoint) => {
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  const record = { version: 1 as const, connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    displayName: "Stripe", endpoint, enabled: true,
    authentication: { kind: "oauth" as const, accessToken: "synthetic-access", expiresAt: 4070908800 } };
  // The canonical setup needs only the saved public definition to reconnect.
  vi.mocked(loadCustomConnectorSnapshot).mockResolvedValue({ configurations: [record], invalid: [] });
  vi.mocked(ExternalConnectorService.privateMcpOAuth).mockResolvedValue({ attemptId: "a".repeat(43),
    authorizeUrl: "https://access.stripe.com/mcp/oauth2/authorize", redirectUri: "https://one.hushh.ai/one/profile/connectors/oauth/return" });
  render(<StripeConnectorReadiness access={access} onPrepareRecovery={vi.fn().mockResolvedValue("ready")} />);
  fireEvent.click(screen.getByRole("button", { name: "Connect or reconnect Stripe tools" }));
  await waitFor(() => expect(HushhOAuthReturn.openAuthorization).toHaveBeenCalledOnce());
  expect(saveCustomConnectorConfiguration).not.toHaveBeenCalled();
  expect(ExternalConnectorService.refreshMcpCatalog).not.toHaveBeenCalled();
});

it("blocks stale-owner Stripe sign-in before creating a definition or starting OAuth", async () => {
  const prepare = vi.fn();
  render(<StripeConnectorReadiness access={access} onPrepareRecovery={prepare} />);
  const readsBeforeOwnerChanged = vi.mocked(loadCustomConnectorSnapshot).mock.calls.length;
  publishValidatedAuthSessionOwner("other-owner");
  fireEvent.click(screen.getByRole("button", { name: "Connect or reconnect Stripe tools" }));
  await Promise.resolve();
  expect(loadCustomConnectorSnapshot).toHaveBeenCalledTimes(readsBeforeOwnerChanged);
  expect(saveCustomConnectorConfiguration).not.toHaveBeenCalled();
  expect(ExternalConnectorService.privateMcpOAuth).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

const stripeConfiguration = {
  version: 1 as const, connectorId: "custom_" + "d".repeat(32), revision: "dddddddd-dddd-4ddd-dddd-dddddddddddd",
  displayName: "Stripe", endpoint: "https://mcp.stripe.com", enabled: true,
  authentication: { kind: "oauth" as const, accessToken: "synthetic-stripe-oauth", expiresAt: 4070908800 },
};
const stripeTools = [{ id: "mcp_" + "b".repeat(40), name: "search_stripe_documentation", revision: "rev1",
  fingerprint: "c".repeat(64), permission: "ask_first" as const, review: "required" as const, access: "read" as const }];

it("shows account readiness only after explicit paired verification and invalidates it on focus", async () => {
  vi.mocked(loadCustomConnectorSnapshot).mockResolvedValue({ configurations: [stripeConfiguration], invalid: [] });
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue(stripeTools);
  vi.mocked(ExternalConnectorService.verifyStripeAccount).mockResolvedValue({ toolingConnected: true,
    accountVerified: true, environmentVerified: true, accountToolsAvailable: true,
    capability: "account_balance_readonly", nextStep: "ready", managementPath: "/one/profile/connectors",
    verificationState: "verified", verifiedAt: "2026-10-07T12:00:00Z",
    configurationRevision: stripeConfiguration.revision, catalogFingerprint: "e".repeat(64) });
  render(<StripeConnectorReadiness access={access} />);
  await screen.findByText(/Stripe sign-in saved/);
  expect(ExternalConnectorService.verifyStripeAccount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByText(/Sandbox account and balance tools verified/);
  expect(ExternalConnectorService.verifyStripeAccount).toHaveBeenCalledOnce();
  expect(screen.getByText(/Provider observation/)).toBeInTheDocument();
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByRole("status")).not.toHaveTextContent("Sandbox account and balance tools verified"));
  expect(document.body.textContent).not.toContain(stripeConfiguration.authentication.accessToken);
});

it("verifies the saved Stripe catalog without consuming the custom settings return handoff or enabling account access", async () => {
  vi.mocked(loadCustomConnectorSnapshot).mockResolvedValue({ configurations: [stripeConfiguration], invalid: [] });
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue(stripeTools);
  rememberRefreshedMcpCatalog({ ownerUserId: access.userId, vaultEpoch: snapshotVaultSessionEpoch(),
    connectorId: stripeConfiguration.connectorId, configurationRevision: stripeConfiguration.revision, tools: stripeTools });
  const stripeView = render(<StripeConnectorReadiness access={access} />);
  await screen.findByText(/Stripe sign-in saved/);
  expect(ExternalConnectorService.refreshMcpCatalog).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByText(/Documentation tools connected/);
  expect(screen.getByRole("status")).toHaveTextContent("Stripe account and balance tools still need verification");
  expect(ExternalConnectorService.privateMcpOAuth).not.toHaveBeenCalled();
  expect(saveCustomConnectorConfiguration).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(stripeConfiguration.authentication.accessToken);
  const change = (userId: string, domain: string) => fireEvent(window, new CustomEvent("pkm-domain-changed", {
    detail: { userId, domain, dataVersion: null, updatedAt: null, operation: "stored" },
  }));
  change("another-owner", "runtime_secrets"); change(access.userId, "travel");
  expect(screen.getByRole("status")).toHaveTextContent("Documentation tools connected");
  vi.mocked(loadCustomConnectorSnapshot).mockResolvedValueOnce({ configurations: [], invalid: [] });
  change(access.userId, "runtime_secrets");
  expect(screen.getByRole("status")).not.toHaveTextContent("Documentation tools connected");
  expect(ExternalConnectorService.refreshMcpCatalog).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByText(/Sign in to Stripe to connect/);
  stripeView.unmount();
  render(<CustomConnectorsSettings access={access} />);
  await screen.findByText("search_stripe_documentation");
  expect(ExternalConnectorService.refreshMcpCatalog).toHaveBeenCalledOnce();
});

it.each(["empty", "expired", "failed", "changed_revision"])("never reports connected for a %s Stripe catalog", async scenario => {
  vi.mocked(loadCustomConnectorSnapshot).mockResolvedValue({ configurations: [stripeConfiguration], invalid: [] });
  if (scenario === "empty") vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockResolvedValue([]);
  if (scenario === "expired") vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockRejectedValue(new McpCatalogAuthenticationError());
  if (scenario === "failed") vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockRejectedValue(new Error("synthetic provider failure"));
  if (scenario === "changed_revision") vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockImplementation(async () => {
    vi.mocked(loadCustomConnectorSnapshot).mockResolvedValue({ configurations: [{ ...stripeConfiguration, revision: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee" }], invalid: [] });
    return stripeTools;
  });
  render(<StripeConnectorReadiness access={access} />);
  await screen.findByText(/Stripe sign-in saved/);
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check connection" })).toBeEnabled());
  expect(screen.getByRole("status")).not.toHaveTextContent("Documentation tools connected");
  expect(screen.getByRole("status")).toHaveTextContent(scenario === "expired" ? "Sign in to Stripe" : "could not be verified");
});

it.each(["owner", "vault", "configuration"])("discards a Stripe catalog arriving after the %s changes", async boundary => {
  vi.mocked(loadCustomConnectorSnapshot).mockResolvedValue({ configurations: [stripeConfiguration], invalid: [] });
  let complete!: (value: typeof stripeTools) => void;
  vi.mocked(ExternalConnectorService.refreshMcpCatalog).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  render(<StripeConnectorReadiness access={access} />);
  await screen.findByText(/Stripe sign-in saved/);
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await waitFor(() => expect(ExternalConnectorService.refreshMcpCatalog).toHaveBeenCalledOnce());
  if (boundary === "owner") publishValidatedAuthSessionOwner("other-owner");
  else if (boundary === "vault") advanceVaultSessionEpoch();
  else dispatchPkmDomainChanged({ userId: access.userId, domain: "runtime_secrets", dataVersion: null, updatedAt: null, operation: "stored" });
  complete(stripeTools);
  await Promise.resolve();
  expect(screen.getByRole("status")).not.toHaveTextContent("Documentation tools connected");
});
