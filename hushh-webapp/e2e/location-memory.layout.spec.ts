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
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": JSON.stringify({
      NEXT_PUBLIC_FIREBASE_API_KEY: "synthetic-fixture-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "synthetic.example.test",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "synthetic-fixture",
      NEXT_PUBLIC_FIREBASE_APP_ID: "synthetic-fixture-app",
    }) },
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle() +
    fs.readdirSync(outDir).filter(name => name.endsWith(".css"))
      .map(name => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
  const { transform } = await import("lightningcss");
  css = transform({ filename: "location-memory.css", code: Buffer.from(css), minify: true }).code.toString();
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
    expect(sizes).toEqual(["14px", "14px", "12px"]);
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
    const overlay = page.locator('[data-slot="dialog-content"][data-pkm-overlay="true"]');
    await expect(overlay).toBeVisible();
    const modalTitle = await overlay.locator('[data-slot="dialog-title"]').evaluate(element => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.lineHeight, style.fontWeight];
    });
    expect(modalTitle).toEqual(["20px", "28px", "600"]);
    expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe(width <= 620 ? "16px" : "14px");
    if (width >= 640) expect((await overlay.boundingBox())!.width).toBeLessThanOrEqual(380);
    await page.screenshot({ path: testInfo.outputPath("edit-memory-synthetic.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(overlay).toHaveCount(0);
    await page.getByRole("button", { name: "Open sharing settings" }).click();
    const sharing = page.locator('[data-pkm-memory-sharing-sheet="true"][data-pkm-overlay="true"]');
    await expect(sharing).toBeVisible();
    await expect(sharing.getByText("Sharing controls for this memory aren’t available right now. Refresh and try again.")).toBeVisible();
    await sharing.getByRole("button", { name: "Done" }).click();
    await expect(sharing).toHaveCount(0);
    await page.getByRole("button", { name: "Forget Memory" }).click();
    const forget = page.locator('[data-slot="alert-dialog-content"][data-pkm-overlay="true"]');
    await expect(forget).toBeVisible();
    const confirmationFills = await forget.evaluate(element => {
      const action = element.querySelector('[data-slot="alert-dialog-action"]')!;
      const cancel = element.querySelector('[data-slot="alert-dialog-cancel"]')!;
      return [getComputedStyle(action).backgroundColor, getComputedStyle(cancel).backgroundColor];
    });
    expect(confirmationFills[0]).not.toBe(confirmationFills[1]);
    await forget.getByRole("button", { name: "Cancel" }).click();
    await expect(forget).toHaveCount(0);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
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

for (const width of [350, 351, 360, 393, 430, 620, 621, 639, 640, 767, 768, 1024, 1440]) for (const theme of ["light", "dark"]) {
  test(`Memory preserves its shell and applies Connect roles at ${width}px, ${theme}`, async ({ page }, testInfo) => {
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
    const tabs = page.getByRole("tablist", { name: "Memory", exact: true });
    await expect(tabs).toHaveAttribute("data-ui-variant", "agent-top");
    await expect(page.locator(".memory-document-panel")).toHaveCount(0);
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
      const heading = document.querySelector('.app-page-header-region')!.getBoundingClientRect();
      const content = document.querySelector('.app-page-content-region')!.getBoundingClientRect();
      return {
        padding: [panelStyle.paddingTop, panelStyle.paddingRight, panelStyle.paddingBottom, panelStyle.paddingLeft],
        radius: panelStyle.borderRadius,
        surface: panelStyle.backgroundColor,
        shadow: panelStyle.boxShadow,
        body: [body.fontFamily, body.fontSize, body.lineHeight, body.color],
        row: [row.fontFamily, row.fontSize, row.lineHeight, row.color],
        sectionSize: section.fontSize,
        headerGap: content.top - heading.bottom,
      };
    });
    expect(styles.padding).toEqual(["0px", "16px", "24px", "16px"]);
    expect(styles.radius).toBe("0px");
    expect(styles.surface).toBe("rgba(0, 0, 0, 0)");
    expect(styles.shadow).toBe("none");
    expect(styles.body).toEqual(styles.row);
    expect(styles.sectionSize).toBe("16px");
    expect(styles.headerGap).toBe(16);
    if (width < 640) {
      const copy = await panel.getByText("The memory One uses in every conversation.").boundingBox();
      const edit = await panel.getByRole("button", { name: "Edit memory.md" }).boundingBox();
      expect(copy!.width).toBeGreaterThan(0);
      expect(await panel.getByText("The memory One uses in every conversation.").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(Math.abs(copy!.x - edit!.x)).toBeLessThan(1);
      expect(edit!.y).toBeGreaterThanOrEqual(copy!.y + copy!.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const editAction = panel.getByRole("button", { name: "Edit memory.md" });
    const action = await editAction.evaluate(element => {
      const outer = getComputedStyle(element);
      const inner = getComputedStyle(element.firstElementChild!);
      const target = element.getBoundingClientRect();
      const pill = element.firstElementChild!.getBoundingClientRect();
      return {
        outerHeight: target.height, pillHeight: pill.height, pillMinWidth: inner.minWidth,
        outerBackground: outer.backgroundColor, borderRadius: inner.borderRadius,
        font: [outer.fontSize, outer.lineHeight, outer.fontWeight],
      };
    });
    expect(action.outerHeight).toBeGreaterThanOrEqual(44);
    expect(action.pillHeight).toBeGreaterThanOrEqual(44);
    expect(action.pillMinWidth).toBe(width <= 350 ? "72px" : width <= 620 ? "78px" : "88px");
    expect(action.borderRadius).toBe("999px");
    expect(action.font).toEqual(["12px", "18px", "550"]);
    expect(action.outerBackground).toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: testInfo.outputPath(`memory-${width}-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Edit memory.md" }).click();
    await expect(page.getByRole("textbox", { name: "memory.md Markdown" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Live memory preview" })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(panel).toContainText("A second detail that stays aligned.");
    expect(errors).toEqual([]);
  });
}

for (const width of [350, 351, 360, 393, 430, 620, 621, 639, 640, 767, 768, 1024, 1440]) for (const theme of ["light", "dark"]) {
  test(`Add review stays readable at ${width}px, ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost/one/pkm**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
    await page.goto("http://localhost/one/pkm?workspace=add");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    await expect(page.getByRole("tab", { name: "Add" })).toHaveAttribute("aria-selected", "true");
    const note = page.getByRole("textbox", { name: "Memory note" });
    await expect(note).toBeVisible();
    expect(await note.evaluate(element => getComputedStyle(element).fontSize)).toBe(width <= 620 ? "16px" : "14px");
    const review = page.getByRole("button", { name: "Review memory" });
    await expect(review).toBeDisabled();
    await note.fill("I prefer synthetic morning flights whenever possible. ".repeat(6));
    await expect(review).toBeEnabled();
    await review.click();
    await expect(page.getByTestId("memory-capture-destination")).toContainText("Preferences");
    await expect(page.getByRole("button", { name: "Save to Memory" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    const geometry = await review.evaluate(element => {
      const inner = element.querySelector("span");
      const outerBox = element.getBoundingClientRect();
      const innerBox = inner?.getBoundingClientRect();
      return { outer: outerBox.height, inner: innerBox?.height ?? 0 };
    });
    expect(geometry.outer).toBeGreaterThanOrEqual(44);
    expect(geometry.inner).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("add-review-synthetic.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
}
