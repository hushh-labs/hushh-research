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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-pagination-"));
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
        entry: path.join(root, "e2e/fixtures/receipt-pagination.tsx"),
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
  css += fs.readdirSync(outDir).filter(file => file.endsWith(".css"))
    .map(file => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n");
});

for (const nested of [true, false]) {
  test(`receipt Previous preserves footer position with ${nested ? "app" : "document"} scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("http://localhost/receipt-pagination.js", route => route.fulfill({ contentType: "application/javascript", body: script }));
    await page.route("http://localhost/receipt-pagination-fixture?*", route => route.fulfill({contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><style>${css} html, body { height: auto; overflow: visible; }</style></head><body><div id="root"></div><script src="/receipt-pagination.js"></script></body></html>`}));
    await page.goto(`http://localhost/receipt-pagination-fixture?nested=${nested}`);
    await awaitProductFont(page);
    const pagination = page.getByRole("navigation", { name: "Table pagination" });
    const next = pagination.getByRole("button", { name: "Go to next page" });
    await pagination.scrollIntoViewIfNeeded();
    const initialTop = (await pagination.boundingBox())!.y;
    await next.click();
    await expect(pagination).toContainText("Page 2");
    expect(Math.abs((await pagination.boundingBox())!.y - initialTop)).toBeLessThan(2);
    await next.click();
    await expect(pagination).toContainText("Page 3");
    const previousTop = (await pagination.boundingBox())!.y;
    await pagination.getByRole("button", { name: "Go to previous page" }).click();
    await expect(pagination).toContainText("Page 2");
    expect(Math.abs((await pagination.boundingBox())!.y - previousTop)).toBeLessThan(2);
    await expect(page.getByTestId("receipt-16")).toBeVisible();
  });
}
