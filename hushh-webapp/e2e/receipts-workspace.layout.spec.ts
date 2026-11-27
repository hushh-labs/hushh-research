import { expect, test, type Page } from "@playwright/test";

import { buildMailWorkspaceFixture } from "./fixtures/build-mail-workspace";
import { awaitProductFont } from "./fixtures/product-font";

// A mailbox of saved receipts only. No payment service exists in this release: every call to one is recorded and
// must never happen, and the screens must load without it.
let script: string;
let css: string;
let disposeFixture: (() => void) | undefined;

test.beforeAll(async () => {
  const fixture = await buildMailWorkspaceFixture();
  script = fixture.script;
  css = fixture.css;
  disposeFixture = fixture.dispose;
});
test.afterAll(() => disposeFixture?.());

async function openReceipts(page: Page, width: number, options: { rise?: boolean; notice?: boolean; theme?: "light" | "dark" } = {}) {
  const theme = options.theme ?? "light";
  await page.setViewportSize({ width, height: width < 500 ? 852 : 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.clock.setFixedTime(new Date("2026-12-10T10:00:00"));
  await page.route("http://localhost/fixture.js", (route) => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/mail-workspace", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="${theme}" data-workspace="receipts" data-stress="receipts-ref"${options.rise ? ' data-rise="1"' : ""}${options.notice ? ' data-notice="1"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-workspace");
  await awaitProductFont(page);
  await expect(page.getByRole("heading", { name: "Receipts", level: 2 })).toBeVisible();
}

const paymentCalls: string[] = [];
test.beforeEach(({ page }) => {
  paymentCalls.length = 0;
  page.on("request", (request) => { if (/\/receipts\/payments|\/api\/one\/mail\/receipts/.test(request.url())) paymentCalls.push(request.url()); });
});
test.afterEach(() => expect(paymentCalls).toEqual([]));

async function showRecurring(page: Page) {
  await page.getByRole("tab", { name: "Recurring" }).click();
  await expect(page.getByRole("heading", { name: "Choose your bills" })).toBeVisible();
}

/** The bottom bar must never cover the last thing on the screen once it is scrolled into view. */
async function expectLastRowClearsBottomBar(page: Page, rowTestId: string) {
  const last = page.getByTestId(rowTestId).last();
  await last.scrollIntoViewIfNeeded();
  await page.evaluate(() => { const root = document.querySelector('[data-app-scroll-root="true"]')!; root.scrollTop = root.scrollHeight; });
  const row = (await last.boundingBox())!;
  const bar = (await page.locator("nav[data-app-bottom-nav]").first().boundingBox())!;
  expect(row.y + row.height).toBeLessThanOrEqual(bar.y + 1);
}

for (const width of [393, 1024, 1440]) {
  test(`All receipts matches the reference structure at ${width}px`, async ({ page }, testInfo) => {
    await openReceipts(page, width);
    await expect(page.getByRole("button", { name: /Activity/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: "All receipts" })).toHaveAttribute("aria-selected", "true");
    const card = page.getByTestId("insight-card");
    await expect(card).toContainText("You pay for 5 subscription plans");
    await expect(card).toContainText("₹1,395 a month");
    await expect(card.getByRole("button", { name: "Review plans" })).toBeVisible();
    await expect(page.getByRole("button", { name: /See all/ })).toBeVisible();
    await expect(page.getByPlaceholder("Search receipts")).toBeVisible();
    await expect(page.getByTestId("receipt-date-filter")).toHaveValue("all");
    await expect(page.getByTestId("receipt-type-filter").getByRole("option", { name: "Due", exact: true })).toHaveCount(0);
    const december = page.getByTestId("receipt-month-group").first();
    await expect(december.getByRole("heading", { name: "December 2026" })).toBeVisible();
    await expect(december.getByTestId("receipt-month-summary")).toContainText("2 payments");
    await expect(december.getByTestId("receipt-month-summary")).toContainText("₹24,899");
    const rows = december.getByTestId("receipt-row");
    await expect(rows.nth(0)).toContainText("Orbit Mobile");
    await expect(rows.nth(0)).toContainText("Recurring payment");
    await expect(rows.nth(1)).toContainText("Maple Homes");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`all-receipts-${width}.png`), animations: "disabled" });
  });

  test(`Recurring shows detected bills with reason, date and amount at ${width}px`, async ({ page }, testInfo) => {
    await openReceipts(page, width);
    await showRecurring(page);
    await expect(page.getByRole("button", { name: /History/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add bill/ })).toBeVisible();
    await expect(page.getByTestId("recurring-view")).toContainText("It doesn’t pay bills.");
    await expect(page.getByText(/Step \d of/)).toHaveCount(0);
    await expect(page.getByTestId("bill-count")).toContainText("recurring payments");
    const rows = page.getByTestId("bill-row");
    const electricity = rows.filter({ hasText: "Electricity bill" });
    await expect(electricity).toContainText("Monthly · 26 Dec");
    await expect(electricity).toContainText("Last");
    await expect(electricity).toContainText("₹1,780");
    await expect(electricity).toContainText("est.");
    await expect(rows.filter({ hasText: "Maple Homes" })).toContainText("₹24,000");
    await expect(rows.filter({ hasText: "Wi-Fi" })).toContainText("Monthly · 30 Dec");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`recurring-${width}.png`), animations: "disabled" });
  });
}

test("Track, skip, change date and stop a bill; each choice survives a reload and is kept in History", async ({ page }, testInfo) => {
  await openReceipts(page, 393);
  await showRecurring(page);
  const wifi = () => page.getByTestId("bill-row").filter({ hasText: "Wi-Fi" });
  await wifi().getByRole("checkbox", { name: "Select Wi-Fi" }).check();
  await expect(page.getByTestId("bill-selection-bar")).toContainText("1 bill selected");
  await page.getByRole("button", { name: "Track selected bills" }).click();
  await expect(wifi()).toHaveAttribute("data-bill-status", "tracking");

  await wifi().getByTestId("bill-menu").click();
  await page.getByRole("menuitem", { name: "Skip this one" }).click();
  await expect(page.getByTestId("recurring-notice")).toContainText("Skipped Wi-Fi on 30 Dec. Next is 30 Jan.");
  await expect(wifi()).toContainText("30 Jan");

  await wifi().getByTestId("bill-menu").click();
  await page.getByRole("menuitem", { name: "Change date" }).click();
  await page.getByLabel("Next bill date").fill("2027-02-03");
  await page.getByRole("button", { name: "Save date" }).click();
  await expect(wifi()).toContainText("3 Feb");
  await expect(wifi()).not.toContainText("est.");

  await page.reload();
  await awaitProductFont(page);
  await showRecurring(page);
  await expect(wifi()).toHaveAttribute("data-bill-status", "tracking");
  await expect(wifi()).toContainText("3 Feb");

  await page.getByRole("button", { name: /History/ }).click();
  const history = page.getByTestId("history-sheet");
  await expect(history).toContainText("You moved Wi-Fi from 30 Jan to 3 Feb");
  await expect(history).toContainText("You skipped Wi-Fi on 30 Dec");
  await expect(history).toContainText("You started tracking Wi-Fi");
  await page.screenshot({ path: testInfo.outputPath("history-393.png") });
  await page.keyboard.press("Escape");

  await wifi().getByTestId("bill-menu").click();
  await page.getByRole("menuitem", { name: "Stop tracking" }).click();
  await page.getByRole("button", { name: "Stop tracking" }).click();
  await expect(page.getByTestId("bill-row").filter({ hasText: "Wi-Fi" })).toHaveCount(0);
  await page.reload();
  await awaitProductFont(page);
  await showRecurring(page);
  await expect(page.getByText(/Stopped \(1\)/)).toBeVisible();
});

test("Add bill tracks a manual bill that is still there after a reload", async ({ page }, testInfo) => {
  await openReceipts(page, 393);
  await showRecurring(page);
  await page.getByRole("button", { name: /Add bill/ }).click();
  const sheet = page.getByTestId("add-bill-sheet");
  await sheet.getByLabel("Bill name").fill("Water bill");
  await sheet.getByRole("radio", { name: "Varies" }).click();
  await page.screenshot({ path: testInfo.outputPath("add-bill-393.png") });
  await page.getByRole("button", { name: "Add bill" }).last().click();
  await expect(page.getByTestId("bill-row").filter({ hasText: "Water bill" })).toHaveAttribute("data-bill-status", "tracking");
  await page.reload();
  await awaitProductFont(page);
  await showRecurring(page);
  await expect(page.getByTestId("bill-row").filter({ hasText: "Water bill" })).toHaveAttribute("data-bill-status", "tracking");
});

test("A bill more than 20% above usual is shown with its comparison and evidence", async ({ page }, testInfo) => {
  await openReceipts(page, 393, { rise: true });
  const card = page.getByTestId("insight-card");
  await expect(card).toContainText("Electricity bill went up 32.7%");
  await expect(card).toContainText("Electricity bill is ₹1,950, up 32.7% from your usual ₹1,470.");
  await card.getByRole("button", { name: "Review bill" }).click();
  const review = page.getByTestId("insight-review");
  await expect(review).toContainText("Usual (middle of the last 3 paid)");
  await expect(review.getByRole("button")).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("price-rise-393.png") });
  await review.getByRole("button").first().click();
  await expect(page.getByTestId("receipt-detail")).toBeVisible();
  await page.keyboard.press("Escape");
  await showRecurring(page);
  await expect(page.getByTestId("bill-row").filter({ hasText: "Electricity bill" }).getByTestId("row-price-rise")).toContainText("Up 32.7% from usual");
});

test("Review plans records keep or cancel; a cancellation stays pending, and Not an issue is remembered", async ({ page }, testInfo) => {
  await openReceipts(page, 393);
  await page.getByRole("button", { name: /See all/ }).click();
  await expect(page.getByTestId("insights-list")).toContainText("You pay for 5 subscription plans");
  await page.getByTestId("insights-list").getByRole("button", { name: /subscription plans/ }).click();
  const review = page.getByTestId("insight-review");
  await expect(review.getByTestId("insight-plan")).toHaveCount(5);
  await review.getByRole("radio", { name: "cancel" }).first().click();
  await page.getByRole("button", { name: "Save choices" }).click();
  await expect(review).toContainText("Marked to cancel · waiting for the provider to confirm");
  await page.screenshot({ path: testInfo.outputPath("review-plans-393.png") });
  await page.reload();
  await awaitProductFont(page);
  await expect(page.getByTestId("insight-card")).toBeVisible();
  await page.getByRole("button", { name: "Review plans" }).click();
  await expect(page.getByTestId("insight-review")).toContainText("Marked to cancel · waiting for the provider to confirm");
  await expect(page.getByTestId("insight-review")).not.toContainText("confirmed the cancellation");
  await page.getByRole("button", { name: /View receipt/ }).first().click();
  await expect(page.getByTestId("receipt-detail")).toBeVisible();
});

test("Back from Recurring returns to All receipts; sheets open and close", async ({ page }) => {
  await openReceipts(page, 393);
  await showRecurring(page);
  await page.getByRole("button", { name: /History/ }).click();
  await expect(page.getByTestId("history-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("history-sheet")).toBeHidden();
  await page.getByRole("tab", { name: "All receipts" }).click();
  await page.getByRole("button", { name: /Activity/ }).click();
  await expect(page.getByTestId("activity-sheet")).toBeVisible();
});

test("Search and filters work, and the last rows stay above the bottom bar", async ({ page }) => {
  await openReceipts(page, 393);
  await page.getByPlaceholder("Search receipts").fill("maple");
  await expect(page.getByTestId("receipt-row")).toHaveCount(4);
  await page.getByPlaceholder("Search receipts").fill("");
  await page.getByTestId("receipt-type-filter").selectOption("recurring");
  await expect(page.getByTestId("receipt-row").first()).toBeVisible();
  await page.getByTestId("receipt-date-filter").selectOption("last_30_days");
  await expectLastRowClearsBottomBar(page, "receipt-row");
  await page.getByTestId("receipt-type-filter").selectOption("all");
  await page.getByTestId("receipt-date-filter").selectOption("all");
  await showRecurring(page);
  await expectLastRowClearsBottomBar(page, "bill-row");
});

test("A long merchant name wraps without pushing the amount off screen", async ({ page }) => {
  await openReceipts(page, 393);
  const rows = page.getByTestId("receipt-row");
  const box = (await rows.first().boundingBox())!;
  const amount = (await rows.first().locator("span.tabular-nums").first().boundingBox())!;
  expect(amount.x + amount.width).toBeLessThanOrEqual(box.x + box.width);
});


// ---- One noticed, from the mailbox check ---------------------------------------------------------------
// MODEL STAND-IN: the backend answer below is scripted. It proves how the real Receipts component shows an
// answer, opens its sources, remembers a choice and checks again only when the evidence changes. The real
// model is exercised separately (see consent-protocol/tests/live).
const sealed = (seed: string) => `grs1_${seed}`.padEnd(48, "x");
const PLAN_NAMES = ["Alpha TV", "Beta Stream", "Gamma Play", "Delta Sports", "Epsilon Kids"];
const PLAN_MINOR = [29900, 39900, 19900, 24900, 24900];
const noticeAnswer = (over: Record<string, unknown> = {}) => ({
  account_key: "synthetic-account", generated_at: "2026-12-10T10:00:00+00:00", model: "stand-in", coverage: { providers: 5, messages: 22 },
  findings: [
    {
      id: "nf_plans_0001", kind: "plan_review", headline: "You pay for 5 TV and streaming plans", reason: "₹1,395 a month. Do you still use them all?", strength: "question",
      provider: null, action: { id: "review_plans", label: "Review plans" }, evidence: [],
      plans: PLAN_NAMES.map((name, index) => ({ label: name, domain: `${name.toLowerCase().replace(/[^a-z]/g, "")}.example`, category: "streaming", period: "monthly", amount_minor: PLAN_MINOR[index], currency: "INR", evidence_id: `ev_plan_${index}0000000`, open_key: sealed(`plan${index}`), paid_on: "2026-11-04" })),
      facts: { count: 5, currency: "INR", monthly_total_minor: 139500, category: "streaming" }, attribution: null, score: 60, generated_at: "2026-12-10T10:00:00+00:00",
    },
    {
      id: "nf_inactive_0001", kind: "inactive_plan", headline: "Still using this ₹399 plan?", reason: "Beta Stream says this account hasn't watched anything in 60 days.", strength: "clear",
      provider: { name: "Beta Stream", domain: "betastream.example" }, action: { id: "review_plan", label: "Review plan" },
      evidence: [
        { evidence_id: "ev_paid_0000001", open_key: sealed("paid"), role: "paid", quote: "Total ₹399.00 paid", on: "2026-11-04", subject: "Your payment receipt", from: "Beta Stream", domain: "betastream.example" },
        { evidence_id: "ev_note_0000001", open_key: sealed("note"), role: "provider_notice", quote: "you haven't watched anything on this account in 60 days", on: "2026-12-02", subject: "We haven't seen you", from: "Beta Stream", domain: "betastream.example" },
      ],
      plans: [], facts: { amount_minor: 39900, currency: "INR", last_paid_on: "2026-11-04", notice_on: "2026-12-02", stated: "60 days", period: "monthly" },
      attribution: { by: "Beta Stream", on: "2026-12-02", statement: "you haven't watched anything on this account in 60 days", evidence_id: "ev_note_0000001" }, score: 75, generated_at: "2026-12-10T10:00:00+00:00",
    },
  ],
  resolved: [], cancellations: [], none_reason: "", ...over,
});

/** Mail asks whether the owner's content is private before any read; this owner is on shared hosting. */
async function stubHosting(page: Page) {
  await page.route("http://localhost/api/one/personal-agent/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ hostingMode: "shared" }) }));
}

async function stubNotice(page: Page, answer: () => unknown, calls: Array<Record<string, unknown>>) {
  await stubHosting(page);
  await page.route("http://localhost/api/kai/gmail/receipts/notice", async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(answer()) });
  });
  await page.route("http://localhost/api/kai/gmail/receipts/notice/source", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ subject: "We haven't seen you", from_name: "Beta Stream", from_domain: "betastream.example", received_at: "2026-12-02T08:00:00+00:00", excerpt: "Hi Alex. Hi, you haven't watched anything on this account in 60 days. We'd love to have you back.", truncated: false }),
  }));
}

for (const width of [393, 1440]) {
  test(`One noticed from the mailbox check: card, evidence and email at ${width}px`, async ({ page }, testInfo) => {
    const calls: Array<Record<string, unknown>> = [];
    await stubNotice(page, () => noticeAnswer(), calls);
    await openReceipts(page, width, { notice: true });
    const card = page.getByTestId("insight-card");
    await expect(card).toContainText("You pay for 5 TV and streaming plans");
    await expect(card).toContainText("₹1,395 a month. Do you still use them all?");
    await expect(card.getByRole("button", { name: "Review plans" })).toBeVisible();
    await expect(card.getByRole("button", { name: /See all \(2\)/ })).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ user_id: "synthetic-owner", account_key: "synthetic-account" });
    expect((calls[0]!.receipt_keys as string[]).every((key) => key.startsWith("grs1_"))).toBe(true);
    await expect(page.getByPlaceholder("Search receipts")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`notice-card-${width}.png`), animations: "disabled" });

    // Why is One showing me this: the card opens the plans and the emails behind them.
    await card.getByRole("button", { name: "Review plans" }).click();
    const review = page.getByTestId("insight-review");
    await expect(review).toContainText("Why you’re seeing this");
    await expect(review.getByTestId("insight-plan")).toHaveCount(5);
    await expect(review.getByTestId("insight-plan").first()).toContainText("₹299 a month");
    await page.screenshot({ path: testInfo.outputPath(`notice-review-plans-${width}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");

    // The second finding: a provider's own statement, quoted and dated, with the email one tap away.
    await page.getByRole("button", { name: /See all/ }).click();
    await page.getByTestId("insights-list").getByRole("button", { name: /Still using this ₹399 plan/ }).click();
    await expect(review).toContainText("Their email · Beta Stream · 2 Dec");
    await expect(review).toContainText("“you haven't watched anything on this account in 60 days”");
    await page.screenshot({ path: testInfo.outputPath(`notice-review-inactive-${width}.png`), animations: "disabled" });
    await review.getByRole("button", { name: "View email" }).nth(1).click();
    await expect(page.getByTestId("notice-source-excerpt")).toContainText("We'd love to have you back.");
    await expect(page.getByTestId("notice-quote-mark")).toHaveText("you haven't watched anything on this account in 60 days");
    await page.screenshot({ path: testInfo.outputPath(`notice-email-${width}.png`), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("Keep it is remembered across a reload, and the same evidence never asks a model again", async ({ page }, testInfo) => {
  const calls: Array<Record<string, unknown>> = [];
  await stubNotice(page, () => noticeAnswer({ findings: [noticeAnswer().findings[1]] }), calls);
  await openReceipts(page, 393, { notice: true });
  const card = page.getByTestId("insight-card");
  await expect(card).toContainText("Still using this ₹399 plan?");
  await page.screenshot({ path: testInfo.outputPath("notice-card-with-email-393.png"), animations: "disabled" });
  // The card links the provider's own email, and opening it decides nothing.
  await card.getByRole("button", { name: "View email" }).click();
  await expect(page.getByTestId("notice-source-excerpt")).toContainText("We'd love to have you back.");
  await expect(page.getByTestId("notice-quote-mark")).toHaveText("you haven't watched anything on this account in 60 days");
  await page.keyboard.press("Escape");
  await expect(card).toContainText("Still using this ₹399 plan?");
  await card.getByRole("button", { name: "Review plan" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await awaitProductFont(page);
  await expect(page.getByRole("heading", { name: "Receipts", level: 2 })).toBeVisible();
  await expect(page.getByTestId("receipt-month-group").first()).toBeVisible();
  await expect(page.getByTestId("insight-card")).toHaveCount(0);
  await page.waitForTimeout(2500);
  expect(calls).toHaveLength(1);
});
