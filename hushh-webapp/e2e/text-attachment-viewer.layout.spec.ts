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

/**
 * The editor behind the composer's pasted-text chip, and "Edit and send
 * again" on a sent one (founder ask, 2026-09-29).
 *
 * Measured, not eyeballed: the sheet's insets are symmetric and on the 4 pt
 * grid, the find field and its buttons share one centre line, each icon sits
 * at its button's centre, nothing overflows at 320 / 393 / 1440 (again with
 * every label widened), and typing into a 100 KB paste stays under an input
 * latency budget with find highlighting live.
 *
 * `PASTE_EDITOR_SHOT_DIR=<dir>` also writes the review renders there.
 */
const EDITOR_WIDTHS = [
  { width: 320, height: 568 },
  { width: 393, height: 852 },
  { width: 1440, height: 900 },
] as const;
// Keydown to the frame after it painted, per keystroke, in a 100 KB paste.
// Compare with a same-run native textarea, allowing at most one 60 Hz frame
// for editor overhead; the hard tail limit remains independent of the runner.
const LATENCY_P95_NATIVE_MARGIN_MS = 17;
const LATENCY_MAX_BUDGET_MS = 120;

async function openEditor(page: Page) {
  await page.getByRole("button", { name: /Edit pasted text/ }).click();
  const editor = page.getByTestId("text-attachment-editor");
  await expect(editor).toBeVisible();
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  return editor;
}

type EditorGeometry = Awaited<ReturnType<typeof measureEditor>>;

function measureEditor(page: Page) {
  return page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('[data-testid="text-attachment-editor"]')!;
    const rect = (element: Element) => element.getBoundingClientRect();
    const centreY = (element: Element) => rect(element).top + rect(element).height / 2;
    const centreX = (element: Element) => rect(element).left + rect(element).width / 2;
    const frame = rect(editor);
    const innerLeft = frame.left + editor.clientLeft;
    const innerRight = innerLeft + editor.clientWidth;
    const header = editor.querySelector('[data-testid="text-attachment-editor-header"]')!;
    const cancel = header.querySelector('[data-testid="text-attachment-editor-cancel"]')!;
    const commit = header.querySelector('[data-testid="text-attachment-editor-commit"]')!;
    const titleBlock = header.querySelector("h2")!.parentElement!;
    const toolbar = editor.querySelector('[data-testid="text-attachment-editor-toolbar"]')!;
    const field = toolbar.querySelector("input")!;
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>(":scope > button")];
    const textarea = editor.querySelector<HTMLTextAreaElement>(
      '[data-testid="text-attachment-editor-textarea"]',
    )!;
    const style = getComputedStyle(textarea);
    const cancelPad = parseFloat(getComputedStyle(cancel).paddingLeft);
    const overflowing = [...editor.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element !== textarea && !element.closest("[aria-hidden='true']"))
      .filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible")
      .map((element) => element.dataset.testid ?? element.tagName.toLowerCase());
    return {
      frame: { left: frame.left, right: frame.right, top: frame.top, bottom: frame.bottom, width: frame.width },
      header: {
        height: rect(header).height,
        cancelInset: rect(cancel).left - innerLeft,
        commitInset: innerRight - rect(commit).right,
        cancelTextInset: rect(cancel).left + cancelPad - innerLeft,
        titleOffsetFromCentre: centreX(titleBlock) - (innerLeft + innerRight) / 2,
        centreSpread: Math.max(centreY(cancel), centreY(commit), centreY(titleBlock)) -
          Math.min(centreY(cancel), centreY(commit), centreY(titleBlock)),
      },
      toolbar: {
        fieldInset: rect(field).left - innerLeft,
        lastButtonInset: innerRight - rect(buttons.at(-1)!).right,
        fieldHeight: rect(field).height,
        buttonSizes: buttons.map((button) => [rect(button).width, rect(button).height]),
        gaps: buttons.map((button, index) =>
          rect(button).left - (index ? rect(buttons[index - 1]!).right : rect(field).right),
        ),
        centreSpread: Math.max(centreY(field), ...buttons.map(centreY)) -
          Math.min(centreY(field), ...buttons.map(centreY)),
        iconOffsets: buttons.map((button) => {
          const icon = button.querySelector("svg")!;
          return [centreX(icon) - centreX(button), centreY(icon) - centreY(button)];
        }),
      },
      text: {
        paddingLeft: parseFloat(style.paddingLeft),
        paddingRight: parseFloat(style.paddingRight),
        paddingTop: parseFloat(style.paddingTop),
      },
      overflowing,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

const onGrid = (value: number) => Math.abs(value / 4 - Math.round(value / 4)) * 4 <= 0.5;

function assertEditorGeometry(geometry: EditorGeometry, viewportWidth: number, label: string) {
  const { frame, header, toolbar, text } = geometry;
  expect.soft(frame.left, `${label}: frame on screen`).toBeGreaterThanOrEqual(0);
  expect.soft(frame.right, `${label}: frame on screen`).toBeLessThanOrEqual(viewportWidth + 0.5);
  expect.soft(geometry.pageOverflow, `${label}: page scrolls sideways`).toBeLessThanOrEqual(1);
  expect.soft(geometry.overflowing, `${label}: clipped content`).toEqual([]);

  // Symmetric insets on the 4 pt grid.
  expect.soft(Math.abs(header.cancelInset - header.commitInset), `${label}: header insets`).toBeLessThanOrEqual(0.5);
  expect.soft(onGrid(header.cancelInset), `${label}: header inset ${header.cancelInset} on grid`).toBe(true);
  expect.soft(Math.abs(toolbar.fieldInset - toolbar.lastButtonInset), `${label}: toolbar insets`).toBeLessThanOrEqual(0.5);
  expect.soft(onGrid(toolbar.fieldInset), `${label}: toolbar inset ${toolbar.fieldInset} on grid`).toBe(true);
  expect.soft(text.paddingLeft, `${label}: text insets`).toBe(text.paddingRight);
  expect.soft(onGrid(text.paddingLeft) && onGrid(text.paddingTop), `${label}: text padding on grid`).toBe(true);
  // Cancel's label starts on the same vertical as the find field.
  expect.soft(Math.abs(header.cancelTextInset - toolbar.fieldInset), `${label}: label column`).toBeLessThanOrEqual(0.5);
  for (const gap of toolbar.gaps) expect.soft(onGrid(gap), `${label}: toolbar gap ${gap}`).toBe(true);
  expect.soft(onGrid(header.height) && onGrid(toolbar.fieldHeight), `${label}: row heights`).toBe(true);

  // One centre line per row; the title centred on the sheet.
  expect.soft(header.centreSpread, `${label}: header centre line`).toBeLessThanOrEqual(0.5);
  expect.soft(Math.abs(header.titleOffsetFromCentre), `${label}: title centred`).toBeLessThanOrEqual(0.5);
  expect.soft(toolbar.centreSpread, `${label}: toolbar centre line`).toBeLessThanOrEqual(0.5);
  for (const [x, y] of toolbar.iconOffsets) {
    expect.soft(Math.hypot(x!, y!), `${label}: icon centred`).toBeLessThanOrEqual(0.5);
  }
  for (const [width, height] of toolbar.buttonSizes) {
    expect.soft(Math.min(width!, height!), `${label}: touch target`).toBeGreaterThanOrEqual(44);
  }
}

/** Per-keystroke latency: keydown to the task after the next frame painted. */
async function typeAndMeasure(page: Page, selector: string, text: string, delay: number) {
  await page.evaluate((target) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(target)!;
    const samples: number[] = [];
    (window as unknown as { __latency: number[] }).__latency = samples;
    textarea.addEventListener("keydown", () => {
      // Start when the page receives the event. WebKit's synthetic event
      // timestamp can precede dispatch by the automation/runner queue delay;
      // counting that delay does not measure the editor's response time.
      const start = performance.now();
      requestAnimationFrame(() => setTimeout(() => samples.push(performance.now() - start), 0));
    });
  }, selector);
  await page.locator(selector).focus();
  await page.keyboard.type(text, { delay });
  await page.waitForTimeout(250);
  const samples = await page.evaluate(() => (window as unknown as { __latency: number[] }).__latency);
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: samples.length,
    p50: sorted[Math.floor(sorted.length * 0.5)]!,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    max: sorted.at(-1)!,
  };
}

async function measureNativeBaseline(page: Page, text: string, delay: number) {
  const geometryDelta = await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="text-attachment-editor-textarea"]',
    )!;
    const native = textarea.cloneNode(true) as HTMLTextAreaElement;
    native.removeAttribute("id");
    native.removeAttribute("aria-label");
    native.removeAttribute("data-testid");
    native.dataset.nativeEditorBaseline = "";
    native.value = textarea.value;
    native.setSelectionRange(textarea.selectionStart, textarea.selectionEnd);
    textarea.style.visibility = "hidden";
    textarea.after(native);
    const appBox = textarea.getBoundingClientRect();
    const nativeBox = native.getBoundingClientRect();
    return Math.max(
      Math.abs(appBox.left - nativeBox.left),
      Math.abs(appBox.top - nativeBox.top),
      Math.abs(appBox.width - nativeBox.width),
      Math.abs(appBox.height - nativeBox.height),
    );
  });
  try {
    expect(geometryDelta, "native control matches editor geometry").toBeLessThanOrEqual(0.5);
    return await typeAndMeasure(page, '[data-native-editor-baseline]', text, delay);
  } finally {
    await page.evaluate(() => {
      document.querySelector('[data-native-editor-baseline]')?.remove();
      const textarea = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="text-attachment-editor-textarea"]',
      );
      if (textarea) textarea.style.visibility = "";
    });
  }
}

async function placeCaret(page: Page, fraction: number) {
  return page.evaluate((at) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="text-attachment-editor-textarea"]',
    )!;
    const offset = textarea.value.lastIndexOf("\n", Math.floor(textarea.value.length * at)) + 1;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(offset, offset);
    return offset;
  }, fraction);
}

function shotPath(name: string) {
  const directory = process.env.PASTE_EDITOR_SHOT_DIR;
  if (!directory) return test.info().outputPath(name);
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

test.describe("pasted text editor", () => {
  for (const viewport of EDITOR_WIDTHS)
    test(`edits a 100 KB paste on the 4 pt grid and stays responsive at ${viewport.width}px`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      const errors = await mount(page, { hash: "pending=100" });
      const transcriptBefore = await scrollTopOf(page, "transcript");
      const chipSize = page.getByTestId("agent-chat-text-attachment-size");
      const sizeBefore = await chipSize.textContent();
      const editor = await openEditor(page);
      expect(await editor.getAttribute("data-presentation")).toBe(viewport.width < 768 ? "sheet" : "panel");
      await expect(page.getByLabel("Pasted text, editable text")).toHaveJSProperty("selectionStart", 0);

      const label = `${viewport.width}px`;
      const geometry = await measureEditor(page);
      info.annotations.push({ type: "geometry", description: `${label} ${JSON.stringify(geometry)}` });
      assertEditorGeometry(geometry, viewport.width, label);

      // Typing in the middle of the paste lands where the caret is.
      const at = await placeCaret(page, 0.5);
      const plainText = "reconciled twice, ".repeat(3);
      const nativePlain = await measureNativeBaseline(page, plainText, 20);
      const plain = await typeAndMeasure(page, '[data-testid="text-attachment-editor-textarea"]', plainText, 20);
      const value = await page.getByLabel("Pasted text, editable text").inputValue();
      expect(value.slice(at, at + plainText.length)).toBe(plainText);

      // Again with find live: every pause rebuilds ~1,300 highlights.
      await page.getByLabel("Find in text").fill("ledger");
      await expect(page.getByTestId("text-attachment-editor-match-count")).toHaveText(/^1 of \d{4} matches$/);
      // Continuous typing does no whole-document work per keystroke: the
      // highlight layer is rebuilt once, after the pause, not per key.
      await placeCaret(page, 0.75);
      await page.evaluate(() => {
        const layer = document.querySelector('[data-testid="text-attachment-editor-highlights"]')!;
        const state = { rebuilds: 0 };
        (window as unknown as { __rebuilds: typeof state }).__rebuilds = state;
        new MutationObserver((records) => {
          if (records.some((record) => record.type === "childList")) state.rebuilds += 1;
        }).observe(layer.firstElementChild!, { childList: true });
      });
      await page.keyboard.type("twenty quick strokes", { delay: 20 });
      await page.waitForTimeout(400);
      const rebuilds = await page.evaluate(
        () => (window as unknown as { __rebuilds: { rebuilds: number } }).__rebuilds.rebuilds,
      );
      expect(rebuilds, `${label}: highlight rebuilds for 20 keystrokes`).toBe(1);

      await placeCaret(page, 0.25);
      const findText = "audit note ".repeat(4);
      const nativeFind = await measureNativeBaseline(page, findText, 150);
      const withFind = await typeAndMeasure(page, '[data-testid="text-attachment-editor-textarea"]', findText, 150);
      info.annotations.push({
        type: "latency",
        description: `${label} plain ${JSON.stringify(plain)} nativePlain ${JSON.stringify(nativePlain)} withFind ${JSON.stringify(withFind)} nativeFind ${JSON.stringify(nativeFind)} rebuilds ${rebuilds}`,
      });
      for (const [name, sample, native] of [["plain", plain, nativePlain], ["find", withFind, nativeFind]] as const) {
        // A 12-18 key sample makes its empirical p95 the same observation as
        // max, so the separate 120 ms tail budget has no effect.
        expect.soft(sample.count, `${label} ${name} sample count`).toBeGreaterThanOrEqual(40);
        expect.soft(native.count, `${label} ${name} native sample count`).toBeGreaterThanOrEqual(40);
        expect.soft(sample.p95, `${label} ${name} p95 versus native ${native.p95}`).toBeLessThanOrEqual(native.p95 + LATENCY_P95_NATIVE_MARGIN_MS);
        expect.soft(sample.max, `${label} ${name} max`).toBeLessThan(LATENCY_MAX_BUDGET_MS);
      }
      // The highlights lay out exactly like the text they sit behind: same
      // metrics, same wrapped height (a 1px font drift moved a highlight a
      // whole word, measured 2026-09-29).
      const alignment = await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="text-attachment-editor-textarea"]',
        )!;
        const mirror = document.querySelector<HTMLElement>('[data-testid="text-attachment-editor-highlights"]')!;
        const a = getComputedStyle(textarea);
        const b = getComputedStyle(mirror);
        const keys = ["fontFamily", "fontSize", "lineHeight", "letterSpacing", "paddingLeft", "paddingTop"] as const;
        return {
          metrics: keys.filter((key) => a[key] !== b[key]),
          heightDelta: Math.abs(mirror.firstElementChild!.getBoundingClientRect().height + parseFloat(b.paddingTop) + parseFloat(b.paddingBottom) - textarea.scrollHeight),
        };
      });
      expect(alignment.metrics, `${label}: highlight metrics`).toEqual([]);
      expect(alignment.heightDelta, `${label}: highlight wrap`).toBeLessThanOrEqual(1);
      const count = Number((await page.getByTestId("text-attachment-editor-match-count").textContent())!.split(" of ")[1]!.split(" ")[0]);
      await page.getByRole("button", { name: "Next match" }).click();
      await expect(page.getByTestId("text-attachment-editor-match-count")).toHaveText(`2 of ${count} matches`);

      // The textarea is the only scroller; the page and transcript stay put.
      const textarea = page.getByLabel("Pasted text, editable text");
      const box = (await textarea.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 900);
      await expect.poll(() => textarea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await scrollTopOf(page, "transcript")).toBe(transcriptBefore);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // Widened labels (CI's fonts run wider than a Mac's) keep the grid.
      await page.addStyleTag({
        content: "[data-testid='text-attachment-editor'] :is(button,h2,p,input){letter-spacing:0.3px}",
      });
      assertEditorGeometry(await measureEditor(page), viewport.width, `${label} widened`);

      await page.getByRole("button", { name: "Done" }).click();
      await expect(editor).toBeHidden();
      await expect(chipSize).not.toHaveText(sizeBefore!);
      expect(errors).toEqual([]);
    });

  test("sits above the keyboard with its safe inset on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await mount(page, { hash: "pending=100" });
    await openEditor(page);
    await page.evaluate(() => document.documentElement.style.setProperty("--kb-height", "336px"));
    const frame = (await page.getByTestId("text-attachment-editor").boundingBox())!;
    const textarea = (await page.getByLabel("Pasted text, editable text").boundingBox())!;
    expect(frame.y + frame.height).toBeCloseTo(852 - 336, 0);
    expect(frame.y).toBeGreaterThanOrEqual(40 - 0.5);
    expect(textarea.height).toBeGreaterThanOrEqual(200);
    expect(textarea.y + textarea.height).toBeLessThanOrEqual(852 - 336 + 0.5);
  });

  test("asks before discarding, and Keep editing keeps the edit", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await mount(page, { hash: "pending=4" });
    const editor = await openEditor(page);
    await placeCaret(page, 0);
    await page.keyboard.type("draft ");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(editor.getByRole("alert")).toHaveText("Discard changes?");
    await expect(page.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(editor.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("Pasted text, editable text")).toHaveValue(/^draft /);
    // Native undo still owns the edit.
    await page.getByLabel("Pasted text, editable text").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(page.getByLabel("Pasted text, editable text")).not.toHaveValue(/^draft /);
  });

  test("Edit and send again sends a new turn and leaves the message as it was", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    const errors = await mount(page, { hash: "lines=30" });
    const chip = page.getByRole("button", { name: /Pasted text/ });
    await chip.scrollIntoViewIfNeeded();
    const before = await chip.textContent();
    const viewer = await openViewer(page);
    await viewer.getByRole("button", { name: "Edit and send again" }).click();
    const editor = page.getByTestId("text-attachment-editor");
    await expect(editor).toBeVisible();
    await placeCaret(page, 1);
    await page.keyboard.type("\n  const extra = 1;");
    await editor.getByRole("button", { name: "Send" }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByTestId("resent-turn")).toHaveText("Sent again: 31 lines");
    expect(await chip.textContent()).toBe(before);
    expect(errors).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const)
    test(`renders the review set at 393px (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 393, height: 852 });
      await mount(page, { hash: "pending=100&lines=30", theme });
      await openEditor(page);
      await page.screenshot({ path: shotPath(`paste-editor-393-${theme}.png`), animations: "disabled" });
      await page.getByLabel("Find in text").fill("vendor 7");
      await expect(page.getByTestId("text-attachment-editor-match-count")).toHaveText(/^1 of \d+ matches$/);
      await page.getByRole("button", { name: "Next match" }).click();
      await page.getByRole("button", { name: "Replace and text options" }).click();
      await page.mouse.move(0, 0);
      await page.getByLabel("Find in text").focus();
      await page.screenshot({ path: shotPath(`paste-editor-search-393-${theme}.png`), animations: "disabled" });
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("text-attachment-editor")).toBeHidden();
      await page.getByRole("button", { name: /Pasted text/ }).first().scrollIntoViewIfNeeded();
      const viewer = await openViewer(page);
      await expect(viewer.getByRole("button", { name: "Edit and send again" })).toBeVisible();
      await page.screenshot({ path: shotPath(`paste-viewer-sent-393-${theme}.png`), animations: "disabled" });
    });
});
