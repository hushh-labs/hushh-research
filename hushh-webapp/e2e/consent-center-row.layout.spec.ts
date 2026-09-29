import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * The Consent Center's Requests row (CONTRACT-2 C8) in a real browser: the row
 * is one button that opens the sheet (tap, Enter or Space), and ✗ / ✓ sit
 * beside it as 44px targets that never open it. Measured at phone and desktop
 * widths, light and dark, then again with every row's text widened a few
 * pixels, because CI's Linux fonts set about 1.5px wider than a Mac.
 * Set CONSENT_ROW_SHOT_DIR to also capture one screenshot per width and theme.
 */
let script: string;
let css: string;

const WIDTHS = [320, 393, 1440] as const;
const DECIDING_ROWS = 3;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "consent-center-row-"));
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
      lib: { entry: path.join(root, "e2e/fixtures/consent-center-row.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
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

async function open(page: Page, width: number, dark: boolean) {
  await page.setViewportSize({ width, height: 900 });
  await page.route("http://localhost/consent-center-row", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto("http://localhost/consent-center-row");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  // React renders the fixture asynchronously; measure only once all five rows exist,
  // otherwise a slow run (e.g. after other specs) measures a partial list.
  await page
    .locator("[data-testid='consent-entry-row'],[data-testid='consent-bundle-row']")
    .nth(4)
    .waitFor();
}

type RowMeasure = {
  name: string;
  overflow: boolean;
  titleRight: number;
  titleWidth: number;
  decisions: Array<{ label: string; left: number; right: number; top: number; width: number; height: number }>;
};

/** Every row's geometry: nothing leaves the row, and the title never runs under ✗ / ✓. */
async function measure(page: Page): Promise<RowMeasure[]> {
  return page.locator("[data-testid='consent-entry-row'],[data-testid='consent-bundle-row']").evaluateAll((rows) =>
    rows.map((row) => {
      const box = row.getBoundingClientRect();
      const title = row.querySelector("[data-slot='settings-row-title']")!.getBoundingClientRect();
      const decisions = [...row.querySelectorAll("[data-slot='consent-row-decisions'] button")].map((button) => {
        const b = button.getBoundingClientRect();
        return { label: button.getAttribute("aria-label") || "", left: b.left, right: b.right, top: b.top, width: b.width, height: b.height };
      });
      return {
        name: row.querySelector("button")?.getAttribute("aria-label") || "",
        overflow: [...row.querySelectorAll("*")].some((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.width > 0 && (bounds.left < box.left - 1 || bounds.right > box.right + 1);
        }),
        titleRight: title.right,
        titleWidth: title.width,
        decisions,
      };
    }),
  );
}

function assertGeometry(rows: RowMeasure[], label: string) {
  expect(rows, label).toHaveLength(5);
  expect(rows.filter((row) => row.decisions.length === 2), label).toHaveLength(DECIDING_ROWS);
  for (const row of rows) {
    expect.soft(row.overflow, `${label}: ${row.name} overflows`).toBe(false);
    expect.soft(row.titleWidth, `${label}: ${row.name} title collapsed`).toBeGreaterThan(60);
    if (row.decisions.length !== 2) continue;
    const [decline, allow] = row.decisions;
    // Don't allow, then Allow last; both full touch targets on one line.
    expect.soft([decline.label, allow.label]).toEqual(["Don't allow", "Allow"]);
    for (const target of row.decisions) {
      expect.soft(target.width, `${label}: ${row.name} ${target.label}`).toBeGreaterThanOrEqual(44);
      expect.soft(target.height, `${label}: ${row.name} ${target.label}`).toBeGreaterThanOrEqual(44);
    }
    expect.soft(Math.abs(decline.top - allow.top)).toBeLessThanOrEqual(1);
    expect.soft(allow.left).toBeGreaterThanOrEqual(decline.right);
    expect.soft(row.titleRight, `${label}: ${row.name} runs under the decisions`).toBeLessThanOrEqual(decline.left);
  }
}

for (const dark of [false, true])
  for (const width of WIDTHS)
    test(`Requests rows fit and decide in place at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, width, dark);
      const label = `${width}px ${dark ? "dark" : "light"}`;

      assertGeometry(await measure(page), label);
      await expect(page.locator("button button, button a, a button")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

      const shotDir = process.env.CONSENT_ROW_SHOT_DIR;
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: path.join(shotDir, `consent-center-row-${width}-${dark ? "dark" : "light"}.png`), fullPage: true, animations: "disabled" });
      }

      // CI renders text wider than a Mac; widen every row's text by a few
      // pixels and the same geometry must still hold.
      await page.addStyleTag({ content: "[data-slot='settings-row-title'],[data-slot='settings-row-description']{letter-spacing:0.3px}" });
      assertGeometry(await measure(page), `${label} widened`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
    });

// R5: the sheet lists a grouped request's items one per row, all chosen, and
// says plainly what an Allow of part of it will do.
for (const width of WIDTHS)
  test(`the sheet's per-item choice fits and names a partial Allow at ${width}px`, async ({ page }) => {
    await open(page, width, false);
    const choice = page.getByTestId("consent-bundle-choice");
    const rows = choice.getByTestId("consent-bundle-choice-row");
    await expect(rows).toHaveCount(2);
    await expect(choice.getByRole("checkbox")).toHaveCount(2);
    for (const row of await rows.all()) {
      const box = (await row.boundingBox())!;
      expect(box.height, `${width}px choice row`).toBeGreaterThanOrEqual(44);
    }
    expect(await choice.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return [...node.querySelectorAll("*")].some((child) => {
        const bounds = child.getBoundingClientRect();
        return bounds.width > 0 && (bounds.left < box.left - 1 || bounds.right > box.right + 1);
      });
    }), `${width}px choice overflows`).toBe(false);
    await expect(page.getByTestId("bundle-choice-allow")).toHaveText("Allow");

    // The whole row is the target, not only the box.
    await rows.nth(1).click({ position: { x: (await rows.nth(1).boundingBox())!.width - 8, y: 20 } });
    await expect(choice.getByRole("checkbox").nth(1)).not.toBeChecked();
    await expect(choice).toContainText("Access · 1 of 2 items");
    await expect(page.getByTestId("consent-bundle-choice-summary")).toContainText("Only Food preferences will be shared.");
    await expect(page.getByTestId("bundle-choice-allow")).toHaveText("Allow 1 of 2");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    const shotDir = process.env.CONSENT_ROW_SHOT_DIR;
    if (shotDir) await choice.screenshot({ path: path.join(shotDir, `consent-bundle-choice-${width}.png`), animations: "disabled" });
  });

test("the row opens on tap, Enter and Space, and ✗ / ✓ never open it", async ({ page }) => {
  await open(page, 393, false);
  const body = page.locator("body");
  const row = page.getByRole("button", { name: "Kushal Trivedi, Food preferences, review" });

  await row.click();
  await expect(body).toHaveAttribute("data-opened", "food");

  await page.evaluate(() => { delete document.body.dataset.opened; });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(body).toHaveAttribute("data-opened", "food");

  await page.evaluate(() => { delete document.body.dataset.opened; });
  await page.keyboard.press("Space");
  await expect(body).toHaveAttribute("data-opened", "food");

  await page.evaluate(() => { delete document.body.dataset.opened; });
  const shell = page.locator("[data-testid='consent-entry-row']").first();
  await shell.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(body).toHaveAttribute("data-decided", "allow:food");
  await shell.getByRole("button", { name: "Don't allow", exact: true }).click();
  await expect(body).toHaveAttribute("data-decided", "decline:food");
  expect(await body.getAttribute("data-opened")).toBeNull();

  // A grouped request is one row that opens directly: no expansion, no Review.
  await page.getByRole("button", { name: "A member, Professional detail 3 and 9 more, review" }).click();
  await expect(body).toHaveAttribute("data-opened", "bundle:professional");
  await expect(page.getByText("Review", { exact: true })).toHaveCount(0);
});
