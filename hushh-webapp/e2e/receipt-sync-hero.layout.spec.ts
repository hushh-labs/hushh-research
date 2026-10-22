import { expect, test, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

let script: string;
let brandingScript: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDirs: string[] = [];

  for (const branding of [false, true]) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-sync-hero-"));
    outDirs.push(outDir);
    await build({
      build: {
        emptyOutDir: false,
        lib: {
          entry: path.join(root, "e2e/fixtures/receipt-sync-hero.tsx"),
          fileName: () => "fixture.js",
          formats: ["iife"],
          name: "Fixture",
        },
        outDir,
      },
      configFile: false,
      define: {
        "process.env": "{}",
        "process.env.NODE_ENV": JSON.stringify("production"),
        "process.env.NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE": JSON.stringify(
          branding ? "https://receipt-logo.test/{domain}.svg" : "",
        ),
      },
      logLevel: "error",
      oxc: { jsx: { runtime: "automatic" } },
      plugins: [
        {
          name: "fixture-css-candidates",
          transform(source, id) {
            if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
              for (const candidate of scanner.scanFiles([
                { content: source, extension: "tsx" },
              ])) {
                candidates.add(candidate);
              }
            }
          },
        },
      ],
      resolve: { alias: [{ find: "@", replacement: root }] },
    });

    const bundledScript = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    if (branding) brandingScript = bundledScript;
    else script = bundledScript;
  }
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs
      .readFileSync(path.join(root, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file =
          id === "tailwindcss"
            ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
              : path.resolve(base, id);
        return {
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
          path: file,
        };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
  css += outDirs.flatMap((outDir) => fs
    .readdirSync(outDir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => fs.readFileSync(path.join(outDir, file), "utf8")))
    .join("\n");
});

for (const width of [320, 390, 1440]) {
  test(`Receipt sync hero stays responsive and actionable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      height: width >= 1024 ? 832 : 900,
      width,
    });
    await page.route("http://localhost/receipt-sync-hero.js", (route) =>
      route.fulfill({
        body: script,
        contentType: "application/javascript; charset=utf-8",
      }),
    );
    await page.route("http://localhost/receipt-sync-hero-fixture", (route) =>
      route.fulfill({
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt sync onboarding fixture</title><style>${css}</style></head><body><div id="root"></div><script src="/receipt-sync-hero.js"></script></body></html>`,
        contentType: "text/html",
      }),
    );

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://localhost/receipt-sync-hero-fixture");
    await awaitProductFont(page);

    await expect(page).toHaveTitle("Receipt sync onboarding fixture");
    const hero = page.getByTestId("receipt-sync-hero");
    const title = page.getByRole("heading", { name: "Your receipts" });
    const cta = page.getByRole("button", { name: "Start sync" });
    const categories = page.getByRole("list", { name: "Receipt categories" });
    const categoryCard = categories.locator("..");
    const heroColumns = hero.locator(":scope > div").locator(":scope > div");
    const recent = page.getByTestId("recent-receipts");
    const receiptRows = recent.getByTestId("receipt-row");
    const status = page.getByTestId("receipt-sync-status");

    await expect(hero).toBeVisible();
    await expect(title).toBeVisible();
    await expect(cta).toBeVisible();
    await expect(categories).toBeVisible();
    await expect(recent).toBeVisible();
    await expect(
      recent.getByRole("heading", { name: "Recent receipts" }),
    ).toBeVisible();
    await expect(
      recent.getByRole("searchbox", { name: "Search table" }),
    ).toBeVisible();
    await expect(
      recent.getByRole("tablist", { name: "Receipt status filters" }),
    ).toBeVisible();
    await expect(
      recent.getByRole("tab", { name: "All", exact: true }),
    ).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(recent.getByText("OCTOBER 2026", { exact: true })).toBeVisible();
    await expect(
      recent.getByText("SEPTEMBER 2026", { exact: true }),
    ).toBeVisible();
    await expect(receiptRows).toHaveCount(10);
    await expect(recent.getByText("—")).toBeVisible();
    await expect(recent.getByText("Myntra")).toHaveCount(3);
    await expect(recent.getByText("ship-confirm", { exact: true })).toHaveCount(
      0,
    );
    await expect(recent.getByText(/MYNTRA-/)).toHaveCount(0);
    await expect(recent.locator('[data-logo-kind="category"]')).toHaveCount(9);
    await expect(recent.locator('[data-logo-kind="fallback"]')).toHaveCount(1);
    await expect(
      recent.getByRole("navigation", { name: /pagination/i }),
    ).toBeVisible();
    await expect(hero.getByRole("button")).toHaveCount(1);
    await expect(status).toHaveText("receipt sync not started");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);

    const heroBounds = (await hero.boundingBox())!;
    const titleBounds = (await title.boundingBox())!;
    const ctaBounds = (await cta.boundingBox())!;
    const ctaLabelBounds = (await cta
      .locator(":scope > span")
      .first()
      .boundingBox())!;
    const cardBounds = (await categoryCard.boundingBox())!;
    const recentBounds = (await recent.boundingBox())!;
    const titleFontSize = await title.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    await expect(heroColumns).toHaveCount(2);
    const copyColumnBounds = (await heroColumns.nth(0).boundingBox())!;
    const previewColumnBounds = (await heroColumns.nth(1).boundingBox())!;
    for (const control of [title, cta, categoryCard]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(heroBounds.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        heroBounds.x + heroBounds.width + 1,
      );
    }
    // "Your receipts" is defined as 0.8x the page title's own
    // --foundation-title1-size token (clamp(28px, 23.36px + 1.2vw, 40px)), so
    // it stays smaller than "Mail" at every width by construction.
    const pageTitleFontSize = Math.min(40, Math.max(28, 23.36 + 0.012 * width));
    const expectedTitleFontSize = pageTitleFontSize * 0.8;
    expect(titleFontSize).toBeCloseTo(expectedTitleFontSize, 1);
    expect(titleFontSize).toBeLessThan(pageTitleFontSize);
    expect(ctaBounds.height).toBe(50);
    expect(ctaBounds.width).toBeLessThanOrEqual(244);
    expect(ctaLabelBounds.x).toBeGreaterThanOrEqual(ctaBounds.x);
    expect(ctaLabelBounds.x + ctaLabelBounds.width).toBeLessThanOrEqual(
      ctaBounds.x + ctaBounds.width,
    );

    const orderedCategories = ["shopping", "dining", "travel"];
    for (const category of orderedCategories) {
      const row = page.getByTestId(`receipt-sync-category-${category}`);
      await expect(row).toBeVisible();
      const bounds = (await row.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(cardBounds.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        cardBounds.x + cardBounds.width + 1,
      );
    }
    await expect(categories.locator("li")).toHaveText([
      "Shopping",
      "Dining",
      "Travel",
    ]);

    // The compact iPhone reference keeps the category preview alongside the
    // copy and action, rather than pushing it below the CTA. Desktop follows
    // the same two-column reading order.
    expect(previewColumnBounds.x).toBeGreaterThan(copyColumnBounds.x);
    expect(previewColumnBounds.y).toBeLessThan(
      copyColumnBounds.y + copyColumnBounds.height,
    );
    expect(cardBounds.x).toBeGreaterThan(titleBounds.x);
    expect(cardBounds.y).toBeLessThan(ctaBounds.y + ctaBounds.height);
    expect(recentBounds.y).toBeGreaterThanOrEqual(
      heroBounds.y + heroBounds.height,
    );

    const rowBackgrounds = await receiptRows.evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).backgroundColor),
    );
    expect(new Set(rowBackgrounds).size).toBe(1);

    const paymentFailedBadge = recent.locator(
      '[data-receipt-status="payment_failed"]',
    );
    const paymentFailedRow = paymentFailedBadge.locator(
      'xpath=ancestor::button[@data-testid="receipt-row"]',
    );
    const paymentFailedMerchant = paymentFailedRow.getByText("Amazon", {
      exact: true,
    });
    const paymentFailedAmount = paymentFailedRow.getByText("₹299.00", {
      exact: true,
    });
    await expect(paymentFailedBadge).toBeVisible();
    const failedRowBounds = (await paymentFailedRow.boundingBox())!;
    const failedBadgeBounds = (await paymentFailedBadge.boundingBox())!;
    const failedMerchantBounds = (await paymentFailedMerchant.boundingBox())!;
    const failedAmountBounds = (await paymentFailedAmount.boundingBox())!;
    if (width >= 390) {
      expect(
        Math.abs(
          failedBadgeBounds.y + failedBadgeBounds.height / 2 -
            (failedMerchantBounds.y + failedMerchantBounds.height / 2),
        ),
      ).toBeLessThanOrEqual(2);
    }
    expect(failedBadgeBounds.x + failedBadgeBounds.width).toBeLessThanOrEqual(
      failedRowBounds.x + failedRowBounds.width,
    );
    expect(failedAmountBounds.x + failedAmountBounds.width).toBeLessThanOrEqual(
      failedRowBounds.x + failedRowBounds.width,
    );

    await page.screenshot({
      path: testInfo.outputPath(`receipt-sync-hero-${width}.png`),
    });

    const selectedReceiptRow = receiptRows.filter({ hasText: "849.00" });
    await expect(selectedReceiptRow).toHaveCount(1);
    await selectedReceiptRow.scrollIntoViewIfNeeded();
    const listScrollPosition = await page.evaluate(() => window.scrollY);
    await selectedReceiptRow.click();
    const receiptDetail = page.getByRole("dialog");
    await expect(receiptDetail).toBeVisible();
    await expect(
      receiptDetail.getByText("MYNTRA-2", { exact: true }),
    ).toBeVisible();
    await expect(
      receiptDetail.getByText("Stored email preview for MYNTRA-2"),
    ).toBeVisible();
    await expect(
      receiptDetail.getByText("Email preview", { exact: true }),
    ).toBeVisible();
    await expect(
      receiptDetail.getByText("MYNTRA-1", { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`receipt-detail-${width}.png`),
    });
    await receiptDetail
      .getByRole("button", {
        name: width < 768 ? "Close" : "Close detail panel",
        exact: true,
      })
      .click();
    await expect(receiptDetail).toBeHidden();
    expect(await page.evaluate(() => window.scrollY)).toBe(listScrollPosition);
    await expect(selectedReceiptRow).toBeFocused();

    const receiptSearch = recent.getByRole("searchbox", {
      name: "Search table",
    });
    await receiptSearch.fill("unknown");
    await expect(recent.getByText("Receipt", { exact: true })).toBeVisible();
    await expect(recent.getByText("Myntra")).toHaveCount(0);
    await receiptSearch.fill("");
    await expect(recent.getByText("Myntra")).toHaveCount(3);

    await recent.getByRole("tab", { name: "Paid", exact: true }).click();
    await expect(receiptRows).toHaveCount(3);
    await expect(
      recent.locator('[data-receipt-status="paid"]').first(),
    ).toHaveClass(/app-success-tint/);

    await recent.getByRole("tab", { name: "Due", exact: true }).click();
    await expect(receiptRows).toHaveCount(0);
    await expect(recent.getByText("No receipts match this view.")).toBeVisible();

    await recent.getByRole("tab", { name: "Overdue", exact: true }).click();
    await expect(receiptRows).toHaveCount(1);
    await expect(
      recent.locator('[data-receipt-status="overdue"]'),
    ).toHaveClass(/app-destructive-tint/);

    await recent.getByRole("tab", { name: "Upcoming", exact: true }).click();
    await expect(receiptRows).toHaveCount(2);

    await recent.getByRole("tab", { name: "Cancelled", exact: true }).click();
    await expect(receiptRows).toHaveCount(2);

    await recent.getByRole("tab", { name: "All", exact: true }).click();
    await expect(receiptRows).toHaveCount(10);
    await recent.getByRole("button", { name: "Next" }).click();
    await expect(recent.getByText("2 / 2")).toBeVisible();
    await expect(receiptRows).toHaveCount(1);

    await cta.click();
    await expect(status).toHaveText("receipt sync started");
    const scanningCta = hero.getByRole("button", { name: "Scanning" });
    await expect(scanningCta).toBeDisabled();
    await expect(hero.getByText("Looking through your recent purchases…")).toBeVisible();
    await expect(hero).not.toContainText(/page \d|\d of \d|candidate|request count/i);
    const progress = hero.getByRole("progressbar");
    await expect(progress).toHaveAttribute("aria-valuenow", "4");
    await expect(progress).toHaveAttribute("aria-valuetext", "Scanning");
    const scanBounds = (await scanningCta.boundingBox())!;
    const scanLabelBounds = (await scanningCta.locator(":scope > span").first().boundingBox())!;
    expect(scanLabelBounds.x).toBeGreaterThanOrEqual(scanBounds.x);
    expect(scanLabelBounds.x + scanLabelBounds.width).toBeLessThanOrEqual(scanBounds.x + scanBounds.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await hero.screenshot({path: testInfo.outputPath(`receipt-scanning-${width}.png`)});
    expect(errors).toEqual([]);
  });
}

async function openBrandingFixture(page: Page, reference = false): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  await page.route("http://localhost/receipt-branding.js", (route) => route.fulfill({
    body: brandingScript,
    contentType: "application/javascript; charset=utf-8",
  }));
  await page.route("http://localhost/receipt-branding-fixture?*", (route) => route.fulfill({
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt merchant branding fixture</title><style>${css}</style></head><body><div id="root"></div><script src="/receipt-branding.js"></script></body></html>`,
    contentType: "text/html",
  }));
  await page.goto(`http://localhost/receipt-branding-fixture?branding=true&reference=${reference}`, {
    waitUntil: "domcontentloaded",
  });
  await awaitProductFont(page);
  await expect(page).toHaveTitle("Receipt merchant branding fixture");
  await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
  await expect(page.locator("nextjs-portal, vite-error-overlay")).toHaveCount(0);
  return errors;
}

async function closeReceiptDetail(page: Page, width: number): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", {
    name: width < 768 ? "Close" : "Close detail panel",
    exact: true,
  }).click();
  await expect(dialog).toBeHidden();
}

async function assertNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) {
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    const detail = dialog.getByTestId("receipt-detail");
    expect(await detail.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
}

// This deliberately non-brand image exercises decoded-image geometry only.
// Official-logo visual evidence is captured separately from an authenticated
// official asset kept outside source control, never this synthetic response.
const decodedImageFixture = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="#ddd"/><text x="18" y="20" text-anchor="middle" font-size="6">fixture</text></svg>';
const brandingHeaders = { "access-control-allow-origin": "*" };

for (const width of [320, 390, 1440]) {
  test(`Reviewed receipt brands preserve row and detail interactions at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width >= 1024 ? 1000 : 844 });
    await context.route("https://receipt-logo.test/**", (route) => route.fulfill({
      body: decodedImageFixture,
      contentType: "image/svg+xml",
      headers: brandingHeaders,
    }));
    await context.route("https://plaid.com/", (route) => route.fulfill({
      body: "<!doctype html><title>Reviewed Plaid homepage</title><p>Homepage navigation proof</p>",
      contentType: "text/html",
    }));
    await page.addInitScript(() => {
      const realOpen = window.open.bind(window);
      const attempts: unknown[][] = [];
      Object.assign(window, { receiptOpenAttempts: attempts });
      window.open = (url, target, features) => {
        attempts.push([url, target, features]);
        return realOpen(url, target, features);
      };
    });
    const errors = await openBrandingFixture(page);
    const rows = page.getByTestId("receipt-row");
    await expect(rows).toHaveCount(10);
    const reviewedBrands = [
      ["Plaid", "plaid.com"], ["Supabase", "supabase.com"],
      ["Amazon", "amazon.com"], ["Kyari", "kyari.co"],
      ["Anthropic", "anthropic.com"], ["Google Play", "play.google.com"],
      ["IndiGo", "goindigo.in"],
    ];
    for (const [index, [name, domain]] of reviewedBrands.entries()) {
      const row = rows.nth(index);
      await expect(row.getByText(name!, { exact: true })).toBeVisible();
      await expect(row.locator('[data-logo-kind="brand"] img')).toHaveAttribute("src", `https://receipt-logo.test/${domain}.svg`);
      expect(await row.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await expect(row.locator("a, button, [role=link], [tabindex]")).toHaveCount(0);
    }

    const plaid = rows.nth(0);
    const originalBounds = (await plaid.boundingBox())!;
    const logo = plaid.locator('[data-slot="receipt-merchant-logo"]');
    const logoBounds = (await logo.boundingBox())!;
    const badge = plaid.locator('[data-receipt-status="payment_failed"]');
    const amount = plaid.locator(":scope > span").last();
    const badgeBounds = (await badge.boundingBox())!;
    const amountBounds = (await amount.boundingBox())!;
    expect(logoBounds.width).toBe(36);
    expect(logoBounds.height).toBe(36);
    expect(originalBounds.height).toBeGreaterThanOrEqual(58);
    const initialUrl = page.url();

    // A press on the logo bubbles to the existing row button.
    await logo.click();
    const dialog = page.getByRole("dialog");
    const detail = dialog.getByTestId("receipt-detail");
    await expect(detail).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Plaid", exact: true })).toBeVisible();
    await expect(dialog.locator('[data-logo-kind="brand"] img')).toHaveAttribute("src", "https://receipt-logo.test/plaid.com.svg");
    await expect(detail.locator("dl dt")).toHaveText([
      "Amount", "Status", "Attention", "Category", "Document", "Recurrence",
      "Invoice", "Details", "Date", "Received", "Confidence", "Sender", "Subject",
    ]);
    await expect(detail.locator("dl dd").nth(0)).toHaveText("Not available");
    await expect(detail.locator("dl dd").nth(1)).toHaveText("Payment failed");
    await expect(detail.locator("dl dd").nth(2)).toHaveText("Payment failed");
    await expect(detail.locator("dl dd").nth(6)).toHaveText("PLAID-FIXTURE-2609");
    await expect(detail.locator("dl dd").nth(10)).toHaveText("95%");
    await expect(detail.getByText("Email preview", { exact: true })).toBeVisible();
    const visit = detail.getByRole("button", { name: "Visit merchant", exact: true });
    await expect(visit).toBeVisible();
    expect(await visit.evaluate((element) => element.closest('[data-testid="receipt-detail"]')!.lastElementChild!.contains(element))).toBe(true);
    expect(await detail.innerText()).not.toMatch(/https?:\/\/|View invoice|View receipt|Pay now|Resolve payment|Open original email/);
    expect(page.url()).toBe(initialUrl);
    expect(context.pages()).toHaveLength(1);
    await assertNoHorizontalOverflow(page, width);

    const popupPromise = context.waitForEvent("page");
    await visit.click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url()).toBe("https://plaid.com/");
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { receiptOpenAttempts: unknown[][] }).receiptOpenAttempts)).toEqual([
      ["https://plaid.com", "_blank", "noopener,noreferrer"],
    ]);
    await popup.close();
    await expect(dialog).toBeVisible();
    await closeReceiptDetail(page, width);
    await expect(plaid).toBeFocused();
    expect((await plaid.boundingBox())!.height).toBe(originalBounds.height);

    // The merchant label is also part of that single row tap target.
    await plaid.getByText("Plaid", { exact: true }).click();
    await expect(detail).toBeVisible();
    expect(page.url()).toBe(initialUrl);
    expect(context.pages()).toHaveLength(1);
    await closeReceiptDetail(page, width);

    for (const [index, kind] of [[7, "category"], [8, "fallback"], [9, "category"]] as const) {
      const row = rows.nth(index);
      await expect(row.locator(`[data-logo-kind="${kind}"]`)).toBeVisible();
      await expect(row.locator("img")).toHaveCount(0);
      await row.click();
      await expect(detail).toBeVisible();
      await expect(detail.getByRole("button", { name: "Visit merchant", exact: true })).toHaveCount(0);
      await assertNoHorizontalOverflow(page, width);
      await closeReceiptDetail(page, width);
    }
    // Even a loaded asset that later fails keeps the category fallback in the
    // same fixed slot, without changing the amount, badge or full row target.
    await plaid.locator("img").evaluate((image) => image.dispatchEvent(new Event("error")));
    await expect(plaid.locator('[data-logo-kind="category"]')).toBeVisible();
    expect((await plaid.boundingBox())!.height).toBe(originalBounds.height);
    expect((await logo.boundingBox())!.width).toBe(logoBounds.width);
    expect((await logo.boundingBox())!.height).toBe(logoBounds.height);
    expect((await badge.boundingBox())!.x).toBe(badgeBounds.x);
    expect((await amount.boundingBox())!.x).toBe(amountBounds.x);
    expect(errors).toEqual([]);
  });
}

for (const failure of ["404", "timeout"] as const) {
  test(`Receipt logo ${failure} preserves its fallback, row and detail sheet`, async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (failure === "timeout") await page.clock.install();
    await context.route("https://receipt-logo.test/**", async (route) => {
      if (failure === "404") await route.fulfill({ status: 404, headers: brandingHeaders });
      // Keep the request unanswered to prove the app's timeout fallback.
    });
    const errors = await openBrandingFixture(page, true);
    const row = page.getByTestId("receipt-row");
    const initialBounds = (await row.boundingBox())!;
    if (failure === "timeout") await page.clock.fastForward(5100);
    await expect(row.locator('[data-logo-kind="category"]')).toBeVisible();
    await expect(row.getByText("Plaid", { exact: true })).toBeVisible();
    expect((await row.boundingBox())!.height).toBe(initialBounds.height);
    await row.click();
    if (failure === "timeout") await page.clock.fastForward(5100);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("receipt-detail")).toBeVisible();
    await expect(dialog.locator('[data-logo-kind="category"]')).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Visit merchant", exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page, 390);
    expect(errors).toEqual([]);
  });
}

async function saveBrandingEvidence(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const destination = process.env.RECEIPT_QA_SCREENSHOT_DIR;
  if (!destination) return;
  fs.mkdirSync(destination, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(destination, `${label}-${testInfo.project.name}.png`) });
}

for (const width of process.env.RECEIPT_QA_PLAID_LOGO_PATH ? [390, 1440] : []) {
  test(`Official Plaid asset visual evidence at ${width}px`, async ({ page, context }, testInfo) => {
    const officialAsset = process.env.RECEIPT_QA_PLAID_LOGO_PATH;
    // Local review supplies https://plaid.com/assets/img/favicons/apple-touch-icon.png
    // linked from Plaid's official homepage. The asset is not committed.
    await page.setViewportSize({ width, height: width >= 1024 ? 1000 : 844 });
    await context.route("https://receipt-logo.test/plaid.com.svg", (route) => route.fulfill({
      body: fs.readFileSync(officialAsset!), contentType: "image/png", headers: brandingHeaders,
    }));
    const errors = await openBrandingFixture(page, true);
    const row = page.getByTestId("receipt-row");
    await expect(row.locator('[data-logo-kind="brand"]')).toBeVisible();
    expect(await row.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 180)).toBe(true);
    await saveBrandingEvidence(page, testInfo, `receipt-branding-${width}-list`);
    await row.click();
    const dialog = page.getByRole("dialog");
    const detail = dialog.getByTestId("receipt-detail");
    await expect(detail).toBeVisible();
    await saveBrandingEvidence(page, testInfo, `receipt-branding-${width}-detail-header`);
    const visit = detail.getByRole("button", { name: "Visit merchant", exact: true });
    await visit.scrollIntoViewIfNeeded();
    await expect(visit).toBeVisible();
    await saveBrandingEvidence(page, testInfo, `receipt-branding-${width}-detail-footer`);
    await assertNoHorizontalOverflow(page, width);
    expect(errors).toEqual([]);
  });
}


for (const nested of [false, true]) {
  test(`returning receipts retain focus, row identity and scroll while updating (${nested ? "app" : "document"} scroll)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("http://localhost/receipt-return**", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${nested ? "html,body{height:100%;overflow:hidden}.test-scroll{height:100dvh;overflow:auto}" : "html,body{height:auto;overflow:visible}"}</style></head><body><div ${nested ? 'class="test-scroll" data-app-scroll-root="true"' : ""}><div id="root"></div></div><script src="/receipt-return.js"></script></body></html>`,
    }));
    // The more specific script route must win over the document wildcard.
    await page.route("http://localhost/receipt-return.js", route => route.fulfill({ body: script, contentType: "application/javascript" }));
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://localhost/receipt-return?returning=true"); await awaitProductFont(page);
    await expect(page.getByTestId("receipt-sync-toolbar")).toBeVisible();
    await expect(page.getByTestId("receipt-sync-hero")).toHaveCount(0);
    const toolbar = page.getByTestId("receipt-sync-toolbar");
    await expect(page.getByRole("button", { name: /Start sync|Refresh/ })).toHaveCount(0);
    const overview = page.getByRole("heading", { name: "Overview", exact: true });
    const beforeHeight = await overview.locator("..").evaluate(element => element.getBoundingClientRect().height);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(toolbar).toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("Checking for new receipts…")).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search table" });
    await search.focus();
    await page.evaluate(() => {
      const root = document.querySelector('[data-app-scroll-root="true"]') ?? document.scrollingElement!;
      const row = document.querySelector('[data-receipt-row-id]')!;
      root.scrollTop += row.getBoundingClientRect().top - (root === document.scrollingElement ? 0 : root.getBoundingClientRect().top) - 40;
      (window as unknown as { oldReceipt: Element }).oldReceipt = row;
    });
    expect(await page.evaluate(() => (document.querySelector('[data-app-scroll-root="true"]') ?? document.scrollingElement!).scrollTop)).toBeGreaterThan(0);
    const anchor = await page.evaluate(() => (window as unknown as { oldReceipt: Element }).oldReceipt.getBoundingClientRect().top);
    await page.evaluate(() => (window as unknown as { finishReceiptRefresh: () => void }).finishReceiptRefresh());
    await expect(toolbar).toHaveAttribute("aria-busy", "false");
    await expect(search).toBeFocused();
    expect(await page.evaluate(() => {
      const row = (window as unknown as { oldReceipt: Element }).oldReceipt;
      return row.isConnected && row === document.querySelector('[data-receipt-row-id]');
    })).toBe(true);
    expect(Math.abs(await page.evaluate(() => (window as unknown as { oldReceipt: Element }).oldReceipt.getBoundingClientRect().top) - anchor)).toBeLessThanOrEqual(1);
    expect(await overview.locator("..").evaluate(element => element.getBoundingClientRect().height)).toBe(beforeHeight);
    await expect(page.getByText("2 / 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
    await expect(page.getByTestId("receipt-row").filter({ hasText: "New merchant" })).toHaveCount(10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.evaluate(() => { const root = document.querySelector('[data-app-scroll-root="true"]') ?? document.scrollingElement!; root.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("returning-receipts.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
}
