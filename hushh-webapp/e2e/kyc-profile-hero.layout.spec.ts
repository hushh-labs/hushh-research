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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "kyc-profile-hero-"));
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
        entry: path.join(root, "e2e/fixtures/kyc-profile-hero.tsx"),
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

for (const width of [320, 390, 768, 1440]) {
  test(`KYC intro card matches the tabs and stays inside the screen at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width >= 1024 ? 832 : 900 });
    await page.route("http://localhost/kyc-profile-hero.js", route => route.fulfill({contentType: "application/javascript; charset=utf-8", body: script}));
    await page.route("http://localhost/kyc-profile-hero-fixture", route => route.fulfill({contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/kyc-profile-hero.js"></script></body></html>`}));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://localhost/kyc-profile-hero-fixture");
    await awaitProductFont(page);

    const hero = page.getByTestId("kyc-profile-hero");
    const tabs = page.getByRole("tablist", { name: "Gmail workspace" });
    await expect(hero).toBeVisible();
    // Exactly the width of the workspace tabs above it, at every width.
    const heroBounds = (await hero.boundingBox())!;
    const tabsBounds = (await tabs.boundingBox())!;
    expect(Math.abs(heroBounds.x - tabsBounds.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(heroBounds.width - tabsBounds.width)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    const title = page.getByRole("heading", { name: "Build your KYC profile" });
    const cta = page.getByRole("button", { name: "Paste details" });
    const preview = page.getByTestId("kyc-profile-preview");
    await expect(page.getByText("KYC Automation")).toHaveCount(0);
    await expect(preview).toBeVisible();
    for (const control of [title, cta, preview]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(heroBounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(heroBounds.x + heroBounds.width + 1);
    }
    // The same footprint as "Chat with One" on the Overview.
    const ctaBounds = (await cta.boundingBox())!;
    expect(ctaBounds.width).toBeCloseTo(244, 0);
    expect(ctaBounds.height).toBeCloseTo(50, 0);
    // Side by side only when the slot can hold both. Stacked it reads heading,
    // copy, the preview, then the action.
    const copyBounds = (await title.boundingBox())!;
    const copyEnd = (await page.getByText("Paste your profile details to automate").boundingBox())!;
    const previewBounds = (await preview.boundingBox())!;
    if (heroBounds.width >= 512) {
      expect(previewBounds.x).toBeGreaterThan(copyBounds.x + copyBounds.width - 1);
      // The action sits under the copy in the same left column.
      expect(Math.abs(ctaBounds.x - copyBounds.x)).toBeLessThanOrEqual(1);
      expect(ctaBounds.y).toBeGreaterThan(copyEnd.y + copyEnd.height);
    } else {
      expect(previewBounds.y).toBeGreaterThanOrEqual(copyEnd.y + copyEnd.height);
      expect(ctaBounds.y).toBeGreaterThanOrEqual(previewBounds.y + previewBounds.height);
      expect(Math.abs(ctaBounds.x + ctaBounds.width / 2 - (heroBounds.x + heroBounds.width / 2))).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`kyc-hero-${width}.png`) });

    await cta.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect.poll(() => dialog.evaluate(el => getComputedStyle(el).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, )/);
    const dialogBounds = (await dialog.boundingBox())!;
    expect(dialogBounds.x).toBeGreaterThanOrEqual(0);
    expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(width);
    expect(dialogBounds.y).toBeGreaterThanOrEqual(0);
    expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await expect(dialog.getByRole("heading", { name: "Paste your profile details" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "KYC details" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save profile" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "KYC details" }).fill("Full name: Example Person");
    await expect(dialog.getByRole("button", { name: "Save profile" })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Skip for now" })).toBeVisible();
    // No hover wash behind the two text actions.
    for (const name of ["Copy prompt to clipboard", "Skip for now"]) {
      const action = dialog.getByRole("button", { name });
      const before = await action.evaluate(el => getComputedStyle(el).backgroundColor);
      await action.hover();
      expect(await action.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(before);
      // The shared Button wraps its label and adds a state-layer element; these
      // are bare buttons, so nothing but the label and an icon is inside.
      expect(await action.locator(":scope > :not(svg)").count()).toBe(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`kyc-dialog-${width}.png`) });
    expect(errors).toEqual([]);
  });
}
