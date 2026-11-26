import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GmailRecentReceipts } from "@/components/gmail/gmail-recent-receipts";
import { MailBriefPanel } from "@/components/gmail/mail-brief-panel";
import { ReceiptNoticeProvider } from "@/components/gmail/receipts/receipt-notice-context";
import { ReceiptTrackingProvider } from "@/components/gmail/receipts/receipt-tracking-context";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  NOTICE_LIMITS, noticeCheckDue, parseNoticeResponse, providerCancellationFor, selectNoticeInput,
} from "@/lib/mail/receipt-notice";
import {
  type Ctx, applyNoticeCheck, emptyTrackingDoc, loadTracking, recordInsightReviewed, saveTracking, validateTrackingDoc,
} from "@/lib/mail/receipt-tracking";
import * as receiptTracking from "@/lib/mail/receipt-tracking";
import { buildRecentReceiptRows } from "@/lib/profile/gmail-receipt-presentation";
import { GmailReceiptsService, type ReceiptListItem } from "@/lib/services/gmail-receipts-service";

// MODEL STAND-IN: the mailbox check below is scripted. These tests prove what the device does with any
// answer: parse it strictly, keep it per mailbox, show the evidence, remember choices, and fail honestly.

const KEY = "12".repeat(32);
const session = { userId: "owner", vaultKey: KEY, vaultOwnerToken: "token" };
const ctx = (at = new Date().toISOString()): Ctx => { let n = 0; return { now: new Date(at), id: () => `id${++n}` }; };
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const sealed = (seed: string) => `grs1_${seed.padEnd(44, "x")}`;

const item = (id: number, merchant: string, daysBack: number, over: Partial<ReceiptListItem> = {}): ReceiptListItem => ({
  id, gmail_message_id: `m${id}`, source_id: sealed(`s${id}`), receipt_key: sealed(`s${id}`), merchant_name: merchant, merchant_domain: `${merchant.toLowerCase()}.example`,
  status: "paid", currency: "INR", amount: 499, receipt_date: daysAgo(daysBack), transaction_date: daysAgo(daysBack).slice(0, 10), category: "Subscription", category_confidence: 0.95, recurrence: "recurring", ...over,
}) as ReceiptListItem;

const netflix = [item(1, "Netflix", 25), item(2, "Netflix", 55), item(3, "Netflix", 85)];
const rowsOf = (items: ReceiptListItem[]) => buildRecentReceiptRows(items, "acct");

const finding = (over: Record<string, unknown> = {}) => ({
  id: "nf_inactive_aaaa", kind: "inactive_plan", headline: "Still using this ₹499 plan?",
  reason: "Netflix says this account hasn't watched anything in 60 days.", strength: "clear",
  provider: { name: "Netflix", domain: "netflix.com" }, action: { id: "review_plan", label: "Review plan" },
  evidence: [
    { evidence_id: "ev_paid_000001", open_key: sealed("paid"), role: "paid", quote: "Total ₹499.00 paid", on: "2026-11-02", subject: "Your payment receipt", from: "Netflix", domain: "netflix.com" },
    { evidence_id: "ev_note_000001", open_key: sealed("note"), role: "provider_notice", quote: "you haven't watched anything on this account in 60 days", on: "2026-11-10", subject: "We haven't seen you", from: "Netflix", domain: "netflix.com" },
  ],
  plans: [], facts: { amount_minor: 49900, currency: "INR", last_paid_on: "2026-11-02", notice_on: "2026-11-10", stated: "60 days", period: "monthly" },
  attribution: { by: "Netflix", on: "2026-11-10", statement: "you haven't watched anything on this account in 60 days", evidence_id: "ev_note_000001" },
  score: 85, generated_at: new Date().toISOString(), ...over,
});
const answer = (findings: unknown[], over: Record<string, unknown> = {}) => ({
  account_key: "acct", generated_at: new Date().toISOString(), model: "gemini-4-hydrogen", coverage: { providers: 1, messages: 5 },
  findings, resolved: [], cancellations: [], none_reason: "", ...over,
});

beforeEach(() => {
  publishValidatedAuthSessionOwner("owner");
  Object.defineProperty(window, "indexedDB", { value: new IDBFactory(), configurable: true });
  window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the server's answer is parsed strictly, for one mailbox", () => {
  it("accepts a well-formed answer and refuses another mailbox's, unknown kinds, links and oversize text", () => {
    expect(parseNoticeResponse(answer([finding()]), "acct").findings[0]?.attribution?.by).toBe("Netflix");
    expect(() => parseNoticeResponse(answer([finding()]), "another-mailbox")).toThrow();
    expect(() => parseNoticeResponse(answer([finding({ kind: "refund_everything" })]), "acct")).toThrow();
    expect(() => parseNoticeResponse(answer([finding({ headline: "Cancel at http://evil.test now" })]), "acct")).toThrow();
    expect(() => parseNoticeResponse(answer([finding({ reason: "x".repeat(201) })]), "acct")).toThrow();
    expect(() => parseNoticeResponse({ ...answer([]), findings: "nope" }, "acct")).toThrow();
    expect(parseNoticeResponse(answer([finding(), finding()]), "acct").findings).toHaveLength(1);
  });
});

describe("which saved receipts are read, and when a check is worth running", () => {
  it("sends a bounded set, favouring bills that repeat, and skips receipts it cannot route", () => {
    const many = Array.from({ length: 14 }, (_, p) => Array.from({ length: 8 }, (_, n) => item(100 + p * 10 + n, `Shop${p}`, 20 + n * 3, { recurrence: p < 3 ? "recurring" : "one_time" }))).flat();
    const unroutable = item(900, "Netflix", 10, { receipt_key: "plain-id", source_id: "plain-id" });
    const { keys } = selectNoticeInput(rowsOf([...many, unroutable]), new Date());
    expect(keys.length).toBeLessThanOrEqual(NOTICE_LIMITS.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("plain-id");
    const recurringFirst = rowsOf(many).filter((row) => keys.includes(row.primaryReceiptKey)).filter((row) => /Shop[012]\b/.test(row.merchantName));
    expect(recurringFirst.length).toBe(15); // three recurring providers, five receipts each
    expect(selectNoticeInput(rowsOf([item(1, "Old", 400)]), new Date()).keys).toEqual([]);
  });

  it("reads a restored receipt through its sealed routing key, and skips one with none", () => {
    // A receipt restored from this device is known by a stable reference; its routing key is kept beside it.
    const restored = rowsOf([item(1, "Netflix", 25, { receipt_key: "evt_ref_1", source_id: "evt_ref_1" }), item(2, "Netflix", 55, { receipt_key: "evt_ref_2", source_id: "evt_ref_2" })]);
    const locators = { evt_ref_1: sealed("routing1") };
    const { keys, digest } = selectNoticeInput(restored, new Date(), locators);
    expect(keys).toEqual([sealed("routing1")]);
    expect(selectNoticeInput(restored, new Date(), {}).keys).toEqual([]);
    // A receipt that becomes readable changes the digest, so the check runs again.
    expect(selectNoticeInput(restored, new Date(), { ...locators, evt_ref_2: sealed("routing2") }).digest).not.toBe(digest);
  });

  it("changes its digest when a receipt arrives and asks again only then, or after a day, or after a failure window", () => {
    const first = selectNoticeInput(rowsOf(netflix), new Date());
    expect(selectNoticeInput(rowsOf(netflix), new Date()).digest).toBe(first.digest);
    const next = selectNoticeInput(rowsOf([item(4, "Netflix", 1), ...netflix]), new Date());
    expect(next.digest).not.toBe(first.digest);
    const checked = applyNoticeCheck(emptyTrackingDoc("b"), parseNoticeResponse(answer([]), "acct"), first.digest, ctx()).notice;
    const now = new Date();
    expect(noticeCheckDue(checked, first.digest, now, null)).toBe(false);
    expect(noticeCheckDue(checked, next.digest, now, null)).toBe(true);
    expect(noticeCheckDue(checked, first.digest, new Date(now.getTime() + 25 * 3600_000), null)).toBe(true);
    expect(noticeCheckDue({ ...checked, digest: "d1_old" }, first.digest, now, now.getTime() - 60_000)).toBe(true); // changed receipts beat a recent failure
    expect(noticeCheckDue({ ...checked, digest: first.digest, checkedAt: null }, first.digest, now, now.getTime() - 60_000)).toBe(false);
  });
});

describe("saved findings follow the evidence", () => {
  it("replaces old findings with the new check, keeps a settled one in a short list, and survives a storage round trip", () => {
    const before = applyNoticeCheck(emptyTrackingDoc("b"), parseNoticeResponse(answer([finding(), finding({ id: "nf_refund_bbbb", kind: "refund_followup" })]), "acct"), "d1_a", ctx());
    expect(before.notice.findings.map((f) => f.id)).toEqual(["nf_inactive_aaaa", "nf_refund_bbbb"]);
    const settledEvidence = { evidence_id: "ev_done_000001", open_key: sealed("done"), role: "refund_confirmation", quote: "We refunded ₹250", on: "2026-11-11", subject: "Refund processed", from: "Swiggy", domain: "swiggy.in" };
    const after = applyNoticeCheck(before, parseNoticeResponse(answer([finding()], { resolved: [{ prior_id: "nf_refund_bbbb", evidence: settledEvidence }, { prior_id: "nf_never_seen", evidence: settledEvidence }] }), "acct"), "d1_b", ctx());
    expect(after.notice.findings.map((f) => f.id)).toEqual(["nf_inactive_aaaa"]);
    expect(after.notice.resolved.map((r) => [r.priorId, r.headline])).toEqual([["nf_refund_bbbb", "Still using this ₹499 plan?"]]);
    expect(validateTrackingDoc(JSON.parse(JSON.stringify(after))).notice.findings).toHaveLength(1);
    const gone = applyNoticeCheck(after, parseNoticeResponse(answer([]), "acct"), "d1_c", ctx());
    expect(gone.notice.findings).toEqual([]);
  });

  it("opens a document saved before this existed, and refuses a finding that was tampered with", () => {
    const old = { ...emptyTrackingDoc("b") } as Record<string, unknown>;
    delete old.notice;
    expect(validateTrackingDoc(old).notice.findings).toEqual([]);
    const doc = applyNoticeCheck(emptyTrackingDoc("b"), parseNoticeResponse(answer([finding()]), "acct"), "d1", ctx());
    const tampered = JSON.parse(JSON.stringify(doc));
    tampered.notice.findings[0].headline = "Click http://evil.test to pay";
    expect(() => validateTrackingDoc(tampered)).toThrow();
  });

  it("confirms a cancellation only from the provider's own email dated after the choice", () => {
    const check = parseNoticeResponse(answer([], { cancellations: [{ domain: "netflix.com", on: "2026-11-12", subject: "Your subscription has ended", evidence_id: "ev_cancel_0001", open_key: sealed("cancel") }] }), "acct");
    const { notice } = applyNoticeCheck(emptyTrackingDoc("b"), check, "d1", ctx());
    expect(providerCancellationFor(notice, "netflix.com", "2026-11-10T09:00:00.000Z")?.evidenceId).toBe("ev_cancel_0001");
    expect(providerCancellationFor(notice, "netflix.com", "2026-11-13T09:00:00.000Z")).toBeNull();
    expect(providerCancellationFor(notice, "hotstar.com", "2026-11-10T09:00:00.000Z")).toBeNull();
  });
});

describe("the card on Receipts", () => {
  const rows = rowsOf(netflix);
  const mount = (account = "acct", list = rows) => render(
    <ReceiptTrackingProvider userId="owner" vaultKey={KEY} vaultOwnerToken="token" accountKey={account} enabled>
      <ReceiptNoticeProvider userId="owner" vaultOwnerToken="token" accountKey={account} getIdToken={async () => "id-token"} rows={list} enabled>
        <GmailRecentReceipts accountKey={account} receipts={[]} savedRows={list} />
      </ReceiptNoticeProvider>
    </ReceiptTrackingProvider>,
  );
  const seed = async (findings: unknown[], list = rows, account = "acct", when = new Date().toISOString()) => {
    const loaded = await loadTracking(session, account);
    const digest = selectNoticeInput(list, new Date()).digest;
    await saveTracking(session, account, applyNoticeCheck(loaded.doc, parseNoticeResponse(answer(findings, { account_key: account }), account), digest, ctx(when)), loaded.version);
  };

  it("shows the saved finding at once and makes no model call when nothing changed", async () => {
    await seed([finding()]);
    const check = vi.spyOn(GmailReceiptsService, "checkReceiptNotice");
    mount();
    const card = await screen.findByTestId("insight-card");
    expect(card).toHaveTextContent("Still using this ₹499 plan?");
    expect(card).toHaveTextContent("Netflix says this account hasn't watched anything in 60 days.");
    expect(within(card).getByRole("button", { name: "Review plan" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "See all" })).toBeVisible();
    expect(within(card).queryByTestId("insight-caption")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(check).not.toHaveBeenCalled();
  });

  it("answers why: tapping the card shows the emails behind it, and View email opens the exact one", async () => {
    await seed([finding()]);
    const open = vi.spyOn(GmailReceiptsService, "openNoticeSource").mockResolvedValue({
      subject: "We haven't seen you", fromName: "Netflix", fromDomain: "mailer.netflix.com", receivedAt: "2026-11-10T08:00:00+00:00",
      excerpt: "Hi there. Hi, you haven't watched anything on this account in 60 days. Come back soon.", truncated: false,
    });
    mount();
    fireEvent.click(await screen.findByTestId("insight-card-body"));
    const review = await screen.findByTestId("insight-review");
    expect(review).toHaveTextContent("Why you’re seeing this");
    const evidence = within(review).getAllByRole("listitem");
    expect(evidence[0]).toHaveTextContent("Payment · Netflix");
    expect(evidence[1]).toHaveTextContent("Their email · Netflix · 10 Nov");
    expect(evidence[1]).toHaveTextContent("“you haven't watched anything on this account in 60 days”");
    fireEvent.click(within(evidence[1]!).getByRole("button", { name: "View email" }));
    const source = await screen.findByTestId("notice-source-excerpt");
    expect(source).toHaveTextContent("Come back soon.");
    expect(within(source).getByTestId("notice-quote-mark")).toHaveTextContent("you haven't watched anything on this account in 60 days");
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ accountKey: "acct", openKey: sealed("note") }));
  });

  it("links the provider's own email from the card, and leaves the decision to the owner", async () => {
    await seed([finding()]);
    const open = vi.spyOn(GmailReceiptsService, "openNoticeSource").mockResolvedValue({
      subject: "We haven't seen you", fromName: "Netflix", fromDomain: "mailer.netflix.com", receivedAt: "2026-11-10T08:00:00+00:00",
      excerpt: "Hi. Hi, you haven't watched anything on this account in 60 days.", truncated: false,
    });
    mount();
    const card = await screen.findByTestId("insight-card");
    fireEvent.click(within(card).getByRole("button", { name: "View email" }));
    expect(await screen.findByTestId("notice-source-excerpt")).toHaveTextContent("you haven't watched anything on this account in 60 days");
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ openKey: sealed("note") }));
    // Nothing was decided by looking: the finding is still there, and so is the primary action.
    expect(screen.getByTestId("insight-card")).toHaveTextContent("Still using this ₹499 plan?");
    expect((await loadTracking(session, "acct")).doc.dismissed).toEqual([]);
  });

  it("keeps a failed email open recoverable and leaves the receipts alone", async () => {
    await seed([finding()]);
    vi.spyOn(GmailReceiptsService, "openNoticeSource").mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ subject: "S", fromName: null, fromDomain: null, receivedAt: null, excerpt: "you haven't watched anything on this account in 60 days", truncated: false });
    mount();
    fireEvent.click(await screen.findByTestId("insight-card-body"));
    fireEvent.click((await screen.findAllByRole("button", { name: "View email" }))[1]!);
    expect(await screen.findByText(/Couldn’t open this email/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("notice-source-excerpt")).toBeVisible();
  });

  it("remembers Keep it for the same evidence, but raises a new finding when new evidence arrives", async () => {
    await seed([finding()]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Review plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByTestId("insight-card")).toBeNull());
    const { doc } = await loadTracking(session, "acct");
    expect(doc.dismissed).toEqual([expect.objectContaining({ id: "nf_inactive_aaaa", choice: "keep" })]);
    cleanup();
    mount();
    await screen.findByText(/Netflix/, undefined, { timeout: 3000 }).catch(() => undefined);
    expect(screen.queryByTestId("insight-card")).toBeNull();
    // The same evidence gives the same id, so a fresh check returning it stays quiet; a new notice has a new id.
    const loaded = await loadTracking(session, "acct");
    const again = applyNoticeCheck(loaded.doc, parseNoticeResponse(answer([finding()]), "acct"), "d1_x", ctx());
    expect(recordInsightReviewed(again, "nf_inactive_aaaa", "x", ctx())).toBe(again);
    await saveTracking(session, "acct", applyNoticeCheck(loaded.doc, parseNoticeResponse(answer([finding({ id: "nf_inactive_bbbb" })]), "acct"), selectNoticeInput(rows, new Date()).digest, ctx()), loaded.version);
    cleanup();
    mount();
    expect(await screen.findByTestId("insight-card")).toHaveTextContent("Still using this ₹499 plan?");
  });

  it("keeps the saved finding and says so when the new check fails, and Try again asks once more", async () => {
    const longAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await seed([finding()], rows, "acct", longAgo);
    const check = vi.spyOn(GmailReceiptsService, "checkReceiptNotice").mockRejectedValueOnce(new Error("One can’t check right now.")).mockResolvedValue(parseNoticeResponse(answer([finding()]), "acct"));
    mount();
    // Before the check runs the card says how old the saved check is; after it fails it says it could not update.
    expect(await screen.findByTestId("insight-caption")).toHaveTextContent(/^Checked /);
    await waitFor(() => expect(screen.getByTestId("insight-caption")).toHaveTextContent(/Couldn’t update\. From /), { timeout: 5000 });
    const caption = screen.getByTestId("insight-caption");
    expect(screen.getByTestId("insight-card")).toHaveTextContent("Still using this ₹499 plan?");
    expect(screen.getByTestId("insight-card")).not.toHaveTextContent("Checking");
    expect(check).toHaveBeenCalledTimes(1);
    fireEvent.click(within(caption).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId("insight-caption")).toBeNull(), { timeout: 3000 });
  });

  it("checks when receipts change, passes only sealed keys and the mailbox, and a contradicting answer removes the finding", async () => {
    await seed([finding()]);
    const check = vi.spyOn(GmailReceiptsService, "checkReceiptNotice").mockResolvedValue(parseNoticeResponse(answer([]), "acct"));
    const changed = rowsOf([item(4, "Netflix", 1), ...netflix]);
    mount("acct", changed);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const sent = check.mock.calls[0]![0];
    expect(sent).toMatchObject({ userId: "owner", accountKey: "acct", idToken: "id-token", vaultOwnerToken: "token" });
    expect(sent.receiptKeys.every((key) => key.startsWith("grs1_"))).toBe(true);
    expect(sent.prior).toEqual([{ id: "nf_inactive_aaaa", kind: "inactive_plan", provider: "Netflix", headline: "Still using this ₹499 plan?" }]);
    await waitFor(() => expect(screen.queryByTestId("insight-card")).toBeNull(), { timeout: 3000 });
  });

  it("never mixes mailboxes: another mailbox shows none of this mailbox's findings", async () => {
    await seed([finding()]);
    mount("another-mailbox");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByTestId("insight-card")).toBeNull();
  });

  it("with no check ever made, labels receipts-only findings as such and never as One's mailbox check", async () => {
    const twice = rowsOf([item(1, "Zomato", 3, { recurrence: "one_time", category: "Food" }), item(2, "Zomato", 2, { recurrence: "one_time", category: "Food" })]);
    vi.spyOn(GmailReceiptsService, "checkReceiptNotice").mockRejectedValue(new Error("One can’t check right now."));
    mount("acct", twice);
    const card = await screen.findByTestId("insight-card");
    expect(card).toHaveTextContent("Possible double charge at Zomato");
    expect(within(card).getByTestId("insight-caption")).toHaveTextContent("From your saved receipts");
    await waitFor(() => expect(within(screen.getByTestId("insight-card")).getByTestId("insight-caption")).toHaveTextContent("Couldn’t check your mailbox. From your saved receipts."), { timeout: 5000 });
  });
});

describe("opened from the Overview", () => {
  const rows = rowsOf(netflix);
  const priceRise = () => finding({
    id: "nf_price_cccc", kind: "price_rise", headline: "Netflix is going up", reason: "Netflix announced a new price for your renewal.",
    action: { id: "review_bill", label: "Review bill" }, score: 40, attribution: null,
    evidence: [
      { evidence_id: "ev_ann_0000001", open_key: sealed("ann"), role: "announcement", quote: "your new price will be ₹1,800", on: "2026-11-10", subject: "Price change", from: "Netflix", domain: "netflix.com" },
      { evidence_id: "ev_paid_000002", open_key: sealed("paid2"), role: "paid", quote: "Total ₹1,200.00 paid", on: "2026-11-02", subject: "Your payment receipt", from: "Netflix", domain: "netflix.com" },
    ],
    facts: { currency: "INR", last_paid_minor: 120000, new_minor: 180000, new_is_announced: true, base_minor: 120000, base_kind: "median_of_last_three", percent: "50.0", effective_on: "2026-11-26" },
  });
  const tree = (request: { id: string; nonce: number } | null) => (
    <ReceiptTrackingProvider userId="owner" vaultKey={KEY} vaultOwnerToken="token" accountKey="acct" enabled>
      <ReceiptNoticeProvider userId="owner" vaultOwnerToken="token" accountKey="acct" getIdToken={async () => "id-token"} rows={rows} enabled>
        <GmailRecentReceipts accountKey="acct" receipts={[]} savedRows={rows} reviewRequest={request} />
      </ReceiptNoticeProvider>
    </ReceiptTrackingProvider>
  );
  const seed = async () => {
    const loaded = await loadTracking(session, "acct");
    const digest = selectNoticeInput(rows, new Date()).digest;
    await saveTracking(session, "acct", applyNoticeCheck(loaded.doc, parseNoticeResponse(answer([finding(), priceRise()], { account_key: "acct" }), "acct"), digest, ctx()), loaded.version);
  };

  it("opens the exact finding it was asked for, not the top card, and only once per request", async () => {
    await seed();
    const view = render(tree(null));
    // Receipts alone leads with its highest-ranked finding.
    expect(await screen.findByTestId("insight-card")).toHaveTextContent("Still using this ₹499 plan?");
    expect(screen.queryByTestId("insight-review")).toBeNull();

    view.rerender(tree({ id: "nf_price_cccc", nonce: 1 }));
    const review = await screen.findByTestId("insight-review");
    // The price finding's own facts and evidence, not the plan finding that leads the list.
    expect(review).toHaveTextContent("New price₹1,800");
    expect(review).toHaveTextContent("“your new price will be ₹1,800”");
    expect(screen.getByRole("dialog")).toHaveTextContent("Netflix is going up");

    // Closing it does not reopen it for the same request; a new request does.
    fireEvent.keyDown(review, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("insight-review")).toBeNull());
    view.rerender(tree({ id: "nf_price_cccc", nonce: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("insight-review")).toBeNull();
    view.rerender(tree({ id: "nf_price_cccc", nonce: 2 }));
    expect(await screen.findByTestId("insight-review")).toHaveTextContent("New price₹1,800");
  });

  it("opens nothing for a finding that is not there", async () => {
    await seed();
    render(tree({ id: "nf_missing_zzzz", nonce: 1 }));
    expect(await screen.findByTestId("insight-card")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("insight-review")).toBeNull();
  });
});

describe("the Overview's price rises", () => {
  const rows = rowsOf(netflix);
  const idle = { status: "idle" as const, data: null, error: null, refreshing: false, fetchedAt: 0 };
  const panel = (onOpenReceipt = vi.fn()) => (
    <ReceiptTrackingProvider userId="owner" vaultKey={KEY} vaultOwnerToken="token" accountKey="acct" enabled>
      <MailBriefPanel
        brief={{ ...idle, status: "ready", fetchedAt: 1, data: { account: "acct", generatedAt: new Date().toISOString(), coverage: { messages: 3, windowDays: 21, mayBePartial: false }, attention: [], updates: [] } }}
        completed={{ ...idle, status: "ready", fetchedAt: 1, data: { account: "acct", items: [] } }}
        ownerInitial="N" draftBusy={null} draftFailure={null}
        onWhy={vi.fn()} onDraft={vi.fn()} onOpenReceipt={onOpenReceipt} onViewSent={vi.fn()}
        onOpenFollowups={vi.fn()} onRetry={vi.fn()} onReconnect={vi.fn()} onUnlock={vi.fn()}
      />
    </ReceiptTrackingProvider>
  );
  const price = (over: Record<string, unknown> = {}) => finding({
    id: "nf_price_cccc", kind: "price_rise", headline: "Netflix is going up", reason: "Netflix announced a new price for your renewal.",
    action: { id: "review_bill", label: "Review bill" }, attribution: null,
    evidence: [{ evidence_id: "ev_ann_0000001", open_key: sealed("ann"), role: "announcement", quote: "your new price will be ₹1,800", on: "2026-11-10", subject: "Price change", from: "Netflix", domain: "netflix.com" },
      { evidence_id: "ev_paid_000002", open_key: sealed("paid2"), role: "paid", quote: "Total ₹1,200.00 paid", on: "2026-11-02", subject: "Your payment receipt", from: "Netflix", domain: "netflix.com" }],
    facts: { currency: "INR", last_paid_minor: 120000, new_minor: 180000, new_is_announced: true, base_minor: 120000, base_kind: "median_of_last_three", percent: "50.0", effective_on: "2026-11-26" },
    ...over,
  });
  const seed = async (findings: unknown[], after?: (doc: ReturnType<typeof emptyTrackingDoc>) => ReturnType<typeof emptyTrackingDoc>) => {
    const loaded = await loadTracking(session, "acct");
    const digest = selectNoticeInput(rows, new Date()).digest;
    let doc = applyNoticeCheck(loaded.doc, parseNoticeResponse(answer(findings, { account_key: "acct" }), "acct"), digest, ctx());
    if (after) doc = after(doc);
    await saveTracking(session, "acct", doc, loaded.version);
  };

  it("shows a saved price rise as one update and opens that exact finding, with no mailbox check", async () => {
    await seed([finding(), price()]);
    const check = vi.spyOn(GmailReceiptsService, "checkReceiptNotice");
    const onOpenReceipt = vi.fn();
    render(panel(onOpenReceipt));

    const row = await screen.findByTestId("receipt-update-row");
    expect(row).toHaveTextContent("Netflix renewal increases by ₹600");
    expect(row).toHaveTextContent("You paid ₹1,200. The 26 Nov renewal is ₹1,800.");
    // Only a price rise is an Overview update; the plan finding stays in Receipts.
    expect(screen.getAllByTestId("receipt-update-row")).toHaveLength(1);
    fireEvent.click(within(row).getByRole("button", { name: /Open in Receipts/ }));
    expect(onOpenReceipt).toHaveBeenCalledWith("nf_price_cccc");
    // Reading what Receipts already saved starts no model call.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(check).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight tracking load when its provider unmounts", async () => {
    let rejectLoad!: (error: Error) => void;
    const load = vi.spyOn(receiptTracking, "loadTracking").mockReturnValue(new Promise((_, reject) => {
      rejectLoad = reject;
    }));
    const view = render(panel());
    const activeSession = load.mock.calls[0]?.[0];
    expect(activeSession?.isCurrent?.()).toBe(true);

    view.unmount();
    await act(async () => rejectLoad(new Error("Storage closed")));

    expect(activeSession?.isCurrent?.()).toBe(false);
  });

  it("leaves out a rise the owner already answered", async () => {
    await seed([price()], (doc) => recordInsightReviewed(doc, "nf_price_cccc", "Netflix is going up", ctx()));
    render(panel());
    expect(await screen.findByText("No changes to report.")).toBeVisible();
    expect(screen.queryByTestId("receipt-update-row")).toBeNull();
  });
});
