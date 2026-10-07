import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-sync-hero-"));

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

  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
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
  css += fs
    .readdirSync(outDir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => fs.readFileSync(path.join(outDir, file), "utf8"))
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
    const expectedTitleFontSize =
      width >= 640 ? 44 : Math.min(34, Math.max(28, width * 0.082));
    expect(titleFontSize).toBeCloseTo(expectedTitleFontSize, 1);
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
