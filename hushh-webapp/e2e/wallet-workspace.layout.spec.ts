import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { measureTabSelection } from "./fixtures/tab-motion";
import { openWalletSharingReview } from "./fixtures/wallet-sharing-review";
import path from "node:path";
import type { WalletCardPayload } from "../lib/services/wallet-card-service";
import { createEncryptedCardFile } from "../lib/wallet/wallet-card-file";
import { awaitProductFont } from "./fixtures/product-font";
import { buildWalletWorkspaceFixture } from "./fixtures/wallet-workspace-build";
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../components/app-ui/signed-in-shell-content-offset";

/** Production Wallet with inert service boundaries: entry artwork/CTA fit, shared
 * workspace header geometry, collection motion/geometry, and direct Add flow. */

const ISO_RATIO = 85.6 / 53.98;
const BOTTOM_SHELL_HEIGHT_PX = 132;



let css = "";
let script = "";
let walletHero: Buffer;

// Geometry and navigation measure settled UI; the spring cases opt back into motion.
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: "reduce" }); });

test.beforeAll(async () => {
  ({ css, script, walletHero } = await buildWalletWorkspaceFixture(process.cwd()));
});

type Scenario = { cards?: number; networkCards?: boolean; locked?: boolean; delayMs?: number; cardsPending?: boolean; sharingStatePending?: boolean; saveDelayMs?: number; deletePending?: boolean; profile?: WalletCardPayload; artworkGallery?: boolean; sharingHistory?: boolean; revokeFailure?: boolean; cardRequest?: boolean; walletWideDetails?: boolean };

const PROBES = `
window.__walletFrames = [];
window.__walletCls = 0;
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__walletCls += entry.value;
  }).observe({ type: "layout-shift", buffered: true });
} catch {}
window.__sampleWallet = (ms) => {
  const start = performance.now();
  window.__walletFrames = [];
  const rect = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const step = () => {
    const cards = [...document.querySelectorAll('[data-testid="wallet-card"]')].map((li) => {
      const transform = getComputedStyle(li).transform;
      const y = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
      return { y, o: Number(getComputedStyle(li).opacity) };
    });
    window.__walletFrames.push({
      t: performance.now() - start,
      title: rect('[data-testid="top-app-bar-breadcrumb-trail"]'),
      introduction: rect('[data-testid="one-wallet-loading"]'),
      face: rect('[data-testid="wallet-card-face"]'),
      cards,
    });
    if (performance.now() - start < ms) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
`;

type FixtureOptions = { height?: number; shell?: boolean; secure?: boolean; reader?: boolean };

function inlineStyle(style: Record<string, unknown>): string {
  return Object.entries(style)
    .map(([name, value]) => `${name}: ${String(value)};`)
    .join(" ");
}

function shellMarkup(): string {
  const offset = resolveSignedInShellContentOffset({
    shellVisible: true,
    routeLayoutMode: "standard",
    localOffset: "0px",
  });
  const shellStyle = inlineStyle({
    ...offset.style,
    ...resolveTopShellGeometryStyle({ hasTabs: false }),
    "--app-bottom-shell-height": `${BOTTOM_SHELL_HEIGHT_PX}px`,
    "--bottom-chrome-stack-height": "var(--app-bottom-shell-height)",
    "--app-scroll-bottom-pad": "var(--bottom-chrome-stack-height)",
  });

  return `<div data-app-shell-root="true" style="${shellStyle}; position: fixed; inset: 0; display: flex; flex-direction: column;">
    <div
      data-app-scroll-root="true"
      style="flex: 1 1 0%; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-bottom: var(--app-scroll-bottom-pad);"
    >
      <div data-app-shell-top-spacer="true" aria-hidden></div>
      <div data-app-shell-content="true" style="min-height: 0;"><div id="root"></div></div>
    </div>
    <div
      data-bottom-chrome
      style="position: fixed; inset-inline: 0; bottom: 0; height: var(--bottom-chrome-stack-height);"
    ></div>
  </div>`;
}

async function open(
  page: Page,
  width: number,
  theme: string,
  scenario: Scenario = {},
  options: FixtureOptions = {},
) {
  const { height = 852, shell = false, secure = false, reader = false } = options;
  await page.setViewportSize({ width, height });
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error("Wallet layout fixture:", error.message); });
  const origin = secure ? "https://wallet-fixture.test" : "http://wallet-fixture.local";
  await page.route(`${origin}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    const assetPath = requestUrl.searchParams.get("url") ?? requestUrl.pathname;
    if (assetPath === "/wallet/apple-wallet-transparent-v1.png") {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: "image/png" });
      return;
    }
    if (assetPath === "/wallet/wallet-cards-hero.webp") {
      await route.fulfill({ body: walletHero, contentType: "image/webp" });
      return;
    }
    if (assetPath === "/wallet/card-scan-complete-v4.webp") {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: "image/webp" });
      return;
    }
    if (/^\/wallet\/artwork\/(profile|referral|nws)-v[123]\.svg$/.test(assetPath)) {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: "image/svg+xml" });
      return;
    }
    if (/^\/brand\/cards\/[a-z]+(?:-[a-z]+)*\.(svg|png)$/.test(assetPath)) {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: assetPath.endsWith(".svg") ? "image/svg+xml" : "image/png" });
      return;
    }
    await route.abort();
  });
  const fixture = shell ? shellMarkup() : '<div id="root"></div>';
  const html = `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><base href="${origin}/"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" data-ambient-chrome-primed="true" style="margin:0">${fixture}</body></html>`;
  await page.route(`${origin}/`, route => route.fulfill({ body: html, contentType: "text/html" }));
  await page.goto(`${origin}/`);
  await awaitProductFont(page);
  await page.addScriptTag({ content: `window.__walletScenario = ${JSON.stringify(scenario)};${PROBES}` });
  if (reader) await page.addScriptTag({ content: "window.__encryptedCardReader = true;" });
  return errors;
}

async function mount(page: Page, enter = true) {
  await page.addScriptTag({ content: script });
  await expect(page.locator("#root")).not.toBeEmpty();
  const next = page.getByRole("button", { name: "Continue", exact: true });
  if (enter) { await expect(next).toBeVisible(); await next.click(); }
}

for (const width of [390, 1024]) {
  test(`tab clicks settle without a spring overshoot at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if (width === 1024) await page.clock.install();
    const errors = await open(page, width, "light", { cards: 3 }, { shell: true });
    await page.addScriptTag({ content: "window.__walletPagerOnly = true;" });
    await mount(page, false);
    await expect(page.getByRole("tabpanel", { name: "Cards", exact: true })).toBeVisible();
    if (width === 1024) await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
    const add = page.getByRole("tab", { name: "Add", exact: true });
    // Bound delayed startup on the animation clock; keep ordinary mobile motion
    // on real time. Both cases observe the shipping spring and DOM geometry.
    const { frames, rendering } = await measureTabSelection(add, width === 1024 ? 150 : 0,
      width === 1024 ? () => page.clock.runFor(816) : undefined);
    const diagnostics = JSON.stringify({ ...rendering, frameCount: frames.length,
      maxFrameGap: Math.max(...frames.map((frame, index) => frame.time - (frames[index - 1]?.time ?? 0))),
      first: frames.slice(0, 3), last: frames.slice(-3) });
    const arrived = frames.find((frame, index) => Math.abs(frame.offset) < 3 && frames.slice(index).every((later) => Math.abs(later.offset) < 3));
    expect(arrived, `the selected pane must arrive: ${diagnostics}`).toBeDefined();
    expect(arrived!.time, `tab presses should not wait out the drag spring: ${diagnostics}`).toBeLessThan(400);
    expect(Math.min(...frames.map((frame) => frame.offset)), `the pane must not overshoot its snap: ${diagnostics}`).toBeGreaterThanOrEqual(-3);
    expect(frames.some(frame => frame.offset > 3 && frame.offset < rendering.viewportWidth - 3), `tab selection must animate rather than jump: ${diagnostics}`).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
  test(`Wallet uses one shell reserve and keeps its own column at ${width}px`, async ({ page }, testInfo) => {
    await open(page, width, "light", {}, { shell: true });
    await mount(page);
    await expect(page.getByRole("tab", { name: "My cards", exact: true })).toBeEnabled();
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
      };
      const tabs = Array.from(document.querySelectorAll('[data-top-shell-tab-set="wallet"] [data-ui-role="agent-tab-label"]'));
      return {
        spacer: box('[data-app-shell-top-spacer]'),
        workspace: box('[data-wallet-hub]'),
        tablist: box('[role="tablist"]'),
        tabStyles: tabs.map(tab => ({ size: getComputedStyle(tab).fontSize, line: getComputedStyle(tab).lineHeight })),
        duplicateHeader: Boolean(document.querySelector('[data-wallet-hub] [data-slot="page-header"]')),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(geometry.duplicateHeader).toBe(false);
    expect(geometry.workspace.width).toBeLessThanOrEqual(1080);
    expect(Math.abs(geometry.workspace.x - (width - geometry.workspace.width) / 2)).toBeLessThanOrEqual(1);
    expect(geometry.tablist.y).toBeGreaterThanOrEqual(geometry.spacer.bottom - 1);
    expect(geometry.tabStyles).toEqual(Array(2).fill({ size: "15px", line: "20px" }));
    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("wallet-card-browser")).toHaveCSS("padding-top", "0px");
    await page.screenshot({ path: testInfo.outputPath(`wallet-${width}.png`) });
  });
}

for (const width of [393, 1440]) {
  test(`Calendar workspace centers its action below the heading at ${width}px`, async ({ page }) => {
    await open(page, width, "light", {}, { shell: true });
    await page.addScriptTag({ content: "window.__calendarHeading=true;" });
    await mount(page, false);
    const action = page.getByRole("button", { name: "Connect your calendar", exact: true });
    await expect(action).toBeVisible();
    const measured = await action.evaluate((button) => {
      const heading = button.closest("section")!.querySelector("#calendar-connect-title")!;
      const rect = button.getBoundingClientRect();
      const title = heading.getBoundingClientRect();
      return {
        gap: rect.top - title.bottom,
        centerOffset: rect.x + rect.width / 2 - title.x - title.width / 2,
        height: rect.height,
      };
    });
    expect(measured.gap).toBeCloseTo(24, 1);
    expect(Math.abs(measured.centerOffset)).toBeLessThanOrEqual(0.5);
    expect(measured.height).toBeGreaterThanOrEqual(44);
  });
}

for (const [width, count] of [[320, 10], [375, 10], [390, 10], [430, 10], [1440, 10], [320, 0], [390, 0], [430, 0], [768, 0], [1440, 0], [390, 1], [1440, 1], [390, 2], [390, 3], [390, 5]]) {
  test(`Cards grid preserves three One cards and ${count} payment cards at ${width}px`, async ({ page }, testInfo) => {
    const errors = await open(page, width, !count && width !== 768 ? "dark" : "light", { cards: count, deletePending: count === 1 }, { height: 844, shell: true });
    await mount(page);
    const collection = page.getByTestId("wallet-card-browser");
    await expect(collection).toBeVisible();
    await expect(collection.locator("[data-wallet-card-id]")).toHaveCount(count + 3);
    await expect(collection.locator('[data-wallet-card-id^="agent-one-"]')).toHaveCount(3);
    const cards = collection.locator('[data-wallet-card-id^="card_"]');
    await expect(cards).toHaveCount(count);
    const boxes = await cards.evaluateAll(elements => elements.map(element => {
      const face = element.querySelector('[data-testid="wallet-card-face"]')!;
      const rect = face.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, ratio: rect.width / rect.height };
    }));
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(Math.abs(box.ratio - ISO_RATIO)).toBeLessThan(.01);
    }
    if (!count) {
      const empty = collection.getByText("No payment cards yet", { exact: true });
      const helper = collection.getByText("Add a card to keep its details close.", { exact: true });
      const add = collection.getByRole("button", { name: "Add a payment card", exact: true });
      const [titleBox, helperBox, addBox] = await Promise.all([empty.boundingBox(), helper.boundingBox(), add.boundingBox()]);
      expect(helperBox!.y - titleBox!.y - titleBox!.height).toBeGreaterThanOrEqual(8);
      expect(addBox!.y - helperBox!.y - helperBox!.height).toBeGreaterThanOrEqual(12);
      expect(addBox!.height).toBeGreaterThanOrEqual(44);
      const oneCards = collection.getByRole("region", { name: "Your One cards", exact: true });
      const rows = oneCards.getByRole("button");
      const rowBoxes = await rows.evaluateAll(elements => elements.map(element => {
        const row = element.getBoundingClientRect();
        const art = element.querySelector('[data-agent-card]')!.getBoundingClientRect();
        return { top: row.top, bottom: row.bottom, height: row.height, artWidth: art.width, artRatio: art.width / art.height, overflow: element.scrollWidth > element.clientWidth + 1 };
      }));
      for (const row of rowBoxes) {
        expect(row.height).toBeGreaterThanOrEqual(44);
        expect(Math.abs(row.artRatio - ISO_RATIO)).toBeLessThan(.01);
        expect(row.overflow).toBe(false);
        if (width < 768) { expect(row.height).toBeLessThanOrEqual(120); expect(row.artWidth).toBeLessThanOrEqual(96); }
      }
      if (width < 768) for (let index = 1; index < rowBoxes.length; index++) expect(rowBoxes[index].top - rowBoxes[index - 1].bottom).toBeGreaterThanOrEqual(8);
      await page.screenshot({ path: testInfo.outputPath(`wallet-empty-${width}.png`), fullPage: true });
      await oneCards.getByRole("button", { name: "Agent One Profile", exact: true }).click();
      await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
      await page.getByRole("button", { name: "All cards", exact: true }).click();
      await expect(oneCards.getByRole("button", { name: "Agent One Profile", exact: true })).toBeFocused();
    }
    if (count) {
      await cards.first().click();
      const selected = page.getByTestId("wallet-selected-card");
      await expect(selected).toBeVisible();
      await expect(selected.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
      await expect(selected.getByRole("region", { name: "Saved card details" })).not.toContainText(/PIN|CVC/);
      expect(await page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("reveal:")))).toEqual([]);
      if (count === 1) {
        await selected.getByRole("button", { name: "Remove card", exact: true }).click();
        await page.getByTestId("one-wallet-remove-confirm-action").click();
        await expect(selected).toBeHidden();
        await expect(cards).toHaveCount(0);
        await expect(collection).toBeFocused();
        expect(await page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("deleted:")))).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`wallet-remove-pending-${width}.png`) });
        await page.evaluate(() => { window.__walletScenario!.deletePending = false; window.dispatchEvent(new Event("wallet-fixture:delete-ready")); });
        await expect(collection.getByRole("button", { name: "Agent One Profile", exact: true })).toBeEnabled();
        await expect(cards).toHaveCount(0);
      } else {
        await selected.getByRole("button", { name: "All cards", exact: true }).click();
        await expect(cards.first()).toBeFocused();
      }
    }
    await page.getByTestId("one-wallet-add").click();
    await expect(page.getByTestId("secure-card-add-form")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 1440]) {
  test(`loading cards keep collection geometry and Share opens during the access check at ${width}px`, async ({ page }, testInfo) => {
    const errors = await open(page, width, "dark", { cards: 1, cardsPending: true, sharingStatePending: true }, { shell: true });
    await mount(page);
    const loading = page.getByRole("status", { name: "Opening your wallet" });
    await expect(loading).toBeVisible();
    const face = loading.locator('[data-slot="skeleton"]').nth(1);
    const box = await face.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.width / box!.height - ISO_RATIO)).toBeLessThan(.01);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`wallet-loading-${width}.png`) });
    await page.evaluate(() => {
      window.__walletScenario!.cardsPending = false;
      window.dispatchEvent(new Event("wallet-fixture:cards-ready"));
    });
    await expect(loading).toBeHidden();
    await page.locator('[data-wallet-card-id="card_a"]').click();
    const selected = page.getByTestId("wallet-selected-card");
    const share = selected.getByRole("button", { name: "Share card", exact: true });
    await expect(share).toBeEnabled();
    await share.click();
    const picker = page.getByRole("dialog", { name: "Share card", exact: true });
    await expect(picker.getByText("Checking card sharing…", { exact: true })).toBeVisible();
    await picker.getByRole("checkbox", { name: "Share with Test Recipient", exact: true }).check();
    const send = picker.getByRole("button", { name: "Share with 1", exact: true });
    await expect(send).toBeDisabled();
    await page.evaluate(() => {
      window.__walletScenario!.sharingStatePending = false;
      window.dispatchEvent(new Event("wallet-fixture:sharing-ready"));
    });
    await expect(send).toBeEnabled({ timeout: 10_000 });
    await expect(picker.getByRole("button", { name: "15 minutes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(selected).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("Wallet collections are keyboard accessible and Add is a cancellable sheet", async ({ page }) => {
  const errors = await open(page, 393, "light"); await mount(page);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "My cards", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Shared with me", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await page.getByTestId("one-wallet-add").click();
  await page.getByLabel("Name on card", { exact: true }).fill("Travel");
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("TRAVEL");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("tab", { name: "My cards", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("one-wallet-add")).toBeFocused();
  await page.getByTestId("one-wallet-add").click();
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});

test("Add sheet owns scrolling and leaves its actions reachable on a short phone", async ({ page }) => {
  const errors = await open(page, 393, "light", {}, { height: 667, shell: true }); await mount(page);
  const root = page.locator('[data-app-scroll-root="true"]');
  const before = await root.evaluate(element => element.scrollTop);
  await page.getByTestId("one-wallet-add").click();
  const dialog = page.getByRole("dialog", { name: "Add card", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("secure-card-save")).toBeInViewport();
  await dialog.getByLabel("Name on card", { exact: true }).fill("Unsaved");
  await dialog.getByLabel("CVV", { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByTestId("secure-card-save")).toBeInViewport();
  expect(await root.evaluate(element => element.scrollTop)).toBe(before);
  expect(await page.evaluate(() => window.__walletBack!())).toBe(true);
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

for (const [width, height] of [[320, 667], [390, 844], [714, 668], [1440, 900]]) {
  test(`Wallet introduction fits image and Continue at ${width}x${height}`, async ({ page }) => {
    const errors = await open(page, width!, "light", { cards: 0 }, { height, shell: true });
    await mount(page, false);
    await expect(page.getByRole("heading", { name: "All your cards in one place", exact: true })).toBeAttached();
    await expect(page.getByTestId("one-wallet-empty-display-title")).toHaveText("All your cards in one place");
    await expect(page.getByRole("heading", { name: "Wallet", exact: true })).toHaveCount(0);
    const image = page.getByTestId("one-wallet-empty-art").locator("img");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("loading", "eager");
    await expect(image).toHaveAttribute("fetchpriority", "high");
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
    const next = page.getByRole("button", { name: "Continue", exact: true });
    await expect(next).toBeInViewport();
    await expect(next).toHaveCSS("min-height", "44px");
    await expect(next).toHaveCSS("border-top-width", "1px");
    await expect(next).toHaveCSS("border-radius", "999px");
    await expect(next).toHaveCSS("font-size", "12px");
    expect((await next.boundingBox())!.y + (await next.boundingBox())!.height).toBeLessThan(height! - BOTTOM_SHELL_HEIGHT_PX);
    await page.screenshot({ path: test.info().outputPath("wallet-introduction.png") });
    await next.click();
    await expect(page.getByRole("heading", { name: "Wallet", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("wallet-card-browser")).toBeVisible();
    expect(errors).toEqual([]);
  });
}







for (const width of [320, 390, 1024]) {
  test(`selected cards use a contained detail panel with working navigation at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "dark", {}, { shell: true }); await mount(page);
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    const selected = page.getByTestId("wallet-selected-card");
    await expect(selected).toBeVisible();
    const dialog = page.getByRole("dialog").filter({ has: selected });
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    await expect(selected.getByRole("button", { name: "Share card", exact: true })).toBeVisible();
    await selected.getByRole("button", { name: "Next card", exact: true }).click();
    await expect(selected).toContainText("Travel");
    await page.keyboard.press("Escape");
    await expect(selected).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId("one-wallet-add").click();
    await expect(page.getByRole("button", { name: "Scan card", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose from photos", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 393, 1440]) {
  test(`compact Add form fits its fields and external save footer at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", {}, { height: 844, shell: true }); await mount(page);
    await page.getByTestId("one-wallet-add").click();
    const form = page.getByTestId("secure-card-add-form");
    await expect.poll(() => page.getByRole("dialog", { name: "Add card", exact: true }).evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
    const save = page.getByTestId("secure-card-save");
    await expect(save).toBeInViewport();
    expect(await save.getAttribute("form")).toBe(await form.getAttribute("id"));
    await expect(form.getByLabel("Card number", { exact: true })).toHaveCSS("font-size", width <= 620 ? "16px" : "14px");
    for (const input of await form.locator('input:not([type="file"]), [role="combobox"]').all()) {
      const box = (await input.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(errors).toEqual([]);
  });
}

test("Profile controls stay reachable from their compact collection row", async ({ page }) => {
  const errors = await open(page, 393, "light", {}, { shell: true }); await mount(page);
  await page.getByRole("button", { name: "Agent One Profile", exact: true }).click();
  const selected = page.getByTestId("wallet-selected-card");
  await expect(selected).toBeVisible();
  await expect(page.getByRole("button", { name: "Close detail panel", exact: true })).toHaveCSS("height", "44px");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Agent One Profile", exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test("typing groups card numbers and inserts expiry separators while allowing middle edits", async ({ page }) => {
  await open(page, 393, "light", {}, { shell: true });
  await mount(page);
  await page.getByTestId("one-wallet-add").click();
  const input = page.getByTestId("secure-card-pan-input");
  await input.pressSequentially("42424242");
  await expect(input).toHaveValue("4242 4242");
  await input.evaluate((node: HTMLInputElement) => { node.focus(); node.setSelectionRange(5, 5); });
  await input.press("Backspace");
  await expect(input).toHaveValue("4244 242");
  expect(await input.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(3);
  await input.press("9");
  await expect(input).toHaveValue("4249 4242");
  for (const [digits, grouped] of [["911111111116", "9111 1111 1116"], ["378282246310005", "3782 8224 6310 005"], ["4242424242424242", "4242 4242 4242 4242"]]) {
    await input.fill("");
    await input.pressSequentially(digits);
    await expect(input).toHaveValue(grouped);
  }
  const expiry = page.getByLabel("Expiry (MM/YY)", { exact: true });
  await expiry.pressSequentially("12");
  await expect(expiry).toHaveValue("12/");
  await expiry.press("Backspace");
  await expect(expiry).toHaveValue("1");
  await expiry.pressSequentially("230");
  await expect(expiry).toHaveValue("12/30");
  await expiry.fill("08/2032");
  await expect(expiry).toHaveValue("08/2032");
  await input.fill("");
  expect(await input.evaluate((node) => node.matches(":placeholder-shown"))).toBe(true);
});

test("Back cancels Add and restores the previously selected masked card", async ({ page }) => {
  const errors = await open(page, 393, "light", {}, { shell: true }); await mount(page);
  await page.getByRole("button", { name: "Everyday", exact: true }).click();
  await page.getByTestId("wallet-selected-card").getByRole("button", { name: "Add a card", exact: true }).click();
  await page.getByLabel("Name on card", { exact: true }).fill("Draft Owner");
  expect(await page.evaluate(() => window.__walletBack!())).toBe(true);
  await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
  await expect(page.getByTestId("secure-card-add-form")).toHaveCount(0);
  expect(await page.evaluate(() => window.__walletEvents ?? [])).not.toContain("reveal:card_a");
  expect(errors).toEqual([]);
});

for (const width of [320, 1440]) {
  test(`Save returns to the collection before a delayed write and keeps pending cards protected at ${width}px`, async ({ page }, testInfo) => {
    const errors = await open(page, width, "dark", { cards: 0, saveDelayMs: 4000 }, { shell: true });
    await mount(page);
    await page.getByTestId("one-wallet-add").click();
    const form = page.getByTestId("secure-card-add-form");
    await form.getByLabel("Card number", { exact: true }).fill("4242424242424242");
    await form.getByLabel("Name on card", { exact: true }).fill("SYNTHETIC SAVE REVIEW");
    await form.getByLabel("Expiry (MM/YY)", { exact: true }).fill("12/30");
    await page.getByTestId("secure-card-save").click();
    await expect(form).toBeHidden({ timeout: 1000 });
    const pending = page.getByTestId("wallet-pending-save");
    await expect(pending).toContainText("Saving card…");
    await expect(pending.locator("button")).toHaveCount(0);
    await expect(page.getByTestId("one-wallet-add")).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`wallet-save-pending-${width}.png`) });
    await expect(pending).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('[data-wallet-card-id="card_saved_1"]')).toBeVisible();
    await expect(page.getByTestId("wallet-selected-card")).toHaveCount(0);
    expect(await page.evaluate(() => (window.__walletEvents ?? []).filter(event => event === "add"))).toEqual(["add"]);
    expect(errors).toEqual([]);
  });
}

test("Add saves typed card details, keeps optional fields empty, and preserves its finish after remount", async ({ page }) => {
  const errors = await open(page, 320, "light", { cards: 0, delayMs: 40 }, { shell: true });
  await mount(page);
  await page.getByTestId("one-wallet-add").click();
  const form = page.getByTestId("secure-card-add-form");
  await form.getByLabel("Card number", { exact: true }).fill("5555 5555 5555 4444");
  await form.getByLabel("Name on card", { exact: true }).fill("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await form.getByLabel("Card network", { exact: true }).click();
  await page.getByRole("option", { name: "Mastercard", exact: true }).click();
  await form.getByLabel("Expiry (MM/YY)", { exact: true }).fill("09/32");
  await page.getByTestId("secure-card-save").click();
  await page.locator('[data-wallet-card-id="card_saved_1"]').click();
  const selected = page.getByTestId("wallet-selected-card");
  const face = selected.getByTestId("wallet-card-face");
  await expect(face).toBeVisible();
  await expect(face.locator('[data-slot="wallet-card-holder"]')).toContainText("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await expect(face.locator('[data-slot="wallet-card-expiry"]')).toContainText("09/32");
  await expect(face.getByTestId("card-network-wordmark-mastercard")).toBeVisible();
  await expect(face.locator('[data-slot="wallet-card-number"]')).toContainText("4444");
  await expect(face).not.toContainText("5555555555554444");
  await expect(face).toHaveAttribute("data-revealed", "false");
  const artwork = await face.getAttribute("data-card-artwork");
  await selected.getByRole("button", { name: "All cards", exact: true }).click();
  const saved = page.locator('[data-wallet-card-id="card_saved_1"]');
  await expect(saved.getByTestId("wallet-card-face")).toHaveAttribute("data-card-artwork", artwork!);
  await expect(page.getByTestId("wallet-card-browser").locator("[data-wallet-card-id]")).toHaveCount(4);
  await page.evaluate(() => window.__walletRemount!());
  await expect(page.getByRole("tab", { name: "My cards", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(saved.getByTestId("wallet-card-face")).toHaveAttribute("data-card-artwork", artwork!);
  await expect(saved.locator('[data-slot="wallet-card-holder"]')).toContainText("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await expect(saved.locator('[data-slot="wallet-card-expiry"]')).toContainText("09/32");
  expect(await page.evaluate(() => window.__walletEvents?.filter(event => !event.startsWith("history-loaded:")))).toEqual(["add"]);
  expect(errors).toEqual([]);
});

test("neutral payment cards fit long names and a revealed 19-digit number at 320px", async ({ page }) => {
  const errors = await open(page, 320, "light", { artworkGallery: true });
  await mount(page, false);
  const faces = page.getByTestId("wallet-card-face");
  await expect(faces).toHaveCount(2);
  const measurements = await faces.evaluateAll((elements) => elements.map((face) => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const number = face.querySelector('[data-slot="wallet-card-number"]')!;
    const fields = [...face.querySelectorAll('[data-slot="wallet-card-bottom"] > span')].map(box);
    const text = [...number.querySelectorAll('[aria-hidden="true"]')].map(box);
    return { artwork: face.getAttribute("data-card-artwork"), face: box(face), number: box(number), fields, text,
      top: [...face.querySelector('[data-slot="wallet-card-top"]')!.children].map(box) };
  }));
  expect(new Set(measurements.map((entry) => entry.artwork)).size).toBe(1);
  for (const entry of measurements) {
    expect(Math.abs(entry.face.width / entry.face.height - ISO_RATIO)).toBeLessThan(0.01);
    for (const part of [...entry.fields, ...entry.text, ...entry.top]) {
      expect(part.left, `${entry.artwork} left edge`).toBeGreaterThanOrEqual(entry.face.left);
      expect(part.right, `${entry.artwork} right edge`).toBeLessThanOrEqual(entry.face.right);
      expect(part.bottom, `${entry.artwork} bottom edge`).toBeLessThanOrEqual(entry.face.bottom);
    }
    expect(entry.top[0]!.right).toBeLessThanOrEqual(entry.top[1]!.left);
    for (let index = 1; index < entry.fields.length; index += 1) {
      expect(entry.fields[index - 1]!.right).toBeLessThanOrEqual(entry.fields[index]!.left);
    }
    expect(entry.number.bottom).toBeLessThan(entry.fields[0]!.top);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

for (const width of [320, 390, 1440]) {
  test(`Wallet Sharing keeps sent and received history reachable at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", { cards: 3, sharingHistory: true }, { height: 844, shell: true }); await mount(page);
    await page.getByRole("tab", { name: "Shared with me", exact: true }).click();
    const received = page.getByRole("region", { name: "Received card history", exact: true });
    const receivedTile = received.getByRole("button", { name: "View VISA •••• 4242 from Example Sender", exact: true });
    await receivedTile.click();
    const receivedDetail = page.getByRole("dialog", { name: "Example Sender", exact: true });
    await expect(receivedDetail.getByText(/15 minutes/)).toBeVisible();
    await expect(receivedDetail.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
    await receivedDetail.getByRole("button", { name: "Back to sharing history" }).click();
    await expect(receivedTile).toBeFocused();
    await page.getByRole("tab", { name: "My cards", exact: true }).click();
    await page.getByRole("button", { name: "Wallet access", exact: true }).click();
    const sharing = page.getByTestId("wallet-sharing-content");
    const history = sharing.getByRole("region", { name: "Card sharing history", exact: true });
    const row = history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true });
    await expect(history.getByRole("heading", { name: "Shared cards | 1", exact: true })).toBeVisible();
    await expect(history.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
    await row.click();
    const detail = page.getByRole("dialog", { name: "Sample recipient", exact: true });
    await expect(detail.getByText(/15 minutes/)).toBeVisible();
    await expect(detail).toContainText("Identity verification required");
    await expect(detail.getByRole("heading", { name: "Sample recipient", exact: true })).toHaveCSS("font-size", "20px");
    const revoke = detail.getByRole("button", { name: "Revoke Everyday •••• 4242 shared with Sample recipient", exact: true });
    await expect(revoke).toBeEnabled(); await expect(revoke).toHaveCSS("min-height", "44px");
    await detail.getByRole("button", { name: "Back to sharing history" }).click();
    await expect(row).toBeFocused();
    expect(await sharing.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });

  // Each dismissal journey keeps its own deadline, including reopen/focus proof.
  for (const dismissal of ["Keep sharing", "Escape"] as const) test(`Wallet Sharing dismissal keeps access and restores focus at ${width}px (${dismissal})`, async ({ page }) => {
    const { errors, revoke, revocations } = await openWalletSharingReview(page, width, { open, mount });
    await revoke.click();
    const confirmation = page.getByRole("alertdialog", { name: "Revoke this card share?", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled();
    expect(await revocations()).toEqual([]);
    if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await confirmation.getByRole("button", { name: "Keep sharing", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(revoke).toBeFocused();
    expect(await revocations()).toEqual([]);
    await revoke.click();
    await expect(confirmation).toBeVisible();
    expect(await revocations()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`Wallet Sharing revocation requires confirmation at ${width}px`, async ({ page }) => {
    const { errors, sharing, history, detail, revoke, revocations } = await openWalletSharingReview(page, width, { open, mount });
    await revoke.click();
    const confirmation = page.getByRole("alertdialog", { name: "Revoke this card share?", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled();
    expect(await revocations()).toEqual([]);
    await confirmation.getByRole("button", { name: "Revoke access", exact: true }).click();
    await expect.poll(revocations).toEqual(["sharing-revoke:fixture-history-grant"]);
    await expect(confirmation).toBeHidden();
    await expect(detail.getByText("Revoked", { exact: true }).first()).toBeVisible();
    await expect(detail.getByText("Connection", { exact: true }).first()).toBeVisible();
    await expect(revoke).toHaveCount(0);
    const back = detail.getByRole("button", { name: "Back to sharing history" });
    await expect(back).toBeFocused();
    await back.click();
    await expect(detail).toBeHidden();
    await expect(history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true })).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Wallet access", exact: true })).toBeVisible();
    await expect(history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).getByText("Sample recipient", { exact: true })).toBeVisible();
    // Terminal settle must remove fractional interpolation so the Sharing
    // pane remains fully inside the viewport; live drag keeps its own transform.
    await expect.poll(() => sharing.evaluate((el) => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
    const recipientBounds = (await history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).getByText("Sample recipient", { exact: true }).boundingBox())!;
    expect(recipientBounds.x).toBeGreaterThanOrEqual(0);
    expect(recipientBounds.x + recipientBounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`Wallet-wide Manage explains the secrets projection at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", { walletWideDetails: true }, { shell: true });
    await mount(page);
    await page.getByRole("button", { name: "Wallet access", exact: true }).click();
    const manage = page.getByRole("region", { name: "Wallet-wide access" }).getByRole("button", { name: "Manage" });
    await manage.click();
    const dialog = page.getByRole("dialog", { name: "Manage access" });
    await expect(dialog).toContainText("Card numbers and cardholder names. Saved security codes are not shared.");
    await expect(dialog.getByText("What is included", { exact: true })).toHaveCSS("font-size", "12px");
    await expect(dialog.getByRole("button", { name: "Revoke access" })).toHaveCSS("font-size", "13px");
    await expect(dialog.getByRole("button", { name: "Revoke access" })).toHaveCSS("min-height", "44px");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(manage).toBeFocused();
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`card details and sharing choices stay readable at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", { networkCards: true }, { height: 844, shell: true, secure: true }); await mount(page);
    await page.getByRole("button", { name: "RuPay", exact: true }).click();
    const selected = page.getByTestId("wallet-selected-card");
    await expect(selected.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
    await selected.getByRole("button", { name: "Share card", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share card", exact: true });
    await expect(dialog.getByRole("textbox", { name: "Search connections" })).toBeVisible();
    await dialog.getByRole("checkbox", { name: "Share with Test Recipient", exact: true }).check();
    await dialog.getByRole("checkbox", { name: "Share with Trusted Recipient", exact: true }).check();
    await expect(dialog.getByRole("button", { name: "Share with 2", exact: true })).toBeEnabled();
    for (const name of ["15 minutes", "1 hour", "2 hours"]) {
      await dialog.getByRole("button", { name, exact: true }).click();
      await expect(dialog.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    await expect(dialog).toContainText("Shares the full card number");
    await expect(dialog).toContainText("CVV and PIN are never shared");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(selected).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390, 1440]) {
  test(`Anonymous encrypted file reader opens a synthetic card locally at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", {}, { secure: true, reader: true });
    await page.addScriptTag({ content: script });
    const file = await createEncryptedCardFile({ pan: "6200000000000001234", cardholderName: "SYNTHETIC RECIPIENT WITH A LONG NAME ".repeat(3).slice(0, 100), brand: "unionpay", expiryMonth: 4, expiryYear: 2030, issuingRegion: "US" }, "synthetic-long-password");
    await page.getByLabel("Encrypted card file").setInputFiles({ name: file.name, mimeType: file.type, buffer: Buffer.from(await file.arrayBuffer()) });
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await expect(page.getByLabel("Password", { exact: true })).toHaveCSS("font-size", width <= 620 ? "16px" : "14px");
    await page.getByRole("button", { name: "Open card", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open card", exact: true })).toBeEnabled();
    await expect(page.getByRole("region", { name: "Shared card details" })).not.toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("synthetic-long-password");
    await page.getByRole("button", { name: "Open card", exact: true }).click();
    const details = page.getByRole("region", { name: "Shared card details" });
    await expect(details).toContainText("6200000000000001234".replace(/(.{4})(?=.)/g, "$1 "));
    await expect(details).not.toContainText("CVV");
    await expect(details).not.toContainText("PIN");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await details.locator('[data-slot="settings-row-trailing"]').evaluateAll(elements => elements.slice(0, 2).every(el => { const value = el.firstElementChild as HTMLElement; return value.scrollWidth <= value.clientWidth + 1 && getComputedStyle(value).textOverflow !== "ellipsis"; }))).toBe(true);
    await page.getByRole("button", { name: "Hide card", exact: true }).click();
    await expect(details).not.toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390, 820, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`received cards use the collection geometry and preserve history at ${width}px (${theme})`, async ({ page }, testInfo) => {
    const errors = await open(page, width, theme, { cards: 3, sharingHistory: true }, { shell: true }); await mount(page);
    await page.getByRole("tab", { name: "Shared with me", exact: true }).click();
    const history = page.getByRole("region", { name: "Received card history" });
    await expect(history).toBeVisible();
    await expect(history.getByTestId("wallet-received-card-preview").first()).toBeVisible();
    const face = history.getByTestId("wallet-card-face").first();
    await expect(face).toHaveAttribute("data-revealed", "false");
    await expect(face.getByRole("img", { name: "Visa", exact: true })).toBeVisible();
    await expect(face.locator('[data-slot="wallet-card-number"]')).toHaveText(/4242/);
    await expect(face.locator('[data-slot="wallet-card-expiry"]')).toContainText("••/••");
    const bounds = (await face.boundingBox())!;
    expect(bounds.width / bounds.height).toBeCloseTo(ISO_RATIO, 1);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await face.locator('[data-slot="wallet-card-number"], [data-slot="wallet-card-holder"], [data-slot="wallet-card-expiry"]').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
    await expect(history).toContainText("From");
    await page.screenshot({ path: testInfo.outputPath(`wallet-received-${width}-${theme}.png`), fullPage: true });
    const tile = history.getByRole("button", { name: /^View / }).first();
    await tile.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("wallet-received-card-preview")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "View card", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(tile).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test("Wallet introduction opens the card collection and keeps existing One cards reachable", async ({ page }) => {
  const errors = await open(page, 390, "light", { cards: 3 }, { height: 844, shell: true });
  await mount(page, false);
  const intro = page.getByTestId("one-wallet-empty");
  const artwork = intro.locator("img");
  await expect.poll(() => artwork.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  await expect(intro.getByRole("button", { name: "Continue" })).toBeInViewport();
  await intro.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("wallet-card-browser").locator("[data-wallet-card-id]")).toHaveCount(6);
  await page.getByRole("button", { name: "Agent One Profile", exact: true }).click();
  await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
  await page.getByRole("button", { name: "All cards", exact: true }).click();
  await page.getByRole("button", { name: "Everyday", exact: true }).click();
  await expect(page.getByRole("region", { name: "Saved card details", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All cards", exact: true }).click();
  await page.getByRole("tab", { name: "Shared with me", exact: true }).click();
  await expect(page.getByRole("region", { name: "Received card history", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const width of [320, 1024]) {
  test(`timed shared profile displays the real card artwork at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light");
    await page.addScriptTag({ content: 'window.__visitorPreview={photo:"",shared:true};' });
    await mount(page, false);
    const face = page.getByTestId("shared-profile-card-face");
    await expect(face.locator('[data-agent-card="profile"]')).toHaveAttribute("data-artwork-ready", "true");
    await expect(face.getByRole("img", { name: "Agent One Profile", exact: true })).toBeVisible();
    const rendered = await face.locator("img").evaluate(async (img: HTMLImageElement) => ({ width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height, svg: await (await fetch(img.src)).text() }));
    expect(rendered.width / rendered.height).toBeCloseTo(ISO_RATIO, 2);
    expect(rendered.svg).toContain("Alex Morgan");
    expect(rendered.svg).not.toContain("data-wallet-qr");
    expect(rendered.svg).not.toContain("MEMBER SINCE");
    expect(rendered.svg).not.toContain("WALLET ID");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("wallet-shared-profile-card.png"), fullPage: true });
  });
}

for (const width of [320, 393, 1024]) {
  test(`Visitor preview keeps photo, details and QR readable at ${width}px`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleErrors.push(message.text()); });
    const errors = await open(page, width, "light", {}, { secure: true });
    const photo = `data:image/webp;base64,${fs.readFileSync(path.join(process.cwd(), "public/ria/onboarding/adv1f.webp")).toString("base64")}`;
    await page.addScriptTag({ content: `window.__visitorPreview = ${JSON.stringify({ photo, long: width === 320 })};` });
    await mount(page, false);
    const card = page.getByTestId("visitor-profile-card");
    await expect(card).toBeVisible();
    await expect(card.locator('[data-slot="avatar-image"]')).toBeVisible();
    await expect(card.getByRole("img", { name: "Hushh profile badge" })).toBeVisible();
    await expect(card.getByRole("img", { name: "Profile QR code", exact: true })).toBeVisible();
    const email = card.locator('a[href^="mailto:"]');
    await email.focus();
    await expect(email).toBeFocused();
    await expect(card.getByRole("link", { name: /Website/ })).toHaveAttribute("rel", "noopener noreferrer");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const overflowing = await card.locator('h1, p, a, figure').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).length);
    expect(overflowing).toBe(0);
    await expect(card.locator('h1')).toHaveCSS('font-size', '20px');
    await expect(card.getByRole('heading', { name: 'About', exact: true })).toHaveCSS('font-size', '12px');
    await expect(email).toHaveCSS('font-size', '14px');
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await email.blur();
    await page.screenshot({ path: testInfo.outputPath(`visitor-${width}.png`), fullPage: true });
  });
  // Bound individual steps while allowing the complete preview/editor journey
  // on loaded WebKit runners. Every assertion retains its existing deadline.
  for (const [kind, title] of [["profile", "Agent One Profile"], ["nws", "Agent One NWS"]] as const) {
    test(`owner ${kind} visitor preview and editor return at ${width}px`, async ({ page }, testInfo) => {
      test.slow(); page.setDefaultTimeout(5_000);
      const errors = await open(page, width, "light", { cards: 0 }, { shell: true, secure: true });
      await mount(page);
      await page.getByRole("button", { name: title, exact: true }).click();
      const face = page.getByTestId("wallet-selected-card").locator("[data-agent-card]");
      await expect(face).toHaveAttribute("data-agent-card", kind);
      await expect(face).toHaveAttribute("data-artwork-ready", "true");
      await page.getByRole("button", { name: /Preview as visitor/ }).click();
      await expect(page.getByTestId("visitor-profile-card")).toBeVisible();
      await expect(face).toBeVisible();
      await expect(page.getByText("Profile card preview", { exact: true })).toHaveCount(0);
      const order = await page.getByTestId("wallet-selected-card").evaluate(el => {
        const face = el.querySelector('[data-agent-card]')!.getBoundingClientRect();
        const visitor = el.querySelector('[data-testid="visitor-profile-card"]')!.getBoundingClientRect();
        return face.bottom <= visitor.top;
      });
      expect(order).toBe(true);
      await expect(page.getByTestId("visitor-profile-card").locator("h1")).toHaveCSS("font-size", "20px");
      await page.screenshot({ path: testInfo.outputPath(`owner-preview-${kind}-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByTestId("visitor-profile-card")).toHaveCount(0);
      await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "card");
      await expect(face).toHaveAttribute("data-agent-card", kind);
      await expect(page.getByRole("button", { name: /Preview as visitor/ })).toBeVisible();
      await page.getByRole("button", { name: /^Edit shared information/ }).click();
      await expect(page.getByTestId("wallet-card-setup-form")).toBeVisible();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByTestId("wallet-card-setup-form")).toHaveCount(0);
      await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "card");
      await page.getByRole("button", { name: "All cards", exact: true }).click();
      await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "all");
      expect(errors).toEqual([]);
    });
  }
}
for (const width of [320, 1440]) {
  for (const kind of ["Profile", "Referral", "NWS"] as const) {
    test(`default ${kind} QR revocation updates the link and counts at ${width}px`, async ({ page }, testInfo) => {
      // This compound journey also edits Profile and checks the shared NWS scan reset.
      test.slow(); page.setDefaultTimeout(5_000);
      const errors = await open(page, width, "light", { cards: 0 }, { height: 900, shell: true, secure: true });
      await mount(page);
      await page.getByRole("button", { name: "Agent One Profile", exact: true }).click();
      if (kind !== "Profile") await page.getByRole("button", { name: "Next card", exact: true }).click();
      if (kind === "NWS") await page.getByRole("button", { name: "Next card", exact: true }).click();
      const counter = page.getByTestId(kind === "Referral" ? "wallet-referral-opens" : "wallet-profile-scans");
      await expect(counter).toHaveText(kind === "Referral" ? "7" : "3");
      const qr = page.getByRole("img", { name: kind === "Referral" ? "Your referral QR code" : "Your Wallet Profile QR code", exact: true });
      const originalQr = await qr.evaluate(el => el.innerHTML);
      const qrActions = page.getByTestId("wallet-qr-actions");
      const geometry = await qrActions.evaluate(el => {
        const qr = el.querySelector('svg[role="img"]')!.getBoundingClientRect();
        const actions = [...el.querySelectorAll("button")].map(button => {
          const box = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return { x: box.x, right: box.right, y: box.y, bottom: box.bottom, height: box.height, cssHeight: Number.parseFloat(style.height), font: style.fontSize };
        });
        return { qrWidth: qr.width, qrRight: qr.right, right: el.getBoundingClientRect().right, actions };
      });
      expect(geometry.actions).toHaveLength(4);
      expect(geometry.qrWidth).toBeLessThanOrEqual(96);
      geometry.actions.forEach((action, i) => {
        expect(action.x).toBeGreaterThan(geometry.qrRight);
        expect(action.right).toBeLessThanOrEqual(geometry.right);
        expect(action.right - action.x).toBeGreaterThanOrEqual(76);
        // Rect subtraction can yield 43.99994px for a 44px control.
        // Keep the authored height strict and allow only numerical noise.
        expect(action.cssHeight).toBeGreaterThanOrEqual(44);
        expect(action.height).toBeGreaterThanOrEqual(44 - 0.001);
        expect(action.font).toBe("12px");
        if (i % 2 === 1) {
          expect(action.y).toBeCloseTo(geometry.actions[i - 1].y, 0);
          expect(action.x).toBeGreaterThanOrEqual(geometry.actions[i - 1].right);
        }
        if (i >= 2) expect(action.y).toBeGreaterThanOrEqual(geometry.actions[i - 2].bottom);
      });
      await expect(page.getByRole("button", { name: /^Rotate QR access/ })).toHaveCount(0);
      await qrActions.scrollIntoViewIfNeeded();
      await qrActions.screenshot({ path: testInfo.outputPath(`qr-actions-${kind.toLowerCase()}-${width}.png`) });
      if (kind === "Profile") {
        await page.getByRole("button", { name: /^Edit shared information/ }).click();
        const form = page.getByTestId("wallet-card-setup-form");
        await expect(form.getByRole("heading", { name: "Shared information" })).toHaveCount(0);
        await expect(form.locator('[data-wallet-grid-item="photo-row"]')).toHaveCount(0);
        await expect(form.getByLabel("Name", { exact: true })).toBeVisible();
        const name = form.getByLabel("Name", { exact: true });
        await expect(name).toHaveCSS("font-size", width <= 620 ? "16px" : "14px");
        expect(await name.evaluate(node => getComputedStyle((node as HTMLInputElement).labels![0]).fontSize)).toBe("15px");
        await expect(form.getByRole("button", { name: "Save changes", exact: true })).toHaveCSS("font-size", "17px");
        await form.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      const revoke = page.getByRole("button", { name: "Revoke access", exact: true });
      await revoke.click();
      let dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText(kind === "Referral" ? "earned referrals" : "reset scans for Profile and NWS");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(counter).toHaveText(kind === "Referral" ? "7" : "3");
      expect(await page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("qr-revoke:")))).toEqual([]);
      await revoke.click();
      dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: "Revoke access", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(counter).toHaveText("0");
      await expect.poll(() => qr.evaluate(el => el.innerHTML)).not.toBe(originalQr);
      if (kind === "Referral") {
        await expect(page.getByRole("link", { name: "Preview referral page" })).toHaveAttribute("href", "https://example.test/r/fixture-referral-new");
        await expect(page.getByText("Qualified referrals", { exact: true })).toBeVisible();
        await expect(page.getByText("2", { exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await counter.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`revoke-${kind.toLowerCase()}-${width}.png`) });
      if (kind !== "Referral") {
        if (kind === "NWS") {
          await page.getByRole("button", { name: "All cards", exact: true }).click();
          await page.getByRole("button", { name: "Agent One Profile", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "Next card", exact: true }).click();
          await page.getByRole("button", { name: "Next card", exact: true }).click();
        }
        await expect(page.getByTestId("wallet-profile-scans")).toHaveText("0");
      }
      expect(errors).toEqual([]);
    });
  }
}

test("a failed default QR revoke retains the existing link and scans", async ({ page }) => {
  await open(page, 393, "light", { cards: 0, revokeFailure: true }, { shell: true, secure: true });
  await mount(page);
  await page.getByRole("button", { name: "Agent One Profile", exact: true }).click();
  await expect(page.getByTestId("wallet-profile-scans")).toHaveText("3");
  const qr = page.getByRole("img", { name: "Your Wallet Profile QR code", exact: true });
  const originalQr = await qr.evaluate(el => el.innerHTML);
  await page.getByRole("button", { name: "Revoke access", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Revoke access", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("qr-revoke:")).length)).toBe(1);
  await expect(dialog.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("wallet-profile-scans")).toHaveText("3");
  expect(await qr.evaluate(el => el.innerHTML)).toBe(originalQr);
});

for (const width of [320, 390, 714, 1440]) {
  test(`Add footer stays in view with balanced insets at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "dark", {}, { height: 667, shell: true }); await mount(page);
    await page.getByTestId("one-wallet-add").click();
    const dialog = page.getByRole("dialog", { name: "Add card", exact: true });
    await expect.poll(() => dialog.evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
    const save = page.getByTestId("secure-card-save");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(save).toBeInViewport(); await expect(cancel).toBeInViewport();
    const bounds = (await dialog.boundingBox())!, left = (await cancel.boundingBox())!, right = (await save.boundingBox())!;
    expect(left.x).toBeGreaterThan(bounds.x); expect(right.x + right.width).toBeLessThan(bounds.x + bounds.width);
    expect(Math.abs(left.y-right.y)).toBeLessThan(2);
    expect(left.height).toBeGreaterThanOrEqual(44); expect(right.height).toBeGreaterThanOrEqual(44);
    expect(errors).toEqual([]);
  });
}

test("Card request review selects a card, sends only to the requester, and clears its route on dismissal", async ({ page }) => {
  const errors = await open(page, 390, "light", { cards: 2, cardRequest: true });
  await mount(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Choose a card to share" })).toBeVisible();
  const send = dialog.getByRole("button", { name: "Share card", exact: true });
  await expect(send).toBeDisabled();
  await dialog.getByRole("radio", { name: /Everyday/ }).check();
  await send.click();
  await expect(dialog.getByText("Card sent", { exact: true })).toBeVisible();
  const sent = await page.evaluate(() => window.__walletEvents?.filter(e => e.startsWith("request-response:")) ?? []);
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0].slice("request-response:".length))).toMatchObject({ cardRequestId: "33333333-3333-4333-8333-333333333333", recipientPersonRefs: ["11111111-1111-4111-8111-111111111111"], durationMinutes: 15 });
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.__walletEvents?.includes("navigate:/one/wallet"))).toBe(true);
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});

for (const width of [380, 440, 460, 480, 620, 639, 640, 767]) {
  test(`Wallet controls stay reachable around responsive boundaries at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", { cards: 3 }, { height: 600, shell: true, secure: true });
    await mount(page);
    await page.getByTestId("one-wallet-add").click();
    const form = page.getByTestId("secure-card-add-form");
    await expect(form.getByLabel("Card number", { exact: true })).toHaveCSS("font-size", width <= 620 ? "16px" : "14px");
    const save = page.getByTestId("secure-card-save");
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    const selected = page.getByTestId("wallet-selected-card");
    await expect(selected).toBeVisible();
    await page.getByRole("button", { name: "Share card", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share card", exact: true });
    await expect(dialog.getByRole("textbox", { name: "Search connections" })).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  });
}

for (const theme of ["light", "dark"]) {
  test(`Wallet quiet command honors the user accent and interaction states in ${theme}`, async ({ page }) => {
    const errors = await open(page, 390, theme, { cards: 0 }, { height: 844, shell: true });
    await mount(page, false);
    await page.evaluate(() => document.documentElement.style.setProperty("--app-accent", "#a52a7b"));
    const action = page.getByRole("button", { name: "Continue", exact: true });
    await expect(action).toHaveCSS("color", "rgb(165, 42, 123)");
    await expect(action).toHaveCSS("border-top-width", "1px");
    await expect(action).toHaveCSS("min-height", "44px");
    const rest = await action.evaluate(element => getComputedStyle(element).backgroundColor);
    await action.hover();
    const hovered = await action.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(hovered).not.toBe(rest);
    await page.keyboard.press("Tab");
    await expect(action).toBeFocused();
    await action.click();
    await expect(page.getByRole("tab", { name: "My cards", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
