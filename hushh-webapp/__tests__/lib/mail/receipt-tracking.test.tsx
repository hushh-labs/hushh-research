import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReceiptTrackingProvider } from "@/components/gmail/receipts/receipt-tracking-context";
import { RecurringView } from "@/components/gmail/receipts/recurring-view";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { findCancellationProof } from "@/lib/mail/receipt-insights";
import { evaluatePriceRise, exceedsRise, priceRiseSentence, risePercent } from "@/lib/mail/receipt-price-rise";
import { riseFacts } from "@/lib/mail/receipt-tracking-present";
import {
  confirmCancellation, confirmedSavings, emptyTrackingDoc, loadTracking, nextDateFor, pendingCancellations, saveTracking,
  savePlanReview, skipOccurrence, stopTracking, trackBill, trackBills, validateTrackingDoc, type Ctx, type NewBill,
} from "@/lib/mail/receipt-tracking";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";

const KEY = "12".repeat(32);
const ctx = (at = "2026-12-10T09:00:00Z"): Ctx => { let n = 0; return { now: new Date(at), id: () => `id${++n}` }; };
const session = { userId: "owner", vaultKey: KEY, vaultOwnerToken: "token" };
const BILL: NewBill = { patternKey: "pattern:rent|INR", source: "detected", name: "Maple Homes", icon: "rent", kind: "fixed", currency: "INR", frequency: "monthly",
  agreedMinor: 2400000, anchorDay: 1, nextOn: "2027-01-01", reason: "Four receipts show ₹24,000 paid on the 1st.", evidence: [], history: [] };

beforeEach(() => {
  publishValidatedAuthSessionOwner("owner");
  Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true });
});
afterEach(cleanup);

const point = (month: number, minor: number) => ({ at: new Date(2026, month - 1, 26), minor, receiptKey: `k${month}`, label: "Electricity" });

describe("price-rise rule", () => {
  const NOW = new Date(2026, 11, 10);
  it("holds only strictly above 20% of the middle of the last three paid bills", () => {
    const history = [point(7, 142000), point(8, 147000), point(9, 178000)];
    expect(exceedsRise(176400, 147000)).toBe(false); // exactly +20%
    expect(exceedsRise(176401, 147000)).toBe(true);
    const flagged = evaluatePriceRise([...history, point(11, 195000)], "INR", NOW);
    expect([flagged?.baselineMinor, flagged?.percent, flagged?.basis]).toEqual([147000, "32.7", "median_last_three"]);
    expect(flagged?.evidence.map((item) => item.ref)).toEqual(["k11", "k9", "k8", "k7"]);
    expect(evaluatePriceRise([...history, point(11, 176400)], "INR", NOW)).toBeNull();
    expect(risePercent(176400, 147000)).toBe("20.0");
  });
  it("calls a bill that never changed the usual amount, never an agreed price, and invents no baseline from short history", () => {
    const same = [point(6, 79900), point(7, 79900), point(8, 79900)];
    expect(evaluatePriceRise([...same, point(9, 95880)], "INR", new Date(2026, 8, 30))).toBeNull();
    const rise = evaluatePriceRise([...same, point(9, 95881)], "INR", new Date(2026, 8, 30));
    expect(rise?.basis).toBe("median_last_three");
    expect(rise && priceRiseSentence("Wi-Fi", rise)).toBe("Wi-Fi is ₹958.81, up 20.0% from your usual ₹799.");
    expect(evaluatePriceRise([point(7, 100), point(8, 100), point(9, 500)], "INR", new Date(2026, 8, 30))).toBeNull();
    expect(evaluatePriceRise([...same, point(9, 500000)], "INR", new Date(2027, 5, 1))).toBeNull(); // too old to be news
  });
  it("treats three rent receipts of ₹4,000 then ₹5,000 as 25% above the usual rent, and ₹4,800 as exactly 20%", () => {
    const rent = [point(6, 400000), point(7, 400000), point(8, 400000)];
    const flagged = evaluatePriceRise([...rent, point(9, 500000)], "INR", new Date(2026, 8, 30));
    expect([flagged?.baselineMinor, flagged?.percent, flagged?.basis]).toEqual([400000, "25.0", "median_last_three"]);
    expect(flagged && priceRiseSentence("Rent", flagged)).toBe("Rent is ₹5,000, up 25.0% from your usual ₹4,000.");
    expect(flagged && riseFacts(flagged).map((fact) => fact.label)).toContain("Usual (middle of the last 3 paid)");
    expect(flagged && riseFacts(flagged).map((fact) => fact.label).join()).not.toMatch(/agreed/i);
    expect(evaluatePriceRise([...rent, point(9, 480000)], "INR", new Date(2026, 8, 30))).toBeNull(); // exactly +20%
    expect(evaluatePriceRise([...rent, point(9, 480001)], "INR", new Date(2026, 8, 30))?.percent).toBe("20.0");
  });
});

describe("provider confirmation", () => {
  const item = (merchant_name: string, transaction_date: string, over: Partial<ReceiptListItem> = {}) => ({
    id: Math.floor(Math.random() * 1e6), gmail_message_id: `m-${merchant_name}-${transaction_date}`, source_id: `s-${merchant_name}-${transaction_date}`, merchant_name,
    merchant_domain: "x.example", status: "cancelled", event_type: "cancellation", currency: "INR", amount: 299, transaction_date, ...over,
  }) as ReceiptListItem;
  it("accepts only the provider's cancellation receipt dated on or after the choice, never a purchase or an older one", () => {
    const rows = buildRecentReceiptRows([
      item("Alpha TV", "2026-11-20"), // cancelled before the owner chose
      item("Alpha TV", "2026-12-12", { status: "paid", event_type: "purchase" }), // a charge is not a confirmation
      item("Beta", "2026-12-12"), // another plan
    ], "acct");
    expect(findCancellationProof(rows, "alpha tv|INR", "2026-12-10T09:00:00.000Z")).toBeNull();
    const confirmed = buildRecentReceiptRows([item("Alpha TV", "2026-12-10")], "acct");
    expect(findCancellationProof(confirmed, "alpha tv|INR", "2026-12-10T09:00:00.000Z")?.merchantName).toBe("Alpha TV");
  });
});

describe("tracking choices", () => {
  it("tracks once, moves a date, skips one occurrence, stops and resumes, recording each choice", () => {
    let doc = trackBill(emptyTrackingDoc("b"), BILL, ctx());
    expect(trackBill(doc, BILL, ctx())).toBe(doc);
    const id = doc.bills[0]!.id;
    doc = skipOccurrence(doc, id, "2027-01-01", ctx());
    expect(nextDateFor(doc.bills[0]!, "2027-01-01", new Date(2026, 11, 10)).on).toBe("2027-02-01");
    expect(skipOccurrence(doc, id, "2027-01-01", ctx())).toBe(doc);
    doc = stopTracking(doc, id, ctx());
    expect(doc.bills[0]!.status).toBe("stopped");
    expect(trackBill(doc, BILL, ctx()).bills[0]!.status).toBe("tracking");
    expect(doc.events.map((event) => event.kind)).toEqual(["tracking_stopped", "occurrence_skipped", "bill_added"]);
  });
  it("keeps a cancellation pending, and counts savings only after the provider's receipt confirms it", () => {
    const plans = [{ key: "alpha|INR", label: "Alpha TV", monthlyMinor: 29900, currency: "INR" }, { key: "beta|INR", label: "Beta", monthlyMinor: 49900, currency: "INR" }];
    let doc = savePlanReview(emptyTrackingDoc("b"), { insightId: "ins", reason: "overlap", plans, choices: { "alpha|INR": "cancel", "beta|INR": "keep" } }, ctx());
    expect(pendingCancellations(doc).map((item) => item.plan.key)).toEqual(["alpha|INR"]);
    expect(confirmedSavings(doc)).toEqual({});
    expect(confirmCancellation(doc, "ins", "beta|INR", "r", ctx())).toBe(doc); // kept, not cancelled
    doc = confirmCancellation(doc, "ins", "alpha|INR", "receipt-key", ctx());
    expect(confirmedSavings(doc)).toEqual({ INR: 29900 });
    expect(pendingCancellations(doc)).toEqual([]);
  });
  it("refuses data it does not recognise instead of trusting it", () => {
    expect(() => validateTrackingDoc({ ...emptyTrackingDoc("b"), bills: [{ id: 1 }] })).toThrow();
    expect(() => validateTrackingDoc({ ...emptyTrackingDoc("b"), schema: "other" })).toThrow();
    expect(validateTrackingDoc(emptyTrackingDoc("b")).bills).toEqual([]);
  });
});

describe("saved on this device, per owner and mailbox", () => {
  it("survives a reload and never shows another mailbox's or owner's choices", async () => {
    const first = await loadTracking(session, "mailbox-a");
    const doc = trackBill(first.doc, BILL, ctx());
    await saveTracking(session, "mailbox-a", doc, first.version);
    expect((await loadTracking(session, "mailbox-a")).doc.bills.map((bill) => bill.name)).toEqual(["Maple Homes"]);
    expect((await loadTracking(session, "mailbox-b")).doc.bills).toEqual([]);
    publishValidatedAuthSessionOwner("someone-else");
    expect((await loadTracking({ ...session, userId: "someone-else" }, "mailbox-a")).doc.bills).toEqual([]);
  });
  it("refuses a stale write, so two tabs cannot silently overwrite each other", async () => {
    const first = await loadTracking(session, "mailbox-a");
    await saveTracking(session, "mailbox-a", trackBill(first.doc, BILL, ctx()), first.version);
    await expect(saveTracking(session, "mailbox-a", first.doc, first.version)).rejects.toMatchObject({ code: "stale_version" });
  });
});

describe("Recurring screen with no payment service", () => {
  const rent = ["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"].map((date, index): ReceiptListItem => ({
    id: index + 1, gmail_message_id: `m${index}`, source_id: `s${index}`, receipt_key: `s${index}`, merchant_name: "Maple Homes", merchant_domain: "maple.example",
    status: "paid", currency: "INR", amount: 24000, transaction_date: date, category: "Bills", category_confidence: 0.95, recurrence: "unknown",
  }) as ReceiptListItem);
  const rows = buildRecentReceiptRows(rent, "acct");
  const mount = (account = "acct") => render(
    <ReceiptTrackingProvider userId="owner" vaultKey={KEY} vaultOwnerToken="token" accountKey={account} enabled>
      <RecurringView rows={rows} onOpenReceipt={() => undefined} />
    </ReceiptTrackingProvider>,
  );

  it("opens with no network call, tracks a detected bill, and still has it after a reload", async () => {
    const network = vi.fn(async () => { throw new Error("no network in this test"); });
    vi.stubGlobal("fetch", network);
    mount();
    const row = await screen.findByTestId("bill-row");
    expect(row).toHaveAttribute("data-bill-status", "suggested");
    expect(row).toHaveTextContent("Maple Homes");
    // Tracking copy only: nothing here pays a bill, and no step of a payment flow is numbered.
    expect(screen.getByText(/One tracks the bills you pick/)).toHaveTextContent("It doesn’t pay bills.");
    expect(screen.queryByText(/Step \d of/)).toBeNull();
    const choose = within(row).getByRole("checkbox", { name: "Select Maple Homes" });
    await waitFor(() => expect(choose).toBeEnabled());
    fireEvent.click(choose);
    expect(screen.getByText("1 bill selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Track selected bills" }));
    await waitFor(() => expect(screen.getByTestId("bill-row")).toHaveAttribute("data-bill-status", "tracking"));
    expect(screen.queryByTestId("bill-selection-bar")).toBeNull();
    cleanup();
    mount();
    await waitFor(() => expect(screen.getByTestId("bill-row")).toHaveAttribute("data-bill-status", "tracking"));
    expect(screen.getByTestId("bill-row")).toHaveTextContent("Maple Homes");
    expect(network).not.toHaveBeenCalled();
    cleanup();
    mount("another-mailbox");
    expect(await screen.findByTestId("bill-row")).toHaveAttribute("data-bill-status", "suggested");
    vi.unstubAllGlobals();
  });

  it("skips one occurrence and stops tracking, and History records both", async () => {
    mount();
    const choose = within(await screen.findByTestId("bill-row")).getByRole("checkbox", { name: "Select Maple Homes" });
    await waitFor(() => expect(choose).toBeEnabled());
    fireEvent.click(choose);
    fireEvent.click(screen.getByRole("button", { name: "Track selected bills" }));
    await waitFor(() => expect(screen.getByTestId("bill-row")).toHaveAttribute("data-bill-status", "tracking"));
    const before = screen.getByTestId("bill-row").textContent;
    fireEvent.keyDown(screen.getByTestId("bill-menu"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip this one" }));
    await waitFor(() => expect(screen.getByTestId("recurring-notice")).toHaveTextContent(/Skipped Maple Homes/));
    expect(screen.getByTestId("bill-row").textContent).not.toBe(before);
    fireEvent.keyDown(screen.getByTestId("bill-menu"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop tracking" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop tracking" }));
    await waitFor(() => expect(screen.getByText(/Stopped \(1\)/)).toBeVisible());
    const { doc } = await loadTracking(session, "acct");
    expect(doc.events.map((event) => event.kind)).toEqual(["tracking_stopped", "occurrence_skipped", "bill_added"]);
  });

  it("still lists the bills found in the receipts when saved choices cannot be opened, and offers Try again", async () => {
    Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });
    mount();
    expect(await screen.findByTestId("tracking-error")).toHaveTextContent(/tracked bills/);
    expect(screen.getByTestId("bill-row")).toHaveTextContent("Maple Homes");
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Select Maple Homes" })).toBeDisabled();
  });
});

describe("Tracking several bills at once", () => {
  const bill = (key: string): NewBill => ({ ...BILL, patternKey: key, name: key });
  it("saves all of them or none, and never changes the document it was given", () => {
    const doc = emptyTrackingDoc("acct");
    const next = trackBills(doc, [bill("a"), bill("b")], ctx());
    expect(next.bills.map((item) => item.patternKey)).toEqual(["a", "b"]);
    expect(doc.bills).toEqual([]);
    const crowded = trackBills(doc, Array.from({ length: 60 }, (_, index) => bill(`k${index}`)), ctx());
    expect(() => trackBills(crowded, [bill("one-more")], ctx())).toThrow();
    expect(crowded.bills).toHaveLength(60);
  });
});
