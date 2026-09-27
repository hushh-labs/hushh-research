import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

/**
 * The pasted-text viewer and the scroll after Send, in a real browser with the
 * real chip, viewer, Sheet primitive, reveal helper and app stylesheet.
 *
 * JSDOM has no layout and no wheel scrolling, so the two defects this guards
 * are invisible there: a viewer body that does not scroll under the wheel (the
 * failure of a non-modal dialog opened from a modal), and a pending "One is
 * preparing your response" row that lands behind the composer overlay.
 *
 * Run: CI=1 npx playwright test e2e/text-attachment-viewer.layout.spec.ts --project=chromium
 */

let css: string;
let script: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "text-attachment-viewer-"));
  await build({
    configFile: false,
    logLevel: "error",
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
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [{ find: "@", replacement: root }] },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/text-attachment-viewer.tsx"),
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
        return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

async function mount(
  page: Page,
  { hash = "", theme = "light" }: { hash?: string; theme?: "light" | "dark" } = {},
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://localhost/text-attachment-viewer", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${theme}"><head><title>Text attachment viewer contract</title><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.goto(`http://localhost/text-attachment-viewer${hash ? `#${hash}` : ""}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByTestId("transcript")).toBeVisible();
  return errors;
}

/** Bring the chip on screen first, so the transcript position is the reader's. */
async function revealChip(page: Page) {
  await page.getByRole("button", { name: /Pasted text/ }).scrollIntoViewIfNeeded();
  return scrollTopOf(page, "transcript");
}

async function openViewer(page: Page) {
  await page.getByRole("button", { name: /Pasted text/ }).click();
  const viewer = page.getByTestId("text-attachment-viewer");
  await expect(viewer).toBeVisible();
  // Measure the settled surface. WebKit rejects `finished` for an animation
  // it cancels (the entry keyframe once the sheet settles), so tolerate that.
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  return viewer;
}

async function scrollTopOf(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((element) => element.scrollTop);
}

test.describe("desktop panel", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of ["light", "dark"] as const)
    test(`reads beside a usable chat and scrolls under the wheel (${theme})`, async ({ page }) => {
      const errors = await mount(page, { theme });
      const transcriptBefore = await revealChip(page);
      const viewer = await openViewer(page);
      expect(await viewer.getAttribute("data-presentation")).toBe("panel");

      // A floating panel on the right; the transcript stays on screen and
      // there is no scrim over it.
      const panel = (await viewer.boundingBox())!;
      expect(panel.x + panel.width).toBeLessThanOrEqual(1440);
      expect(panel.width).toBeLessThanOrEqual(640);
      expect(panel.x).toBeGreaterThan(700);
      expect(await page.locator('[data-slot="sheet-overlay"]').count()).toBe(0);

      // Its body owns the scroll: the wheel moves the text, not the page.
      const body = page.getByTestId("text-attachment-viewer-body");
      const box = (await body.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 1_200);
      await expect.poll(() => scrollTopOf(page, "text-attachment-viewer-body")).toBeGreaterThan(600);
      expect(await scrollTopOf(page, "transcript")).toBe(transcriptBefore);

      // The chat keeps working beside it: typing does not close the panel.
      const composer = page.getByLabel("Message");
      await composer.click();
      await composer.pressSequentially(", continued");
      await expect(composer).toHaveValue("half-typed reply, continued");
      await expect(viewer).toBeVisible();
      await page.getByLabel("Find in text").fill("ledger");
      await page.screenshot({ path: test.info().outputPath(`panel-${theme}.png`) });

      // Escape from inside the panel closes it and hands focus back to the chip.
      await body.focus();
      await page.keyboard.press("Escape");
      await expect(viewer).toBeHidden();
      await expect(page.getByRole("button", { name: /Pasted text/ })).toBeFocused();
      await expect(composer).toHaveValue("half-typed reply, continued");
      expect(await scrollTopOf(page, "transcript")).toBe(transcriptBefore);

      expect(errors).toEqual([]);
    });

  test("builds a 170k-character paste lazily and reaches its last line", async ({ page }) => {
    await mount(page);
    await openViewer(page);
    const body = page.getByTestId("text-attachment-viewer-body");
    const builtAtOpen = await body.locator("[data-line]").count();
    expect(builtAtOpen).toBeLessThanOrEqual(600);
    expect(await body.textContent().then((text) => text?.length ?? 0)).toBeLessThan(60_000);

    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    // Chunks build as they near the scrollport; keep going until the end.
    await expect
      .poll(
        async () => {
          await body.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          return body.locator('[data-line="2000"]').count();
        },
        { timeout: 5_000 },
      )
      .toBe(1);
  });

  test("Find jumps to a match in an unbuilt chunk and scrolls the body only", async ({ page }) => {
    await mount(page);
    await openViewer(page);
    await page.getByLabel("Find in text").fill("row1850 ");
    await expect(page.getByTestId("text-attachment-viewer-match-count")).toHaveText("1 of 1");
    const active = page.locator("[data-active-match]");
    await expect(active).toBeInViewport();
    expect(await active.evaluate((mark) => mark.closest("[data-line]")?.getAttribute("data-line"))).toBe("1851");
    const viewerBox = (await page.getByTestId("text-attachment-viewer").boundingBox())!;
    expect(viewerBox.y).toBeGreaterThanOrEqual(0);
  });
});

test.describe("phone sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("opens as a large bottom sheet whose body scrolls and whose handle swipes it away", async ({ page }) => {
    const errors = await mount(page);
    const transcriptBefore = await revealChip(page);
    const viewer = await openViewer(page);
    expect(await viewer.getAttribute("data-presentation")).toBe("sheet");

    const sheet = (await viewer.boundingBox())!;
    expect(sheet.y + sheet.height).toBeCloseTo(844, 0);
    expect(sheet.height).toBeGreaterThanOrEqual(844 * 0.9);
    // The sheet is a fixed frame; the text box is the only scroller.
    expect(await viewer.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    const body = page.getByTestId("text-attachment-viewer-body");
    await body.evaluate((element) => element.scrollBy(0, 900));
    await expect.poll(() => scrollTopOf(page, "text-attachment-viewer-body")).toBeGreaterThan(800);
    // The find field is not focused on open, so no keyboard rises over the text.
    await expect(page.getByLabel("Find in text")).not.toBeFocused();

    await page.screenshot({ path: test.info().outputPath("sheet-light.png") });
    const handle = (await page.getByRole("button", { name: "Drag down to close" }).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    // A finger's first move is a few px, inside the handle, which is where
    // the sheet takes pointer capture for the rest of the swipe.
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 240, {
      steps: 30,
    });
    await page.mouse.up();
    await expect(viewer).toBeHidden();
    await expect(page.getByLabel("Message")).toHaveValue("half-typed reply");
    expect(await scrollTopOf(page, "transcript")).toBe(transcriptBefore);

    expect(errors).toEqual([]);
  });
});

test.describe("scroll after Send", () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ])
    test(`brings One's pending turn above the composer at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mount(page, { hash: "lines=30" });
      await page.getByRole("button", { name: "Send" }).click();
      const pending = page.getByTestId("pending-turn");
      await expect(pending).toBeAttached();
      const pendingBox = (await pending.boundingBox())!;
      const composerBox = (await page.getByTestId("composer").boundingBox())!;
      expect(pendingBox.y).toBeGreaterThanOrEqual(0);
      expect(pendingBox.y + pendingBox.height).toBeLessThanOrEqual(composerBox.y);
    });

  test("negative control: aligning the end marker with the scrollport hides it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mount(page, { hash: "lines=30&reveal=legacy" });
    await page.getByRole("button", { name: "Send" }).click();
    const pendingBox = (await page.getByTestId("pending-turn").boundingBox())!;
    const composerBox = (await page.getByTestId("composer").boundingBox())!;
    expect(pendingBox.y + pendingBox.height).toBeGreaterThan(composerBox.y);
  });
});
