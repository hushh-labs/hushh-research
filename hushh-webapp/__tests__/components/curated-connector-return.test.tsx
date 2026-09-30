import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as null | { uid: string; getIdToken: () => Promise<string> },
    loading: false,
  },
  completeOAuth: vi.fn(),
  completeWeb: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultOwnerToken: "synthetic-owner-token",
    vaultKey: "synthetic-key",
    ownerTokenStatus: "ready",
  }),
}));
vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: {
    completeOAuthConnect: mocks.completeOAuth,
    completeWebOAuth: mocks.completeWeb,
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

import Callback from "@/app/one/profile/connectors/oauth/return/page";
import { saveCuratedConnectorSettingsHandoff } from "@/lib/agent/drive-oauth-chat-recovery";

const ATTEMPT = "attempt-abcdefghijklmnopqrstuvwxyz0123456789";

describe("curated connector OAuth return", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = {
      user: { uid: "owner-a", getIdToken: async () => "firebase-token" },
      loading: false,
    };
    mocks.completeOAuth.mockResolvedValue({ connectorId: "hubspot", status: "connected" });
    saveCuratedConnectorSettingsHandoff({
      ownerUserId: "owner-a",
      attemptId: ATTEMPT,
      curatedConnector: { connectorId: "hubspot" },
    });
    window.history.replaceState(
      null,
      "",
      "/one/profile/connectors/oauth/return?code=secret-code&state=signed-state",
    );
  });
  afterEach(() => {
    cleanup();
    // eslint-disable-next-line no-restricted-globals -- Clear the synthetic handoff marker.
    sessionStorage.clear();
  });

  it("completes through the owner-token route, never the Drive-only popup route", async () => {
    render(<Callback />);
    await screen.findByText("Connected. Taking you back…");
    expect(mocks.completeOAuth).toHaveBeenCalledExactlyOnceWith({
      vaultOwnerToken: "synthetic-owner-token",
      state: "signed-state",
      code: "secret-code",
    });
    expect(mocks.completeWeb).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one/profile/connectors"), {
      timeout: 4000,
    });
  });

  it("does not claim success when the connection is still unverified", async () => {
    mocks.completeOAuth.mockResolvedValue({ connectorId: "hubspot", status: "verifying" });
    render(<Callback />);
    await screen.findByText(/could not be verified yet/);
  });

  it("refuses another account's handoff without exchanging the code", async () => {
    mocks.auth.user = { uid: "owner-b", getIdToken: async () => "firebase-token" };
    render(<Callback />);
    await screen.findByText("Missing authorization details. Please try again.");
    expect(mocks.completeOAuth).not.toHaveBeenCalled();
    expect(mocks.completeWeb).not.toHaveBeenCalled();
  });
});
