import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * Profile > Preferences > "How One writes to you" at the pixel grid (founder
 * bar, 2026-09-29): rows on the shared SettingsRow geometry with symmetric
 * 16 px sides and 8 px top and bottom, one 60 px row rhythm on a wide screen
 * and a 12 px label-to-control step on a phone, every control 44 px tall with
 * one shared right edge, the note block and footer on the same 16 px inset, a flat surface (no glass blur), the ripple on the Save
 * press with no scale, duotone row glyphs and no em dash in the copy. Light and
 * dark, phone and desktop, then again with every row's text widened a little,
 * because CI's Linux fonts set wider than a Mac.
 * Set STYLE_SETTINGS_SHOT_DIR to capture one screenshot per width and theme.
 */
let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "style-settings-"));
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
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/style-settings.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
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

async function open(page: Page, theme: "light" | "dark", state = "saved", reducedMotion: "reduce" | "no-preference" = "reduce") {
  // The ripple picks its mode when it mounts, so motion is set before the fixture loads.
  await page.emulateMedia({ reducedMotion });
  await page.route("http://localhost/style-settings**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto(`http://localhost/style-settings?state=${state}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByTestId("style-settings-row")).toHaveCount(5);
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("element has no box");
  return bounds;
}

const onGrid = (value: number, unit: number) => Math.abs(value / unit - Math.round(value / unit)) < 0.02;

type Geometry = {
  rowPadding: number[][];
  rowHeights: number[];
  /** Phone: the gap from a row's label block to the control stacked under it. */
  stackGaps: number[];
  notePadding: number[];
  textareaHeight: number;
  iconInsets: number[];
  controlHeights: number[];
  controlRights: number[];
  noteInsets: number[];
  footerInsets: number[];
  saveHeight: number;
  overflow: boolean;
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-testid='style-settings-row']")];
    const grid = (row: HTMLElement) => row.querySelector<HTMLElement>(":scope > div, :scope > button") ?? row;
    const rect = (node: Element) => node.getBoundingClientRect();
    const controls = [
      ...document.querySelectorAll<HTMLElement>("[data-testid='style-settings'] input, [data-testid='style-settings'] [data-slot='select-trigger']"),
    ];
    const note = document.querySelector<HTMLElement>("[data-testid='style-settings-note-block']")!;
    const textarea = note.querySelector("textarea")!;
    const footer = document.querySelector<HTMLElement>("[data-testid='style-settings-footer']")!;
    const group = document.querySelector<HTMLElement>("[data-testid='style-settings-note-group']")!;
    const root = document.querySelector<HTMLElement>("[data-testid='style-settings']")!;
    const rootBox = rect(root);
    return {
      rowPadding: rows.map((row) => {
        const style = getComputedStyle(grid(row));
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat);
      }),
      rowHeights: rows.map((row) => rect(row).height),
      stackGaps: rows.flatMap((row) => {
        const label = row.querySelector("[data-slot='settings-row-title']")?.parentElement;
        const control = row.querySelector("input, [data-slot='select-trigger']");
        if (!label || !control) return [];
        const gap = rect(control).top - rect(label).bottom;
        return gap > 0 ? [gap] : [];
      }),
      notePadding: (() => {
        const style = getComputedStyle(note);
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat);
      })(),
      textareaHeight: rect(textarea).height,
      iconInsets: rows.map((row) => rect(row.querySelector("[data-slot='settings-row-icon']")!).left - rect(row).left),
      controlHeights: controls.map((control) => rect(control).height),
      controlRights: controls.map((control) => rect(control).right),
      noteInsets: [rect(textarea).left - rect(note).left, rect(note).right - rect(textarea).right],
      footerInsets: [
        rect(footer.querySelector("[data-testid='style-settings-status']")!).left - rect(group).left,
        rect(group).right - rect(footer.querySelector("[data-testid='style-settings-save']")!).right,
      ],
      saveHeight: rect(footer.querySelector("[data-testid='style-settings-save']")!).height,
      overflow: [...root.querySelectorAll("*")].some((node) => {
        const bounds = rect(node);
        return bounds.width > 0 && (bounds.left < rootBox.left - 1 || bounds.right > rootBox.right + 1);
      }),
    };
  });
}

function assertGeometry(geometry: Geometry, label: string, width: number) {
  for (const padding of geometry.rowPadding) expect(padding, `${label} row padding`).toEqual([8, 16, 8, 16]);
  if (width >= 640) {
    // One 60 px rhythm: 8 + 44 + 8, every row, whatever its control.
    for (const height of geometry.rowHeights) expect(height, `${label} row height`).toBeCloseTo(60, 0);
    expect(geometry.stackGaps, `${label} nothing stacks`).toEqual([]);
  } else {
    // Text sets the label block's own height; the step under it is the grid's.
    expect(geometry.stackGaps.length, `${label} stacked controls`).toBe(4);
    for (const gap of geometry.stackGaps) expect(gap, `${label} label-to-control step`).toBeCloseTo(12, 0);
  }
  expect(geometry.notePadding, `${label} note padding`).toEqual([16, 16, 16, 16]);
  expect(onGrid(geometry.textareaHeight, 8), `${label} note field ${geometry.textareaHeight}`).toBe(true);
  for (const inset of geometry.iconInsets) expect(inset, `${label} icon inset`).toBeCloseTo(16, 0);
  expect(geometry.controlHeights.length, label).toBe(4);
  for (const height of geometry.controlHeights) expect(height, `${label} control height`).toBeCloseTo(44, 0);
  const rights = geometry.controlRights;
  expect(Math.max(...rights) - Math.min(...rights), `${label} control right edges`).toBeLessThan(0.5);
  expect(geometry.noteInsets[0], `${label} note left inset`).toBeCloseTo(16, 0);
  expect(Math.abs(geometry.noteInsets[0]! - geometry.noteInsets[1]!), `${label} note insets`).toBeLessThan(0.5);
  expect(geometry.footerInsets[0], `${label} footer left inset`).toBeCloseTo(16, 0);
  expect(Math.abs(geometry.footerInsets[0]! - geometry.footerInsets[1]!), `${label} footer insets`).toBeLessThan(0.5);
  expect(geometry.saveHeight, `${label} Save height`).toBeGreaterThanOrEqual(44);
  expect(geometry.overflow, `${label} overflow`).toBe(false);
}

for (const theme of ["light", "dark"] as const)
  for (const [width, height] of [[393, 852], [1440, 900]] as const)
    test(`style settings sit on the 4/8 grid at ${width}px, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, theme);
      const label = `${width}px ${theme}`;
      const geometry = await measure(page);
      assertGeometry(geometry, label, width);

      // Flat Morphy surfaces: no backdrop blur on any group or row.
      const blurred = await page.locator("[data-testid='style-settings'] *").evaluateAll((nodes) =>
        nodes.filter((node) => {
          const filter = getComputedStyle(node).backdropFilter;
          return filter && filter !== "none";
        }).length);
      expect(blurred, `${label} glass`).toBe(0);
      // Bare duotone glyphs on transparent wells; never a sparkle; no em dash.
      for (const well of await page.locator("[data-slot='settings-row-icon']").all()) {
        expect(await well.getAttribute("data-icon-tone")).toBe("capability");
        expect(await well.locator("svg [opacity='0.2']").count()).toBeGreaterThan(0);
      }
      const text = (await page.getByTestId("style-settings").textContent()) ?? "";
      expect(text).not.toMatch(/[—–]/);
      expect(await page.locator("[data-icon*='sparkle' i], [class*='sparkle' i]").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

      const metrics = { width, theme, ...geometry };
      testInfo.annotations.push({ type: "geometry", description: JSON.stringify(metrics) });
      const shotDir = process.env.STYLE_SETTINGS_SHOT_DIR;
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, `geometry-${width}-${theme}.json`), JSON.stringify(metrics, null, 2));
        await page.setViewportSize({ width, height: 1800 });
        await page.getByTestId("style-settings").screenshot({ path: path.join(shotDir, `style-settings-${width}-${theme}.png`), animations: "disabled" });
        await page.setViewportSize({ width, height });
      }

      await page.addStyleTag({ content: "[data-slot='settings-row-title'],[data-slot='settings-row-description'],[data-testid='style-settings-status']{letter-spacing:0.3px}" });
      assertGeometry(await measure(page), `${label} widened`, width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
    });

test("the Save press ripples without scaling, and a chat offer reads as unsaved", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await open(page, "light", "suggested", "no-preference");
  await expect(page.getByTestId("style-settings-status")).toHaveText("Suggested in chat. Check it, then save.");
  const save = page.getByTestId("style-settings-save");
  await expect(save).toBeEnabled();
  await save.scrollIntoViewIfNeeded();
  const before = await box(save);
  await page.mouse.move(before.x + before.width * 0.3, before.y + before.height / 2);
  await page.mouse.down();
  const read = () => save.evaluate((button) => {
    const surface = button.querySelector(".morphy-ripple-host md-ripple")?.shadowRoot?.querySelector(".surface");
    const style = getComputedStyle(button);
    const flatScale = style.scale === "none" || /^1(\s+1)?$/.test(style.scale);
    return { pressed: Boolean(surface?.classList.contains("pressed")), scaled: style.transform !== "none" || !flatScale };
  });
  await expect.poll(async () => (await read()).pressed, { timeout: 2000 }).toBe(true);
  await page.waitForTimeout(120);
  const reading = await read();
  const pressed = await box(save);
  await page.mouse.up();
  expect(reading.scaled).toBe(false);
  expect(Math.abs(pressed.width - before.width)).toBeLessThan(0.5);
  expect(Math.abs(pressed.height - before.height)).toBeLessThan(0.5);
});
