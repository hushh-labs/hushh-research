import { expect, type Page, test } from "@playwright/test";

import { awaitProductFont } from "./fixtures/product-font";
import { buildMailWorkspaceFixture } from "./fixtures/build-mail-workspace";

test.use({ timezoneId: "Asia/Kolkata", locale: "en-IN" });

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

async function sharedReadingGutter(page: Page): Promise<number> {
  return page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-inline-gutter-standard"))
  );
}

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    for (const workspace of ["overview", "followups", "receipts"] as const) {
      test(`Mail ${workspace} ${theme} at ${width}px uses the shared reading frame`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
        await page.route("http://localhost/mail-workspace", route => route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html class="${theme}" data-workspace="${workspace}" data-brief-rise="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        }));
        await page.goto("http://localhost/mail-workspace");
        await expect(page.getByRole("tablist", { name: "Gmail workspace" })).toBeVisible();
        await awaitProductFont(page);
        const frame = page.locator(".app-page-shell");
        const geometry = await frame.evaluate(element => ({ width: element.getBoundingClientRect().width, gutter: parseFloat(getComputedStyle(element).paddingLeft) }));
        expect(geometry.width).toBe(Math.min(width, 864));
        expect(geometry.gutter).toBe(await sharedReadingGutter(page));
        const header = page.getByTestId("top-app-bar-breadcrumb-trail");
        await expect(header).toHaveText("Mail");
        const title = await header.locator("span").last().evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; });
        expect(title).toEqual(["17px", "22px", "600"]);
        const tabs = page.getByRole("tablist", { name: "Gmail workspace" });
        expect((await tabs.boundingBox())!.height).toBe(36);
        const tabType = await tabs.locator("[data-ui-contract=required-title]").first().evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; });
        expect(tabType).toEqual(["15px", "20px", "550"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (workspace === "overview") {
          // The brief leads: header, three tabs, then the sections in the approved order.
          await expect(page.getByTestId("mail-header")).toBeVisible();
          await expect(page.getByTestId("mail-account-chip")).toContainText("neha@hushh.ai");
          await expect(page.getByTestId("mail-attention-count")).toHaveText("4");
          await expect(page.getByRole("heading", { name: "Needs your attention" })).toBeVisible();
          const overviewPanel = page.getByRole("tabpanel", { name: "Overview" });
          await expect(overviewPanel.getByTestId("attention-card")).toHaveCount(3);
          await expect(page.getByRole("button", { name: "All 4 in Follow-ups" })).toBeVisible();
          await expect(page.getByRole("heading", { name: "Recent updates" })).toBeVisible();
          await expect(page.getByRole("heading", { name: "Recently completed" })).toBeVisible();
          // Every control in the brief is a touch target that sits fully inside the frame.
          const frameBox = (await frame.boundingBox())!;
          const controls = await page.getByRole("tabpanel", { name: "Overview" }).getByRole("button").evaluateAll(elements =>
            elements.filter(element => (element as HTMLElement).offsetParent !== null).map(element => { const box = element.getBoundingClientRect(); return { name: element.textContent?.trim() ?? "", left: box.left, right: box.right, height: box.height }; }));
          for (const control of controls) {
            expect(control.right, control.name).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1);
            expect(control.left, control.name).toBeGreaterThanOrEqual(frameBox.x - 1);
            expect(control.height, control.name).toBeGreaterThanOrEqual(36);
          }
          // Search, Recent mail and Write stay reachable as secondary tools.
          await expect(overviewPanel.getByTestId("mail-write")).toBeVisible();
          await overviewPanel.getByTestId("mail-tools-toggle").click();
          await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible();
          await expect(page.getByRole("heading", { name: "Recent mail" })).toBeVisible();
          await expect(page.getByTestId("mail-row")).toHaveCount(5);
          await expect(page.getByText("Draft with One.")).toHaveCount(0);
          const chip = page.getByTestId("mail-account-chip");
          await chip.click();
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          const box = (await menu.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          await page.keyboard.press("Escape");
          await expect(chip).toBeFocused();
        }
        if (workspace === "followups") {
          // The tab opens the tracked board inside the same reading frame; the attention list is one tap away.
          await page.getByRole("button", { name: "View Overview follow-ups" }).click();
          await expect(page.getByRole("heading", { name: "Follow-ups", level: 2 })).toBeVisible();
          const followupsPanel = page.getByRole("tabpanel", { name: "Follow-ups" });
          await expect(followupsPanel.getByTestId("attention-card")).toHaveCount(4);
          await expect(followupsPanel.getByTestId("followups-count")).toHaveText("4 need you");
          // KYC is its own screen: nothing in Follow-ups leads to it or lists it.
          await expect(page.getByTestId("open-kyc")).toHaveCount(0);
          await expect(followupsPanel.getByText("Requests for your details")).toHaveCount(0);
        }
        if (workspace === "receipts") {
          await expect(page.getByText("Amazon", { exact: true })).toBeVisible();
          await expect(page.getByTestId("receipt-controls")).toBeVisible();
          await expect(page.getByRole("heading", { name: "Receipts", level: 2 })).toBeVisible();
          const month = await page.getByTestId("receipt-month-group").first().getByRole("heading").evaluate(element => {
            const style = getComputedStyle(element);
            return [style.fontSize, style.lineHeight, style.fontWeight, style.letterSpacing];
          });
          expect(month).toEqual(["17px", "22px", "600", "normal"]);
        }
        expect(errors).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`mail-${workspace}-${width}-${theme}.png`) });
      });
    }
  }
}

// KYC is its own screen, not a Mail tab: no tabs, no brief, the same requests and paste flow.
for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`KYC screen ${theme} at ${width}px stands alone, with no Mail tabs`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-workspace", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="${theme}" data-workspace="kyc"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-workspace");
      await awaitProductFont(page);
      await expect(page.getByRole("tablist", { name: "Gmail workspace" })).toHaveCount(0);
      await expect(page.getByRole("tab")).toHaveCount(0);
      await expect(page.getByTestId("mail-header")).toHaveCount(0);
      await expect(page.getByTestId("attention-card")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "KYC", level: 1 })).toBeVisible();
      const frame = page.locator(".app-page-shell");
      expect((await frame.boundingBox())!.width).toBe(Math.min(width, 864));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const paste = page.getByRole("button", { name: "Paste details", exact: true });
      await expect(paste).toBeVisible();
      expect((await paste.boundingBox())!.height).toBe(44);
      await paste.click();
      const dialog = page.getByRole("dialog", { name: "Paste your profile details" });
      await expect(dialog).toBeVisible();
      const dialogTitle = await dialog.getByRole("heading", { name: "Paste your profile details" }).evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.lineHeight, style.fontWeight, style.fontFamily];
      });
      expect(dialogTitle.slice(0, 3)).toEqual(["20px", "28px", "600"]);
      expect(dialogTitle[3]).toContain("Plus Jakarta Sans");
      const inputType = await dialog.getByRole("textbox", { name: "KYC details" }).evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.lineHeight, style.fontWeight];
      });
      expect(inputType).toEqual([width <= 620 ? "16px" : "14px", "22px", "400"]);
      const utility = dialog.getByRole("button", { name: "Copy prompt to clipboard" });
      const utilityType = await utility.evaluate(element => {
        const style = getComputedStyle(element);
        // Layout height, so a dialog still scaling in cannot change what is measured.
        return [style.fontSize, style.lineHeight, style.fontWeight, (element as HTMLElement).offsetHeight];
      });
      expect(utilityType).toEqual([width <= 620 ? "12px" : "13px", "21px", "550", 44]);
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(paste).toBeFocused();
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`kyc-${width}-${theme}.png`) });
    });
  }
}

/** `tools: true` (the default) opens "Search and recent mail", where Recent mail, Search and Open live. */
async function openOverview(page: import("@playwright/test").Page, input: { width: number; height: number; scenario?: string; zoom?: number; tools?: boolean; attrs?: string; theme?: "light" | "dark"; shell?: boolean }) {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({ colorScheme: input.theme ?? "light", reducedMotion: "reduce" });
  await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/mail-workspace", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="${input.theme ?? "light"}" data-workspace="overview" data-overview="${input.scenario ?? "populated"}" ${input.shell ? 'data-shell="1"' : ""} ${input.attrs ?? ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-workspace");
  await expect(page.getByRole("tablist", { name: "Gmail workspace" })).toBeVisible();
  await awaitProductFont(page);
  if (input.zoom) await page.evaluate(value => { (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(value); }, input.zoom);
  if (input.tools ?? true) {
    await page.getByRole("tabpanel", { name: "Overview" }).getByTestId("mail-tools-toggle").click();
    await expect(page.getByRole("searchbox", { name: "Search mail" })).toBeVisible();
  }
}

for (const size of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
  test(`Mail overview searches, opens an exact email and returns at ${size.width}px`, async ({ page }, testInfo) => {
    await openOverview(page, size);
    const rows = page.getByTestId("mail-row");
    await expect(rows).toHaveCount(5);
    const field = page.getByRole("searchbox", { name: "Search mail" });
    await field.fill("invoice");
    await field.press("Enter");
    await expect(rows).toHaveCount(3);
    await expect(page.getByText(/All mail \(Spam and Trash excluded\)/)).toBeVisible();
    await expect(field).toHaveValue("invoice");
    // Two rows share a subject; each opens its own message.
    const second = rows.nth(2);
    await second.click();
    const body = page.getByTestId("mail-message-body");
    await expect(body).toBeVisible();
    // Mail text is shown as text: the markup in the fixture body stays literal.
    await expect(body).toContainText("<b>markup</b>");
    expect(await body.locator("b, a, img").count()).toBe(0);
    await expect(page.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: testInfo.outputPath(`mail-overview-open-${size.width}.png`) });
    await page.getByRole("button", { name: /Search results/ }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toBeFocused();
    await page.getByRole("button", { name: /Recent mail/ }).click();
    await expect(rows).toHaveCount(5);
    await expect(field).toHaveValue("");
  });
}

test("Mail overview keeps its last row clear of the bottom bar, and the search field above the keyboard", async ({ page }, testInfo) => {
  await openOverview(page, { width: 393, height: 852 });
  await page.getByRole("button", { name: "View more" }).click();
  const rows = page.getByTestId("mail-row");
  await expect(rows).toHaveCount(8);
  const reachable = async () => {
    await page.locator("[data-app-scroll-root]").evaluate(element => { element.scrollTop = element.scrollHeight; });
    const last = (await rows.last().boundingBox())!;
    const bar = (await page.locator("nav[data-app-bottom-nav]").boundingBox())!;
    return bar.y - (last.y + last.height);
  };
  // The tab pane resizes a frame after rows arrive, so poll until it has settled:
  // the last row can then always be scrolled fully above the bottom bar.
  await expect.poll(reachable).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("mail-overview-last-row-393.png") });

  // An open keyboard, as the shell publishes it: the viewport shrinks and --kb-height is set.
  await page.evaluate(() => document.documentElement.style.setProperty("--kb-height", "336px"));
  await page.setViewportSize({ width: 393, height: 852 - 336 });
  await page.locator("[data-app-scroll-root]").evaluate(element => { element.scrollTop = 0; });
  const field = page.getByRole("searchbox", { name: "Search mail" });
  await field.focus();
  await field.scrollIntoViewIfNeeded();
  const input = (await field.boundingBox())!;
  const submit = (await page.getByRole("button", { name: "Search", exact: true }).boundingBox())!;
  expect(input.y).toBeGreaterThanOrEqual(0);
  expect(input.y + input.height).toBeLessThanOrEqual(852 - 336);
  expect(submit.y + submit.height).toBeLessThanOrEqual(852 - 336);
  await page.screenshot({ path: testInfo.outputPath("mail-overview-keyboard-393.png") });
});

test("Mail overview stays usable at larger text (150% zoom) on a phone", async ({ page }, testInfo) => {
  await openOverview(page, { width: 393, height: 852, zoom: 1.5 });
  await expect(page.getByTestId("mail-row")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  await page.screenshot({ path: testInfo.outputPath("mail-overview-zoom-393.png") });
});

for (const [scenario, text, action] of [
  ["empty", "No mail in your Inbox.", null],
  ["failed", "Couldn't load your mail. Try again.", "Try again"],
  ["reconnect", "Your mail connection needs attention. Reconnect to continue.", "Reconnect"],
] as const) {
  test(`Mail overview says "${scenario}" truthfully`, async ({ page }) => {
    await openOverview(page, { width: 393, height: 852, scenario });
    await expect(page.getByText(text)).toBeVisible();
    if (action) await expect(page.getByRole("button", { name: action, exact: true })).toBeVisible();
    await expect(page.getByTestId("mail-row")).toHaveCount(0);
    // A failed read is never worded as an empty Inbox.
    if (scenario !== "empty") await expect(page.getByText("No mail in your Inbox.")).toHaveCount(0);
  });
}

for (const size of [{ width: 1280, height: 900 }, { width: 393, height: 852 }, { width: 360, height: 780 }]) {
  test(`Mail overview shows how old the list is, with a reachable Refresh at ${size.width}px`, async ({ page }, testInfo) => {
    await openOverview(page, size);
    await expect(page.getByTestId("mail-row")).toHaveCount(5);
    const tools = page.locator("#mail-tools-panel");
    const updated = tools.getByText(/^Updated \d{1,2}:\d{2}/);
    const refresh = tools.getByRole("button", { name: "Refresh", exact: true });
    await expect(updated).toBeVisible();
    await expect(refresh).toBeVisible();
    // A touch-sized target that stays inside the frame and above the first row.
    const box = await refresh.boundingBox();
    const firstRow = await page.getByTestId("mail-row").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(firstRow!.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: testInfo.outputPath(`mail-overview-freshness-${size.width}.png`) });
    // Refresh reads again and leaves the list as it was when nothing is newer.
    await refresh.click();
    await expect(page.getByTestId("mail-row")).toHaveCount(5);
    await expect(refresh).toBeEnabled();
  });
}

test("Mail overview shows loading text while the first read is in flight", async ({ page }) => {
  await openOverview(page, { width: 393, height: 852, scenario: "slow" });
  await expect(page.getByText("Loading your mail…")).toBeVisible();
  await expect(page.getByTestId("mail-row")).toHaveCount(0);
});


// ── The approved Overview: layout against the reference, then the journeys ─────────────────────────────────

const REFERENCE_ATTRS = 'data-brief-rise="1"';

async function openBrief(page: import("@playwright/test").Page, input: { width: number; height?: number; theme?: "light" | "dark"; attrs?: string }) {
  await page.route("**/api/kai/gmail/receipts/notice*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: { code: "GMAIL_RECEIPT_NOTICE_UNAVAILABLE" } }) }));
  await openOverview(page, { width: input.width, height: input.height ?? (input.width >= 768 ? 1000 : 852), tools: false, shell: true, theme: input.theme, attrs: input.attrs ?? REFERENCE_ATTRS });
  const overview = page.getByRole("tabpanel", { name: "Overview" });
  await expect(overview.getByTestId("attention-card")).toHaveCount(3);
  await expect(overview.getByTestId("receipt-update-row")).toHaveCount(1);
  await expect(overview.getByTestId("completed-row")).toHaveCount(1);
  return overview;
}

for (const width of [1440, 1100, 1024, 768, 430, 393, 360]) {
  test(`Mail Overview lays out the approved brief at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const overview = await openBrief(page, { width });
    const frame = (await page.locator(".app-page-shell").boundingBox())!;
    const gutter = await sharedReadingGutter(page);
    const cards = await overview.getByTestId("attention-card").evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height, right: box.right }; }));
    expect(cards).toHaveLength(3);
    if (width >= 1100) {
      // The reference: three equal cards in one row.
      for (const card of cards) expect(Math.abs(card.top - cards[0]!.top)).toBeLessThanOrEqual(1);
      expect(cards[1]!.left).toBeGreaterThan(cards[0]!.right - 1);
      expect(cards[2]!.left).toBeGreaterThan(cards[1]!.right - 1);
      for (const card of cards) { expect(Math.abs(card.width - cards[0]!.width)).toBeLessThanOrEqual(2); expect(Math.abs(card.height - cards[0]!.height)).toBeLessThanOrEqual(2); }
    } else if (width >= 620) {
      expect(Math.abs(cards[1]!.top - cards[0]!.top)).toBeLessThanOrEqual(1); // two across, the third below
      expect(cards[2]!.top).toBeGreaterThan(cards[0]!.top + cards[0]!.height - 1);
    } else {
      // A phone: one card per row, each the full width of the frame between its gutters.
      for (const [index, card] of cards.entries()) {
        expect(Math.abs(card.left - (frame.x + gutter))).toBeLessThanOrEqual(1);
        expect(card.width).toBeGreaterThanOrEqual(frame.width - gutter * 2 - 2);
        if (index) expect(card.top).toBeGreaterThan(cards[index - 1]!.top + cards[index - 1]!.height - 1);
      }
    }
    // The lower sections: side by side on a wide screen, the updates wider; stacked otherwise.
    const updates = (await overview.getByTestId("updates-list").boundingBox())!;
    const completed = (await overview.getByTestId("completed-list").boundingBox())!;
    if (width > 900) {
      expect(Math.abs(updates.y - completed.y)).toBeLessThanOrEqual(2);
      expect(completed.x).toBeGreaterThan(updates.x + updates.width - 1);
      expect(updates.width).toBeGreaterThan(completed.width);
    } else {
      expect(completed.y).toBeGreaterThan(updates.y + updates.height - 1);
      expect(Math.abs(updates.x - completed.x)).toBeLessThanOrEqual(1);
    }
    // Nothing is clipped or pushed off the side: every control sits inside the frame, and the page does not scroll sideways.
    const controls = await overview.getByRole("button").evaluateAll(elements => elements.filter(element => (element as HTMLElement).offsetParent !== null).map(element => { const box = element.getBoundingClientRect(); return { name: element.textContent?.trim() ?? "", left: box.left, right: box.right, width: box.width }; }));
    for (const control of controls) {
      expect(control.left, control.name).toBeGreaterThanOrEqual(frame.x - 1);
      expect(control.right, control.name).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
    // No label breaks across lines: a control reads as one line wherever it sits, so "All 4 in Follow-ups" never splits mid-word.
    const wrapped = await overview.getByRole("button").evaluateAll(elements => elements.filter(element => (element as HTMLElement).offsetParent !== null).filter(element => {
      // Text only: an icon sits at its own height and says nothing about wrapping.
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const tops = new Set<number>();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const box of Array.from(range.getClientRects())) if (box.width > 0) tops.add(Math.round(box.top));
      }
      return tops.size > 1;
    }).map(element => element.textContent?.trim() ?? ""));
    expect(wrapped).toEqual([]);
    const clipped = await overview.locator("[data-testid=attention-card], [data-testid=update-row], [data-testid=receipt-update-row], [data-testid=completed-row]").evaluateAll(elements => elements.filter(element => element.scrollWidth > element.clientWidth + 1).length);
    expect(clipped).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // The production Talk to One bar and tab pill sit below the content, which can always scroll clear of them.
    const bar = page.locator("[data-app-bottom-shell]");
    await expect(bar).toBeVisible();
    await page.locator("[data-app-scroll-root]").evaluate(element => { element.scrollTop = element.scrollHeight; });
    const lastBottom = await overview.getByTestId("brief-updated").evaluate(element => element.getBoundingClientRect().bottom);
    expect(lastBottom).toBeLessThanOrEqual((await bar.boundingBox())!.y + 1);
    await page.locator("[data-app-scroll-root]").evaluate(element => { element.scrollTop = 0; });
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`reference-compare-${width}.png`) });
  });
}

for (const width of [1440, 393]) {
  test(`Mail Overview in dark mode at ${width}px keeps every section readable`, async ({ page }, testInfo) => {
    const overview = await openBrief(page, { width, theme: "dark" });
    for (const name of ["Needs your attention", "Recent updates", "Recently completed"]) await expect(overview.getByRole("heading", { name })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`reference-compare-${width}-dark.png`) });
  });
}

test("Mail Overview: a card's evidence is the exact message, and 'Draft follow-up' hands a reviewed reply on that thread to One without sending", async ({ page }) => {
  const overview = await openBrief(page, { width: 1280 });
  const sends: string[] = [];
  page.on("request", request => { if (/email\/(prepare|send)/.test(request.url())) sends.push(request.url()); });

  const first = overview.getByTestId("attention-card").first();
  await expect(first).toContainText("IIT KGP · Follow-up");
  await expect(first.getByTestId("attention-due")).toHaveText("Promised 20 November");
  await first.getByTestId("why-this").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("I will send the signed document by 20 Nov");
  await dialog.getByTestId("brief-view-email").click();
  const body = page.getByTestId("brief-message-body");
  await expect(body).toContainText("Prof. Sen");
  await expect(page.getByTestId("brief-quote-mark")).toHaveText("I will send the signed document by 20 Nov");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await first.getByTestId("attention-action").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mailHandoff: () => unknown }).__mailHandoff())).toMatchObject({
    intent: "reply",
    reply: { to: "sender@example.com", sourceId: expect.stringMatching(/^ms1\./), body: "Could you send the signed document when you can? Thank you." },
  });
  // Only a reply source was prepared; delivery was never prepared or sent.
  expect(sends).toEqual([]);
});

test("Mail Overview: 'All 4 in Follow-ups' opens those four, and Thank, sent email and Receipts each open the right thing", async ({ page }) => {
  const overview = await openBrief(page, { width: 1280 });

  // Recent updates: the approval has a Thank draft; the renewal opens its exact Receipts finding.
  const approval = overview.getByTestId("update-row");
  await expect(approval).toContainText("Proposal approved");
  await expect(approval).toContainText("Scope and ₹2.4 lakh budget confirmed.");
  await approval.getByTestId("update-action").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mailHandoff: () => unknown }).__mailHandoff())).toMatchObject({
    intent: "reply", reply: { body: "Thank you, Priya." },
  });
  const rise = overview.getByTestId("receipt-update-row");
  await expect(rise).toContainText("Renewal increases by ₹600");
  await expect(rise).toContainText("You paid ₹1,200. The 26 Nov renewal is ₹1,800.");

  // Recently completed: a confirmed send, with its attachment, and the exact sent message behind it.
  const done = overview.getByTestId("completed-row");
  await expect(done).toContainText("Pricing sheet sent to Priya");
  await expect(done).toContainText("Attached: pricing-sheet.pdf");
  await expect(done).toContainText("22 Nov 2026 · 9:38 AM");
  await done.getByTestId("view-sent-email").click();
  await expect(page.getByTestId("brief-message-body")).toContainText("Attached is the approved pricing sheet.");
  await page.keyboard.press("Escape");

  await rise.getByTestId("open-in-receipts").click();
  // That exact finding's review opens over the Receipts tab.
  const review = page.getByTestId("insight-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText("New price₹1,800");
  await expect(review).toContainText("Last paid₹1,200");
  await expect(page.getByRole("dialog")).toContainText("Your plan is going up");
  // With the modal closed, Receipts is the tab that is showing.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tablist", { name: "Gmail workspace" }).getByRole("tab", { name: "Receipts" })).toHaveAttribute("aria-selected", "true");
});

test("Mail Overview: 'All N in Follow-ups' shows the real count and opens those same items", async ({ page }) => {
  await openOverview(page, { width: 393, height: 852, tools: false, attrs: 'data-brief="many"' });
  const overview = page.getByRole("tabpanel", { name: "Overview" });
  await expect(overview.getByTestId("attention-card")).toHaveCount(3);
  await expect(page.getByTestId("mail-attention-count")).toHaveText("6");
  await overview.getByRole("button", { name: "All 6 in Follow-ups" }).click();
  await expect(page.getByRole("tab", { name: "Follow-ups" })).toHaveAttribute("aria-selected", "true");
  const followups = page.getByRole("tabpanel", { name: "Follow-ups" });
  await expect(followups.getByTestId("attention-card")).toHaveCount(6);
  await expect(followups.getByRole("heading", { name: "Get the signed document" })).toBeVisible();
});

for (const [scenario, expectations] of [
  ["empty", ["No action found in the 14 messages checked", "No changes to report.", "Nothing sent through One in the last 30 days."]],
  ["failed", ["One couldn't check your mail just now. Try again."]],
] as const) {
  test(`Mail Overview says "${scenario}" truthfully, section by section`, async ({ page }) => {
    await openOverview(page, { width: 393, height: 852, tools: false, attrs: `data-brief="${scenario}"` });
    const overview = page.getByRole("tabpanel", { name: "Overview" });
    for (const text of expectations) await expect(overview.getByText(text).first()).toBeVisible();
    await expect(overview.getByTestId("attention-card")).toHaveCount(0);
    if (scenario === "failed") {
      // A failed check is never worded as "nothing needs you", and the confirmed sends are unaffected.
      await expect(overview.getByText(/nothing needs/i)).toHaveCount(0);
      await expect(overview.getByTestId("completed-row")).toHaveCount(1);
      await expect(overview.getByRole("button", { name: "Try again" }).first()).toBeVisible();
    }
  });
}

test("Mail Overview shows loading, not an empty brief, while One is checking", async ({ page }) => {
  await openOverview(page, { width: 393, height: 852, tools: false, attrs: 'data-brief="slow"' });
  const overview = page.getByRole("tabpanel", { name: "Overview" });
  await expect(overview.getByLabel("Checking recent mail")).toBeVisible();
  await expect(overview.getByText(/nothing needs/i)).toHaveCount(0);
  await expect(overview.getByTestId("attention-card")).toHaveCount(0);
});

test("a link to KYC opens the KYC screen, with no Mail tab selected or offered", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/mail-workspace", route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="kyc"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-workspace");
  await expect(page.getByRole("button", { name: "Paste details", exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
});

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Mail intro ${theme} at ${width}px hands off to setup`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-workspace", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="${theme}" data-workspace="intro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-workspace");
      await awaitProductFont(page);
      await expect(page.getByRole("heading", { name: "Your mail, made useful." })).toBeVisible();
      const continueButton = page.getByRole("button", { name: "Continue" });
      expect((await continueButton.boundingBox())!.height).toBeGreaterThanOrEqual(50);
      await page.screenshot({ path: testInfo.outputPath(`mail-intro-${width}-${theme}.png`) });
      await continueButton.click();
      await expect(page.getByRole("button", { name: "Finish Mail setup" })).toBeVisible();
      await expect(page.locator('[data-capability-cinematic-body="gmail"]')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
}

for (const width of [350, 351, 620, 621, 767]) {
  test(`Mail frame boundary at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="overview"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    await expect(page.getByRole("tablist", { name: "Gmail workspace" })).toBeVisible();
    const gutter = await page.locator(".app-page-shell").evaluate(element => parseFloat(getComputedStyle(element).paddingLeft));
    expect(gutter).toBe(await sharedReadingGutter(page));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

for (const width of [393, 1024, 1440]) {
  test(`Mail disconnected status ${width}px keeps the Connect action geometry`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="overview" data-connection="disconnected"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const status = page.getByRole("tabpanel", { name: "Overview" }).getByTestId("mail-connection-status");
    await expect(status).toBeVisible();
    await awaitProductFont(page);
    const gutter = await sharedReadingGutter(page);
    const left = (width - Math.min(width, 864)) / 2 + gutter;
    const tabs = page.getByRole("tablist", { name: "Gmail workspace" });
    for (const control of [tabs, status]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeCloseTo(left, 0);
      expect(box.x + box.width).toBeCloseTo(width - left, 0);
    }
    const headingType = await status.locator("h2").evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(headingType).toEqual(["14px", "22px", "600"]);
    const connect = status.getByRole("button", { name: "Connect Mail" });
    const geometry = await connect.evaluate(element => {
      const pill = element.querySelector<HTMLElement>("[data-slot=mail-action-pill]")!;
      const style = getComputedStyle(pill);
      return {
        outer: element.getBoundingClientRect().width,
        inner: pill.getBoundingClientRect().width,
        height: pill.getBoundingClientRect().height,
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
      };
    });
    expect(geometry.outer).toBe(geometry.inner);
    expect(geometry.outer).toBeLessThanOrEqual(244);
    expect(geometry.height).toBe(44);
    expect(geometry.border).toBe("1px");
    expect(geometry.radius).toBe("999px");
    expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
    await page.route("http://localhost/location-reference", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-reference="location"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/location-reference");
    for (const reference of [page.getByRole("tablist"), page.getByTestId("one-location-share-row")]) {
      await expect(reference).toBeVisible();
      const box = (await reference.boundingBox())!;
      expect(box.x).toBeCloseTo(left, 0);
      expect(box.x + box.width).toBeCloseTo(width - left, 0);
    }

  });

  test(`Mail KYC request ${width}px keeps review and selection roles`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="kyc" data-queue="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const review = page.getByRole("button", { name: "Review", exact: true });
    await expect(review).toBeVisible();
    await awaitProductFont(page);
    const rowName = await page.getByText("Information requested", { exact: true }).first().evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(rowName).toEqual(["14px", "21px", "550"]);
    await review.click();
    const title = page.getByRole("heading", { name: "Review request" });
    await expect(title).toBeVisible();
    const titleType = await title.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(titleType).toEqual(["20px", "28px", "600"]);
    const choice = page.getByRole("button", { name: "Available: Postal code" });
    await expect(choice).toHaveAttribute("aria-pressed", "false");
    const before = await choice.locator("[data-slot=mail-action-pill]").evaluate(element => getComputedStyle(element).backgroundColor);
    await choice.click();
    const selected = page.getByRole("button", { name: "Selected: Postal code" });
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    const after = await selected.locator("[data-slot=mail-action-pill]").evaluate(element => getComputedStyle(element).backgroundColor);
    expect(after).not.toBe(before);
    const openMail = page.getByRole("button", { name: "Open mail" });
    const utility = await openMail.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight, element.getBoundingClientRect().height];
    });
    expect(utility).toEqual([width <= 620 ? "12px" : "13px", "21px", "550", 44]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });

  test(`Mail saved receipt ${width}px opens the matching detail surface`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="receipts"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const row = page.getByText("Amazon", { exact: true }).locator("xpath=ancestor::button[1]");
    await expect(row).toBeVisible();
    await row.click();
    const title = page.getByRole("heading", { name: "Amazon" });
    await expect(title).toBeVisible();
    await awaitProductFont(page);
    const titleType = await title.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(titleType).toEqual(["20px", "28px", "600"]);
    await expect(page.getByTestId("receipt-detail")).toBeVisible();
    await expect(page.getByText("Saved receipt details are available. Reconnect Mail or sync again to load the original email and source evidence.")).toBeVisible();
    const detail = page.getByTestId("receipt-detail");
    const valueType = await detail.locator("dd").first().evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(valueType).toEqual(["14px", "21px", "550"]);
    await page.getByRole("button", { name: /^Close(?: detail panel)?$/ }).click();
    await expect(row).toBeFocused();
  });
}

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Mail setup body ${theme} at ${width}px keeps the full-page role`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-workspace", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="${theme}" data-workspace="setup"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-workspace");
      const finish = page.getByRole("button", { name: "Finish Mail setup" });
      await expect(finish).toBeVisible();
      await awaitProductFont(page);
      const title = await page.getByRole("heading", { level: 1, name: "Mail" }).evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.lineHeight, style.fontWeight, style.fontFamily];
      });
      expect(title.slice(0, 3)).toEqual(["28px", "36px", "600"]);
      expect(title[3]).toContain("Plus Jakarta Sans");
      expect((await finish.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`mail-setup-${width}-${theme}.png`) });
    });
  }
}

test("Mail disconnected setup and prerequisite skeleton keep their own labels", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/mail-workspace", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="setup" data-connection="disconnected"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-workspace");
  await expect(page.getByRole("button", { name: "Skip Mail setup" })).toBeVisible();
  await expect(page.getByText("You can connect Mail from setup whenever you are ready.")).toBeVisible();
  await page.route("http://localhost/mail-skeleton", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="skeleton"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-skeleton");
  await expect(page.getByRole("heading", { level: 1, name: "Gmail" })).toBeVisible();
  const skeleton = page.getByLabel("Checking your Gmail status").first();
  await expect(skeleton).toHaveAttribute("aria-busy", "true");
  await page.route("http://localhost/mail-hidden-skeleton", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="skeleton-hidden"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-hidden-skeleton");
  await expect(page.getByRole("heading", { level: 1, name: "Gmail" })).toHaveClass(/sr-only/);
  await expect(page.getByTestId("top-app-bar-breadcrumb-trail")).toHaveText("Mail");
});

test("Mail KYC cold check keeps its readable section heading", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/mail-workspace", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="kyc" data-kyc-loading="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/mail-workspace");
  const pending = page.getByLabel("Checking KYC setup");
  await expect(pending).toHaveAttribute("aria-busy", "true");
  const heading = await pending.getByText("KYC requests").evaluate(element => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.lineHeight, style.fontWeight];
  });
  expect(heading).toEqual(["14px", "22px", "600"]);
});

for (const width of [393, 1024]) {
  test(`Mail KYC monitoring confirmation ${width}px preserves the shared decision`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="kyc" data-queue="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const turnOff = page.getByRole("button", { name: "Turn off", exact: true });
    await expect(turnOff).toBeVisible();
    await turnOff.click();
    const alert = page.getByRole("alertdialog", { name: "Turn off monitoring?" });
    await expect(alert).toBeVisible();
    const title = await alert.getByRole("heading", { name: "Turn off monitoring?" }).evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(title).toEqual(["20px", "28px", "600"]);
    await alert.getByRole("button", { name: "Keep monitoring on" }).click();
    await expect(alert).not.toBeVisible();
  });

  test(`Mail receipt updates ${width}px keeps the conditional dialog and focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="receipts" data-updates="disabled"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const view = page.getByRole("button", { name: "View details" });
    await expect(view).toBeVisible();
    await view.click();
    const dialog = page.getByRole("dialog", { name: "Receipt updates" });
    await expect(dialog).toBeVisible();
    const title = await dialog.getByRole("heading", { name: "Receipt updates" }).evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(title).toEqual(["20px", "28px", "600"]);
    await expect(dialog.getByText("New receipt updates aren’t supported by your current setup yet. You can still open saved receipts found on this device.")).toBeVisible();
    await dialog.getByRole("button", { name: "Got it" }).click();
    await expect(view).toBeFocused();
  });
}

for (const width of [360, 393, 430, 768, 1024, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Mail OAuth return ${theme} at ${width}px preserves the recovery flow`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-callback", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="${theme}" data-workspace="callback"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-callback");
      const heading = page.getByRole("heading", { level: 1, name: "Mail connection needs attention" });
      await expect(heading).toBeVisible();
      await awaitProductFont(page);
      const title = await heading.evaluate(element => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.lineHeight, style.fontWeight, style.fontFamily];
      });
      expect(title.slice(0, 3)).toEqual(["28px", "36px", "600"]);
      expect(title[3]).toContain("Plus Jakarta Sans");
      await expect(page.getByText("Google sign-in was cancelled.")).toBeVisible();
      const back = page.getByRole("button", { name: "Back to Mail" });
      await expect(back).toBeVisible();
      expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`mail-oauth-return-${width}-${theme}.png`) });
    });
  }
}

for (const width of [393, 1024]) {
  test(`Mail OAuth return waiting ${width}px keeps a live status`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
    await page.route("http://localhost/mail-callback", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html class="light" data-workspace="callback-loading"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-callback");
    const status = page.getByText("Connecting your Gmail…");
    await expect(status).toBeVisible();
    const role = await status.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(role).toEqual(["13px", "18px", "600"]);
  });
}

test("Cloud callback keeps its existing loading presentation", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("http://localhost/cloud-callback", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html class="light" data-workspace="callback-cloud-loading"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
  }));
  await page.goto("http://localhost/cloud-callback");
  const cloudStatus = page.getByText("Setting up your cloud. This can take a few minutes…");
  await expect(cloudStatus).toBeVisible();
  expect(await cloudStatus.evaluate(element => getComputedStyle(element).fontSize)).toBe("14px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
});

for (const width of [360, 1024]) {
  for (const workspace of ["overview", "receipts"] as const) {
    test(`Mail ${workspace} ${width}px keeps long synthetic values within the frame`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width >= 768 ? 1000 : 852 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
      await page.route("http://localhost/mail-stress", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html class="light" data-workspace="${workspace}" data-stress="long"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      }));
      await page.goto("http://localhost/mail-stress");
      if (workspace === "overview") {
        // The Overview names the mailbox in its header chip, which shortens a long address instead of pushing past the frame.
        const chip = page.getByTestId("mail-account-chip");
        await expect(chip).toContainText("alexander.morgan.with.a.very.long.name@international-research-and-services.example");
        const box = (await chip.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      } else {
        await expect(page.getByText("Connected to alexander.morgan.with.a.very.long.name@international-research-and-services.example")).toBeVisible();
      }
      if (workspace === "receipts") {
        const merchant = page.getByText("The Very Long International Merchant and Services Group Limited", { exact: true });
        await expect(merchant).toBeVisible();
        await merchant.scrollIntoViewIfNeeded();
        expect((await merchant.boundingBox())!.x + (await merchant.boundingBox())!.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`mail-${workspace}-${width}-long.png`) });
    });
  }
}

for (const width of [393, 1440]) {
  test(`Private Mail summary and original at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.route("http://localhost/fixture.js", route => route.fulfill({ contentType: "application/javascript", body: script }));
    await page.route("http://localhost/mail-workspace", route => route.fulfill({
      contentType: "text/html",
      body: `<html data-summary-reader="1"><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
    }));
    await page.goto("http://localhost/mail-workspace");
    const body = page.getByTestId("brief-message-body");
    await expect(body).toContainText("Upload A by June 2.");
    await expect(body).toContainText("Ask Sam for B.");
    await expect(page.getByText(/Partial summary/)).toBeVisible();
    await expect(page.getByText("Reviewer", { exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "View original email" }).click();
    await expect(body).toContainText("Original excerpt");
    await expect(page.getByText(/Showing the available portion/)).toBeVisible();
  });
}
