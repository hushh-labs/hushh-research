import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * Mail opened on its KYC tab (`/one/gmail?workspace=kyc`) before Gmail is
 * connected, at the pixel grid (founder bar). A Memory item or a chat offer for
 * an identity fact links here, so this is what that link lands on.
 *
 * Contract: the KYC tab is the selected one; KYC's own connect entry is the
 * shared compact row (48 px, a 28 px well 16 px in, the bare duotone registry
 * glyph centred in it), on a flat Morphy surface with the Material press ripple
 * clipped to the row and no press scale; the note sits 8 px under the group with
 * its text on the glyph's column; spacing on the 4 and 8 pt grid and symmetric
 * left and right. Light and dark, phone and desktop, then again with the text
 * widened (CI's Linux faces set wider). Set MAIL_KYC_SHOT_DIR to capture one
 * screenshot and one geometry file per width and theme.
 */
let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-kyc-connect-"));
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
      lib: { entry: path.join(root, "e2e/fixtures/mail-kyc-connect.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
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

// next-themes (attribute="class") puts `light` or `dark` on <html>; the flat
// Morphy card tokens at phone width are scoped to exactly those classes.
async function open(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("http://localhost/mail-kyc-connect**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto("http://localhost/mail-kyc-connect");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("element has no box");
  return bounds;
}

const onGrid = (value: number, unit: number) => Math.abs(value / unit - Math.round(value / unit)) < 0.02;
const close = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

type RowReading = {
  height: number;
  lines: number;
  glyphCenterOffset: number;
  glyphSize: number;
  glyphLeft: number;
  wellTop: number;
  wellBottom: number;
  wellSize: number;
  textRight: number;
  chevronLeft: number;
  chevronRight: number;
  backdrop: string;
};

async function readRow(row: Locator): Promise<RowReading> {
  return row.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const well = element.querySelector<HTMLElement>("[data-slot='settings-row-icon']")!.getBoundingClientRect();
    const glyph = element.querySelector<HTMLElement>("[data-slot='settings-row-icon'] svg")!.getBoundingClientRect();
    const titleNode = element.querySelector<HTMLElement>("[data-slot='settings-row-title']")!;
    const title = titleNode.getBoundingClientRect();
    const trailing = element.querySelector<HTMLElement>("[data-slot='settings-row-trailing'] svg")!.getBoundingClientRect();
    return {
      height: r.height,
      lines: Math.round(title.height / parseFloat(getComputedStyle(titleNode).lineHeight)),
      glyphCenterOffset: Math.max(
        Math.abs(glyph.top + glyph.height / 2 - (well.top + well.height / 2)),
        Math.abs(glyph.left + glyph.width / 2 - (well.left + well.width / 2)),
      ),
      glyphSize: glyph.width,
      glyphLeft: well.left - r.left,
      wellTop: well.top - r.top,
      wellBottom: r.bottom - well.bottom,
      wellSize: well.height,
      textRight: title.right,
      chevronLeft: trailing.left,
      chevronRight: r.right - trailing.right,
      backdrop: getComputedStyle(element).backdropFilter || "none",
    };
  });
}

function assertRow(reading: RowReading, label: string) {
  expect(reading.height, `${label}: 44 px target`).toBeGreaterThanOrEqual(44);
  expect(onGrid(reading.height, reading.lines === 1 ? 8 : 4), `${label}: row height ${reading.height} on the grid`).toBe(true);
  expect(reading.glyphCenterOffset, `${label}: glyph centred in its well`).toBeLessThanOrEqual(0.5);
  expect(onGrid(reading.glyphLeft, 4), `${label}: well inset ${reading.glyphLeft} on the 4 pt grid`).toBe(true);
  expect(close(reading.wellTop, reading.wellBottom), `${label}: symmetric vertical insets`).toBe(true);
  expect(onGrid(reading.wellSize, 4), `${label}: well ${reading.wellSize} on the 4 pt grid`).toBe(true);
  expect(reading.textRight, `${label}: title clear of the chevron`).toBeLessThanOrEqual(reading.chevronLeft + 0.5);
  expect(reading.backdrop, `${label}: flat surface, no blur`).toBe("none");
}

/** Flat: every shadow layer, if any, has no offset, blur or spread. */
async function isFlat(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const shadow = getComputedStyle(element).boxShadow;
    if (!shadow || shadow === "none") return true;
    return shadow
      .split(/,(?![^(]*\))/)
      .every((layer) => [...layer.matchAll(/(-?\d*\.?\d+)px/g)].every((match) => Number(match[1]) === 0));
  });
}

const WIDEN = "[data-slot='settings-row-title'],[data-testid='mail-kyc-connect-note']{letter-spacing:0.3px}";

for (const theme of ["light", "dark"] as const)
  for (const [width, height] of [[393, 852], [1440, 900]] as const)
    test(`Mail's KYC tab offers Connect Gmail on the 4/8 grid at ${width}px, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, theme);

      // The link opened the KYC tab, not the overview.
      await expect(page.getByRole("tab", { name: "KYC" })).toHaveAttribute("aria-selected", "true");
      const entry = page.getByTestId("mail-kyc-connect");
      await expect(entry).toBeVisible();
      const row = page.getByTestId("mail-kyc-connect-row");
      await expect(row).toHaveText("Connect Gmail to manage identity");
      // The whole label shows: it names what connecting is for.
      expect(await row.locator("[data-slot='settings-row-title']").evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 0.5 && getComputedStyle(element).textOverflow !== "ellipsis",
      )).toBe(true);

      const reading = await readRow(row);
      assertRow(reading, `${width} ${theme}`);
      // The shared compact row is 48 px since 2c45bbf4b (8 px vertical padding,
      // 48 px minimum); the icon and horizontal grid did not change.
      expect(reading.lines).toBe(1);
      expect(reading.height).toBeCloseTo(48, 0);
      expect(reading.wellSize).toBeCloseTo(28, 0);
      expect(reading.glyphLeft).toBeCloseTo(16, 0);
      expect(reading.glyphSize).toBeCloseTo(22, 0);
      // The bare registry glyph: a transparent well, never a filled tile.
      const wellFill = await row.locator("[data-slot='settings-row-icon']").evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(wellFill === "transparent" || /rgba\(0, 0, 0, 0\)/.test(wellFill), `transparent well, got ${wellFill}`).toBe(true);

      // The group spans the tab bar's column, symmetric left and right.
      const group = page.getByTestId("mail-kyc-connect-group").locator("[data-slot='settings-group-shell']");
      const groupBox = await box(group);
      const tabs = await box(page.getByRole("tablist", { name: "Gmail workspace" }));
      const leftInset = groupBox.x - tabs.x;
      const rightInset = tabs.x + tabs.width - (groupBox.x + groupBox.width);
      expect(close(leftInset, rightInset), `insets ${leftInset} / ${rightInset}`).toBe(true);
      expect(onGrid(leftInset, 4), `inset ${leftInset} on the 4 pt grid`).toBe(true);
      const pageLeft = groupBox.x;
      const pageRight = width - (groupBox.x + groupBox.width);
      // The centred 820 px column: symmetric at every width (at 1440 each
      // margin is 310, set by the viewport, not by the layout's spacing).
      expect(close(pageLeft, pageRight), `page margins ${pageLeft} / ${pageRight}`).toBe(true);
      expect(await isFlat(group), "flat Morphy surface, no shadow").toBe(true);
      expect(await group.evaluate((element) => getComputedStyle(element).backdropFilter || "none")).toBe("none");

      // The tab band (a fixed --top-tabs-h strip, on the 8 pt grid, with the
      // control centred in it), then the page's own stack gap, then the entry:
      // the same rhythm as every other Mail tab. That gap is the shared
      // --surface-stack-gap-compact token (14 px on a phone, 16 on desktop).
      const band = await page.getByRole("tablist", { name: "Gmail workspace" }).evaluate((element) => {
        const strip = element.closest<HTMLElement>("[class*='top-tabs-h']")!;
        const stripBox = strip.getBoundingClientRect();
        const control = element.getBoundingClientRect();
        return {
          bottom: stripBox.bottom,
          height: stripBox.height,
          above: control.top - stripBox.top,
          below: stripBox.bottom - control.bottom,
          stackGap: parseFloat(getComputedStyle(strip.parentElement!).rowGap),
        };
      });
      expect(onGrid(band.height, 8), `tab band ${band.height} on the 8 pt grid`).toBe(true);
      expect(close(band.above, band.below), `tab control centred in its band (${band.above} / ${band.below})`).toBe(true);
      const tabGap = groupBox.y - band.bottom;
      expect(close(tabGap, band.stackGap), `tab gap ${tabGap} is the page's stack gap ${band.stackGap}`).toBe(true);

      // The note sits 8 px under the group, its text on the glyph's column.
      const note = page.getByTestId("mail-kyc-connect-note");
      const noteBox = await box(note);
      const noteGap = noteBox.y - (groupBox.y + groupBox.height);
      expect(noteGap).toBeCloseTo(8, 0);
      const notePadding = await note.evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft));
      const rowBox = await box(row);
      const noteColumn = noteBox.x + notePadding - (rowBox.x + reading.glyphLeft);
      expect(Math.abs(noteColumn), "note text on the glyph column").toBeLessThanOrEqual(0.5);
      const noteLine = await note.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
      expect(onGrid(noteLine, 4), `note line height ${noteLine} on the 4 pt grid`).toBe(true);

      // Ripple on: a press grows the Material ripple inside the row, clipped to it.
      await page.mouse.move(rowBox.x + 40, rowBox.y + rowBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(80);
      const ripple = await row.evaluate((element) => {
        const host = element.querySelector<HTMLElement>(".morphy-ripple-host");
        const pressed = Boolean(host?.querySelector("md-ripple")?.shadowRoot?.querySelector(".surface.pressed"))
          || Boolean(host?.querySelector("[data-ripple-flat][data-pressed]"));
        const a = element.getBoundingClientRect();
        const b = host?.getBoundingClientRect();
        return {
          pressed,
          clipped: Boolean(b && Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1 &&
            Math.abs(a.top - b.top) < 1 && Math.abs(a.bottom - b.bottom) < 1),
          scaled: getComputedStyle(element).scale !== "none" && getComputedStyle(element).scale !== "1",
        };
      });
      await page.mouse.up();
      expect(ripple.pressed, "ripple on pointerdown").toBe(true);
      expect(ripple.clipped, "ripple clipped to the row").toBe(true);
      expect(ripple.scaled, "no bounce or press scale").toBe(false);
      // The press reached the one control: a connection was started.
      await expect(page.getByTestId("kyc-connects")).toHaveText("1");

      // Widened text: the row holds its grid and the title still clears its chevron.
      await page.addStyleTag({ content: WIDEN });
      const widened = await readRow(row);
      assertRow(widened, `${width} ${theme} widened`);
      expect(close(widened.glyphLeft, reading.glyphLeft), "glyph column holds when widened").toBe(true);
      expect(close(widened.chevronRight, reading.chevronRight), "chevron column holds when widened").toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

      const text = (await entry.textContent()) ?? "";
      expect(text).not.toMatch(/[—–]/);
      expect(await entry.locator("[data-icon*='sparkle' i], [class*='sparkle' i], [class*='glass' i]").count()).toBe(0);
      expect(errors).toEqual([]);

      const metrics = { width, theme, leftInset, rightInset, pageLeft, pageRight, tabGap, noteGap, row: reading, widened };
      testInfo.annotations.push({ type: "geometry", description: JSON.stringify(metrics) });
      const shotDir = process.env.MAIL_KYC_SHOT_DIR;
      if (shotDir) {
        await page.reload();
        await open(page, theme);
        await page.mouse.move(0, 0);
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, `geometry-kyc-connect-${width}-${theme}.json`), JSON.stringify(metrics, null, 2));
        await page.screenshot({ path: path.join(shotDir, `mail-kyc-connect-${width}-${theme}.png`), fullPage: false });
      }
    });

test("leaving KYC retains its pane but removes connect authority (negative control)", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await open(page, "light");
  await expect(page.getByTestId("mail-kyc-connect")).toBeVisible();
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toBeVisible();
  await expect(page.locator("#top-shell-gmail-workspace-panel-kyc")).toHaveAttribute("inert", "");
  await expect(page.locator("#top-shell-gmail-workspace-panel-kyc")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Connect Gmail to manage identity" })).toHaveCount(0);
  await expect(page.getByTestId("kyc-connects")).toHaveText("0");
});

test("Mail drags through all three retained panes and nested receipt scrolling wins", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await open(page, "light");
  await expect(page.getByRole("tabpanel", { name: "KYC" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { retainedKyc: Element | null }).retainedKyc = document.querySelector("[data-testid='mail-kyc-connect']");
  });
  const pager = page.locator("[data-swipe-views-root='true']");
  // Fill height is measured on the first animation frame. Starting before
  // that frame would place the gesture on receipt content, not the blank body.
  await expect.poll(async () => pager.evaluate(element => parseFloat(getComputedStyle(element).minHeight))).toBeGreaterThan(400);
  const pagerBox = await box(pager);
  const y = pagerBox.y + Math.min(pagerBox.height / 2, 180);
  const drag = async (direction: "left" | "right", atY = y) => {
    const left = pagerBox.x + 40;
    const right = pagerBox.x + pagerBox.width - 40;
    await page.mouse.move(direction === "left" ? right : left, atY);
    await page.mouse.down();
    await page.mouse.move(direction === "left" ? left : right, atY, { steps: 12 });
    await page.mouse.up();
  };
  const selected = async (name: string) => {
    await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    // Selection reports immediately; a follow-up gesture must start on the
    // settled visible pane rather than on the outgoing one mid-snap.
    // The shared pager reconciles snap residuals above 1 CSS px; keep this
    // arrival check on that existing engine contract (WebKit stops at ~0.57).
    await expect.poll(async () => Math.abs((await box(page.getByRole("tabpanel", { name }))).x - (await box(pager)).x)).toBeLessThanOrEqual(1);
  };
  await drag("right");
  await selected("Overview");
  await drag("left");
  await selected("KYC");
  await drag("left");
  await selected("Receipts");

  const rail = await box(page.getByTestId("receipt-rail"));
  await drag("right", rail.y + rail.height / 2);
  await selected("Receipts");
  await drag("right");
  await selected("KYC");
  expect(await page.evaluate(() => (window as unknown as { retainedKyc: Element | null }).retainedKyc === document.querySelector("[data-testid='mail-kyc-connect']"))).toBe(true);
  await expect(page.getByTestId("kyc-connects")).toHaveText("0");
  await page.getByRole("tab", { name: "Receipts" }).click();
  await expect(page.getByRole("tabpanel", { name: "Receipts" })).toBeVisible();
  await page.getByRole("tab", { name: "Receipts" }).press("Home");
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Connect Mail to set up receipts and KYC requests.")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Pager frames stay local to this strip, never invalidate the app root.
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--top-shell-tab-swipe-gmail-workspace-position"))).toBe("");
});
