import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import type { CommerceActivityItem, ScopeCommerceRequest, ScopeQuote } from "@/lib/services/scope-commerce-service";

const mocks = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: vi.fn(async () => "owner-token") } as { uid: string; getIdToken: () => Promise<string> } | null,
  readiness: vi.fn(), sandboxVerified: vi.fn(), tariff: vi.fn(), saveTariff: vi.fn(), account: vi.fn(), activity: vi.fn(), onboarding: vi.fn(), management: vi.fn(), hosted: vi.fn(), periodic: vi.fn(),
  scopeRequest: vi.fn(), quote: vi.fn(), purchase: vi.fn(), exporter: vi.fn(),
  pathname: "/one/profile/payouts", search: "", vaultKey: "memory-key", openWindow: vi.fn(),
  answerGates: vi.fn(), answerAccount: vi.fn(), answerLink: vi.fn(), answerOnboarding: vi.fn(),
}));
vi.mock("@/lib/services/answer-request-service", () => ({ AnswerRequestService: {
  gates: mocks.answerGates, payoutAccount: mocks.answerAccount, payoutLink: mocks.answerLink, payoutOnboarding: mocks.answerOnboarding,
} }));
vi.mock("@/components/consent/document-hashcoins", () => ({ DocumentHashcoinPayouts: () => null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(mocks.search) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: mocks.vaultKey, getVaultOwnerToken: () => "vault-owner-token" }) }));
vi.mock("@/lib/consent/scope-commerce-export", () => ({ prepareAndStagePaidScopeExport: mocks.exporter }));
vi.mock("@/lib/services/scope-commerce-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/scope-commerce-service")>(),
  ScopeCommerceService: { readiness: mocks.readiness, sandboxVerified: mocks.sandboxVerified, tariff: mocks.tariff, saveTariff: mocks.saveTariff, account: mocks.account, activity: mocks.activity, onboarding: mocks.onboarding, managePayoutAccount: mocks.management,
    scopeRequest: mocks.scopeRequest, quote: mocks.quote, purchase: mocks.purchase },
}));
vi.mock("@/lib/services/scope-commerce-browser", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/scope-commerce-browser")>(), openCommerceHostedUrl: mocks.hosted, openCommerceHostedWindow: mocks.openWindow,
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({ usePeriodicTask: mocks.periodic, useCoarseClock: () => Date.now() }));
vi.mock("@/components/ui/button", async () => {
  const { Slot } = await import("@radix-ui/react-slot");
  return { buttonVariants: () => "", Button: ({ children, variant: _variant, asChild, size: _size, showRipple: _ripple, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; asChild?: boolean; size?: string; showRipple?: boolean }) => asChild ? <Slot {...props}>{children}</Slot> : <button {...props}>{children}</button> };
});
vi.mock("@/components/app-ui/settings-ui", () => ({ SettingsGroup: ({ title, children }: { title: string; children: ReactNode }) => <section aria-label={title}>{children}</section> }));

import { useCommerceRead } from "@/components/consent/use-commerce-session";
import { useScopeCommerceRequest } from "@/components/consent/use-scope-commerce-request";
import { ScopeCommerceOwnerReview } from "@/components/consent/scope-commerce-owner-review";
import { ScopeCommerceBuyerReview } from "@/components/consent/scope-commerce-buyer-review";
import { ScopeCommerceActivity } from "@/components/consent/scope-commerce-activity";
import { ScopeCommerceAccountPanel } from "@/components/consent/scope-commerce-account-panel";
import { MemoryCommerceSummary } from "@/components/profile/memory-commerce-summary";
import { ScopeTariffEditor } from "@/components/consent/scope-tariff-editor";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AnswerPayoutAccount } from "@/components/consent/answer-payout-account";
import { PaymentsAndEarnings } from "@/components/consent/payments-and-earnings";
import { ScopeCommerceRequestPanel } from "@/components/consent/scope-commerce-request-panel";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { getVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { COMMERCE_RETURN_EVENT } from "@/lib/services/scope-commerce-browser";
import { commerceMoneyButtonName } from "../../../.agents/skills/reviewer-app-testing/scripts/scope-commerce-rehearsal-contract.mjs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const requestId = "request_approved";
const purchaseId = "purchase_approved";
const readiness = () => ({ schema_version: 1 as const, enabled: true, free: { requires_payment_provider: false as const, requires_owner_approval: true as const, tariff_controls_available: true },
  platform: { status: "ready" as const, reason_code: null, verification_scope: "configured_and_persisted" as const }, seller: { status: "not_onboarded" as const, reason_code: "seller_onboarding_required" as const },
  capabilities: { set_free_tariff: true, set_paid_tariff: false, approve_paid_request: false, reserve_paid_purchase: true, start_funding: true, start_onboarding: true } });
const unavailable = () => ({ ...readiness(), enabled: false, platform: { ...readiness().platform, status: "disabled" as const, reason_code: "commerce_disabled" as const }, capabilities: { set_free_tariff: true, set_paid_tariff: false, approve_paid_request: false, reserve_paid_purchase: false, start_funding: false, start_onboarding: false } });
const balanceAccount = () => ({ enabled: true, readiness: readiness(), currency: "USD", balance: { available_cents: 1, reserved_cents: 0 },
  earnings: { pending_cents: 0, available_cents: 0 }, seller: { onboarded: false, eligible: false, country: "US" },
  payout: { minimum_net_cents: 50 }, funding_lots: [] });
const quote: ScopeQuote = { id: "exact_quote", request_id: requestId, machine_scope: "attr.food.preferences.*", scope_handle: "scope_food", amount_cents: 1,
  base_price_cents: 7, base_duration_seconds: 604800, duration_seconds: 86400, currency: "USD", expires_at: "2099-01-01T00:00:00Z" };
const ownerRequest = (): ScopeCommerceRequest => ({ request_id: requestId, role: "owner", scope_handle: "scope_food", machine_scope: "attr.food.preferences.*",
  purpose: "Synthetic approved purpose", duration_seconds: 86400, tariff: null,
  purchase: { id: purchaseId, request_id: requestId, status: "reserved", amount_cents: 1, processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345 },
  negative_net_acknowledgement: { version: 1, binding: "a".repeat(64), gross_cents: 1, processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345 } });
const entry = (id: string): CommerceActivityItem => ({ id, request_id: requestId, purchase_id: purchaseId, kind: "sale", status: "reserved", direction: "incoming",
  counterpart: { label: "Approved requester" }, scope_label: "Food preferences", scope_handle: "scope_food", machine_scope: "attr.food.preferences.*",
  gross_cents: 1, amount_cents: 1, processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345, refunded_cents: 0,
  created_at: "2026-10-06T00:00:00Z", activation_at: null, expires_at: null, matures_at: null, fulfillment_deadline: null,
  next_action: { label: "Prepare information", href: `/one/consent?commerceRequestId=${requestId}` } });

beforeEach(() => {
  vi.resetAllMocks();
  publishValidatedAuthSessionOwner("owner");
  mocks.user = { uid: "owner", getIdToken: vi.fn(async () => "owner-token") };
  mocks.pathname = "/one/profile/payouts"; mocks.search = ""; mocks.vaultKey = "memory-key";
  mocks.account.mockResolvedValue(balanceAccount());
  mocks.readiness.mockResolvedValue(readiness());
  mocks.sandboxVerified.mockRejectedValue(new Error("unverified"));
  mocks.tariff.mockResolvedValue(null);
  mocks.saveTariff.mockResolvedValue({});
  mocks.activity.mockResolvedValue({ items: [], next_cursor: null });
  mocks.scopeRequest.mockResolvedValue(ownerRequest());
  mocks.quote.mockResolvedValue(quote);
  mocks.answerGates.mockResolvedValue({ payouts: true });
  mocks.answerAccount.mockResolvedValue({ stripeMode: "test", account: null });
});
afterEach(cleanup);

describe("commerce session and review authority", () => {
  it("labels simulated funds only after owner-bound Sandbox verification", async () => {
    render(<ScopeCommerceAccountPanel />);
    await screen.findByText(/1 Hussh coin/);
    expect(screen.queryByText(/Sandbox test/)).toBeNull();
    mocks.sandboxVerified.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh payment status" }));
    await screen.findByText(/Sandbox test — funds are simulated/);
  });
  it("drops older reads, account ABA responses and results arriving after a vault epoch change", async () => {
    const old = deferred<{ pending: boolean; label: string }>();
    const newer = deferred<{ pending: boolean; label: string }>();
    const locked = deferred<{ pending: boolean; label: string }>();
    const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise).mockReturnValueOnce(locked.promise);
    const { result, rerender } = renderHook(() => useCommerceRead("review", load, value => value.pending));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => newer.resolve({ pending: true, label: "current" }));
    expect(result.current.data?.label).toBe("current");
    await act(async () => old.resolve({ pending: false, label: "stale" }));
    expect(result.current.data?.label).toBe("current");
    const lastPoll = mocks.periodic.mock.calls.at(-1)!;
    expect(lastPoll[1]).toBe(15000); expect(lastPoll[3].enabled).toBe(true);
    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    act(() => advanceVaultSessionEpoch());
    await act(async () => locked.resolve({ pending: false, label: "wrong epoch" }));
    expect(result.current.data?.label).toBe("current"); expect(result.current.loading).toBe(false);
    const previousAccount = deferred<{ pending: boolean; label: string }>();
    load.mockReturnValueOnce(previousAccount.promise).mockResolvedValueOnce({ pending: false, label: "new owner" });
    const original = mocks.user;
    mocks.user = { uid: "other", getIdToken: async () => "other-token" }; rerender();
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    mocks.user = original; rerender();
    await waitFor(() => expect(result.current.data?.label).toBe("new owner"));
    await act(async () => previousAccount.resolve({ pending: true, label: "other owner's history" }));
    expect(result.current.data?.label).toBe("new owner");
    expect(mocks.periodic.mock.calls.at(-1)![3].enabled).toBe(false);
  });

  it.each(["vault", "authentication"])("retries an initially retired %s read with fresh authority without publishing its result", async boundary => {
    const retired = deferred<{ pending: boolean; label: string }>();
    const load = vi.fn().mockReturnValueOnce(retired.promise).mockResolvedValueOnce({ pending: false, label: "current review" });
    const { result } = renderHook(() => useCommerceRead("review", load, value => value.pending));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    act(() => {
      if (boundary === "vault") advanceVaultSessionEpoch();
      else { publishValidatedAuthSessionOwner(null); publishValidatedAuthSessionOwner("owner"); }
    });
    await act(async () => retired.resolve({ pending: true, label: "retired review" }));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    const retry = mocks.periodic.mock.calls.at(-1)!;
    expect(retry[3].enabled).toBe(true);
    await act(async () => retry[2]());
    expect(result.current.data?.label).toBe("current review");
    expect(mocks.periodic.mock.calls.at(-1)![3].enabled).toBe(false);
  });

  it("requires acknowledgement of exact negative net and resets consent when the cost binding changes", async () => {
    const prepare = vi.fn(async () => undefined);
    const request = ownerRequest();
    const { rerender } = render(<ScopeCommerceOwnerReview request={request} busy={false} unlocked prepare={prepare} />);
    expect(screen.getByRole("button", { name: "Prepare encrypted information" })).toBeDisabled();
    expect(prepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Prepare encrypted information" }));
    expect(prepare).toHaveBeenCalledWith({ version: 1, binding: "a".repeat(64), acknowledged: true });
    rerender(<ScopeCommerceOwnerReview request={{ ...request, negative_net_acknowledgement: { ...request.negative_net_acknowledgement!, binding: "b".repeat(64) } }} busy={false} unlocked prepare={prepare} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Prepare encrypted information" })).toBeDisabled();
  });

  it("allows one-cent reviewed purchase only on a human click with sufficient balance", () => {
    const purchase = vi.fn(async () => undefined); const reviewPrice = vi.fn(async () => undefined);
    const { rerender } = render(<ScopeCommerceBuyerReview quote={quote} balance={0} expired={false} busy={false} enabled purchase={purchase} reviewPrice={reviewPrice} />);
    expect(screen.getByText(/You need 1 Hussh coin \(\$0.01\) more/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm 1 Hussh coin ($0.01) from balance" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Add funds or manage payments in Payments and earnings" })).toBeVisible();
    expect(purchase).not.toHaveBeenCalled();
    rerender(<ScopeCommerceBuyerReview quote={quote} balance={1} expired={false} busy={false} enabled purchase={purchase} reviewPrice={reviewPrice} />);
    expect(screen.queryByRole("link", { name: "Add funds or manage payments in Payments and earnings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: commerceMoneyButtonName("purchase", 1) }));
    expect(purchase).toHaveBeenCalledOnce();
    rerender(<ScopeCommerceBuyerReview quote={quote} balance={1} expired busy={false} enabled purchase={purchase} reviewPrice={reviewPrice} />);
    expect(screen.getByRole("button", { name: "Confirm 1 Hussh coin ($0.01) from balance" })).toBeDisabled();
  });

  it("does not begin owner crypto after an account change while its identity token is pending", async () => {
    const { result, rerender } = renderHook(() => useScopeCommerceRequest(requestId));
    await waitFor(() => expect(result.current.request).not.toBeNull());
    const token = deferred<string>();
    mocks.user!.getIdToken = () => token.promise;
    act(() => { void result.current.prepare({ version: 1, binding: "a".repeat(64), acknowledged: true }); });
    mocks.user = { uid: "other", getIdToken: async () => "other-token" }; rerender();
    await act(async () => token.resolve("old-owner-token"));
    expect(mocks.exporter).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("does not attach an old quote to a different request reviewed in the same account", async () => {
    const oldQuote = deferred<ScopeQuote>();
    mocks.quote.mockReturnValueOnce(oldQuote.promise);
    const { result, rerender } = renderHook(({ id }) => useScopeCommerceRequest(id), { initialProps: { id: requestId } });
    await waitFor(() => expect(result.current.request?.request_id).toBe(requestId));
    act(() => { void result.current.reviewPrice(); });
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledOnce());
    mocks.scopeRequest.mockResolvedValue({ ...ownerRequest(), request_id: "new_request", purchase: null });
    rerender({ id: "new_request" });
    await waitFor(() => expect(result.current.request?.request_id).toBe("new_request"));
    await act(async () => oldQuote.resolve(quote));
    expect(result.current.quote).toBeNull();
    expect(mocks.purchase).not.toHaveBeenCalled();
  });
});

describe("Payments and earnings history", () => {
  it("pages with the server cursor and rejects a late page after switching views", async () => {
    mocks.activity.mockResolvedValueOnce({ items: [entry("first")], next_cursor: "page_two" })
      .mockResolvedValueOnce({ items: [entry("second")], next_cursor: "page_three" });
    render(<ScopeCommerceActivity />);
    await screen.findByRole("button", { name: "Load more purchases" });
    expect(screen.getByRole("link", { name: "Prepare information" })).toBeVisible();
    expect(screen.queryByText("Attributed processing costs")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View receipt" }));
    expect(screen.getByText("Attributed processing costs")).toBeVisible();
    act(() => { expect(unwindBackLayer(mocks.pathname)).toBe(true); });
    expect(screen.queryByText("Attributed processing costs")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more purchases" }));
    await waitFor(() => expect(screen.getAllByText("Food preferences")).toHaveLength(2));
    expect(mocks.activity).toHaveBeenNthCalledWith(2, "owner-token", "purchases", "page_two");
    const oldPage = deferred<{ items: CommerceActivityItem[]; next_cursor: null }>();
    mocks.activity.mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce({ items: [], next_cursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Load more purchases" }));
    await waitFor(() => expect(mocks.activity).toHaveBeenCalledTimes(3));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sales" }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("tab", { name: "Sales" }));
    await screen.findByText("No sales yet.");
    await act(async () => oldPage.resolve({ items: [entry("stale")], next_cursor: null }));
    expect(screen.queryByText("Food preferences")).not.toBeInTheDocument();
    expect(mocks.activity).toHaveBeenLastCalledWith("owner-token", "sales");
  });

  it.each([
    ["/one/profile/payouts", "", true],
    ["/one/pkm", "profile_pane=1&profile_panel=payouts", true],
    ["/one/pkm", "profile_pane=1&profile_panel=account", false],
    ["/one/pkm", "profile_pane=1&profile_panel=phone", false],
    ["/one/pkm", "", false],
    ["/one/profile/account", "", false],
  ])("keeps receipt and History Back within active Payments at %s?%s", async (pathname, query, active) => {
    mocks.pathname = pathname;
    mocks.search = query;
    mocks.activity.mockResolvedValue({ items: [entry("receipt")], next_cursor: null });
    render(<ScopeCommerceAccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "View receipt" }));
    act(() => { expect(unwindBackLayer(pathname, new URLSearchParams(query))).toBe(active); });
    if (!active) {
      expect(screen.getByText("Attributed processing costs")).toBeVisible();
      expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-expanded", "true");
      return;
    }
    expect(screen.queryByText("Attributed processing costs")).toBeNull();
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-expanded", "true");
    act(() => { expect(unwindBackLayer(pathname, new URLSearchParams(query))).toBe(true); });
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-expanded", "false");
    expect(unwindBackLayer(pathname, new URLSearchParams(query))).toBe(false);
  });

  it("shows disabled history and preserves managed balances without enabling new funding", async () => {
    mocks.account.mockResolvedValueOnce({ enabled: false, readiness: unavailable() });
    const first = render(<ScopeCommerceAccountPanel />);
    await screen.findByText(/New purchases and funding are currently unavailable/);
    expect(screen.queryByRole("button", { name: "Continue to secure checkout" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByText("No purchases yet."); first.unmount();
    mocks.account.mockResolvedValueOnce({ ...balanceAccount(), enabled: false, readiness: unavailable(), managed_balances: true,
      earnings: { pending_cents: 0, available_cents: -25, debt_cents: 25 }, funding_lots: [{ id: "existing_lot", refundable_cents: 50 }] });
    render(<ScopeCommerceAccountPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Refund unused balance" }));
    await screen.findByRole("button", { name: commerceMoneyButtonName("refund", 50) });
    expect(screen.getByText("Unrecovered costs")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Set up information-access payouts" }));
    expect(screen.getByRole("button", { name: "Review withdrawal" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Continue to secure checkout" })).not.toBeInTheDocument();
  });

  it("exposes unfinished payout setup and retires its hosted link when the vault session changes", async () => {
    mocks.openWindow.mockReturnValue(null);
    const view = render(<ScopeCommerceAccountPanel />);
    const payouts = await screen.findByRole("button", { name: "Set up information-access payouts" });
    expect(screen.queryByRole("button", { name: "Withdraw information-access earnings" })).toBeNull();
    expect(screen.getByText(/Payments and earnings → Set up information-access payouts before setting a paid price/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Set up payouts with Stripe" })).toBeNull();
    fireEvent.click(payouts);
    act(() => { expect(unwindBackLayer(mocks.pathname)).toBe(true); });
    expect(payouts).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(payouts);
    const button = await screen.findByRole("button", { name: "Set up payouts with Stripe" });
    fireEvent.click(button);
    expect(mocks.onboarding).not.toHaveBeenCalled();
    expect(screen.getByText(/Allow pop-ups for One/)).toBeVisible();
    const popup = { close: vi.fn() };
    mocks.openWindow.mockReturnValue(popup);
    const pending = deferred<{ url: string; returnUrl: string; attemptId: string }>();
    mocks.onboarding.mockReturnValue(pending.promise);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.onboarding).toHaveBeenCalledOnce());
    act(() => advanceVaultSessionEpoch());
    expect(popup.close).toHaveBeenCalled();
    pending.resolve({ url: "https://connect.stripe.com/setup/retired", returnUrl: "https://example.test/one/profile/account", attemptId: "opaque_attempt_12345" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(mocks.hosted).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each(["query", "event"])("binds a warm expired onboarding %s return to its owner and creates a fresh link only on click", async source => {
    const popup = { close: vi.fn() };
    const session = { url: "https://connect.stripe.com/setup/new", returnUrl: "https://example.test/one/profile/account", attemptId: "opaque_attempt_12345" };
    mocks.openWindow.mockReturnValue(popup);
    mocks.onboarding.mockResolvedValue(session);
    const view = render(<ScopeCommerceAccountPanel />);
    await screen.findByRole("button", { name: "Set up information-access payouts" });
    expect(screen.queryByRole("button", { name: "Get a new payout setup link" })).toBeNull();
    for (const foreign of ["documents", "answers"]) {
      act(() => window.dispatchEvent(new CustomEvent(COMMERCE_RETURN_EVENT, { detail: { source: foreign, action: "onboarding_refresh" } })));
      expect(screen.queryByRole("button", { name: "Get a new payout setup link" })).toBeNull();
    }
    if (source === "query") {
      mocks.search = "commerceReturn=1&commerceAttemptId=opaque_attempt_12345&commerceAction=onboarding_refresh";
      view.rerender(<ScopeCommerceAccountPanel />);
    } else act(() => window.dispatchEvent(new CustomEvent(COMMERCE_RETURN_EVENT, { detail: { action: "onboarding_refresh" } })));
    await screen.findByRole("button", { name: "Get a new payout setup link" });
    expect(mocks.onboarding).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Get a new payout setup link" }));
    await waitFor(() => expect(mocks.hosted).toHaveBeenCalledWith(session, "onboarding", popup, expect.any(AbortSignal)));
    expect(mocks.openWindow.mock.invocationCallOrder[0]).toBeLessThan(mocks.onboarding.mock.invocationCallOrder[0]);
    expect(mocks.onboarding).toHaveBeenCalledWith("owner-token", "US", expect.any(String));
    const firstKey = mocks.onboarding.mock.calls[0][2];
    await waitFor(() => expect(screen.getByRole("button", { name: "Get a new payout setup link" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Get a new payout setup link" }));
    await waitFor(() => expect(mocks.onboarding).toHaveBeenCalledTimes(2));
    expect(mocks.onboarding.mock.calls[1][2]).not.toBe(firstKey);
    const original = mocks.user;
    mocks.user = { uid: "counterpart", getIdToken: vi.fn(async () => "counterpart-token") };
    view.rerender(<ScopeCommerceAccountPanel />);
    await screen.findByRole("button", { name: "Set up information-access payouts" });
    expect(screen.queryByRole("button", { name: "Get a new payout setup link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up information-access payouts" }));
    await screen.findByRole("button", { name: "Set up payouts with Stripe" });
    expect(screen.queryByText(/Your payout setup link expired/)).toBeNull();
    expect(mocks.onboarding).toHaveBeenCalledTimes(2);
    mocks.user = original;
    view.rerender(<ScopeCommerceAccountPanel />);
    act(() => advanceVaultSessionEpoch());
    expect(screen.queryByRole("button", { name: "Get a new payout setup link" })).toBeNull();
    expect(mocks.onboarding).toHaveBeenCalledTimes(2);
  });
});


describe("free sharing independent of payment setup", () => {
  it("projects canonical earnings in Saved and routes payout setup to Payments and earnings without starting OAuth", async () => {
    mocks.account.mockResolvedValue({ ...balanceAccount(), earnings: { pending_cents: 450, available_cents: 100 } });
    render(<MemoryCommerceSummary />);
    await screen.findByText("450 Hussh coins ($4.50)");
    expect(screen.getByText("100 Hussh coins ($1.00)")).toBeVisible();
    expect(screen.getByRole("link", { name: "Set up payouts and view your wallet" })).toHaveAttribute("href", "/one?profile_pane=1&profile_panel=payouts");
    const originalUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState({}, "", "/one/pkm?tab=saved");
    fireEvent.click(screen.getByRole("link", { name: "Set up payouts and view your wallet" }));
    expect(window.location.pathname).toBe("/one/pkm");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("saved");
    expect(new URLSearchParams(window.location.search).get("profile_panel")).toBe("payouts");
    expect(window.history.state.__hushhProfilePane).toEqual({ depth: 1, returnsToOrigin: true });
    window.history.replaceState({}, "", originalUrl);
    expect(mocks.onboarding).not.toHaveBeenCalled();
    expect(mocks.hosted).not.toHaveBeenCalled();
  });
  it("shows a saved section price before opening review and directs eligible onboarding to Payments and earnings", async () => {
    mocks.tariff.mockResolvedValue({ price_cents: 1, base_duration_seconds: 3600 });
    const leaveOverview = vi.fn();
    function Overview() {
      const [open, setOpen] = useState(true);
      return <Dialog open={open}><DialogContent><DialogTitle>Bundle overview</DialogTitle>
        <ScopeTariffEditor scopeHandle="exact_handle" machineScope="attr.food.preferences.*" label="Food preferences" showSavedPrice
          onPaymentsNavigate={() => { leaveOverview(); setOpen(false); return true; }} />
      </DialogContent></Dialog>;
    }
    render(<Overview />);
    const button = screen.getByRole("button", { name: "Set sharing price for Food preferences" });
    await waitFor(() => expect(button).toHaveTextContent("1 Hussh coin ($0.01) / 1h"));
    expect(mocks.tariff).toHaveBeenCalledWith("owner-token", "exact_handle", "attr.food.preferences.*");
    fireEvent.click(button);
    await screen.findByRole("heading", { name: "Price for Food preferences" });
    const setup = screen.getByRole("link", { name: "Set up payouts with Stripe in Payments and earnings" });
    expect(setup).toHaveAttribute("href", "/one?profile_pane=1&profile_panel=payouts");
    fireEvent.click(setup, { ctrlKey: true });
    expect(screen.getByRole("heading", { name: "Price for Food preferences" })).toBeVisible();
    expect(leaveOverview).not.toHaveBeenCalled();
    fireEvent.click(setup);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(leaveOverview).toHaveBeenCalledOnce();
    expect(mocks.saveTariff).not.toHaveBeenCalled();
  });

  it("preserves a positive saved price when paid setup is unavailable and allows only an explicitly confirmed free change", async () => {
    mocks.readiness.mockResolvedValue(unavailable());
    mocks.tariff.mockResolvedValue({ price_cents: 450, base_duration_seconds: 604800 });
    render(<ScopeTariffEditor scopeHandle="exact_handle" machineScope="attr.food.preferences.*" label="Food preferences" />);
    fireEvent.click(screen.getByRole("button", { name: "Set sharing price for Food preferences" }));
    const input = await screen.findByLabelText("USD base price");
    await waitFor(() => expect(input).toHaveValue("4.50"));
    fireEvent.click(screen.getByRole("button", { name: "Review sharing price" }));
    expect(screen.queryByRole("button", { name: "Save price" })).not.toBeInTheDocument();
    expect(mocks.saveTariff).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Check payment availability in Payments and earnings" })).toHaveAttribute("href", "/one?profile_pane=1&profile_panel=payouts");
    fireEvent.change(input, { target: { value: "0.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review sharing price" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm free" }));
    await waitFor(() => expect(mocks.saveTariff).toHaveBeenCalledWith("owner-token", { scope_handle: "exact_handle", machine_scope: "attr.food.preferences.*", price_cents: 0, base_duration_seconds: 604800 }, expect.any(String)));
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it.each(["back", "agent"])("prefills without saving and closes confirmation before the editor through %s", async method => {
    mocks.pathname = "/one/pkm";
    const available = readiness(); available.capabilities.set_paid_tariff = true;
    mocks.readiness.mockResolvedValue(available);
    const close = vi.fn();
    render(<ScopeTariffEditor scopeHandle="exact_handle" machineScope="attr.food.preferences.*" label="Food preferences"
      reviewRequest={{ id: "review_only", proposedPriceCents: 1, proposedBaseHours: 24 }} onReviewClose={close} />);
    const input = await screen.findByLabelText("USD base price");
    await waitFor(() => expect(input).toHaveValue("0.01"));
    expect(mocks.saveTariff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review sharing price" }));
    expect(await screen.findByRole("button", { name: "Save price" })).toBeVisible();
    expect(getVoiceSurfaceMetadata()?.interactionLayer).toMatchObject({ blocksUnderlyingActions: true, visibleActionIds: ["pkm.close_sharing_price_review"] });
    const dismiss = async () => { await act(async () => {
      if (method === "back") expect(unwindBackLayer(mocks.pathname)).toBe(true);
      else expect(await resolveLocalOnboardingHandler("pkm.close_sharing_price_review")!({})).toMatchObject({ status: "succeeded" });
    }); };
    await dismiss();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByLabelText("USD base price")).toHaveValue("0.01");
    expect(close).not.toHaveBeenCalled();
    await dismiss();
    expect(close).toHaveBeenCalledOnce(); expect(mocks.saveTariff).not.toHaveBeenCalled();
    expect(resolveLocalOnboardingHandler("pkm.close_sharing_price_review")).toBeNull();
  });

  it.each([false, true])("dispatches an explicitly confirmed price only in the original auth generation (retired=%s)", async retired => {
    const available = readiness(); available.capabilities.set_paid_tariff = true;
    mocks.readiness.mockResolvedValue(available);
    render(<ScopeTariffEditor scopeHandle="exact_handle" machineScope="attr.food.preferences.*" label="Food preferences"
      reviewRequest={{ id: "one_cent", proposedPriceCents: 1, proposedBaseHours: 24 }} />);
    await waitFor(() => expect(screen.getByLabelText("USD base price")).toHaveValue("0.01"));
    fireEvent.click(screen.getByRole("button", { name: "Review sharing price" }));
    const pendingToken = deferred<string>(); mocks.user!.getIdToken = () => pendingToken.promise;
    fireEvent.click(await screen.findByRole("button", { name: "Save price" }));
    if (retired) act(() => { publishValidatedAuthSessionOwner(null); publishValidatedAuthSessionOwner("owner"); });
    await act(async () => pendingToken.resolve("owner-token"));
    if (retired) expect(mocks.saveTariff).not.toHaveBeenCalled();
    else expect(mocks.saveTariff).toHaveBeenCalledWith("owner-token", { scope_handle: "exact_handle", machine_scope: "attr.food.preferences.*", price_cents: 1, base_duration_seconds: 86400 }, expect.any(String));
  });

  it("keeps a confirmed free request reachable when payment availability cannot be read", async () => {
    mocks.readiness.mockRejectedValue(new Error("unavailable"));
    mocks.account.mockRejectedValue(new Error("provider unavailable"));
    mocks.scopeRequest.mockResolvedValue({ ...ownerRequest(), purchase: null, tariff: null, negative_net_acknowledgement: null });
    render(<ScopeCommerceRequestPanel requestId={requestId} />);
    await screen.findByText(/This request is free/);
    expect(screen.getByRole("link", { name: "Review this request in Consent" })).toHaveAttribute("href", `/one/consent?requestId=${requestId}`);
    expect(screen.queryByRole("button", { name: /Confirm .* from balance/ })).not.toBeInTheDocument();
    expect(mocks.account).not.toHaveBeenCalled();
  });
});


describe("unconfigured platform funds", () => {
  it("uses readiness rather than the feature flag for new money actions while preserving existing refunds", async () => {
    const availability = { ...unavailable(), enabled: true, platform: { ...unavailable().platform, status: "unconfigured" as const, reason_code: "provider_credentials_required" as const } };
    mocks.account.mockResolvedValue({ ...balanceAccount(), readiness: availability, funding_lots: [{ id: "existing_lot", refundable_cents: 50 }] });
    render(<ScopeCommerceAccountPanel />);
    await screen.findByText(/Payments are not set up for this app yet/);
    fireEvent.click(await screen.findByRole("button", { name: "Refund unused balance" }));
    expect(screen.getByRole("button", { name: "Review refund of 50 Hussh coins ($0.50)" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Continue to secure checkout" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up information-access payouts" }));
    expect(screen.getByRole("button", { name: "Set up payouts with Stripe" })).toBeDisabled();
    expect(mocks.onboarding).not.toHaveBeenCalled();
  });
});

describe("answer payout hosted continuity", () => {
  it("admits the auxiliary window before creating a link and retires it on vault change", async () => {
    const view = render(<AnswerPayoutAccount />);
    const button = await screen.findByRole("button", { name: "Manage answer payouts" });
    await screen.findByText("Test payout setup. No real money moves.");
    mocks.openWindow.mockReturnValue(null);
    fireEvent.click(button);
    expect(mocks.answerOnboarding).not.toHaveBeenCalled();
    expect(screen.getByText(/Allow pop-ups/)).toBeVisible();
    const popup = { close: vi.fn() };
    mocks.openWindow.mockReturnValue(popup);
    const link = deferred<{ url: string; returnUrl: string; attemptId: string; source: "answers" }>();
    mocks.answerOnboarding.mockReturnValue(link.promise);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.answerOnboarding).toHaveBeenCalledOnce());
    expect(mocks.openWindow.mock.invocationCallOrder[1]).toBeLessThan(mocks.answerOnboarding.mock.invocationCallOrder[0]);
    act(() => advanceVaultSessionEpoch());
    expect(popup.close).toHaveBeenCalled();
    link.resolve({ url: "https://connect.stripe.com/setup/synthetic", returnUrl: "https://one.hushh.ai/one/profile/payouts", attemptId: "opaque_attempt_12345", source: "answers" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(mocks.hosted).not.toHaveBeenCalled();
    view.unmount();
  });
  it.each(["answers", "scope"])("discards a %s management link returned after the authenticated owner changes", async source => {
    mocks.answerAccount.mockResolvedValue({ stripeMode: "test", account: { ready: true, canManageBank: true } });
    mocks.account.mockResolvedValue({ ...balanceAccount(), enabled: false, readiness: unavailable(), seller: { onboarded: true, eligible: true, country: "US" } });
    const popup = { close: vi.fn(), location: { replace: vi.fn() } };
    mocks.openWindow.mockReturnValue(popup);
    const link = deferred<string>(); (source === "answers" ? mocks.answerLink : mocks.management).mockReturnValue(link.promise);
    const surface = () => source === "answers" ? <AnswerPayoutAccount /> : <ScopeCommerceAccountPanel />;
    const view = render(surface());
    if (source === "scope") fireEvent.click(await screen.findByRole("button", { name: "Withdraw information-access earnings" }));
    fireEvent.click(await screen.findByRole("button", { name: source === "answers" ? "Manage answer payouts" : "Manage payout account" }));
    await waitFor(() => source === "answers" ? expect(mocks.answerLink).toHaveBeenCalledWith("owner-token", "dashboard") : expect(mocks.management).toHaveBeenCalledWith("owner-token"));
    mocks.user = { uid: "another", getIdToken: vi.fn(async () => "another-token") };
    view.rerender(surface());
    link.resolve("https://connect.stripe.com/express/synthetic");
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("closes undispatched management windows during token retirement and admits only one synchronous click", async () => {
    mocks.answerAccount.mockResolvedValue({ stripeMode: "test", account: { ready: true, canManageBank: true } });
    const popup = { close: vi.fn(), location: { replace: vi.fn() } };
    mocks.openWindow.mockReturnValue(popup);
    render(<AnswerPayoutAccount />);
    await screen.findByText("Test payout setup. No real money moves.");
    const token = deferred<string>();
    vi.mocked(mocks.user!.getIdToken).mockReturnValue(token.promise);
    const button = screen.getByRole("button", { name: "Manage answer payouts" });
    act(() => { button.click(); button.click(); });
    expect(mocks.openWindow).toHaveBeenCalledOnce();
    act(() => advanceVaultSessionEpoch());
    expect(popup.close).toHaveBeenCalledOnce();
    token.resolve("retired-token");
    await waitFor(() => expect(button).toBeEnabled());
    expect(mocks.answerLink).not.toHaveBeenCalled();
    expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("offers an authenticated fresh answer link on cold payout arrival without starting onboarding", async () => {
    mocks.search = "commerceReturn=1&commerceAttemptId=opaque_attempt_12345&commerceSource=answers&commerceAction=onboarding_refresh";
    render(<PaymentsAndEarnings />);
    await screen.findByRole("button", { name: "Manage answer payouts" });
    await waitFor(() => expect(mocks.answerAccount).toHaveBeenCalledWith("owner-token"));
    expect(mocks.answerOnboarding).not.toHaveBeenCalled();
    expect(mocks.onboarding).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Get a new payout setup link" })).toBeNull();
  });
});
