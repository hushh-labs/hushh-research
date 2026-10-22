import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyHistoryMovement } from "./helpers/history-motion";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let script: string;
let css: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-motion-"));
  try {
    await build({
      configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic" } },
      plugins: [{ name: "motion-fixture-candidates", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      } }],
      resolve: { alias: { "@": root } },
      define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      build: { outDir, emptyOutDir: false, lib: {
        entry: path.join(root, "e2e/fixtures/history-motion.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js",
      } },
    });
    script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    const { compile } = await import("tailwindcss");
    const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const filename = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css") : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
        return { path: filename, base: path.dirname(filename), content: fs.readFileSync(filename, "utf8") };
      },
    });
    css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle() +
      fs.readdirSync(outDir).filter(name => name.endsWith(".css")).map(name => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test("History tap motion and interrupted pulls move the entire panel without shifting Chat @motion-performance", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://localhost/history-motion-fixture", route => route.fulfill({
    contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto("http://localhost/history-motion-fixture");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await verifyHistoryMovement(page, true);
  expect(errors).toEqual([]);
});
