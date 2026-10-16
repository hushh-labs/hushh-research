import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let script: string;
let css: string;
let fixtureOutputDirectory: string | null = null;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "duration-dialog-"));
  fixtureOutputDirectory = outDir;
  await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [{
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      },
    }],
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/duration-selector-dialog.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
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

test.afterAll(() => {
  if (!fixtureOutputDirectory) return;
  const target = path.resolve(fixtureOutputDirectory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !/^duration-dialog-[a-zA-Z0-9]+$/.test(path.basename(target))) {
    throw new Error(`Unexpected duration fixture directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
});

for (const [width, height, current] of [
  [320, 568, false], [390, 844, false], [430, 932, true],
  [768, 1024, false], [1440, 900, false], [844, 390, true],
] as const) {
  test(`duration options stay inside the dialog at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://localhost/duration-dialog**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.goto(`http://localhost/duration-dialog${current ? "?current=1" : ""}`);
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const dialog = page.getByRole("dialog");
    const trigger = page.getByRole("combobox", { name: "New time" });
    const closed = await dialog.boundingBox();
    expect(closed).not.toBeNull();
    await trigger.click();
    const options = page.getByRole("listbox");
    await expect(options).toBeVisible();
    await expect.poll(async () => {
      const outer = await dialog.boundingBox();
      const inner = await options.boundingBox();
      return Boolean(outer && inner && inner.x >= outer.x + 8 &&
        inner.x + inner.width <= outer.x + outer.width - 8 &&
        inner.y >= outer.y + 8 && inner.y + inner.height <= outer.y + outer.height - 8 &&
        inner.y >= 0 && inner.y + inner.height <= height);
    }).toBe(true);
    expect((await dialog.boundingBox())!.height).toBeGreaterThan(closed!.height + 60);
    for (const option of await page.getByRole("option").all()) {
      expect(await option.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(43.99);
    }
    const evidenceDir = process.env.OVERFLOW_ACTION_EVIDENCE_DIR;
    if (evidenceDir && (width === 390 || width === 1440)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: path.join(evidenceDir, `duration-dialog-${width}-${testInfo.project.name}.png`) });
    }
    await page.getByRole("option", { name: "Until I stop", exact: true }).click();
    await expect(trigger).toContainText("Until I stop");
    await expect(options).toHaveCount(0);
    await expect.poll(async () => (await dialog.boundingBox())!.height).toBeLessThanOrEqual(closed!.height + 1);
    await trigger.click();
    await expect(options).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(trigger).toBeFocused();
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`contact badges align beside row controls at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("http://localhost/duration-dialog**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }));
    for (const surface of ["invite", "sms"]) {
      await page.goto(`http://localhost/duration-dialog?people=${surface}`);
      await page.addScriptTag({ content: script });
      await awaitProductFont(page);
      const rows = surface === "invite"
        ? page.locator('[data-testid^="one-location-circle-grow-eligible-person-"]')
        : page.getByTestId("contact-picker-row");
      await expect(rows).toHaveCount(4);
      const geometry = await rows.evaluateAll((elements, surface) => elements.map((row) => {
        const badge = row.querySelector('[aria-label="Connected from your contacts"]')!;
        const control = row.querySelector(surface === "invite"
          ? '[data-slot="settings-row-trailing"] > span > span:last-child'
          : "button")!;
        const b = badge.getBoundingClientRect();
        const c = control.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        return { right: b.right, gap: c.left - b.right,
          centreDelta: Math.abs(b.y + b.height / 2 - c.y - c.height / 2),
          controlRight: c.right, rowRight: r.right };
      }), surface);
      for (const row of geometry) {
        expect(row.right).toBeCloseTo(geometry[0].right, 0);
        expect(row.gap).toBeCloseTo(12, 0);
        expect(row.centreDelta).toBeLessThanOrEqual(1);
        expect(row.controlRight).toBeLessThanOrEqual(row.rowRight - 10);
      }
      if (process.env.OVERFLOW_ACTION_EVIDENCE_DIR && (width === 390 || width === 1440)) {
        await page.screenshot({ path: path.join(process.env.OVERFLOW_ACTION_EVIDENCE_DIR,
          `contact-badges-${surface}-${width}-${testInfo.project.name}.png`) });
      }
    }
  });
}
