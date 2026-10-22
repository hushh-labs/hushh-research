import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
let baselineScript: string;
let outDir: string;


async function setFixtureContent(page: Page, content: string) {
  // A mobile browser otherwise uses its 980px compatibility layout viewport,
  // which measures desktop placement instead of the phone surface.
  await page.setContent(content.replace("<head>", '<head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "circle-invite-picker-"));
  const configuration: import("vite").InlineConfig = {
    configFile: false,
    publicDir: false,
    logLevel: "error",
    plugins: [{
      // These layout cases never navigate a message. Keep that external
      // service out of the fixture's auth-free component harness.
      name: "fixture-message-navigation-boundary",
      resolveId(id) { if (id === "\0fixture:message-navigation") return id; },
      load(id) { if (id === "\0fixture:message-navigation") return 'export async function resolveDirectMessageHref() { throw new Error("Message navigation is outside this layout fixture"); }'; },
    }, {
      name: "fixture-css-candidates",
      transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
        }
      },
    }],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [{ find: "@/lib/direct-messages/navigate-direct-message", replacement: "\0fixture:message-navigation" }, { find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/circle-invite-picker.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  };
  await build(configuration);
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  if (process.env.SHEETS_BASELINE_REF) {
    const previous = execFileSync("git", ["show", `${process.env.SHEETS_BASELINE_REF}:hushh-webapp/components/one-location/redesign/circles/circle-grow-actions.tsx`], { cwd: root, encoding: "utf8" });
    await build({ ...configuration, plugins: [{
      name: "previous-circle-picker", enforce: "pre",
      transform(_source, id) {
        if (id.endsWith("/components/one-location/redesign/circles/circle-grow-actions.tsx")) {
          for (const candidate of scanner.scanFiles([{ content: previous, extension: "tsx" }])) candidates.add(candidate);
          return { code: previous, map: null };
        }
      },
    }, ...(configuration.plugins ?? [])] });
    baselineScript = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  }
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
  const modules = fs.readdirSync(outDir).filter(name => name.endsWith(".css"))
    .map(name => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
  const { optimize } = await import("@tailwindcss/node");
  css = stripAppFontFaces(optimize(compiler.build([...candidates]) + modules, { minify: true }).code) + productFontStyle();
});

test.afterAll(() => { if (outDir) fs.rmSync(outDir, { recursive: true, force: true }); });

for (const viewport of [
  { name: "iPhone SE keyboard", width: 320, height: 568, keyboard: 260, safeTop: 20 },
  { name: "iPhone SE native first frame", width: 320, height: 568, keyboard: 260, safeTop: 59 },
  { name: "iPhone 15 keyboard", width: 393, height: 852, keyboard: 336, safeTop: 59 },
  { name: "desktop", width: 1440, height: 900, keyboard: 0, safeTop: 0 },
]) {
  test(`Circle picker keeps search, people and action visible: ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await setFixtureContent(page, `<html class="${viewport.keyboard ? "native-ios native-keyboard-inset kb-open" : ""}" style="--kb-height:${viewport.keyboard}px;--app-safe-area-top-effective:${viewport.safeTop}px"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addScriptTag({ content: script });
    const dialog = page.getByRole("dialog", { name: "Add people to Trusted" });
    await expect(dialog).toBeVisible();
    await awaitProductFont(page);
    await expect(dialog.getByText("Connected person 1", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Select Connected person 1 for Circle invitation/ })).toHaveAccessibleDescription(/Connected .*From your contacts.*Verified advisor/);
    // Content arriving during entry can cancel an animation; both states settle before measurement.
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
    expect(errors).toEqual([]);
    const measure = () => page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>("[data-circle-invite-picker]")!;
      const search = sheet.querySelector<HTMLElement>('input[placeholder="Search connections"]')!;
      const list = sheet.querySelector<HTMLElement>("[data-circle-invite-results]")!;
      const firstRow = sheet.querySelector<HTMLElement>('[data-testid="one-location-circle-grow-eligible-person-1"]')!;
      const action = [...sheet.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.includes("Select people"))!;
      return {
        top: sheet.getBoundingClientRect().top,
        bottom: sheet.getBoundingClientRect().bottom,
        searchTop: search.getBoundingClientRect().top,
        searchBottom: search.getBoundingClientRect().bottom,
        frameScroll: sheet.querySelector("[data-task-scroll]")?.getAttribute("data-task-scroll"),
        listHeight: list.clientHeight,
        firstRowBottom: firstRow.getBoundingClientRect().bottom,
        listBottom: list.getBoundingClientRect().bottom,
        listScrollable: list.scrollHeight > list.clientHeight,
        actionBottom: action.getBoundingClientRect().bottom,
      };
    });
    const before = await measure();
    expect(before.top).toBeGreaterThanOrEqual(-0.5);
    expect(before.bottom).toBeLessThanOrEqual(viewport.height - viewport.keyboard + 0.5);
    expect(before.searchBottom).toBeLessThan(before.actionBottom);
    expect(before.actionBottom).toBeLessThanOrEqual(viewport.height - viewport.keyboard + 0.5);
    if (before.frameScroll === "frame") {
      // On a short keyboard viewport, the frame itself scrolls rather than
      // clipping the form to keep an impossible fixed-header/body split.
      expect(await dialog.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await dialog.getByPlaceholder("Search connections").focus();
      await expect(dialog.getByPlaceholder("Search connections")).toBeInViewport();
    } else {
      expect(before.listHeight).toBeGreaterThanOrEqual(72);
      expect(before.firstRowBottom).toBeLessThanOrEqual(before.listBottom + 1);
      expect(before.listScrollable).toBe(true);
    }
    await page.locator("[data-circle-invite-results]").evaluate((list) => { list.scrollTop = list.scrollHeight; });
    const after = await measure();
    if (before.frameScroll !== "frame") expect(after.searchTop).toBeCloseTo(before.searchTop, 0);
    await dialog.getByPlaceholder("Search connections").fill("Connected person 40");
    await expect(dialog.getByText("Connected person 40", { exact: true })).toBeVisible();
  });
}

for (const theme of ["light", "dark"]) {
  test(`Task surface is opaque above the shared blurred backdrop: ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setFixtureContent(page, `<html class="${theme}"><head><style>${css}</style></head><body><main>Previous screen</main><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: script });
    const dialog = page.getByRole("dialog", { name: "Add people to Trusted" });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    const geometry = await dialog.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const overlay = getComputedStyle(document.querySelector('[data-slot="sheet-overlay"]')!);
      const title = node.querySelector('[data-slot="sheet-title"]')!.getBoundingClientRect();
      const search = node.querySelector('[data-slot="input-group"]')!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, background: style.backgroundColor,
        overlay: overlay.backgroundColor, blur: overlay.backdropFilter || overlay.getPropertyValue("-webkit-backdrop-filter"),
        insetDelta: Math.abs(title.left - search.left), searchHeight: search.height };
    });
    expect(geometry.x + geometry.width / 2).toBeCloseTo(640, 0);
    expect(geometry.y + geometry.height / 2).toBeCloseTo(450, 0);
    expect(geometry.insetDelta).toBeLessThanOrEqual(1);
    expect(geometry.searchHeight).toBe(44);
    expect(geometry.background).toMatch(/^rgb\(/);
    expect(geometry.blur).toMatch(/blur\([1-9]/);
    expect(geometry.overlay).not.toMatch(/rgba?\([^)]*, 0\)$/);
    // Crossing the breakpoint changes placement without recreating the form.
    await dialog.getByTestId("one-location-circle-grow-eligible-person-1").click();
    await dialog.getByPlaceholder("Search connections").fill("Connected person 1");
    const input = await dialog.getByPlaceholder("Search connections").elementHandle();
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(dialog.getByRole("button", { name: "Invite 1 person", exact: true })).toBeEnabled();
    expect(await input!.evaluate(node => node === document.querySelector('input[placeholder="Search connections"]'))).toBe(true);
    await expect(dialog.getByPlaceholder("Search connections")).toHaveValue("Connected person 1");
    // Negative control: dropping independent centering reproduces the old
    // optimized-animation displacement and must fail the center predicate.
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.evaluate(node => { node.style.translate = "none"; });
    const displacedCenter = await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.y + r.height / 2; });
    expect(Math.abs(displacedCenter - 450)).toBeGreaterThan(100);
  });
}

for (const viewport of [
  { width: 320, height: 568, keyboard: 260 },
  { width: 393, height: 852, keyboard: 336 },
]) test(`Living picker preserves phone search and action above the keyboard: ${viewport.width}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await setFixtureContent(page, `<html data-fixture="living" class="native-ios native-keyboard-inset kb-open" style="--kb-height:${viewport.keyboard}px;--app-safe-area-top-effective:59px"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  const dialog = page.getByRole("dialog", { name: "Add people", exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
  const bounds = await dialog.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(59 - 0.5);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - viewport.keyboard + 0.5);
  const input = dialog.getByRole("searchbox");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocapitalize", "none");
  await expect(input).toHaveAttribute("spellcheck", "false");
  await expect(input).toHaveAttribute("enterkeyhint", "search");
  await input.focus();
  await expect(input).toBeInViewport();
  await input.fill("Connected person 40");
  await input.press("Enter");
  await expect(input).not.toBeFocused();
  await dialog.getByRole("checkbox", { name: "Add Connected person 40 to Family", exact: true }).check();
  const action = dialog.getByRole("button", { name: "Add people", exact: true });
  await expect(action).toBeEnabled();
  await expect(action).toBeInViewport();
  expect((await action.boundingBox())!.y + (await action.boundingBox())!.height)
    .toBeLessThanOrEqual(viewport.height - viewport.keyboard + 0.5);
});

test("Selected view keeps the frame stable and enlarged confirmations remain reachable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await setFixtureContent(page, `<html data-fixture="living"><head><style>${css}</style></head><body><main>Previous screen</main><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  const dialog = page.getByRole("dialog", { name: "Add people", exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
  const before = await dialog.boundingBox();
  await dialog.getByRole("checkbox", { name: "Add Connected person 1 to Family", exact: true }).click();
  await dialog.getByRole("tab", { name: "Selected (1)" }).click();
  const after = await dialog.boundingBox();
  expect(after!.height).toBeCloseTo(before!.height, 0);
  await expect(dialog.getByRole("button", { name: "Add people", exact: true })).toBeInViewport();
  await dialog.getByRole("searchbox").fill("No match");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Clear search" }).click();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  const screenshot = await page.screenshot({ path: "/tmp/sheets-v15-living-phone.png" });
  await testInfo.attach("sheets-v15-living-phone", { body: screenshot, contentType: "image/png" });
  await setFixtureContent(page, `<html data-fixture="confirmation" style="--kb-height:336px;font-size:24px"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Remove", exact: true })).toBeInViewport();
  const scrollable = await confirmation.evaluate(node => node.scrollHeight > node.clientHeight);
  expect(scrollable).toBe(true);
  await confirmation.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
});

test("Create step two keeps its virtual list and final controls reachable above the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await setFixtureContent(page, `<html data-fixture="create-people" class="native-ios kb-open native-keyboard-inset" style="--kb-height:336px;--app-safe-area-top-effective:59px"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  const dialog = page.getByRole("dialog", { name: "Create Circle: add people" });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole("searchbox", { name: "Search connections" });
  await search.fill("Connected person 45");
  const row = dialog.getByRole("button", { name: "Add Connected person 45", exact: true });
  await row.click();
  await expect(dialog.getByRole("button", { name: "Add 1 person", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Add 1 person", exact: true })).toBeInViewport();
  const rect = await dialog.boundingBox();
  expect(rect!.y).toBeGreaterThanOrEqual(-1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(852 - 336 + 1);
  const more = dialog.getByRole("button", { name: "Load more contacts" });
  await more.scrollIntoViewIfNeeded();
  await more.click();
  await expect(more).toHaveCount(0);
});

test("Member-action Drawer uses the solid dark task canvas through its confirmation pane", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await setFixtureContent(page, `<html class="dark" data-fixture="member-actions"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.getByRole("button").click();
  const drawer = page.locator('[data-task-surface="drawer"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("menu")).toHaveCount(0);
  const share = drawer.getByRole("button", { name: "Share location with Asha" });
  await expect(share).toBeVisible();
  const colors = await drawer.evaluate(node => {
    const share = node.querySelector('[aria-label="Share location with Asha"]')!;
    return { canvas: getComputedStyle(node).backgroundColor,
      label: getComputedStyle(share).color,
      titleWeight: getComputedStyle(node.querySelector('[data-slot="drawer-title"]')!).fontWeight };
  });
  expect(colors.canvas).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.label).not.toBe(colors.canvas);
  expect(colors.titleWeight).toBe("600");
  await drawer.getByRole("button", { name: "Remove from Circle", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expect(drawer).toHaveCSS("background-color", colors.canvas);
  await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(share).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

if (process.env.SHEETS_BASELINE_REF) test("records canonical before/after fixture frame diagnostics", async ({ page }, testInfo) => {
  const reports: Record<string, unknown> = {};
  for (const [version, fixtureScript] of [["before", baselineScript], ["after", script]]) {
    await page.setViewportSize({ width: 393, height: 852 });
    await setFixtureContent(page, `<html data-probe="true"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: fixtureScript });
    await expect(page.getByTestId("hushh-perf-status")).toContainText("perf=ready");
    const list = page.locator("[data-circle-invite-results]");
    await expect(list).toBeVisible();
    for (let iteration = 0; iteration < 3; iteration++) {
      await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.waitForTimeout(200);
      await list.evaluate(node => { node.scrollTop = 0; });
      await page.waitForTimeout(200);
    }
    reports[version] = await page.evaluate(() => window.__hushhPerf?.snapshot());
    await page.evaluate(() => (window as unknown as { stopFixtureProbe: () => void }).stopFixtureProbe());
  }
  const report = JSON.stringify({ attribution: "headless WebKit, optimized CSS, programmatic scrolling; not native gesture certification", reports }, null, 2);
  await testInfo.attach("sheets-v15-perf", { body: report, contentType: "application/json" });
  fs.writeFileSync("/tmp/sheets-v15-perf.json", report);
  for (const report of Object.values(reports)) {
    expect((report as { windows: Array<{ kind: string }> }).windows.some(window => window.kind === "scroll:programmatic")).toBe(true);
  }
});

test("Adaptive task frame stays inside native reserved chrome after CSS optimization", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await setFixtureContent(page, `<html class="native-ios native-reserved-chrome" style="--native-overlay-top:120px;--native-overlay-bottom:100px"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  const dialog = page.getByRole("dialog", { name: "Add people to Trusted" });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
  const frame = await dialog.boundingBox();
  expect(frame!.y).toBeGreaterThanOrEqual(120);
  expect(frame!.y + frame!.height).toBeLessThanOrEqual(668);
  expect(frame!.y + frame!.height / 2).toBeCloseTo(394, 0);
  const close = await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox();
  expect(close!.height).toBe(44);
  expect(close!.y).toBeGreaterThanOrEqual(frame!.y);
  expect(close!.y + close!.height).toBeLessThanOrEqual(frame!.y + frame!.height);
});
