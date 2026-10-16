import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/** Production Mail status card and retained pager: equal typography, padding,
 * connection action and status tone in Overview, KYC and Receipts. */
let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-kyc-connect-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      },
    }],
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/mail-kyc-connect.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
          : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
            : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

// next-themes (attribute="class") puts `light` or `dark` on <html>; the flat
// Morphy card tokens at phone width are scoped to exactly those classes.
async function open(page: Page, theme: "light" | "dark", revoked = false) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("http://localhost/mail-kyc-connect**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto(`http://localhost/mail-kyc-connect${revoked ? "?revoked" : ""}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("element has no box");
  return bounds;
}

async function cardGeometry(card: Locator) {
  return card.evaluate((element) => {
    const heading = element.querySelector("h2")!;
    const button = element.querySelector("button")!;
    const label = element.querySelector("p")!;
    const cardStyle = getComputedStyle(element);
    const headingStyle = getComputedStyle(heading);
    const buttonStyle = getComputedStyle(button);
    const labelStyle = getComputedStyle(label);
    const bounds = element.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    return {
      x: bounds.x, width: bounds.width, height: bounds.height,
      padding: [cardStyle.paddingTop, cardStyle.paddingRight, cardStyle.paddingBottom, cardStyle.paddingLeft],
      radius: cardStyle.borderRadius, background: cardStyle.backgroundColor, border: cardStyle.borderColor,
      heading: [headingStyle.fontFamily, headingStyle.fontSize, headingStyle.lineHeight, headingStyle.fontWeight],
      label: [labelStyle.fontSize, labelStyle.lineHeight, labelStyle.fontWeight],
      button: [buttonStyle.fontFamily, buttonStyle.fontSize, buttonStyle.lineHeight, buttonStyle.fontWeight],
      buttonWidth: buttonBounds.width, buttonHeight: buttonBounds.height,
      buttonCenter: Math.abs(buttonBounds.x + buttonBounds.width / 2 - (bounds.x + bounds.width / 2)),
    };
  });
}

for (const theme of ["light", "dark"] as const)
  for (const [width, height] of [[320, 780], [393, 852], [768, 1024], [1440, 900]] as const)
    for (const revoked of [false, true])
      test(`Mail connection card matches all tabs at ${width}px, ${theme}, ${revoked ? "revoked" : "disconnected"}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await open(page, theme, revoked);
        await expect(page.getByRole("tab", { name: "KYC" })).toHaveAttribute("aria-selected", "true");
        const action = revoked ? "Reconnect Mail" : "Connect Mail";
        const kyc = page.getByRole("tabpanel", { name: "KYC" });
        const baseline = await cardGeometry(kyc.getByTestId("mail-connection-status"));
        expect(baseline.buttonHeight).toBeGreaterThanOrEqual(44);
        expect(baseline.buttonCenter).toBeLessThanOrEqual(0.5);
        expect(Math.abs(baseline.x - (width - baseline.x - baseline.width))).toBeLessThanOrEqual(0.5);
        await expect(kyc.getByRole("heading", { name: revoked ? "Reconnect Mail" : "Mail not connected", exact: true })).toBeVisible();
        if (revoked) await expect(kyc).toContainText("Refresh access to keep receipts syncing.");

        for (const name of ["Overview", "Receipts", "KYC"]) {
          await page.getByRole("tab", { name, exact: true }).click();
          const panel = page.getByRole("tabpanel", { name, exact: true });
          const card = panel.getByTestId("mail-connection-status");
          await expect(card).toBeVisible();
          const button = page.getByRole("button", { name: action, exact: true });
          await expect(button).toHaveCount(1);
          // Compare rendered geometry and type against the same KYC viewport.
          await expect.poll(() => cardGeometry(card)).toEqual(baseline);
        }
        await page.getByRole("button", { name: action, exact: true }).click();
        await expect(page.getByTestId("kyc-connects")).toHaveText("1");
        await page.addStyleTag({ content: "[data-testid='mail-connection-status']{letter-spacing:0.3px}" });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        expect(errors).toEqual([]);
        testInfo.annotations.push({ type: "geometry", description: JSON.stringify(baseline) });
        const shotDir = process.env.MAIL_KYC_SHOT_DIR;
        if (shotDir && revoked) {
          fs.mkdirSync(shotDir, { recursive: true });
          await page.screenshot({ path: path.join(shotDir, `mail-kyc-connect-${width}-${theme}.png`), fullPage: false });
        }
      });

test("leaving KYC retains its pane but removes connect authority (negative control)", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await open(page, "light");
  await expect(page.getByRole("tabpanel", { name: "KYC" }).getByTestId("mail-connection-status")).toBeVisible();
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toBeVisible();
  await expect(page.locator("#top-shell-gmail-workspace-panel-kyc")).toHaveAttribute("inert", "");
  await expect(page.locator("#top-shell-gmail-workspace-panel-kyc")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Connect Mail", exact: true })).toHaveCount(1);
  await expect(page.getByTestId("kyc-connects")).toHaveText("0");
});

test("Mail drags through all three retained panes and nested receipt scrolling wins", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await open(page, "light");
  await expect(page.getByRole("tabpanel", { name: "KYC" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { retainedKyc: Element | null }).retainedKyc = document.querySelector("#top-shell-gmail-workspace-panel-kyc [data-testid='mail-connection-status']");
  });
  const pager = page.locator("[data-swipe-views-root='true']");
  // Fill height is measured on the first animation frame. Starting before
  // that frame would place the gesture on receipt content, not the blank body.
  await expect.poll(async () => pager.evaluate(element => parseFloat(getComputedStyle(element).minHeight))).toBeGreaterThan(400);
  const pagerBox = await box(pager);
  const y = pagerBox.y + Math.min(pagerBox.height / 2, 180);
  const drag = async (direction: "left" | "right", atY = y) => {
    const left = pagerBox.x + 40;
    const right = pagerBox.x + pagerBox.width - 40;
    await page.mouse.move(direction === "left" ? right : left, atY);
    await page.mouse.down();
    await page.mouse.move(direction === "left" ? left : right, atY, { steps: 12 });
    await page.mouse.up();
  };
  const selected = async (name: string) => {
    await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    // Selection reports immediately; a follow-up gesture must start on the
    // settled visible pane rather than on the outgoing one mid-snap.
    // The shared pager reconciles snap residuals above 1 CSS px; keep this
    // arrival check on that existing engine contract (WebKit stops at ~0.57).
    await expect.poll(async () => Math.abs((await box(page.getByRole("tabpanel", { name }))).x - (await box(pager)).x)).toBeLessThanOrEqual(1);
  };
  await drag("right");
  await selected("Overview");
  await drag("left");
  await selected("KYC");
  await drag("left");
  await selected("Receipts");

  const rail = await box(page.getByTestId("receipt-rail"));
  await drag("right", rail.y + rail.height / 2);
  await selected("Receipts");
  await drag("right");
  await selected("KYC");
  expect(await page.evaluate(() => (window as unknown as { retainedKyc: Element | null }).retainedKyc === document.querySelector("#top-shell-gmail-workspace-panel-kyc [data-testid='mail-connection-status']"))).toBe(true);
  await expect(page.getByTestId("kyc-connects")).toHaveText("0");
  await page.getByRole("tab", { name: "Receipts" }).click();
  await expect(page.getByRole("tabpanel", { name: "Receipts" })).toBeVisible();
  await page.getByRole("tab", { name: "Receipts" }).press("Home");
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Connect Mail to set up receipts and KYC requests.")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Pager frames stay local to this strip, never invalidate the app root.
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--top-shell-tab-swipe-gmail-workspace-position"))).toBe("");
});
