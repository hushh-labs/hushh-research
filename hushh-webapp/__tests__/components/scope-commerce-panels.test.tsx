import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import type { CommerceActivityItem, ScopeCommerceRequest, ScopeQuote } from "@/lib/services/scope-commerce-service";

const mocks = vi.hoisted(() => ({
  user: { uid: "owner", getIdToken: vi.fn(async () => "owner-token") } as { uid: string; getIdToken: () => Promise<string> } | null,
  readiness: vi.fn(), sandboxVerified: vi.fn(), tariff: vi.fn(), saveTariff: vi.fn(), account: vi.fn(), activity: vi.fn(), onboarding: vi.fn(), hosted: vi.fn(), periodic: vi.fn(),
  scopeRequest: vi.fn(), quote: vi.fn(), purchase: vi.fn(), exporter: vi.fn(),
  search: "", vaultKey: "memory-key",
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: mocks.vaultKey, getVaultOwnerToken: () => "vault-owner-token" }) }));
vi.mock("@/lib/consent/scope-commerce-export", () => ({ prepareAndStagePaidScopeExport: mocks.exporter }));
vi.mock("@/lib/services/scope-commerce-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/scope-commerce-service")>(),
  ScopeCommerceService: { readiness: mocks.readiness, sandboxVerified: mocks.sandboxVerified, tariff: mocks.tariff, saveTariff: mocks.saveTariff, account: mocks.account, activity: mocks.activity, onboarding: mocks.onboarding,
    scopeRequest: mocks.scopeRequest, quote: mocks.quote, purchase: mocks.purchase },
}));
vi.mock("@/lib/services/scope-commerce-browser", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/scope-commerce-browser")>(), openCommerceHostedUrl: mocks.hosted,
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({ usePeriodicTask: mocks.periodic, useCoarseClock: () => Date.now() }));
vi.mock("@/components/ui/button", async () => {
  const { Slot } = await import("@radix-ui/react-slot");
  return { Button: ({ children, variant: _variant, asChild, size: _size, showRipple: _ripple, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; asChild?: boolean; size?: string; showRipple?: boolean }) => asChild ? <Slot {...props}>{children}</Slot> : <button {...props}>{children}</button> };
});
vi.mock("@/components/app-ui/settings-ui", () => ({ SettingsGroup: ({ title, children }: { title: string; children: ReactNode }) => <section aria-label={title}>{children}</section> }));

import { useCommerceRead } from "@/components/consent/use-commerce-session";
import { useScopeCommerceRequest } from "@/components/consent/use-scope-commerce-request";
import { ScopeCommerceOwnerReview } from "@/components/consent/scope-commerce-owner-review";
import { ScopeCommerceBuyerReview } from "@/components/consent/scope-commerce-buyer-review";
import { ScopeCommerceActivity } from "@/components/consent/scope-commerce-activity";
import { ScopeCommerceAccountPanel } from "@/components/consent/scope-commerce-account-panel";
import { ScopeTariffEditor } from "@/components/consent/scope-tariff-editor";
import { ScopeCommerceRequestPanel } from "@/components/consent/scope-commerce-request-panel";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

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
  mocks.user = { uid: "owner", getIdToken: vi.fn(async () => "owner-token") };
  mocks.search = ""; mocks.vaultKey = "memory-key";
  mocks.account.mockResolvedValue(balanceAccount());
  mocks.readiness.mockResolvedValue(readiness());
  mocks.sandboxVerified.mockRejectedValue(new Error("unverified"));
  mocks.tariff.mockResolvedValue(null);
  mocks.saveTariff.mockResolvedValue({});
  mocks.activity.mockResolvedValue({ items: [], next_cursor: null });
  mocks.scopeRequest.mockResolvedValue(ownerRequest());
  mocks.quote.mockResolvedValue(quote);
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
    expect(purchase).not.toHaveBeenCalled();
    rerender(<ScopeCommerceBuyerReview quote={quote} balance={1} expired={false} busy={false} enabled purchase={purchase} reviewPrice={reviewPrice} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1 Hussh coin ($0.01) from balance" }));
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

describe("existing Account payment history", () => {
  it("pages with the server cursor and rejects a late page after switching views", async () => {
    mocks.activity.mockResolvedValueOnce({ items: [entry("first")], next_cursor: "page_two" })
      .mockResolvedValueOnce({ items: [entry("second")], next_cursor: "page_three" });
    render(<ScopeCommerceActivity />);
    await screen.findByRole("button", { name: "Load more purchases" });
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

  it("shows disabled history and preserves managed balances without enabling new funding", async () => {
    mocks.account.mockResolvedValueOnce({ enabled: false, readiness: unavailable() });
    const first = render(<ScopeCommerceAccountPanel />);
    await screen.findByText(/New purchases and funding are currently unavailable/);
    expect(screen.queryByRole("button", { name: "Continue to secure checkout" })).not.toBeInTheDocument();
    await screen.findByText("No purchases yet."); first.unmount();
    mocks.account.mockResolvedValueOnce({ ...balanceAccount(), enabled: false, readiness: unavailable(), managed_balances: true,
      earnings: { pending_cents: 0, available_cents: -25, debt_cents: 25 }, funding_lots: [{ id: "existing_lot", refundable_cents: 50 }] });
    render(<ScopeCommerceAccountPanel />);
    await screen.findByRole("button", { name: "Review refund of 50 Hussh coins ($0.50)" });
    expect(screen.getByText("Unrecovered costs")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review withdrawal" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Continue to secure checkout" })).not.toBeInTheDocument();
  });

  it("treats an expired onboarding return as presentation and requests a fresh authenticated link only on click", async () => {
    mocks.search = "commerceReturn=1&commerceAttemptId=opaque_attempt_12345&commerceAction=onboarding_refresh";
    mocks.onboarding.mockResolvedValue("https://connect.stripe.com/setup/new");
    render(<ScopeCommerceAccountPanel />);
    await screen.findByRole("button", { name: "Get a new payout setup link" });
    expect(mocks.onboarding).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Get a new payout setup link" }));
    await waitFor(() => expect(mocks.hosted).toHaveBeenCalledWith("https://connect.stripe.com/setup/new", "onboarding"));
    expect(mocks.onboarding).toHaveBeenCalledWith("owner-token", "US", expect.any(String));
    const firstKey = mocks.onboarding.mock.calls[0][2];
    await waitFor(() => expect(screen.getByRole("button", { name: "Get a new payout setup link" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Get a new payout setup link" }));
    await waitFor(() => expect(mocks.onboarding).toHaveBeenCalledTimes(2));
    expect(mocks.onboarding.mock.calls[1][2]).not.toBe(firstKey);
  });
});


describe("free sharing independent of payment setup", () => {
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
    fireEvent.change(input, { target: { value: "0.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review sharing price" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm free" }));
    await waitFor(() => expect(mocks.saveTariff).toHaveBeenCalledWith("owner-token", { scope_handle: "exact_handle", machine_scope: "attr.food.preferences.*", price_cents: 0, base_duration_seconds: 604800 }, expect.any(String)));
    expect(mocks.account).not.toHaveBeenCalled();
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
    expect(screen.getByRole("button", { name: "Review refund of 50 Hussh coins ($0.50)" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Continue to secure checkout" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up payouts with Stripe" })).toBeDisabled();
    expect(mocks.onboarding).not.toHaveBeenCalled();
  });
});
