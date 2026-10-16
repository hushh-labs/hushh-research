import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
let outDir: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "circle-invite-picker-"));
  await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      },
    }],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/circle-invite-picker.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
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

test.afterAll(() => { if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); });

for (const viewport of [
  { name: "iPhone SE keyboard", width: 320, height: 568, keyboard: 260, safeTop: 20 },
  { name: "iPhone SE native first frame", width: 320, height: 568, keyboard: 260, safeTop: 59 },
  { name: "iPhone 15 keyboard", width: 393, height: 852, keyboard: 336, safeTop: 59 },
  { name: "desktop", width: 1440, height: 900, keyboard: 0, safeTop: 0 },
]) {
  test(`Circle picker keeps search, people and action visible: ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.setContent(`<html class="${viewport.keyboard ? "native-ios native-keyboard-inset kb-open" : ""}" style="--kb-height:${viewport.keyboard}px;--app-safe-area-top-effective:${viewport.safeTop}px"><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addScriptTag({ content: script });
    const dialog = page.getByRole("dialog", { name: "Add people to Trusted" });
    await expect(dialog).toBeVisible();
    await awaitProductFont(page);
    await expect(dialog.getByText("Connected person 1", { exact: true })).toBeVisible();
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    expect(errors).toEqual([]);
    const measure = () => page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>("[data-circle-invite-picker]")!;
      const search = sheet.querySelector<HTMLElement>('input[placeholder="Search connections"]')!;
      const list = sheet.querySelector<HTMLElement>("[data-circle-invite-results]")!;
      const firstRow = sheet.querySelector<HTMLElement>('[data-testid="one-location-circle-grow-eligible-person-1"]')!;
      const action = [...sheet.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.includes("Select people"))!;
      return {
        top: sheet.getBoundingClientRect().top,
        bottom: sheet.getBoundingClientRect().bottom,
        searchTop: search.getBoundingClientRect().top,
        searchBottom: search.getBoundingClientRect().bottom,
        listHeight: list.clientHeight,
        firstRowBottom: firstRow.getBoundingClientRect().bottom,
        listBottom: list.getBoundingClientRect().bottom,
        listScrollable: list.scrollHeight > list.clientHeight,
        actionBottom: action.getBoundingClientRect().bottom,
      };
    });
    const before = await measure();
    expect(before.top).toBeGreaterThanOrEqual(-0.5);
    expect(before.bottom).toBeLessThanOrEqual(viewport.height - viewport.keyboard + 0.5);
    expect(before.searchBottom).toBeLessThan(before.actionBottom);
    expect(before.actionBottom).toBeLessThanOrEqual(viewport.height - viewport.keyboard + 0.5);
    expect(before.listHeight).toBeGreaterThanOrEqual(72);
    expect(before.firstRowBottom).toBeLessThanOrEqual(before.listBottom + 1);
    expect(before.listScrollable).toBe(true);
    await page.locator("[data-circle-invite-results]").evaluate((list) => { list.scrollTop = list.scrollHeight; });
    const after = await measure();
    expect(after.searchTop).toBeCloseTo(before.searchTop, 0);
    await dialog.getByPlaceholder("Search connections").fill("Connected person 40");
    await expect(dialog.getByText("Connected person 40", { exact: true })).toBeVisible();
  });
}
