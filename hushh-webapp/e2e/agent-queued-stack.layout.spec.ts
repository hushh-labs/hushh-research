import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

/**
 * Messages queued while One works, measured on the pixel grid in a real
 * browser: the stack shares the composer's box (equal side insets at every
 * width), keeps an 8 pt frame and a 4 pt row rhythm, mirrors its 12 pt text
 * inset with a 12 pt glyph inset on the right, and centres every row's marker,
 * text and glyphs on one line. The joined caption ends where its bubble's text
 * does. At phone and desktop widths, light and dark, then again with the text
 * widened, because CI's Linux fonts set about 1.5px wider than a Mac.
 * Set QUEUE_STACK_SHOT_DIR to also capture one screenshot per width and theme.
 */
let script: string;
let css: string;

const WIDTHS = [320, 393, 1440] as const;
const HALF_PX = 0.5;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-queued-stack-"));
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
      lib: { entry: path.join(root, "e2e/fixtures/agent-queued-stack.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("http://localhost/agent-queued-stack", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto("http://localhost/agent-queued-stack");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await page.getByTestId("agent-chat-queued-row").nth(2).waitFor();
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type Geometry = {
  viewport: number;
  scrollWidth: number;
  stack: Box;
  composer: Box;
  header: Box;
  headerParts: Box[];
  rows: Array<{ row: Box; marker: Box; text: Box; buttons: Box[]; glyphs: Box[]; overflow: boolean }>;
  bubble: Box;
  bubbleText: Box;
  captionText: Box;
  caption: Box;
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const box = (node: Element): Box => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const textBox = (node: Element): Box => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const one = (id: string) => document.querySelector(`[data-testid='${id}']`)!;
    const stack = one("agent-chat-prompt-queue");
    const header = one("agent-chat-prompt-queue-header");
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      stack: box(stack),
      composer: box(one("fixture-composer")),
      header: box(header),
      headerParts: [...header.querySelectorAll("span")].map(box),
      rows: [...stack.querySelectorAll("[data-testid='agent-chat-queued-row']")].map((row) => {
        const bounds = row.getBoundingClientRect();
        return {
          row: box(row),
          marker: box(row.querySelector("[data-testid='agent-chat-queued-marker']")!),
          text: box(row.querySelector("[data-testid='agent-chat-queued-text'], input")!),
          buttons: [...row.querySelectorAll("button")].map(box),
          glyphs: [...row.querySelectorAll("button svg")].map(box),
          overflow: [...row.querySelectorAll("*")].some((node) => {
            const b = node.getBoundingClientRect();
            return b.width > 0 && (b.left < bounds.left - 0.5 || b.right > bounds.right + 0.5);
          }),
        };
      }),
      bubble: box(one("fixture-joined-bubble")),
      bubbleText: textBox(one("fixture-joined-bubble")),
      caption: box(one("agent-message-queued-joined")),
      captionText: textBox(one("agent-message-queued-joined")),
    };
  });
}

const centre = (b: Box) => b.top + b.height / 2;

function assertGrid(g: Geometry, label: string) {
  // Equal side insets, and exactly the composer's box.
  expect.soft(Math.abs(g.stack.left - (g.viewport - g.stack.right)), `${label}: side insets`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(Math.abs(g.stack.left - g.composer.left), `${label}: left edge vs composer`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(Math.abs(g.stack.right - g.composer.right), `${label}: right edge vs composer`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(g.scrollWidth, `${label}: horizontal scroll`).toBeLessThanOrEqual(g.viewport + 1);

  // 8 pt frame: header top, row sides, last row bottom.
  const first = g.rows[0]!;
  const last = g.rows[g.rows.length - 1]!;
  expect.soft(g.header.top - g.stack.top, `${label}: top padding`).toBeCloseTo(8, 0);
  expect.soft(first.row.left - g.stack.left, `${label}: left padding`).toBeCloseTo(8, 0);
  expect.soft(g.stack.right - first.row.right, `${label}: right padding`).toBeCloseTo(8, 0);
  expect.soft(g.stack.bottom - last.row.bottom, `${label}: bottom padding`).toBeCloseTo(8, 0);
  expect.soft(first.row.top - g.header.bottom, `${label}: header to rows`).toBeCloseTo(4, 0);
  expect.soft(g.header.height, `${label}: header height`).toBeCloseTo(24, 0);

  // Header: count and hint share one line and mirror each other's inset.
  const [count, hint] = g.headerParts;
  expect.soft(Math.abs(centre(count!) - centre(hint!)), `${label}: header baseline`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(Math.abs((count!.left - g.stack.left) - (g.stack.right - hint!.right)), `${label}: header insets`).toBeLessThanOrEqual(HALF_PX);

  for (const [index, item] of g.rows.entries()) {
    const name = `${label} row ${index + 1}`;
    expect.soft(item.overflow, `${name}: overflow`).toBe(false);
    expect.soft(item.row.height, `${name}: height`).toBeCloseTo(40, 0);
    if (index > 0) expect.soft(item.row.top - g.rows[index - 1]!.row.bottom, `${name}: rhythm`).toBeCloseTo(4, 0);
    // Optical symmetry: the marker sits as far from the left edge as the last
    // glyph sits from the right edge.
    const lastGlyph = item.glyphs[item.glyphs.length - 1]!;
    expect.soft(item.marker.left - item.row.left, `${name}: left inset`).toBeCloseTo(12, 0);
    expect.soft(Math.abs((item.marker.left - item.row.left) - (item.row.right - lastGlyph.right)), `${name}: mirrored insets`).toBeLessThanOrEqual(HALF_PX);
    // One line: marker, text and every glyph centred on the row.
    for (const part of [item.marker, item.text, ...item.glyphs]) {
      expect.soft(Math.abs(centre(part) - centre(item.row)), `${name}: vertical centre`).toBeLessThanOrEqual(HALF_PX + 0.25);
    }
    for (const button of item.buttons) {
      expect.soft([button.width, button.height], `${name}: 32 pt target`).toEqual([32, 32]);
    }
    expect.soft(item.text.right, `${name}: text runs under actions`).toBeLessThanOrEqual(item.buttons[0]!.left + HALF_PX);
  }

  // The caption ends where the bubble's text does (both 4 pt in from the edge
  // the text aligns to) and sits 4 pt under the bubble.
  expect.soft(Math.abs(g.caption.right - g.bubble.right), `${label}: caption column`).toBeLessThanOrEqual(HALF_PX);
  expect.soft(g.caption.right - g.captionText.right, `${label}: caption inset`).toBeCloseTo(4, 0);
  expect.soft(g.caption.top - g.bubble.bottom, `${label}: caption gap`).toBeCloseTo(4, 0);
}

for (const dark of [false, true])
  for (const width of WIDTHS)
    test(`queued stack sits on the composer's grid at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, width, dark);
      const label = `${width}px ${dark ? "dark" : "light"}`;

      assertGrid(await measure(page), label);

      const shotDir = process.env.QUEUE_STACK_SHOT_DIR;
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: path.join(shotDir, `queued-stack-${width}-${dark ? "dark" : "light"}.png`), fullPage: true, animations: "disabled" });
      }

      await page.addStyleTag({
        content: "[data-testid='agent-chat-queued-text'],[data-testid='agent-chat-prompt-queue-header'] span,[data-testid='agent-message-queued-joined'],[data-testid='fixture-joined-bubble']{letter-spacing:0.3px}",
      });
      assertGrid(await measure(page), `${label} widened`);
      expect(errors).toEqual([]);
    });

test("a queued message edits in place without moving the grid, and removes cleanly", async ({ page }) => {
  await open(page, 393, false);
  await page.getByRole("button", { name: "Edit queued message 2" }).click();
  const input = page.getByRole("textbox", { name: "Edit queued message 2" });
  await expect(input).toBeFocused();
  assertGrid(await measure(page), "393px editing");

  await input.fill("Move the standup to 10");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("agent-chat-queued-text").nth(1)).toHaveText("Move the standup to 10");

  await page.getByRole("button", { name: "Remove queued message 1" }).click();
  await expect(page.getByTestId("agent-chat-queued-row")).toHaveCount(2);
  await expect(page.getByTestId("agent-chat-prompt-queue-header")).toContainText("2 queued");
  assertGrid(await measure(page), "393px after remove");
});
