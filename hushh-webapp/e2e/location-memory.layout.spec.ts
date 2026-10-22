import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "location-memory-"));
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
      { find: "next/navigation", replacement: path.join(root, "e2e/fixtures/memory-workspace-ports.ts") },
      { find: "@/lib/pkm/use-live-mirror-view", replacement: path.join(root, "e2e/fixtures/memory-workspace-ports.ts") },
      { find: "./use-soul-memory-model", replacement: path.join(root, "e2e/fixtures/memory-workspace-ports.ts") },
      { find: "@/lib/pkm/markdown-memory", replacement: path.join(root, "e2e/fixtures/memory-workspace-ports.ts") },
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/location-memory.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
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

for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
  test(`Location details are readable in one click at ${width}px, ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://localhost/one/pkm**", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
    await page.goto("http://localhost/one/pkm");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    await page.getByRole("button", { name: "Location Saved places and visits" }).click();
    await expect(page).toHaveURL("http://localhost/one/pkm/location");
    const address = page.getByRole("button", { name: /^Home: Address/ });
    await expect(address).toContainText("Synthetic long address, ".repeat(16).trim());
    await expect(page.getByText("Synthetic library")).toBeVisible();
    await expect(page.getByText("12345")).toBeVisible();
    await expect(page.getByText(/Synthetic second line/)).toBeVisible();
    await expect(page.getByText("Locations", { exact: true })).toHaveCount(0);
    const sizes = await page.evaluate(() => ["settings-group-heading", "settings-row-title", "settings-row-description"].map((slot) => getComputedStyle(document.querySelector(`[data-slot="${slot}"]`)!).fontSize));
    expect(sizes).toEqual(["15px", "17px", "13px"]);
    expect(await address.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("location-memory-synthetic.png"), fullPage: true });
    await address.click();
    await expect(page).toHaveURL(/\/one\/pkm\/location\/detail\?memory=[a-f0-9]{16}$/);
    await expect(page.getByText("Home", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open in Location" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("searchbox", { name: "Search Location memory" })).toBeVisible();
    await page.getByRole("searchbox").fill("second line");
    await expect(page.getByText("Home", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Cafe", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear Location memory search" }).click();
    await expect(page.getByText("Home", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Location details: Note/ }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "New value for Note" });
    const initial = "Editable first line\nEditable second line " + "Full note ".repeat(30);
    await expect(editor).toHaveValue(initial);
    const corrected = initial.replace("Editable first", "Corrected first");
    await editor.fill(corrected);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Location details: Note/ })).toContainText(corrected.trim());
    await page.getByRole("button", { name: /^Location details: Note/ }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "New value for Note" })).toHaveValue(corrected);
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390, 768, 1440]) for (const theme of ["light", "dark"]) {
  test(`Memory uses Location's grouped reading rhythm at ${width}px, ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost/one/pkm**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="overflow:auto"><div id="root"></div></body></html>` }));
    await page.goto("http://localhost/one/pkm?workspace=1");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    expect(errors).toEqual([]);
    const panel = page.getByRole("region", { name: "memory.md", exact: true });
    const live = page.getByTestId("live-mirror-preview").locator('[data-slot="settings-group-shell"]');
    const tabs = page.getByRole("tablist", { name: "Memory navigation" });
    await expect(panel).toBeVisible();
    const bounds = await Promise.all([panel, live, tabs].map(locator => locator.boundingBox()));
    for (const item of bounds) expect(item).not.toBeNull();
    for (const item of bounds.slice(1)) {
      expect(Math.abs(item!.x - bounds[0]!.x)).toBeLessThan(1);
      expect(Math.abs(item!.width - bounds[0]!.width)).toBeLessThan(1);
    }
    const styles = await panel.evaluate(element => {
      const panelStyle = getComputedStyle(element);
      const row = getComputedStyle(document.querySelector('[data-testid="live-mirror-fact"] [data-slot="settings-row-title"]')!);
      const body = getComputedStyle(element.querySelector("li")!);
      const section = getComputedStyle(element.querySelector("h2")!);
      const liveStyle = getComputedStyle(document.querySelector('[data-testid="live-mirror-preview"] [data-slot="settings-group-shell"]')!);
      const heading = document.querySelector('.app-page-header-region')!.getBoundingClientRect();
      const content = document.querySelector('.app-page-content-region')!.getBoundingClientRect();
      return {
        padding: [panelStyle.paddingTop, panelStyle.paddingRight, panelStyle.paddingBottom, panelStyle.paddingLeft],
        radius: [panelStyle.borderRadius, liveStyle.borderRadius],
        surface: [panelStyle.backgroundColor, liveStyle.backgroundColor],
        body: [body.fontFamily, body.fontSize, body.lineHeight, body.color],
        row: [row.fontFamily, row.fontSize, row.lineHeight, row.color],
        sectionSize: section.fontSize,
        headerGap: content.top - heading.bottom,
      };
    });
    expect(styles.padding).toEqual(["16px", "16px", "16px", "16px"]);
    expect(styles.radius[0]).toBe(styles.radius[1]);
    expect(styles.surface[0]).toBe(styles.surface[1]);
    expect(styles.body).toEqual(styles.row);
    expect(styles.sectionSize).toBe("15px");
    expect(styles.headerGap).toBeLessThanOrEqual(width < 640 ? 1 : 7);
    if (width < 640) {
      const copy = await panel.getByText("The memory One uses in every conversation.").boundingBox();
      const edit = await panel.getByRole("button", { name: "Edit memory.md" }).boundingBox();
      expect(copy!.width).toBeGreaterThan(width * 0.65);
      expect(Math.abs(copy!.x - edit!.x)).toBeLessThan(1);
      expect(edit!.y).toBeGreaterThanOrEqual(copy!.y + copy!.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`memory-${width}-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Edit memory.md" }).click();
    await expect(page.getByRole("textbox", { name: "memory.md Markdown" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Live memory preview" })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(panel).toContainText("A second detail that stays aligned.");
    expect(errors).toEqual([]);
  });
}
