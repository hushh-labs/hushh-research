import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let script: string;
let css: string;
let outDir: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "consent-tab-strip-"));
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
    resolve: { alias: [
      { find: "next/navigation", replacement: path.join(root, "e2e/fixtures/consent-tab-navigation.ts") },
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/consent-tab-strip.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
          : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  const { optimize } = await import("@tailwindcss/node");
  const modules = fs.readdirSync(outDir).filter((name) => name.endsWith(".css"))
    .map((name) => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
  css = stripAppFontFaces(optimize(compiler.build([...candidates]) + modules, { minify: true }).code) + productFontStyle();
});

test.afterAll(() => { if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); });

for (const width of [320, 350, 360, 390, 400, 430, 768, 1440])
  test(`the mounted Consent tabs keep complete 15px labels at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.route("http://localhost/consent-tab-strip", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.goto("http://localhost/consent-tab-strip");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(4);
    await expect(tabs).toHaveText(["Requests", "Active", "History", "Connections"]);
    const geometry = await tabs.evaluateAll((nodes) => nodes.map((node) => {
      const label = node.querySelector('[data-ui-role="agent-tab-label"]')!;
      const box = node.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      const style = getComputedStyle(label);
      return { label: node.getAttribute("aria-label"), size: style.fontSize, line: style.lineHeight,
        weight: style.fontWeight, clipped: text.left < box.left - 1 || text.right > box.right + 1,
        height: box.height, selected: node.getAttribute("aria-selected") };
    }));
    expect(geometry.map((item) => item.label)).toEqual(["Requests", "Active", "History", "Connections"]);
    for (const item of geometry) {
      expect([item.size, item.line, item.weight]).toEqual(["15px", "20px", "550"]);
      expect(item.clipped, item.label!).toBe(false);
      expect(item.height).toBeGreaterThanOrEqual(44);
    }
    await tabs.nth(3).focus();
    await page.keyboard.press("Home");
    await expect(tabs.nth(0)).toBeFocused();
    await page.keyboard.press("End");
    await expect(tabs.nth(3)).toBeFocused();
    await expect(page.getByTestId("selected-consent-tab")).toHaveText("connections");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
