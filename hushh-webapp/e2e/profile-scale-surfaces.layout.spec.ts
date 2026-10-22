import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The surfaces that take the Profile type scale outside Connect's own page:
 * the Feed "Needs you" rows, the Agents roster, the Circles card and the
 * Remove-connection dialog. Production components; only routing is replaced
 * (e2e/fixtures/profile-scale-boundaries.tsx).
 */

let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-scale-surfaces-"));
  const boundary = path.join(root, "e2e/fixtures/profile-scale-boundaries.tsx");
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }]))
              candidates.add(candidate);
        },
      },
    ],
    resolve: {
      alias: [
        { find: /^next\/link$/, replacement: boundary },
        { find: /^next\/navigation$/, replacement: boundary },
        { find: /^@\/lib\/firebase\/config$/, replacement: boundary },
        { find: "@", replacement: root },
      ],
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: {
      copyPublicDir: false,
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/profile-scale-surfaces.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file =
          id === "tailwindcss"
            ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
              : path.resolve(base, id);
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  css =
    stripAppFontFaces(compiler.build([...candidates])) +
    productFontStyle() +
    fs.readdirSync(outDir).filter((name) => name.endsWith(".css")).map((name) => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
});

type Flags = { long?: boolean; single?: boolean; dialog?: boolean };

async function open(page: Page, width: number, dark = false, flags: Flags = {}) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  const url = "http://localhost/profile-scale-surfaces";
  const data = Object.entries(flags).filter(([, on]) => on).map(([name]) => `data-${name}="1"`).join(" ");
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${dark ? "dark" : ""}" ${data}><head><title>Profile scale</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: dark ? "dark" : "light" });
  await page.goto(url);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByTestId("fx-feed").getByTestId("feed-actionable-connection:1")).toBeVisible();
  await expect(page.getByTestId("one-agents-section")).toBeVisible();
  return errors;
}

/** Optional evidence shots: set PROFILE_SCALE_SHOT_DIR to write them. */
async function shoot(page: Page, name: string, testId?: string) {
  const dir = process.env.PROFILE_SCALE_SHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const target = testId ? page.getByTestId(testId) : page;
  await target.screenshot({ path: path.join(dir, `${name}.png`) });
}

const read = (page: Page, selector: string, index = 0) =>
  page.locator(selector).nth(index).evaluate((node) => {
    const s = getComputedStyle(node);
    return { size: s.fontSize, weight: s.fontWeight, line: s.lineHeight, color: s.color, background: s.backgroundColor };
  });

for (const width of [320, 393, 430, 768]) {
  test(`Feed "Needs you" rows use Profile roles and keep each action beside its request at ${width}px`, async ({ page }) => {
    const errors = await open(page, width);
    const feed = page.getByTestId("fx-feed");
    const row = (id: string) => feed.getByTestId(`feed-actionable-${id}`);

    // Profile roles: name, supporting line, action label.
    expect(await read(page, '[data-testid="fx-feed"] [data-slot="settings-row-title"]')).toMatchObject({ size: "13px", weight: "400", line: "15.86px" });
    expect(await read(page, '[data-testid="fx-feed"] [data-slot="feed-event-description"]')).toMatchObject({ size: "12px", line: "15.6px" });
    expect(await read(page, '[data-testid="fx-feed"] [data-profile-role="action"]', 2)).toMatchObject({ size: "12px", weight: "500" });

    // Each row: the action area is to the right of the text column, inside the row.
    for (const id of ["connection:1", "connection:2", "doc:1", "gmail-needs-reply"]) {
      const geometry = await row(id).evaluate((node) => {
        const box = node.getBoundingClientRect();
        const text = node.querySelector<HTMLElement>('[data-slot="settings-row-title"]')!.getBoundingClientRect();
        const trailing = node.querySelector('[data-slot="settings-row-trailing"]')!;
        const actions = [...trailing.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
        return {
          rowHeight: box.height,
          textRight: text.right,
          actionLeft: Math.min(...actions.map((a) => a.left)),
          actionRight: Math.max(...actions.map((a) => a.right)),
          actionTop: Math.min(...actions.map((a) => a.top)),
          actionBottom: Math.max(...actions.map((a) => a.bottom)),
          rowRight: box.right,
          rowTop: box.top,
          rowBottom: box.bottom,
          textBottom: text.bottom,
        };
      });
      expect(geometry.textRight).toBeLessThanOrEqual(geometry.actionLeft + 1);
      expect(geometry.actionRight).toBeLessThanOrEqual(geometry.rowRight + 1);
      expect(geometry.actionTop).toBeGreaterThanOrEqual(geometry.rowTop - 1);
      expect(geometry.actionBottom).toBeLessThanOrEqual(geometry.rowBottom + 1);
      // Beside the content, not on a line under it.
      expect(geometry.actionTop).toBeLessThan(geometry.textBottom);
    }

    // The request pair: a check and a cross, separate 44px targets, names kept.
    const accept = row("connection:1").getByRole("button", { name: "Confirm", exact: true });
    const declineButton = row("connection:1").getByRole("button", { name: "Decline (tap again to confirm)" });
    for (const button of [accept, declineButton]) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(button.locator("svg")).toHaveCount(1);
    }
    const [a, d] = [(await accept.boundingBox())!, (await declineButton.boundingBox())!];
    expect(a.x).toBeGreaterThanOrEqual(d.x + d.width - 1);

    // The Mail row says it once: the title names what waits, the button says where.
    await expect(row("gmail-needs-reply").locator('[data-slot="feed-event-description"]')).toHaveCount(0);

    // A compact request row is not taller than a two-line person row.
    expect((await row("connection:1").boundingBox())!.height).toBeLessThanOrEqual(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
    if (width === 393) await shoot(page, "feed-needs-you-393", "fx-feed");
  });

  test(`Agents roster follows the Profile header, label and count roles at ${width}px`, async ({ page }) => {
    await open(page, width);
    expect(await read(page, '[data-testid="one-agents-section"] [data-profile-role="header"]')).toMatchObject({ size: "20px", weight: "600", line: "23px" });
    await expect(page.getByRole("heading", { name: /^Agents \(\d+\)$/ })).toBeVisible();
    expect(await read(page, '[data-testid="one-agent-tile-location"] [data-profile-role="label"]')).toMatchObject({ size: "13px", weight: "550", line: "15.6px" });
    for (const index of [0, 1]) {
      expect(await read(page, '[data-testid="one-agent-tile-ria"] [data-profile-role="description"]', index)).toMatchObject({ size: "12px", weight: "400", line: "15.6px" });
    }
    // Names and counts stay on one line each; the grid does not scroll sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 393) await shoot(page, "agents-grid-393", "fx-agents");
    await page.getByTestId("one-agents-view-list").click();
    expect(await read(page, '[data-testid="one-agent-list-row-ria"] [data-profile-role="label"]')).toMatchObject({ size: "13px", weight: "550" });
    if (width === 393) await shoot(page, "agents-list-393", "fx-agents");
  });

  test(`Circles card uses the Profile hierarchy, the short location line and a compact footer at ${width}px`, async ({ page }) => {
    await open(page, width);
    const card = page.getByTestId("fx-circles");
    await expect(card).not.toContainText("Manage access permissions");
    await expect(card.getByTestId("circle-starter-location")).toContainText("Choose who sees your location");
    expect(await read(page, '[data-testid="fx-circles"] h2')).toMatchObject({ size: "13px", weight: "550" });
    expect(await read(page, '[data-testid="circle-starter-family"] [data-profile-role="name"]')).toMatchObject({ size: "13px", weight: "400" });
    expect(await read(page, '[data-testid="circle-starter-family"] [data-profile-role="description"]')).toMatchObject({ size: "12px" });
    expect(await read(page, '[data-testid="circle-starter-family"] [data-profile-role="action"]')).toMatchObject({ size: "12px", weight: "500" });
    // On an ordinary phone the location line is one line, with no orphaned word.
    if (width >= 375) {
      const lines = await card.getByTestId("circle-starter-location").locator('[data-profile-role="description"]').evaluate((node) => Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)));
      expect(lines).toBe(1);
    }

    // Footer: equal 26px faces and chip, one 8px overlap, a short dynamic label.
    const footer = card.locator("[data-circle-discovery-footer]");
    await expect(footer).toContainText("7 connections");
    await expect(footer).not.toContainText("to build with");
    const faces = await footer.locator("[data-circle-discovery-faces] > span").evaluateAll((nodes) =>
      nodes.map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, width: r.width, height: r.height, top: r.top }; }));
    expect(faces).toHaveLength(4);
    expect(faces.every((f) => f.width === 26 && f.height === 26 && f.top === faces[0].top)).toBe(true);
    for (let index = 1; index < faces.length; index += 1) expect(faces[index].left - faces[index - 1].left).toBeCloseTo(18, 0);
    expect(await footer.evaluate((node) => { const r = node.getBoundingClientRect(); return [...node.querySelectorAll("button")].every((b) => { const c = b.getBoundingClientRect(); return c.left >= r.left - 1 && c.right <= r.right + 1; }); })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 393) await shoot(page, "circles-393", "fx-circles");
  });
}

test("Circles footer keeps the count dynamic and singular", async ({ page }) => {
  await open(page, 393, false, { single: true });
  const footer = page.getByTestId("fx-circles").locator("[data-circle-discovery-footer]");
  await expect(footer).toContainText("1 connection");
  await expect(footer).not.toContainText("1 connections");
});

for (const dark of [false, true]) {
  test(`Advisor's count is primary text like every other count (${dark ? "dark" : "light"})`, async ({ page }) => {
    await open(page, 393, dark);
    const numeral = (id: string) => read(page, `[data-testid="one-agent-tile-${id}"] [data-profile-role="description"]`, 0);
    const advisor = await numeral("ria");
    const mail = await numeral("gmail");
    const calendar = await numeral("calendar");
    // The root cause was a conditional "warning" tone painting the numeral #FF9500.
    expect(advisor.color).not.toBe("rgb(255, 149, 0)");
    expect(advisor.color).toBe(calendar.color);
    expect(advisor.color).toBe(mail.color);
    expect(advisor.color).toBe(dark ? "rgb(245, 245, 247)" : "rgb(29, 29, 31)");
  });
}

for (const dark of [false, true]) {
  test(`Remove-connection dialog uses Profile's dialog roles and keeps its destructive action (${dark ? "dark" : "light"})`, async ({ page }) => {
    await open(page, 393, dark, { dialog: true });
    const dialog = page.getByTestId("fx-dialog");
    await expect(dialog).toBeVisible();
    expect(await read(page, '[data-testid="fx-dialog"] [data-slot="alert-dialog-title"]')).toMatchObject({ size: "15px", weight: "600", line: "18px" });
    expect(await read(page, '[data-testid="fx-dialog"] [data-slot="alert-dialog-description"]')).toMatchObject({ size: "11px", line: "13.75px" });
    expect(await read(page, '[data-testid="fx-dialog"] [data-slot="alert-dialog-footer"] > button', 0)).toMatchObject({ size: "12px", weight: "600" });
    const remove = await read(page, '[data-testid="fx-dialog"] [data-slot="alert-dialog-footer"] > button', 1);
    expect(remove).toMatchObject({ size: "12px", weight: "600" });
    // Still the red destructive button, not an accent one.
    expect(remove.background).toMatch(/^(rgb|oklch|color)/);
    await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await shoot(page, `remove-dialog-${dark ? "dark" : "light"}`);
    // The dialog's scope does not leak: the shared dialog elsewhere is unchanged.
    expect(await page.evaluate(() => !document.querySelector('[data-slot="alert-dialog-content"]:not([data-profile-type-scale])'))).toBe(true);
  });
}

for (const width of [160, 196]) {
  test(`stays readable at 200% enlargement (${width}px layout width)`, async ({ page }) => {
    await open(page, width, false, { long: true });
    const fits = await page.locator('[data-testid^="feed-actionable-"]').evaluateAll((nodes, viewport) => nodes.map((row) => {
      const box = row.getBoundingClientRect();
      const trailing = row.querySelector('[data-slot="settings-row-trailing"]');
      const reach = trailing
        ? [...trailing.querySelectorAll<HTMLElement>("button")].every((button) => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= viewport + 1 && r.width >= 28; })
        : true;
      return box.right <= viewport + 1 && reach;
    }), width);
    expect(fits.length).toBeGreaterThanOrEqual(5);
    expect(fits.every(Boolean)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.getByTestId("fx-circles").locator("[data-circle-discovery-footer]")).toBeVisible();
  });
}
