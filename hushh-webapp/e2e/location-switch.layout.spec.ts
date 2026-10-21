import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let css: string;
let script: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "location-switch-"));
  // Measure the exact shipped footer/button classes; the page unit test owns
  // its stale-only admission and real request handler.
  const previewSource = fs.readFileSync(path.join(root, "app/one/location/page.tsx"), "utf8");
  const hubSource = fs.readFileSync(path.join(root, "components/one-location/redesign/location-redesign-hub.tsx"), "utf8");
  const refreshRowClass = previewSource.match(/data-testid="one-location-map-refresh-action"\s+className="([^"]+)"/)?.[1];
  const refreshButtonClass = hubSource.match(/onClick=\{\(\) => vm\.onAskReshare\(grant\)\}[\s\S]*?className="([^"]+)"/)?.[1];
  if (!refreshRowClass || !refreshButtonClass) throw new Error("Location preview action geometry not found");
  for (const candidate of scanner.scanFiles([{ content: `${refreshRowClass} ${refreshButtonClass}`, extension: "html" }])) candidates.add(candidate);
  await build({
    configFile: false,
    logLevel: "error",
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
          }
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": root } },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
      __LOCATION_REFRESH_ROW_CLASSNAME__: JSON.stringify(refreshRowClass),
      __LOCATION_REFRESH_BUTTON_CLASSNAME__: JSON.stringify(refreshButtonClass),
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/location-switch.tsx"),
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
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  const { transform } = await import("lightningcss");
  css = transform({ filename: "location-switch.css", code: Buffer.from(stripAppFontFaces(compiler.build([...candidates])) + productFontStyle()), minify: true }).code.toString();
});

for (const width of [320, 393, 1440]) {
  for (const dark of [false, true]) {
    test(`stale map keeps only a right-aligned refresh action at ${width}px ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(`<html class="${dark ? "dark" : ""}"><head><style>${css}</style></head><body data-stale-preview="true"><div id="root"></div></body></html>`);
      await page.addScriptTag({ content: script });
      await awaitProductFont(page);
      const row = page.getByTestId("preview-refresh-row");
      const action = row.getByRole("button", { name: "Ask to refresh" });
      await expect(action).toBeVisible();
      await expect(row).toHaveText("Ask to refresh");
      await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(row).toHaveCSS("border-top-width", "0px");
      const geometry = await row.evaluate(node => {
        const action = node.querySelector("button")!.getBoundingClientRect();
        return { rightInset: node.getBoundingClientRect().right - action.right,
          padding: parseFloat(getComputedStyle(node).paddingRight), width: action.width, height: action.height };
      });
      expect(geometry.rightInset).toBeCloseTo(geometry.padding, 0);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
      expect(geometry.width).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath("stale-map-refresh-action.png") });
    });
  }
}

async function expectThumbPosition(page: Page, checked: boolean) {
  await expect(page.getByRole("switch")).toHaveAttribute(
    "aria-checked",
    String(checked),
  );
  await expect
    .poll(async () =>
      page.getByRole("switch").evaluate((el) => {
        const track = el.getBoundingClientRect();
        const thumb = el
          .querySelector("[data-slot=switch-thumb]")!
          .getBoundingClientRect();
        return Math.round((thumb.left - track.left) / (track.width / 51));
      }),
    )
    .toBe(checked ? 21 : 1);
}

// Inspect every animation frame: a settled screenshot alone misses the GSAP
// transform being applied to the thumb during initial and deferred mounting.
async function expectContainedDuringEnter(page: Page) {
  const frames = await page.getByRole("switch").evaluate(async (el) => {
    const result = [];
    for (let i = 0; i < 24; i++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const track = el.getBoundingClientRect();
      const thumb = el.querySelector<HTMLElement>("[data-slot=switch-thumb]")!;
      const box = thumb.getBoundingClientRect();
      const scale = track.width / 51;
      result.push({
        top: (box.top - track.top) / scale,
        bottom: (track.bottom - box.bottom) / scale,
        left: (box.left - track.left) / scale,
        right: (track.right - box.right) / scale,
        transform: thumb.style.transform,
      });
    }
    return result;
  });
  for (const frame of frames) {
    expect(frame.transform).toBe("");
    expect(frame.top).toBeCloseTo(2, 0);
    expect(frame.bottom).toBeCloseTo(2, 0);
    expect(frame.left).toBeGreaterThanOrEqual(0.9);
    expect(frame.right).toBeGreaterThanOrEqual(0.9);
  }
}

for (const width of [320, 393, 430, 768, 1440]) {
  test(`request access duration heading fits one line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<html><head><style>${css}</style></head><body data-request-duration="true"><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: script });
    const title = page.getByRole("heading", { name: "Request Access Duration", exact: true });
    await expect(title).toBeVisible();
    await awaitProductFont(page);
    const geometry = await title.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      const style = getComputedStyle(node);
      return { lines: range.getClientRects().length, textLeft: text.left, textRight: text.right,
        textWidth: text.width, width: node.clientWidth, scrollWidth: node.scrollWidth,
        size: parseFloat(style.fontSize), height: node.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight), textOverflow: style.textOverflow };
    });
    expect(geometry.lines).toBe(1);
    expect(geometry.textLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.textRight).toBeLessThanOrEqual(width);
    expect(geometry.textWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.size).toBeGreaterThanOrEqual(20);
    expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1);
    expect(geometry.textOverflow).not.toBe("ellipsis");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath(`request-duration-heading-${width}.png`), animations: "disabled" });
  });
}

for (const width of [320, 393, 430, 1440]) {
  test(`compact Location header and text-aligned share action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<html><head><style>${css}</style></head><body data-compact="true"><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: script });
    const toggle = page.getByRole("switch");
    await expect(toggle).toHaveCSS("width", "54px");
    await expect(toggle).toHaveCSS("height", "24px");
    await expect(toggle.locator('[data-slot="switch-thumb"]')).toHaveCSS("width", "20px");
    await expect(toggle.locator('[data-slot="switch-thumb"]')).toHaveCSS("height", "20px");
    await awaitProductFont(page);
    const status = page.getByTestId("one-location-header-status");
    const geometry = await status.evaluate((node) => ({ size: parseFloat(getComputedStyle(node).fontSize), width: node.clientWidth, scrollWidth: node.scrollWidth, tapHeight: node.closest("label")!.getBoundingClientRect().height }));
    expect(geometry.size).toBeLessThanOrEqual(12);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.tapHeight).toBeGreaterThanOrEqual(44);
    const alignment = await status.evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      const track = node.closest("label")!.querySelector("[role=switch]")!.getBoundingClientRect();
      return { textLeft: text.left, textCenter: text.left + text.width / 2, trackLeft: track.left, trackCenter: track.left + track.width / 2 };
    });
    expect(Math.abs(alignment.textCenter - alignment.trackCenter)).toBeLessThan(1);
    expect(Math.abs(alignment.textLeft - alignment.trackLeft)).toBeLessThan(9);
    await status.click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => toggle.evaluate(node => {
      const track = node.getBoundingClientRect();
      const thumb = node.querySelector("[data-slot=switch-thumb]")!.getBoundingClientRect();
      return track.right - thumb.right;
    })).toBeCloseTo(3, 0);
    await toggle.press("Space");
    await expect(toggle).not.toBeChecked();
    // Width, thumb size and travel must scale together with browser text size.
    await page.locator("html").evaluate(node => { node.style.fontSize = "20px"; });
    await expect(toggle).toHaveCSS("width", "67.5px");
    for (const checked of [true, false]) {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", String(checked));
      await expect.poll(() => toggle.evaluate(node => {
        const track = node.getBoundingClientRect();
        const thumb = node.querySelector("[data-slot=switch-thumb]")!.getBoundingClientRect();
        return thumb.left >= track.left && thumb.right <= track.right;
      })).toBe(true);
    }
    await page.locator("html").evaluate(node => { node.style.fontSize = ""; });
    const share = page.getByRole("button", { name: "Share location", exact: true });
    const caption = page.getByText("Choose a Circle or contact.", { exact: true });
    if (width < 640) expect(Math.abs((await share.boundingBox())!.x - (await caption.boundingBox())!.x)).toBeLessThanOrEqual(1);
    await share.click();
    await expect(page.locator("body")).toHaveAttribute("data-shared", "true");
    const stop = page.getByRole("button", { name: "Stop SMS", exact: true });
    await expect(stop).toHaveCSS("color", "rgb(255, 59, 48)");
    await stop.hover();
    await expect(stop).toHaveCSS("color", "rgb(255, 59, 48)");
    await stop.click();
    await expect(page.locator("body")).toHaveAttribute("data-stopped", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath(`compact-location-${width}.png`), animations: "disabled" });
  });

  for (const dark of [false, true]) {
    test(`Location controls at ${width}px ${dark ? "dark" : "light"}`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(
        `<html class="${dark ? "dark" : ""}"><head><style>${css}</style></head><body data-initial="on"><div id="root"></div></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await expect(page.getByRole("switch")).toBeVisible();
      await expect(page.locator("main")).toHaveAttribute(
        "data-gsap-auto-fade-ready",
        "1",
      );
      await expectContainedDuringEnter(page);
      await expectThumbPosition(page, true);
      for (const checked of [false, true, false, true]) {
        await page.getByRole("switch").click();
        await expectThumbPosition(page, checked);
      }
      // The MutationObserver must apply the same exclusion to deferred views.
      await page.getByRole("button", { name: "Remount controls" }).click();
      await expectContainedDuringEnter(page);
      await expectThumbPosition(page, true);
      await page.getByRole("switch").press("Space");
      await expectThumbPosition(page, false);

      const alignment = await page
        .locator("[data-share-card]")
        .evaluate((card) => {
          const grid = card.querySelector("[role=group] > div")!;
          const box = card.getBoundingClientRect();
          return Math.abs(
            grid.getBoundingClientRect().left -
              (box.left + parseFloat(getComputedStyle(card).paddingLeft)),
          );
        });
      expect(alignment).toBeLessThanOrEqual(1);
      await page.getByRole("button", { name: "1 hour", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "1 hour", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(errors).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath("location-controls-off.png"),
        style: "[data-fixture-tools] { visibility: hidden }",
      });
      await page.getByRole("switch").click();
      await expectThumbPosition(page, true);
      await page.screenshot({
        path: testInfo.outputPath("location-controls-on.png"),
        style: "[data-fixture-tools] { visibility: hidden }",
      });
    });
  }
}
