import { render, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  useAuth: vi.fn(),
  useVault: vi.fn(),
  loadPlaidOAuthResumeSession: vi.fn(),
  clearPlaidOAuthResumeSession: vi.fn(),
  loadPlaidLink: vi.fn(),
  plaidPortfolioService: {
    resumeOAuth: vi.fn(),
    exchangeFundingPublicToken: vi.fn(),
    exchangePublicToken: vi.fn(),
  },
  vaultService: {
    getOrIssueVaultOwnerToken: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mocks.useVault,
}));

vi.mock("@/lib/kai/brokerage/plaid-oauth-session", () => ({
  loadPlaidOAuthResumeSession: mocks.loadPlaidOAuthResumeSession,
  clearPlaidOAuthResumeSession: mocks.clearPlaidOAuthResumeSession,
}));

vi.mock("@/lib/kai/brokerage/plaid-link-loader", () => ({
  loadPlaidLink: mocks.loadPlaidLink,
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

import KaiPlaidOauthReturnPage from "@/app/kai/plaid/oauth/return/page";

function buildResumeSession(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    version: 1,
    flowKind: "funding",
    userId: "user-123",
    resumeSessionId: "resume-session-123",
    returnPath: "/kai/funding",
    startedAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("KaiPlaidOauthReturnPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "http://localhost:3000/kai/plaid/oauth/return?oauth_state_id=funding-state");

    mocks.useAuth.mockReturnValue({
      user: { uid: "user-123" },
      loading: false,
    });
    mocks.useVault.mockReturnValue({
      vaultKey: "vault-key-123",
      unlockVault: vi.fn(),
    });
    mocks.loadPlaidOAuthResumeSession.mockReturnValue(buildResumeSession());
    mocks.vaultService.getOrIssueVaultOwnerToken.mockResolvedValue({
      token: "vault-owner-token-123",
      expiresAt: "2026-04-24T00:00:00.000Z",
    });
    mocks.plaidPortfolioService.resumeOAuth.mockResolvedValue({
      configured: true,
      link_token: "link-token-123",
    });
    mocks.plaidPortfolioService.exchangeFundingPublicToken.mockResolvedValue({
      configured: true,
      linked: true,
    });
    mocks.plaidPortfolioService.exchangePublicToken.mockResolvedValue({
      configured: true,
      linked: true,
    });
  });

  it("resumes a funding OAuth session, uses only opaque resume state, and exchanges the funding public token after Plaid success", async () => {
    mocks.loadPlaidOAuthResumeSession.mockReturnValue(
      buildResumeSession({
        flowKind: "funding",
        plaidAccessToken: "browser-plaid-access-token",
        vaultOwnerToken: "browser-vault-owner-token",
        vaultKey: "browser-vault-key",
      })
    );

    const createMock = vi.fn((config: Record<string, unknown>) => {
      const handler = {
        destroy: vi.fn(),
        open: vi.fn(() => {
          const onSuccess = config.onSuccess as
            | ((publicToken: string, metadata: Record<string, unknown>) => void)
            | undefined;
          onSuccess?.("public-token-123", {
            institution: { institution_id: "ins_123", name: "Test Bank" },
            accounts: [{ id: "account-123" }],
          });
        }),
      };
      return handler;
    });

    mocks.loadPlaidLink.mockResolvedValue({
      create: createMock,
    });

    render(<KaiPlaidOauthReturnPage />);

    await waitFor(() => {
      expect(mocks.loadPlaidOAuthResumeSession).toHaveBeenCalledTimes(1);
      expect(mocks.plaidPortfolioService.resumeOAuth).toHaveBeenCalledTimes(1);
    });

    const resumePayload = mocks.plaidPortfolioService.resumeOAuth.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(resumePayload).toEqual({
      userId: "user-123",
      resumeSessionId: "resume-session-123",
      vaultOwnerToken: "vault-owner-token-123",
    });
    expect(resumePayload).not.toHaveProperty("plaidAccessToken");
    expect(resumePayload).not.toHaveProperty("vaultOwnerToken", "browser-vault-owner-token");
    expect(resumePayload).not.toHaveProperty("vaultKey", "browser-vault-key");

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    const plaidConfig = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(plaidConfig.token).toBe("link-token-123");
    expect(plaidConfig.receivedRedirectUri).toBe(window.location.href);

    await waitFor(() => {
      expect(mocks.plaidPortfolioService.exchangeFundingPublicToken).toHaveBeenCalledTimes(1);
    });

    const fundingExchangePayload =
      mocks.plaidPortfolioService.exchangeFundingPublicToken.mock.calls[0]?.[0];
    expect(fundingExchangePayload).toEqual({
      userId: "user-123",
      publicToken: "public-token-123",
      vaultOwnerToken: "vault-owner-token-123",
      metadata: {
        institution: { institution_id: "ins_123", name: "Test Bank" },
        accounts: [{ id: "account-123" }],
      },
      resumeSessionId: "resume-session-123",
      consentTimestamp: expect.any(String),
    });
    expect(fundingExchangePayload).not.toHaveProperty("plaidAccessToken");
    expect(fundingExchangePayload).not.toHaveProperty("vaultOwnerToken", "browser-vault-owner-token");
    expect(fundingExchangePayload).not.toHaveProperty("vaultKey", "browser-vault-key");
    expect(mocks.plaidPortfolioService.exchangePublicToken).not.toHaveBeenCalled();

    expect(mocks.clearPlaidOAuthResumeSession).toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/kai/funding");
    });
  });

  it("falls back to the portfolio resume branch when the stored session is not funding and keeps browser state opaque", async () => {
    window.history.replaceState({}, "", "http://localhost:3000/kai/plaid/oauth/return?oauth_state_id=portfolio-state");
    mocks.loadPlaidOAuthResumeSession.mockReturnValue(
      buildResumeSession({
        flowKind: undefined,
        resumeSessionId: "resume-session-portfolio",
        returnPath: "/kai/portfolio",
        plaidAccessToken: "browser-plaid-access-token",
        vaultOwnerToken: "browser-vault-owner-token",
        vaultKey: "browser-vault-key",
      })
    );

    const createMock = vi.fn((config: Record<string, unknown>) => {
      const handler = {
        destroy: vi.fn(),
        open: vi.fn(() => {
          const onSuccess = config.onSuccess as
            | ((publicToken: string, metadata: Record<string, unknown>) => void)
            | undefined;
          onSuccess?.("public-token-portfolio", {
            institution: { institution_id: "ins_456", name: "Portfolio Bank" },
            accounts: [{ id: "account-portfolio" }],
          });
        }),
      };
      return handler;
    });

    mocks.loadPlaidLink.mockResolvedValue({
      create: createMock,
    });

    render(<KaiPlaidOauthReturnPage />);

    await waitFor(() => {
      expect(mocks.plaidPortfolioService.resumeOAuth).toHaveBeenCalledTimes(1);
    });

    const resumePayload = mocks.plaidPortfolioService.resumeOAuth.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(resumePayload).toEqual({
      userId: "user-123",
      resumeSessionId: "resume-session-portfolio",
      vaultOwnerToken: "vault-owner-token-123",
    });
    expect(resumePayload).not.toHaveProperty("plaidAccessToken");
    expect(resumePayload).not.toHaveProperty("vaultOwnerToken", "browser-vault-owner-token");
    expect(resumePayload).not.toHaveProperty("vaultKey", "browser-vault-key");

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    const plaidConfig = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(plaidConfig.token).toBe("link-token-123");
    expect(plaidConfig.receivedRedirectUri).toBe(window.location.href);

    await waitFor(() => {
      expect(mocks.plaidPortfolioService.exchangePublicToken).toHaveBeenCalledTimes(1);
    });

    const portfolioExchangePayload = mocks.plaidPortfolioService.exchangePublicToken.mock.calls[0]?.[0];
    expect(portfolioExchangePayload).toEqual({
      userId: "user-123",
      publicToken: "public-token-portfolio",
      vaultOwnerToken: "vault-owner-token-123",
      metadata: {
        institution: { institution_id: "ins_456", name: "Portfolio Bank" },
        accounts: [{ id: "account-portfolio" }],
      },
      resumeSessionId: "resume-session-portfolio",
    });
    expect(portfolioExchangePayload).not.toHaveProperty("consentTimestamp");
    expect(portfolioExchangePayload).not.toHaveProperty("plaidAccessToken");
    expect(portfolioExchangePayload).not.toHaveProperty("vaultOwnerToken", "browser-vault-owner-token");
    expect(portfolioExchangePayload).not.toHaveProperty("vaultKey", "browser-vault-key");
    expect(mocks.plaidPortfolioService.exchangeFundingPublicToken).not.toHaveBeenCalled();

    expect(mocks.clearPlaidOAuthResumeSession).toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.routerReplace).toHaveBeenCalledWith("/kai/portfolio");
    });
  });
});
