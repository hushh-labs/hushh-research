import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ALPACA_OAUTH_SESSION_KEY = "kai_alpaca_oauth_resume_v1";

const mocks = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  useAuth: vi.fn(),
  useVault: vi.fn(),
  unlockVault: vi.fn(),
  plaidPortfolioService: {
    completeAlpacaConnect: vi.fn(),
  },
  vaultService: {
    getOrIssueVaultOwnerToken: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mocks.useVault,
}));

vi.mock("@/lib/kai/brokerage/plaid-portfolio-service", () => ({
  PlaidPortfolioService: mocks.plaidPortfolioService,
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: mocks.vaultService,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import KaiAlpacaOauthReturnPage from "@/app/kai/alpaca/oauth/return/page";
import {
  clearAlpacaOAuthResumeSession,
  saveAlpacaOAuthResumeSession,
} from "@/lib/kai/brokerage/alpaca-oauth-session";

function seedSession(overrides?: Partial<{
  userId: string;
  state: string;
  returnPath: string;
  startedAt: string;
}>) {
  const session = {
    version: 1 as const,
    userId: overrides?.userId ?? "user-123",
    state: overrides?.state ?? "alpaca-state-123",
    returnPath: overrides?.returnPath ?? "/kai/funding-trade",
    startedAt: overrides?.startedAt ?? "2026-04-23T00:00:00.000Z",
  };
  saveAlpacaOAuthResumeSession(session);
  return session;
}

function readStoredSession(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(ALPACA_OAUTH_SESSION_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe("KaiAlpacaOauthReturnPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(
      {},
      "",
      "http://localhost:3000/kai/alpaca/oauth/return?code=alpaca-code-123&state=alpaca-state-123"
    );

    mocks.useAuth.mockReturnValue({
      user: { uid: "user-123" },
      loading: false,
    });
    mocks.useVault.mockReturnValue({
      vaultKey: "vault-key-123",
      unlockVault: mocks.unlockVault,
    });
    mocks.vaultService.getOrIssueVaultOwnerToken.mockResolvedValue({
      token: "vault-owner-token-123",
      expiresAt: "2026-04-24T00:00:00.000Z",
    });
    mocks.plaidPortfolioService.completeAlpacaConnect.mockResolvedValue({
      configured: true,
      linked: true,
    });
  });

  it("completes the Alpaca callback, persists only opaque session state, and clears browser storage after success", async () => {
    const session = seedSession();

    const storedBeforeRender = readStoredSession();
    expect(storedBeforeRender).toEqual(session);
    expect(Object.keys(storedBeforeRender ?? {}).sort()).toEqual([
      "returnPath",
      "startedAt",
      "state",
      "userId",
      "version",
    ]);
    expect(JSON.stringify(storedBeforeRender)).not.toContain("alpaca-code-123");
    expect(JSON.stringify(storedBeforeRender)).not.toContain("vault-owner-token-123");

    render(<KaiAlpacaOauthReturnPage />);

    await waitFor(() => {
      expect(mocks.vaultService.getOrIssueVaultOwnerToken).toHaveBeenCalledWith("user-123");
    });

    await waitFor(() => {
      expect(mocks.plaidPortfolioService.completeAlpacaConnect).toHaveBeenCalledWith({
        userId: "user-123",
        vaultOwnerToken: "vault-owner-token-123",
        state: "alpaca-state-123",
        code: "alpaca-code-123",
      });
    });

    expect(mocks.unlockVault).toHaveBeenCalledWith(
      "vault-key-123",
      "vault-owner-token-123",
      "2026-04-24T00:00:00.000Z"
    );

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/kai/funding-trade");
    });

    expect(readStoredSession()).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("shows an error when no Alpaca OAuth session exists", async () => {
    render(<KaiAlpacaOauthReturnPage />);

    expect(await screen.findByText("Alpaca connection needs attention")).toBeTruthy();
    expect(
      screen.getByText("No active Alpaca OAuth session was found. Start again from funding settings.")
    ).toBeTruthy();
    expect(mocks.vaultService.getOrIssueVaultOwnerToken).not.toHaveBeenCalled();
    expect(mocks.plaidPortfolioService.completeAlpacaConnect).not.toHaveBeenCalled();
    expect(readStoredSession()).toBeNull();
  });

  it("clears the session and shows an error when Alpaca does not return required params", async () => {
    expect(readStoredSession()).toBeNull();
    seedSession();
    window.history.replaceState(
      {},
      "",
      "http://localhost:3000/kai/alpaca/oauth/return?state=alpaca-state-123"
    );

    render(<KaiAlpacaOauthReturnPage />);

    expect(await screen.findByText("Alpaca connection needs attention")).toBeTruthy();
    expect(mocks.plaidPortfolioService.completeAlpacaConnect).not.toHaveBeenCalled();
    expect(readStoredSession()).toBeNull();
    expect(
      screen.getByText("No active Alpaca OAuth session was found. Start again from funding settings.")
    ).toBeTruthy();
  });

  it("clears the session and blocks a callback that belongs to a different signed-in user", async () => {
    expect(readStoredSession()).toBeNull();
    seedSession({ userId: "user-999" });

    render(<KaiAlpacaOauthReturnPage />);

    expect(await screen.findByText("Alpaca connection needs attention")).toBeTruthy();
    expect(mocks.vaultService.getOrIssueVaultOwnerToken).not.toHaveBeenCalled();
    expect(mocks.plaidPortfolioService.completeAlpacaConnect).not.toHaveBeenCalled();
    expect(readStoredSession()).toBeNull();
    expect(
      screen.getByText("No active Alpaca OAuth session was found. Start again from funding settings.")
    ).toBeTruthy();
  });

  it("clears the session and surfaces backend completion errors", async () => {
    seedSession();
    mocks.plaidPortfolioService.completeAlpacaConnect.mockRejectedValue(
      new Error("Alpaca login exchange failed.")
    );

    render(<KaiAlpacaOauthReturnPage />);

    expect(await screen.findByText("Alpaca connection needs attention")).toBeTruthy();
    expect(screen.getByText("Alpaca login exchange failed.")).toBeTruthy();
    expect(readStoredSession()).toBeNull();
    expect(mocks.routerReplace).not.toHaveBeenCalledWith("/kai/funding-trade");
  });

  it("clears the session and blocks state mismatches", async () => {
    expect(readStoredSession()).toBeNull();
    seedSession({ state: "expected-state-123" });

    render(<KaiAlpacaOauthReturnPage />);

    expect(await screen.findByText("Alpaca connection needs attention")).toBeTruthy();
    expect(mocks.plaidPortfolioService.completeAlpacaConnect).not.toHaveBeenCalled();
    expect(readStoredSession()).toBeNull();
    expect(
      screen.getByText("No active Alpaca OAuth session was found. Start again from funding settings.")
    ).toBeTruthy();
  });
});
