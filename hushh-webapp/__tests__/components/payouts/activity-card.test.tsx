import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted and vi.mock are file-scoped, so each payouts test file repeats this setup.
const state = vi.hoisted(() => ({
  token: "owner-token" as string | null,
  epoch: 1,
  apiJson: vi.fn(),
  list: vi.fn(),
  item: vi.fn(),
  stream: "live" as "live" | "polling",
  // Fallback reads registered on the idle clock, run by hand.
  tasks: new Map<string, () => void>(),
}));

vi.mock("@/lib/capacitor/platform", () => ({ isNative: () => false }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token }) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
// Stream "live" by default: refreshes come only from payout events, so every read here is deliberate.
vi.mock("@/lib/payouts/payout-live-store", () => ({
  PAYOUT_COALESCE_MS: 150,
  usePayoutFreshness: () => ({ lastSuccessAt: null, refreshing: false, failures: 0, online: true, stream: state.stream }),
}));
vi.mock("@/lib/perf/use-periodic-task", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/perf/use-periodic-task")>(),
  usePeriodicTask: (id: string, _intervalMs: number, run: () => void, options: { enabled?: boolean } = {}) => {
    if (options.enabled === false) state.tasks.delete(id);
    else state.tasks.set(id, run);
  },
}));
vi.mock("@/lib/services/api-client", () => ({ apiJson: state.apiJson }));

import { PayoutActivityCard } from "@/components/consent/payouts/activity-card";
import { rowDate } from "@/components/consent/payouts/receipts/activity-copy";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";
import { dispatchPayoutStateChanged } from "@/lib/payouts/payout-events";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const day = (n: number) => new Date(Date.UTC(2026, 8, n, 12)).toISOString();
const line = (n: number, prefix = "") => `${prefix}Request ${n} · ${rowDate(day(n))}`;
const earning = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `earning:${uuid(n)}`, kind: "earning", type: "earning", status: "credited", reversalStatus: null, review: null,
  occurredAt: day(n), updatedAt: day(n), coinsDelta: 100 + n, amountCents: 100 + n, balanceAfterCoins: 1000 + n,
  request: { id: uuid(n), label: `Request ${n}` }, test: false, expectedArrivalAt: null, bank: null, ...extra,
});
const deposit = (n: number, test = false) => ({
  id: `deposit:po_${n}Abc`, kind: "deposit", type: "bank_deposit", status: "in_transit", reversalStatus: null, review: null,
  occurredAt: day(n), updatedAt: day(n), coinsDelta: null, amountCents: 1550, balanceAfterCoins: null, request: null,
  test, expectedArrivalAt: day(n + 2), bank: { name: "Example Bank", last4: "6789" },
});
// A fake server page: it honours `limit` like the real one.
const page = (query: URLSearchParams, items: unknown[], nextCursor: string | null = null) => ({
  schemaVersion: 1, mode: query.get("mode"), kind: query.get("kind"), asOf: day(28), currency: "USD",
  coinsPerDollar: 100, balanceCoins: 1200, items: query.get("since") ? items : items.slice(0, Number(query.get("limit"))),
  nextCursor: !query.get("since") && items.length > Number(query.get("limit")) ? nextCursor ?? "more" : nextCursor, reset: false,
});
const earningReceipt = (n: number, status = "credited") => ({
  id: `earning:${uuid(n)}`, kind: "earning", status, coins: 100 + n, reference: "HC-0000000A",
  request: { id: uuid(n), label: `Request ${n}`, confirmedFiles: 1, expectedFiles: 1 },
  breakdown: { grossCents: 200, refundCents: 0, platformFeeCents: 6, processingFeeCents: 94 - n, netCents: 100 + n },
  stages: [{ stage: "paid", at: day(n) }, { stage: "credited", at: day(n) }], cashOut: null, review: null,
});
const range = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, index) => from - index);
const listCalls = () => state.list.mock.calls.map(([query]) => (query as URLSearchParams).toString());
const receiptNumber = (itemId: string) => Number(itemId.slice("earning:".length, "earning:".length + 8));
const reads = (limit: number) => listCalls().filter((query) => query === `kind=all&mode=live&limit=${limit}`).length;
const settle = (ms = 300) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
// The clock moves on without touching timers: "Updated 3m ago" and the poll gap read Date.now().
const realNow = Date.now.bind(Date);
let skew = 0;

describe("payout activity card", () => {
  beforeEach(() => {
    state.token = "owner-token";
    state.epoch = 1;
    state.stream = "live";
    state.tasks.clear();
    skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    state.list.mockReset();
    state.item.mockReset();
    state.apiJson.mockReset().mockImplementation(async (path: string) => {
      const url = new URL(path, "http://localhost");
      if (url.pathname === "/api/one/payouts/activity") return state.list(url.searchParams);
      return state.item(decodeURIComponent(url.pathname.slice("/api/one/payouts/activity/".length)));
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("shows the newest real activity and switches by filter, with test activity only on request", async () => {
    state.list.mockImplementation((query: URLSearchParams) => {
      if (query.get("kind") === "deposit") return page(query, [deposit(4, query.get("mode") === "test")]);
      return page(query, range(9, 4).map((n) => earning(n)), "c1");
    });
    render(<PayoutActivityCard />);
    const card = await screen.findByRole("region", { name: "Payout activity" });
    expect(await within(card).findByText(line(9))).toBeVisible();
    expect(within(card).getAllByRole("button", { name: /^Earned\s*Request/ })).toHaveLength(5);
    expect(within(card).getByText("+$1.09")).toBeVisible();
    expect(within(card).getByRole("button", { name: "View all" })).toBeVisible();
    expect(listCalls()).toEqual(["kind=all&mode=live&limit=5"]);

    fireEvent.keyDown(within(card).getByRole("button", { name: "Show: All" }), { key: "ArrowDown" });
    // Real or test is a choice of one, never an "also show"; every row meets the 44 px target.
    expect(await screen.findByRole("menuitemradio", { name: "Real activity" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Test activity" })).toHaveAttribute("aria-checked", "false");
    for (const item of screen.getAllByRole("menuitemradio")) expect(item).toHaveClass("min-h-11");
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Deposits" }));
    expect(await within(card).findByText(`Example Bank •••• 6789 · ${rowDate(day(4))}`)).toBeVisible();
    expect(within(card).getByRole("button", { name: /^On the way/ })).toHaveTextContent("$15.50");
    expect(within(card).queryByText(line(9))).toBeNull();
    expect(card).not.toHaveTextContent("po_");
    expect(listCalls()).toContain("kind=deposit&mode=live&limit=5");

    fireEvent.keyDown(within(card).getByRole("button", { name: "Show: Deposits" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Test activity" }));
    expect(await within(card).findByText(`Test · Example Bank •••• 6789 · ${rowDate(day(4))}`)).toBeVisible();
    expect(within(card).getByRole("button", { name: "Show: Deposits · Test" })).toBeVisible();
    expect(listCalls()).toContain("kind=deposit&mode=test&limit=5");
  });

  it("keeps older pages, an in-flight More and an open receipt through live refreshes", async () => {
    let finishMore!: () => void;
    let head = range(28, 9).map((n) => earning(n));
    state.list.mockImplementation((query: URLSearchParams) => {
      if (query.get("limit") === "5") return page(query, head.slice(0, 5), "card");
      if (query.get("since")) return page(query, [earning(3, { status: "held", updatedAt: day(29) })]);
      if (query.get("cursor") === "p2") {
        return new Promise((resolve) => { finishMore = () => resolve(page(query, range(8, 1).map((n) => earning(n)))); });
      }
      return page(query, head, "p2");
    });
    state.item.mockImplementation((itemId: string) => earningReceipt(receiptNumber(itemId)));
    render(<PayoutActivityCard />);
    fireEvent.click(await screen.findByRole("button", { name: "View all" }));
    const sheet = await screen.findByRole("dialog", { name: "Activity" });
    expect(await within(sheet).findByText(line(9))).toBeVisible();

    fireEvent.click(within(sheet).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(listCalls()).toContain("kind=all&mode=live&limit=20&cursor=p2"));
    // New activity lands while the older page is still loading; the chain is unbroken.
    head = [earning(29), ...head.slice(0, 19)];
    act(() => dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }));
    expect(await within(sheet).findByText(line(29))).toBeVisible();
    await act(async () => { finishMore(); });
    expect(await within(sheet).findByText(line(3))).toBeVisible();
    expect(within(sheet).getByText(line(9))).toBeVisible();

    fireEvent.click(within(sheet).getByRole("button", { name: /^Earned\s*Request 3 ·/ }));
    const receipt = await screen.findByRole("dialog", { name: "$1.03" });
    expect(within(receipt).getByText("Your earnings")).toBeVisible();
    expect(state.item).toHaveBeenCalledTimes(1);

    state.item.mockImplementation((itemId: string) => earningReceipt(receiptNumber(itemId), "held"));
    act(() => dispatchPayoutStateChanged({ kinds: ["earnings"], source: "sse" }));
    await waitFor(() => expect(state.item).toHaveBeenCalledTimes(2));
    // The receipt stays open with the new state, and an older row updates in place.
    expect(await within(screen.getByRole("dialog", { name: "$1.03" })).findByText("Under review")).toBeVisible();
    // Activity reads after the store's coalescing window; the receipt reads at once.
    await waitFor(() => expect(listCalls().filter((query) => query.includes("since="))).toHaveLength(1));
    await waitFor(() => expect(within(sheet).getByText(line(3)).closest("button")).toHaveTextContent(/^Under review/));
    expect(within(sheet).getByText(line(1))).toBeInTheDocument();
    expect(within(sheet).getByText(line(29))).toBeInTheDocument();
  });

  it("closes the receipt, then View all, on Back without leaving Payouts, and returns focus to the row", async () => {
    state.list.mockImplementation((query: URLSearchParams) => page(query, range(9, 4).map((n) => earning(n))));
    state.item.mockImplementation((itemId: string) => earningReceipt(receiptNumber(itemId)));
    const navigate = vi.fn();
    render(<PayoutActivityCard />);
    const viewAll = await screen.findByRole("button", { name: "View all" });
    fireEvent.click(viewAll);
    const sheet = await screen.findByRole("dialog", { name: "Activity" });
    const row = await within(sheet).findByRole("button", { name: /^Earned\s*Request 6 ·/ });
    fireEvent.click(row);
    expect(await screen.findByRole("dialog", { name: "$1.06" })).toBeVisible();

    act(() => { navigateTopShellBack({ pathname: "/one/profile/payouts", navigate }); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "$1.06" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Activity" })).toBeVisible();
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(navigate).not.toHaveBeenCalled();

    act(() => { navigateTopShellBack({ pathname: "/one/profile/payouts", navigate }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(viewAll));
    expect(navigate).not.toHaveBeenCalled();

    act(() => { navigateTopShellBack({ pathname: "/one/profile/payouts", navigate }); });
    expect(navigate).toHaveBeenCalledWith({ href: "/one/profile", mode: "push", transitionMode: "full" });
  });

  it("hands a receipt's next step to Payouts after closing the receipt, and View all over it", async () => {
    const review = { reason: "transfer_check", nextStep: "update_bank" };
    state.list.mockImplementation((query: URLSearchParams) => page(query, range(9, 4).map((n) => earning(n))));
    state.item.mockImplementation((itemId: string) => ({ ...earningReceipt(receiptNumber(itemId), "held"), review }));
    const onAction = vi.fn();
    render(<PayoutActivityCard onAction={onAction} />);
    const card = await screen.findByRole("region", { name: "Payout activity" });
    fireEvent.click(await within(card).findByRole("button", { name: /^Earned\s*Request 9 ·/ }));
    const receipt = await screen.findByRole("dialog", { name: "$1.09" });
    fireEvent.click(await within(receipt).findByRole("button", { name: "Update your bank" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("manage_bank");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(card).getByRole("button", { name: "View all" }));
    const sheet = await screen.findByRole("dialog", { name: "Activity" });
    state.item.mockImplementation((itemId: string) => ({ ...earningReceipt(receiptNumber(itemId), "held"),
      review: { ...review, nextStep: "verify_details" } }));
    fireEvent.click(await within(sheet).findByRole("button", { name: /^Earned\s*Request 6 ·/ }));
    const viewAllReceipt = await screen.findByRole("dialog", { name: "$1.06" });
    fireEvent.click(await within(viewAllReceipt).findByRole("button", { name: "Verify details" }));
    expect(onAction).toHaveBeenLastCalledWith("verify");
    expect(onAction).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers no receipt action without onAction", async () => {
    state.list.mockImplementation((query: URLSearchParams) => page(query, [earning(9)]));
    state.item.mockImplementation((itemId: string) => ({ ...earningReceipt(receiptNumber(itemId), "held"),
      review: { reason: "transfer_check", nextStep: "update_bank" } }));
    render(<PayoutActivityCard />);
    fireEvent.click(await screen.findByRole("button", { name: /^Earned\s*Request 9 ·/ }));
    const receipt = await screen.findByRole("dialog", { name: "$1.09" });
    expect(await within(receipt).findByText("Update your bank")).toBeVisible();
    expect(within(receipt).queryByRole("button", { name: /Update your bank|Next step/ })).toBeNull();
  });

  it("offers Retry when the first read fails and closes its sheets for another vault owner", async () => {
    state.list.mockRejectedValueOnce(new Error("offline"))
      .mockImplementation((query: URLSearchParams) => page(query, [earning(5)]));
    const view = render(<PayoutActivityCard />);
    fireEvent.click(await screen.findByRole("button", { name: /Couldn't load activity/ }));
    fireEvent.click(await screen.findByRole("button", { name: "View all" }));
    expect(await screen.findByRole("dialog", { name: "Activity" })).toBeVisible();

    state.token = "another-owner";
    state.list.mockImplementation((query: URLSearchParams) => page(query, []));
    view.rerender(<PayoutActivityCard />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("No activity yet")).toBeVisible();
    expect(screen.queryByText(line(5))).toBeNull();
  });

  it("keeps rows after a failed refresh, says how old they are, and retries in the card and View all", async () => {
    state.list.mockImplementation((query: URLSearchParams) => page(query, range(9, 4).map((n) => earning(n))));
    render(<PayoutActivityCard />);
    const card = await screen.findByRole("region", { name: "Payout activity" });
    expect(await within(card).findByText(line(9))).toBeVisible();
    expect(card).not.toHaveTextContent("Couldn't update");

    skew = 3 * 60_000;
    state.list.mockRejectedValue(new Error("offline"));
    act(() => dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }));
    const notice = await within(card).findByRole("button", { name: /^Couldn't update/ });
    expect(notice).toHaveTextContent("Updated 3m ago");
    expect(notice).toHaveTextContent("Retry");
    expect(within(card).getByText(line(9))).toBeVisible();
    expect(card).not.toHaveTextContent("Couldn't load activity");

    state.list.mockImplementation((query: URLSearchParams) => page(query, range(9, 4).map((n) => earning(n))));
    fireEvent.click(notice);
    await waitFor(() => expect(within(card).queryByText("Couldn't update")).toBeNull());
    expect(reads(5)).toBe(3);

    fireEvent.click(within(card).getByRole("button", { name: "View all" }));
    const sheet = await screen.findByRole("dialog", { name: "Activity" });
    expect(await within(sheet).findByText(line(9))).toBeVisible();
    state.list.mockRejectedValue(new Error("offline"));
    act(() => dispatchPayoutStateChanged({ kinds: ["earnings"], source: "sse" }));
    expect(await within(sheet).findByRole("button", { name: /^Couldn't update/ })).toHaveTextContent("Updated just now");
    expect(within(sheet).getByText(line(9))).toBeVisible();
  });

  it("reads once per burst of payout frames, and rests the card while View all is open", async () => {
    state.list.mockImplementation((query: URLSearchParams) => page(query, range(9, 4).map((n) => earning(n))));
    render(<PayoutActivityCard />);
    const card = await screen.findByRole("region", { name: "Payout activity" });
    expect(await within(card).findByText(line(9))).toBeVisible();
    expect(reads(5)).toBe(1);

    act(() => {
      dispatchPayoutStateChanged({ kinds: ["wallet"], source: "local_redeem" });
      dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" });
      dispatchPayoutStateChanged({ kinds: ["wallet", "earnings"], source: "sse" });
    });
    await settle();
    expect(reads(5)).toBe(2);
    // A deposit-only account change is not activity.
    act(() => dispatchPayoutStateChanged({ kinds: ["account"], source: "sse" }));
    await settle();
    expect(reads(5)).toBe(2);

    fireEvent.click(within(card).getByRole("button", { name: "View all" }));
    const sheet = await screen.findByRole("dialog", { name: "Activity" });
    expect(await within(sheet).findByText(line(9))).toBeVisible();
    act(() => dispatchPayoutStateChanged({ kinds: ["wallet"], source: "sse" }));
    await settle();
    expect(reads(20)).toBe(2);
    expect(reads(5)).toBe(2);

    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(reads(5)).toBe(3));
  });

  it("skips a fallback read when one just started, as on a return to the page", async () => {
    state.stream = "polling";
    state.list.mockImplementation((query: URLSearchParams) => page(query, range(9, 4).map((n) => earning(n))));
    render(<PayoutActivityCard />);
    expect(await screen.findByText(line(9))).toBeVisible();
    const poll = [...state.tasks].find(([id]) => id.startsWith("payout-activity:"))?.[1];
    expect(poll).toBeDefined();

    skew = 60_000;
    // visibilitychange and focus can both run the same due task.
    act(() => { poll!(); poll!(); });
    await settle();
    expect(reads(5)).toBe(2);

    skew = 120_000;
    act(() => { poll!(); });
    await settle();
    expect(reads(5)).toBe(3);
  });
});
