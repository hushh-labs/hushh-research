import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "country-picker-"));
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
          }
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": root } },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/country-picker.tsx"),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle() + fs.readdirSync(outDir).filter((name) => name.endsWith(".css")).map((name) => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
});


for (const width of [320, 393, 1440]) {
  for (const dark of [false, true]) {
    test(`Country picker ${width}px ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(`<html class="${dark ? "dark" : ""}"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({ content: script });
      const trigger = page.getByRole("button", { name: /^Country code:/ });
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveCSS("opacity", "1");
      await expect.poll(async () => (await dialog.boundingBox())!.x).toBeGreaterThanOrEqual(0);
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(845);
      expect(bounds!.width).toBe(width < 640 ? width : 520);
      await page.getByRole("button", { name: "Jump to U", exact: true }).click();
      await expect(page.getByRole("button", { name: "United Kingdom (+44)", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("country-picker.png") });
      for (const [name, code, iso] of [["United States", "+1", "US"], ["United Kingdom", "+44", "GB"], ["India", "+91", "IN"], ["Angola", "+244", "AO"], ["Brazil", "+55", "BR"]]) {
        await page.getByRole("searchbox", { name: "Search countries" }).fill(name);
        const row = page.getByRole("button", { name: `${name} (${code})`, exact: true });
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await row.click();
        await expect(dialog).toBeHidden();
        await expect(trigger).toHaveAccessibleName(`Country code: ${name} (${code})`);
        await expect(trigger).toContainText(iso);
        await trigger.click();
      }
      await page.getByRole("searchbox").fill("no country matches");
      await expect(page.getByRole("status")).toHaveText("No country codes found.");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toHaveAccessibleName("Country code: Brazil (+55)");
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  }
}
