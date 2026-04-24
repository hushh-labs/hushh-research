import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FundingTradeView } from "@/components/kai/views/funding-trade-view";
import type {
  PlaidFundingStatusResponse,
  PlaidFundingTradeIntentRef,
} from "@/lib/kai/brokerage/portfolio-sources";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  useVault: vi.fn(),
  usePortfolioSources: vi.fn(),
  plaidPortfolioService: {
    createFundingLinkToken: vi.fn(),
    exchangeFundingPublicToken: vi.fn(),
    setFundingBrokerageAccount: vi.fn(),
    startAlpacaConnect: vi.fn(),
    createFundedTradeIntent: vi.fn(),
    refreshFundedTradeIntent: vi.fn(),
  },
  savePlaidOAuthResumeSession: vi.fn(),
  clearPlaidOAuthResumeSession: vi.fn(),
  saveAlpacaOAuthResumeSession: vi.fn(),
  loadPlaidLink: vi.fn(),
  resolvePlaidRedirectUri: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mocks.useVault,
}));

vi.mock("@/lib/kai/brokerage/use-portfolio-sources", () => ({
  usePortfolioSources: mocks.usePortfolioSources,
}));

vi.mock("@/lib/kai/brokerage/plaid-portfolio-service", () => ({
  PlaidPortfolioService: mocks.plaidPortfolioService,
}));

vi.mock("@/lib/kai/brokerage/plaid-oauth-session", () => ({
  savePlaidOAuthResumeSession: mocks.savePlaidOAuthResumeSession,
  clearPlaidOAuthResumeSession: mocks.clearPlaidOAuthResumeSession,
}));

vi.mock("@/lib/kai/brokerage/alpaca-oauth-session", () => ({
  saveAlpacaOAuthResumeSession: mocks.saveAlpacaOAuthResumeSession,
}));

vi.mock("@/lib/kai/brokerage/plaid-link-loader", () => ({
  loadPlaidLink: mocks.loadPlaidLink,
}));

vi.mock("@/lib/kai/brokerage/plaid-redirect-uri", () => ({
  resolvePlaidRedirectUri: mocks.resolvePlaidRedirectUri,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({
    title,
    description,
    actions,
  }: {
    title: string;
    description?: string;
    actions?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
      <div>{actions}</div>
    </div>
  ),
}));

vi.mock("@/components/app-ui/surfaces", () => ({
  SurfaceCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SurfaceCardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SurfaceStack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

type MockPortfolioSourcesResult = {
  isLoading: boolean;
  error: string | null;
  plaidFundingStatus: PlaidFundingStatusResponse | null;
  reload: ReturnType<typeof vi.fn>;
};

let currentPortfolioSources: MockPortfolioSourcesResult;

function buildIntent(
  overrides: Partial<PlaidFundingTradeIntentRef> = {}
): PlaidFundingTradeIntentRef {
  return {
    intent_id: "intent-1",
    transfer_id: "transfer-1",
    alpaca_account_id: "alpaca-acc-1",
    funding_item_id: "fund-item-1",
    funding_account_id: "fund-acct-1",
    symbol: "AAPL",
    side: "buy",
    order_type: "market",
    time_in_force: "day",
    notional_usd: "100.00",
    status: "funding_pending",
    requested_at: "2026-04-24T10:00:00.000Z",
    ...overrides,
  };
}

function buildFundingStatus(
  overrides: Partial<PlaidFundingStatusResponse> = {}
): PlaidFundingStatusResponse {
  return {
    configured: true,
    user_id: "user-123",
    items: [
      {
        item_id: "fund-item-1",
        institution_name: "Test Bank",
        status: "active",
        sync_status: "completed",
        selected_funding_account_id: "fund-acct-1",
        transactions_cursor: null,
        accounts: [
          {
            account_id: "fund-acct-1",
            item_id: "fund-item-1",
            name: "Checking Account",
            mask: "6789",
            is_selected_funding_account: true,
          },
        ],
        relationships: [],
        transfers: [],
      },
    ],
    brokerage_accounts: [
      {
        alpaca_account_id: "alpaca-acc-1",
        status: "active",
        is_default: true,
      },
    ],
    latest_transfers: [],
    latest_trade_intents: [],
    aggregate: {
      item_count: 1,
      account_count: 1,
      relationship_count: 1,
      institution_names: ["Test Bank"],
      last_synced_at: "2026-04-24T10:00:00.000Z",
    },
    ...overrides,
  };
}

function setPortfolioSources(
  plaidFundingStatus: PlaidFundingStatusResponse | null,
  reload: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): ReturnType<typeof vi.fn> {
  currentPortfolioSources = {
    isLoading: false,
    error: null,
    plaidFundingStatus,
    reload,
  };
  return reload;
}

function renderView() {
  return render(
    <FundingTradeView
      userId="user-123"
      vaultOwnerToken="vault-owner-token-123"
    />
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("FundingTradeView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mocks.useVault.mockReturnValue({
      vaultKey: "vault-key-123",
    });

    setPortfolioSources(buildFundingStatus());
    mocks.usePortfolioSources.mockImplementation(() => currentPortfolioSources);
    mocks.plaidPortfolioService.createFundedTradeIntent.mockResolvedValue({
      intent: buildIntent(),
    });
    mocks.plaidPortfolioService.refreshFundedTradeIntent.mockResolvedValue({
      intent: buildIntent({
        status: "order_filled",
        order_id: "order-1234",
        executed_at: "2026-04-24T10:05:00.000Z",
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls pending intents on an interval and stops once reconciliation reaches a terminal status", async () => {
    vi.useFakeTimers();

    setPortfolioSources(
      buildFundingStatus({
        latest_trade_intents: [
          buildIntent({
            intent_id: "intent-pending",
            transfer_id: "transfer-9",
            status: "funding_pending",
            order_id: null,
          }),
          buildIntent({
            intent_id: "intent-filled",
            transfer_id: "transfer-8",
            status: "order_filled",
            order_id: "order-8888",
            executed_at: "2026-04-24T10:01:00.000Z",
          }),
        ],
      })
    );

    mocks.plaidPortfolioService.refreshFundedTradeIntent.mockResolvedValueOnce({
      intent: buildIntent({
        intent_id: "intent-pending",
        transfer_id: "transfer-9",
        status: "order_filled",
        order_id: "order-9999",
        executed_at: "2026-04-24T10:06:00.000Z",
      }),
    });

    renderView();

    expect(screen.getByText("funding_pending")).toBeTruthy();
    expect(screen.getByText(/Order order-8888/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await flushMicrotasks();
    });

    expect(mocks.plaidPortfolioService.refreshFundedTradeIntent).toHaveBeenCalledTimes(1);
    expect(mocks.plaidPortfolioService.refreshFundedTradeIntent).toHaveBeenCalledWith({
      userId: "user-123",
      intentId: "intent-pending",
      vaultOwnerToken: "vault-owner-token-123",
    });

    expect(screen.getByText(/Order order-9999/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await flushMicrotasks();
    });

    expect(mocks.plaidPortfolioService.refreshFundedTradeIntent).toHaveBeenCalledTimes(1);
  });

  it("keeps a new funded trade pending until polling advances it into order states", async () => {
    vi.useFakeTimers();

    const reload = setPortfolioSources(buildFundingStatus({ latest_trade_intents: [] }));

    mocks.plaidPortfolioService.createFundedTradeIntent.mockResolvedValueOnce({
      intent: buildIntent({
        intent_id: "intent-new",
        transfer_id: "transfer-new",
        status: "funding_pending",
        order_id: null,
      }),
    });
    mocks.plaidPortfolioService.refreshFundedTradeIntent
      .mockResolvedValueOnce({
        intent: buildIntent({
          intent_id: "intent-new",
          transfer_id: "transfer-new",
          status: "order_submitted",
          order_id: "order-new",
        }),
      })
      .mockResolvedValueOnce({
        intent: buildIntent({
          intent_id: "intent-new",
          transfer_id: "transfer-new",
          status: "order_filled",
          order_id: "order-new",
          executed_at: "2026-04-24T10:08:00.000Z",
        }),
      });

    renderView();

    fireEvent.change(screen.getByLabelText(/Linked funding account/i), {
      target: { value: "fund-acct-1" },
    });
    fireEvent.change(screen.getByLabelText(/Alpaca brokerage destination/i), {
      target: { value: "alpaca-acc-1" },
    });
    fireEvent.change(screen.getByLabelText(/Legal name on funding account/i), {
      target: { value: "Kai User" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Fund and trade/i }));
      await flushMicrotasks();
    });

    expect(mocks.plaidPortfolioService.createFundedTradeIntent).toHaveBeenCalledTimes(1);

    expect(mocks.plaidPortfolioService.createFundedTradeIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        vaultOwnerToken: "vault-owner-token-123",
        fundingItemId: "fund-item-1",
        fundingAccountId: "fund-acct-1",
        symbol: "AAPL",
        userLegalName: "Kai User",
        notionalUsd: 100,
        side: "buy",
        orderType: "market",
        timeInForce: "day",
        brokerageAccountId: "alpaca-acc-1",
      })
    );

    const createPayload = mocks.plaidPortfolioService.createFundedTradeIntent.mock.calls[0]?.[0] as {
      tradeIdempotencyKey: string;
      transferIdempotencyKey: string;
    };
    expect(createPayload.tradeIdempotencyKey).toMatch(/^kai_trade_user-123_/);
    expect(createPayload.transferIdempotencyKey).toMatch(/^kai_transfer_user-123_/);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("funding_pending")).toBeTruthy();
    expect(screen.queryByText(/Order order-new/)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await flushMicrotasks();
    });

    expect(mocks.plaidPortfolioService.refreshFundedTradeIntent).toHaveBeenCalledTimes(1);
    expect(screen.getByText("order_submitted")).toBeTruthy();
    expect(screen.getByText(/Order order-new/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await flushMicrotasks();
    });

    expect(mocks.plaidPortfolioService.refreshFundedTradeIntent).toHaveBeenCalledTimes(2);
    expect(screen.getByText("order_filled")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await flushMicrotasks();
    });

    expect(mocks.plaidPortfolioService.refreshFundedTradeIntent).toHaveBeenCalledTimes(2);
  });
});
