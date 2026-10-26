import { expect, test, type Page } from "@playwright/test";
import { awaitProductFont } from "./fixtures/product-font";
import { buildPersonProfileBrowserFixture, type PersonProfileBrowserFixture } from "./fixtures/person-profile-browser";

let fixture: PersonProfileBrowserFixture | undefined;
let css: string;
let requestScript: string;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixture = await buildPersonProfileBrowserFixture({ includePresentation: false });
  ({ css, requestScript } = fixture);
});
test.afterAll(() => fixture?.dispose());

async function openFinancialPackets(page: Page, width: number, mode: "owner" | "connect" | "pending" | "request", zoom = 1) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: width === 320 ? 568 : width === 375 ? 812 : 900 });
  await page.route("https://profile-fixture.test/?*", route => route.fulfill({ contentType: "text/html",
    body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto(`https://profile-fixture.test/?packets=${mode}`);
  await page.addScriptTag({ content: requestScript });
  if (zoom !== 1) await page.evaluate(scale => { document.documentElement.style.zoom = String(scale); }, zoom);
  await awaitProductFont(page);
  return errors;
}

async function expectFinancialRowsFit(page: Page) {
  const geometry = await page.locator('[data-testid="settings-row"]').evaluateAll(rows => rows.filter(row => row.getClientRects().length).map(row => {
    const rect = row.getBoundingClientRect(), title = row.querySelector('[data-slot="settings-row-title"]')!;
    const range = document.createRange(); range.selectNodeContents(title);
    const titleRect = range.getBoundingClientRect();
    return { title: title.textContent, rowLeft: rect.left, rowRight: rect.right, titleLeft: titleRect.left,
      titleRight: titleRect.right, titleBottom: titleRect.bottom, rowBottom: rect.bottom,
      overflow: row.scrollWidth - row.clientWidth, control: row.tagName === "BUTTON", height: rect.height,
      zoom: Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1 };
  }));
  for (const row of geometry) {
    expect(row.overflow, row.title ?? "row overflow").toBeLessThanOrEqual(1);
    expect(row.titleLeft, row.title ?? "title left").toBeGreaterThanOrEqual(row.rowLeft - 1);
    expect(row.titleRight, row.title ?? "title right").toBeLessThanOrEqual(row.rowRight + 1);
    expect(row.titleBottom, row.title ?? "title bottom").toBeLessThanOrEqual(row.rowBottom + 1);
    if (row.control) expect(row.height / row.zoom, row.title ?? "touch target").toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

for (const [width, zoom] of [[320, 1], [375, 1], [1440, 1], [1440, 0.67]] as const) {
  test(`financial packet owner counts and profile controls fit ${width}px at ${Math.round(zoom * 100)} percent`, async ({ page }, testInfo) => {
    const errors = await openFinancialPackets(page, width, "owner", zoom);
    const root = page.getByRole("region", { name: "Owner financial packets", exact: true });
    const toggle = root.getByRole("switch", { name: "Show on profile", exact: true });
    await expect(toggle).toBeChecked();
    await expect(root.getByRole("switch")).toHaveCount(1);
    await root.getByRole("button", { name: "Open Financial documents", exact: true }).click();
    const back = root.getByRole("button", { name: "Back to all categories", exact: true });
    await expect(back).toBeVisible();
    const title = back.locator('[data-slot="settings-row-title"]');
    expect(await title.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map(rect => rect.top)).size;
    })).toBe(1);
    const period = root.getByRole("button", { name: /Jul–Aug 2026 · 51 files/ });
    await expect(period).toBeVisible();
    await expect(period).toContainText("Files found");
    await expect(period).not.toContainText("0 files");
    await expectFinancialRowsFit(page);
    await page.screenshot({ path: testInfo.outputPath("financial-owner.png"), fullPage: true });
    await period.click();
    const detail = page.getByRole("dialog");
    await expect(detail).toContainText("Synthetic private statement.pdf");
    await expect(detail.getByRole("button", { name: /List for|Request for|Change price|Hide public summary/ })).toHaveCount(0);
    await page.evaluate(() => window.packetProof.refresh());
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Synthetic private statement.pdf");
    expect(await page.evaluate(() => window.packetProof.back())).toBe(true);
    await expect(detail).toBeHidden();
    await expect(period).toBeFocused();
    // Same selected category and count survive the warm refresh and detail Back.
    await expect(period).toBeVisible();
    expect(await page.evaluate(() => window.packetProof.back())).toBe(true);
    await expect(root.getByRole("button", { name: "Open Financial documents", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.packetProof.writes)).toEqual(["prepare-preview"]);
    expect(errors).toEqual([]);
  });

  test(`financial packet profile has one public path at ${width}px at ${Math.round(zoom * 100)} percent`, async ({ page }, testInfo) => {
    const errors = await openFinancialPackets(page, width, "connect", zoom);
    const profile = page.getByRole("region", { name: "Person financial packets", exact: true });
    const summaries = profile.getByRole("region", { name: "Financial documents", exact: true });
    await expect(summaries).toHaveCount(1);
    await expect(profile.getByRole("button", { name: "Financial documents", exact: true })).toHaveCount(0);
    await expect(profile.getByRole("button", { name: "Available packets", exact: true })).toHaveCount(0);
    const period = summaries.getByRole("button", { name: /Jul–Aug 2026/ });
    await expect(period).toContainText("51 search matches");
    await expect(period).toContainText("$5");
    await expect(period).toContainText("one-time");
    await expectFinancialRowsFit(page);
    await page.screenshot({ path: testInfo.outputPath("financial-profile.png"), fullPage: true });
    await period.click();
    const detail = page.getByRole("dialog", { name: "Financial documents", exact: true });
    await expect(detail).toContainText("51 search matches");
    await expect(detail.getByRole("button", { name: /Request for|Buy for|Pay/ })).toHaveCount(0);
    await expect(detail).not.toContainText("Synthetic private statement.pdf");
    expect(await detail.locator('a[href*="drive.google.com"], a[href*="docs.google.com"]').count()).toBe(0);
    const connect = detail.getByRole("button", { name: "Connect to request", exact: true });
    await expect(connect).toBeInViewport();
    // The shared sheet enters from below the viewport; measure its settled seat.
    await expect.poll(() => connect.evaluate(el => el.getBoundingClientRect().bottom - innerHeight)).toBeLessThanOrEqual(0);
    const cta = await connect.evaluate(el => {
      const box = el.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el);
      const text = range.getBoundingClientRect(), scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      return { left: box.left, right: box.right, bottom: box.bottom, height: box.height / scale,
        textLeft: text.left, textRight: text.right, textBottom: text.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    expect(cta.left).toBeGreaterThanOrEqual(0); expect(cta.right).toBeLessThanOrEqual(cta.viewportWidth);
    expect(cta.bottom).toBeLessThanOrEqual(cta.viewportHeight);
    expect(cta.height).toBeGreaterThanOrEqual(44);
    expect(cta.textLeft).toBeGreaterThanOrEqual(cta.left); expect(cta.textRight).toBeLessThanOrEqual(cta.right);
    expect(cta.textBottom).toBeLessThanOrEqual(cta.bottom);
    await expectFinancialRowsFit(page);
    await page.screenshot({ path: testInfo.outputPath("financial-profile-detail.png"), fullPage: true });
    await connect.click();
    await expect(detail).toContainText("Request sent");
    await expect(detail.getByRole("button", { name: /Connect to request|Request for/ })).toHaveCount(0);
    expect(await page.evaluate(() => window.packetProof.writes)).toEqual(["connect"]);
    expect(await page.evaluate(() => window.packetProof.reads.includes("private-buyer"))).toBe(false);
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
    await expect(period).toBeFocused();
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 375]) test(`financial packet connected profile uses one sale request and never charges at ${width}px`, async ({ page }, testInfo) => {
  const errors = await openFinancialPackets(page, width, "request");
  const profile = page.getByRole("region", { name: "Person financial packets", exact: true });
  const period = profile.getByRole("button", { name: /Jul–Aug 2026/ });
  await expect(period).toHaveCount(1);
  await expect(profile.getByRole("heading", { name: "Available packets", exact: true })).toHaveCount(0);
  await period.click();
  const privateDetail = page.getByRole("dialog");
  await expect(privateDetail).toContainText("7 documents");
  await expect(privateDetail).toContainText("You pay after Aarav Sharma approves.");
  const request = privateDetail.getByRole("button", { name: "Request for $5", exact: true });
  await expect(request).toHaveCount(1);
  expect(await page.evaluate(() => window.packetProof.writes)).toEqual([]);
  await expect.poll(() => request.evaluate(el => el.getBoundingClientRect().bottom - innerHeight)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("financial-private-request.png"), fullPage: true });
  await request.click();
  await expect(privateDetail.getByRole("link", { name: "View request", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.packetProof.writes)).toEqual(["request"]);
  await expect(privateDetail).not.toContainText("Synthetic private statement.pdf");
  expect(errors).toEqual([]);
});
