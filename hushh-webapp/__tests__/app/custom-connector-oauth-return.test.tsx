import React, { StrictMode } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ complete: vi.fn(), save: vi.fn(), refresh: vi.fn(), remember: vi.fn(), replace: vi.fn(), markReturned: vi.fn(), current: true, locked: false, owner: "owner", platform: "web", returnTo: undefined as "connector_settings" | undefined }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => mocks.platform } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: mocks.owner }, loading: false }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-owner-token", ownerTokenStatus: "ready" }) }));
vi.mock("@/components/vault/vault-lock-guard", () => ({ VaultLockGuard: ({ children }: { children: React.ReactNode }) => mocks.locked ? <div>Unlock vault</div> : children }));
vi.mock("@/lib/profile/drive-oauth-popup", () => ({ hasDrivePopupMarker: () => false }));
vi.mock("@/lib/agent/drive-oauth-chat-recovery", () => ({
  readDriveChatRecoveryHandoff: () => ({ reason: "web_full_page", ownerUserId: "owner", attemptId: "a".repeat(43), returnTo: mocks.returnTo, customConnector: { connectorId: "custom_" + "a".repeat(32), revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" } }),
  markDriveChatRecoveryReturned: mocks.markReturned,
}));
vi.mock("@/lib/auth/session-owner", () => ({ snapshotValidatedAuthSessionOwner: () => ({ userId: mocks.owner }), isValidatedAuthSessionOwnerCurrent: () => mocks.current }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: () => mocks.current }));
vi.mock("@/lib/services/external-connector-service", () => ({ ExternalConnectorService: { privateMcpOAuth: mocks.complete, refreshMcpCatalog: mocks.refresh } }));
vi.mock("@/lib/connections/custom-connector-configuration", () => ({ saveCustomConnectorOAuthResult: mocks.save }));
vi.mock("@/lib/connections/custom-mcp-catalog-handoff", () => ({ rememberRefreshedMcpCatalog: mocks.remember }));
import Page from "@/app/one/profile/connectors/oauth/return/page";

beforeEach(() => {
  vi.clearAllMocks(); mocks.current = true; mocks.locked = false; mocks.owner = "owner"; mocks.platform = "web"; mocks.returnTo = undefined;
  mocks.complete.mockResolvedValue({ privateSyntheticResult: true });
  mocks.save.mockResolvedValue({});
  mocks.refresh.mockResolvedValue([]);
  window.history.replaceState(null, "", "/one/profile/connectors/oauth/return?code=synthetic-code&state=synthetic-state&iss=https%3A%2F%2Fissuer.example");
});

it("exchanges once in StrictMode, strips callback URL and saves only through vault writer", async () => {
  render(<StrictMode><Page /></StrictMode>);
  await screen.findByText(/Sign-in saved in your vault/);
  expect(mocks.complete).toHaveBeenCalledTimes(1);
  expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ operation: "complete", payload: expect.objectContaining({ code: "synthetic-code", state: "synthetic-state", issuer: "https://issuer.example" }) }));
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe("");
  expect(document.body.textContent).not.toContain("synthetic-code");
  expect(document.body.textContent).not.toContain("privateSyntheticResult");
  expect(mocks.replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Return to Chat" }));
  expect(mocks.replace).toHaveBeenCalledTimes(1);
});

it("does not exchange under a different signed-in owner", async () => {
  mocks.owner = "different-owner";
  render(<Page />);
  await waitFor(() => expect(screen.getByText(/Could not save this connection/)).toBeTruthy());
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it.each(["web", "ios", "android"])("records the actual %s return surface", async platform => {
  mocks.platform = platform;
  render(<Page />);
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    expect.objectContaining({ confirmedByUser: true, surface: platform, source: "connector_oauth_return" }),
    expect.any(Function),
  );
});

it("returns Settings sign-in to Settings without arming Chat draft recovery", async () => {
  mocks.returnTo = "connector_settings";
  mocks.save.mockResolvedValue({ connectorId: "custom_" + "a".repeat(32), revision: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" });
  mocks.refresh.mockResolvedValue([{ id: "mcp_" + "b".repeat(40), name: "search_files", revision: "rev1" }]);
  render(<Page />);
  await screen.findByText(/Sign-in saved in your vault/);
  await waitFor(() => expect(mocks.remember).toHaveBeenCalledWith(expect.objectContaining({
    ownerUserId: "owner", connectorId: "custom_" + "a".repeat(32),
    configurationRevision: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    tools: [{ id: "mcp_" + "b".repeat(40), name: "search_files", revision: "rev1" }],
  })));
  expect(mocks.markReturned).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Return to Connectors" }));
  expect(mocks.replace).toHaveBeenCalledWith("/one/profile/connectors");
});

it("does not replay completion after lock during refresh and preserves the saved outcome", async () => {
  let settle!: () => void;
  mocks.refresh.mockReturnValue(new Promise<void>(resolve => { settle = resolve; }));
  const view = render(<Page />);
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  mocks.locked = true; mocks.current = false;
  view.rerender(<Page />);
  expect(screen.getByText("Unlock vault")).toBeTruthy();
  mocks.locked = false; mocks.current = true;
  view.rerender(<Page />);
  await screen.findByText("Sign-in saved in your vault. Refresh tools in Chat.");
  settle();
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(mocks.save).toHaveBeenCalledOnce();
});
