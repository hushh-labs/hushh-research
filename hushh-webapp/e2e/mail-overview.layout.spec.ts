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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-overview-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        // Candidates are derived from every transformed module, so a class the
        // card renders cannot be missing from the CSS. A hand-maintained list
        // would let an unregistered class emit no style and still pass.
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
        },
      },
    ],
    resolve: {
      alias: [
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/mail-overview.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
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
              ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

for (const width of [320, 390, 430, 768, 1440]) {
  test(`Mail overview stays aligned at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("http://localhost/mail-overview.js", route => route.fulfill({contentType: "application/javascript", body: script}));
    await page.route("http://localhost/mail-overview-fixture", route => route.fulfill({contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/mail-overview.js"></script></body></html>`}));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://localhost/mail-overview-fixture");
    await awaitProductFont(page);
    const hero = page.getByRole("heading", {name: "Draft with One."});
    await expect(hero).toBeVisible();
    expect(await hero.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(width < 640 ? 28 : 44);
    const receipts = page.getByTestId("mail-receipt-sync");
    await expect(receipts.locator("button, a, [data-slot=settings-row-chevron]")).toHaveCount(0);
    expect(await receipts.evaluate(el => getComputedStyle(el).borderTopLeftRadius)).toBe("20px");
    const beforeHover = await receipts.evaluate(el => getComputedStyle(el).backgroundColor);
    await receipts.hover();
    expect(await receipts.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(beforeHover);
    const chat = page.getByRole("button", {name: "Chat with One"});
    const manage = page.getByRole("button", {name: "Manage"});
    const heroBefore = await hero.boundingBox();
    const triggerBackground = await manage.evaluate(el => getComputedStyle(el).backgroundColor);
    await manage.hover();
    expect(await manage.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(triggerBackground);
    await manage.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(["Reconnect", "Disconnect"]);
    expect(await hero.boundingBox()).toEqual(heroBefore);
    const menuBounds = await menu.boundingBox();
    expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(manage).toBeFocused();
    await manage.click();
    await page.getByRole("menuitem", {name: "Reconnect", exact: true}).click();
    await expect(page.getByTestId("mail-action")).toHaveText("reconnect");
    await expect(menu).toBeHidden();
    await manage.click();
    await page.getByRole("menuitem", {name: "Disconnect", exact: true}).click();
    await expect(page.getByTestId("mail-action")).toHaveText("disconnect");
    await expect(menu).toBeHidden();
    for (const control of [receipts, chat, manage]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect((await receipts.boundingBox())!.y).toBeGreaterThan((await hero.boundingBox())!.y);
    expect((await chat.boundingBox())!.y).toBeGreaterThan((await receipts.boundingBox())!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(chat.locator("svg")).toHaveCount(0);
    await expect(page.getByRole("status", {name: "Fetching receipts"})).toBeVisible();
    await page.getByRole("button", {name: "Finish sync"}).click();
    await expect(page.getByRole("status", {name: "Fetching receipts"})).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({path: testInfo.outputPath(`mail-${width}.png`)});
  });
}
