import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  productFontStyle,
  stripAppFontFaces,
  awaitProductFont,
} from "./fixtures/product-font";

let script: string;
let css: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "first-connect-insights-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
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
        { find: "@/lib/agent/first-connect-insights", replacement: path.join(root, "e2e/fixtures/first-connect-insights-boundaries.ts") },
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
        entry: path.join(root, "e2e/fixtures/first-connect-insights.tsx"),
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
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
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


for (const [width, dark] of [[320, false], [390, false], [1280, false], [390, true]] as const) {
  test(`Keep and Forget align before and during confirmation at ${width}px${dark ? " dark" : ""}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("http://localhost/insights-fixture", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.goto("http://localhost/insights-fixture");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const keep = page.getByTestId("first-connect-insight-keep").first();
    const forget = page.getByTestId("first-connect-insight-forget").first();
    const geometry = async () => {
      const a = (await keep.boundingBox())!;
      const b = (await forget.boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(1);
      expect(Math.abs(a.width - b.width)).toBeLessThan(1);
      expect(Math.abs(a.height - b.height)).toBeLessThan(1);
      expect(a.height).toBeGreaterThanOrEqual(44);
      expect(b.x).toBeGreaterThan(a.x + a.width);
      expect(await keep.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    await expect(keep).toBeVisible();
    for (const row of await page.getByTestId("first-connect-insight").all()) {
      const bounds = (await row.boundingBox())!;
      for (const action of ["Keep", "Forget"]) {
        const button = row.getByRole("button", { name: action, exact: true });
        const target = (await button.boundingBox())!;
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(target.y).toBeGreaterThanOrEqual(bounds.y);
        expect(target.y + target.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      }
    }
    await geometry();
    await keep.click();
    await expect(keep).toHaveAttribute("aria-busy", "true");
    await geometry();
    await expect(keep).toHaveAccessibleName("Keep and share");
    await expect(page.getByText(/share with 2 people/)).toBeVisible();
    await geometry();
    await page.screenshot({ path: test.info().outputPath(`insight-controls-${width}${dark ? "-dark" : ""}.png`), animations: "disabled" });
    await forget.click();
    await expect(page.getByTestId("first-connect-insight")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Show my week" })).toHaveCount(0);
    await page.getByTestId("first-connect-insight-forget").click();
    const showWeek = page.getByRole("button", { name: "Show my week" });
    await expect(showWeek).toBeVisible();
    const target = (await showWeek.boundingBox())!;
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.x).toBeGreaterThanOrEqual(16);
    expect(target.x + target.width).toBeLessThanOrEqual(width - 16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`calendar-follow-up-${width}${dark ? "-dark" : ""}.png`), animations: "disabled" });
    await showWeek.click();
    await expect(page.getByRole("status")).toHaveText("What's on my calendar this week?");
    await expect(showWeek).toHaveCount(0);
  });
}
