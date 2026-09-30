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
 * One's answers, read on a phone: the real `AgentMarkdown` renderer, the real
 * chat bubble classes and the app stylesheet, fed realistic replies (see
 * `e2e/fixtures/agent-markdown.tsx`).
 *
 * JSDOM has no layout, so the defects this guards are invisible there: a long
 * URL or code line that widens the whole page, a wide table that pushes the
 * transcript sideways instead of scrolling in its own box, link targets too
 * small to tap, and link colour that sinks into the grey bubble.
 *
 * Run: CI=1 npx playwright test e2e/agent-markdown.layout.spec.ts --project=chromium --project=webkit
 *
 * Renders for design review (not asserted): set CHAT_FORMATTING_RENDERS_DIR and
 * run with `--grep renders`.
 */

let css: string;
let script: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-markdown-"));
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
    resolve: {
      alias: [
        {
          find: /^next\/navigation$/,
          replacement: path.join(root, "e2e/fixtures/agent-markdown-boundaries.ts"),
        },
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/agent-markdown.tsx"),
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

type Theme = "light" | "dark";

async function mount(
  page: Page,
  width: number,
  { theme = "light", accent = "blue" }: { theme?: Theme; accent?: "blue" | "gold" } = {},
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.route("http://localhost/agent-markdown", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${theme}" data-accent="${accent}"><head><title>Agent answer formatting contract</title><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style><style>html,body{height:auto}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  // A tracker image must never be fetched just because an answer mentioned it.
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://localhost/")) remoteRequests.push(request.url());
  });
  await page.goto("http://localhost/agent-markdown");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByTestId("transcript")).toBeVisible();
  return { errors, remoteRequests };
}

type Geometry = {
  viewport: number;
  pageScrollWidth: number;
  scrollBoxes: Array<{ kind: string; right: number; scrollWidth: number; clientWidth: number }>;
  smallLinks: Array<{ text: string; height: number }>;
  linkCount: number;
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const scrollBoxes = [
      ...document.querySelectorAll<HTMLElement>("[data-agent-code-scroll],[data-agent-table-scroll]"),
    ].map((box) => ({
      kind: box.hasAttribute("data-agent-code-scroll") ? "code" : "table",
      right: box.getBoundingClientRect().right,
      scrollWidth: box.scrollWidth,
      clientWidth: box.clientWidth,
    }));
    const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-testid=transcript] a[href]")];
    const smallLinks = links
      .map((link) => ({
        text: (link.textContent ?? "").trim().slice(0, 40),
        height: Math.min(...[...link.getClientRects()].map((rect) => rect.height)),
      }))
      .filter((link) => link.height < 24);
    return {
      viewport: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      scrollBoxes,
      smallLinks,
      linkCount: links.length,
    };
  });
}

function assertGeometry(geometry: Geometry, label: string) {
  expect(geometry.pageScrollWidth, `${label}: the page itself never scrolls sideways`).toBeLessThanOrEqual(
    geometry.viewport,
  );
  const code = geometry.scrollBoxes.filter((box) => box.kind === "code");
  const tables = geometry.scrollBoxes.filter((box) => box.kind === "table");
  expect(code.length, `${label}: every fenced block, the open one included`).toBe(3);
  expect(tables.length, `${label}: both tables, the half-written one included`).toBe(2);
  for (const box of geometry.scrollBoxes) {
    expect(box.right, `${label}: a ${box.kind} box stays inside the viewport`).toBeLessThanOrEqual(
      geometry.viewport,
    );
  }
  // The long curl line overflows its own box, which then scrolls: proof the
  // overflow is contained rather than absent because something was clipped.
  expect(code[0].scrollWidth, `${label}: the long code line scrolls inside its block`).toBeGreaterThan(
    code[0].clientWidth,
  );
  expect(geometry.linkCount, `${label}: the answers carry their links`).toBeGreaterThan(8);
  expect(geometry.smallLinks, `${label}: every link target is at least 24px tall`).toEqual([]);
}

for (const width of [320, 393]) {
  for (const theme of ["light", "dark"] as const) {
    test(`answers fit a ${width}px phone in ${theme} without widening the page`, async ({ page }) => {
      const { errors, remoteRequests } = await mount(page, width, { theme });
      const geometry = await measure(page);
      assertGeometry(geometry, `${width}px ${theme}`);
      if (width === 320) {
        const tables = geometry.scrollBoxes.filter((box) => box.kind === "table");
        expect(tables[0].scrollWidth, "the six-column table scrolls inside its box on a 320px phone").toBeGreaterThan(
          tables[0].clientWidth,
        );
        // CI's Linux fonts set about 1.5px wider than a Mac. Widen on purpose.
        await page.addStyleTag({ content: ".agent-markdown *{letter-spacing:0.03em}" });
        assertGeometry(await measure(page), `${width}px ${theme} widened`);
      }
      expect(remoteRequests, "no answer content is fetched from the network").toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test("unsafe links stay inert and images never load", async ({ page }) => {
  await mount(page, 393);
  const edges = page.getByTestId("message-edges");
  await expect(edges.getByText("this", { exact: true })).toBeVisible();
  await expect(edges.locator("a", { hasText: /^this$/ })).toHaveCount(0);
  await expect(page.locator("a[href^='javascript' i], a[href^='data:' i]")).toHaveCount(0);
  await expect(page.locator("[data-testid=transcript] img")).toHaveCount(0);
});

test("code is set in a true monospace, block and inline", async ({ page }) => {
  await mount(page, 393);
  // preflight hands every <code> the app's mono token, which is the product
  // sans; equal advances for "iiii" and "MMMM" prove the stack actually won.
  const widths = await page.evaluate(() =>
    ["[data-agent-code-scroll] code", ".agent-markdown p code"].map((selector) => {
      const code = document.querySelector<HTMLElement>(selector)!;
      const probe = document.createElement("span");
      code.appendChild(probe);
      probe.textContent = "iiii";
      const narrow = probe.getBoundingClientRect().width;
      probe.textContent = "MMMM";
      const wide = probe.getBoundingClientRect().width;
      probe.remove();
      return { selector, narrow, wide };
    }),
  );
  for (const { selector, narrow, wide } of widths) {
    expect(Math.abs(narrow - wide), `${selector} is monospaced`).toBeLessThan(0.5);
  }
});

test("footnote citations link to the source list of their own answer", async ({ page }) => {
  await mount(page, 393);
  const flights = page.getByTestId("message-flights");
  const sources = flights.getByRole("list", { name: "Sources" });
  await expect(sources.getByRole("link", { name: "TAP Air Portugal fares" })).toBeVisible();
  const citation = flights.getByRole("link", { name: "Source 1" });
  const target = await citation.getAttribute("href");
  expect(target).toMatch(/^#/);
  // The id is unique to this answer, so a second answer's [1] cannot jump here.
  await expect(page.locator(`[id="${target!.slice(1)}"]`)).toHaveCount(1);
  await expect(flights.locator(`[id="${target!.slice(1)}"]`)).toHaveCount(1);
});

/** Composite a CSS colour onto an opaque background, as the screen does. */
async function contrastOfLinkOnBubble(page: Page): Promise<number> {
  return page.evaluate(() => {
    const link = document.querySelector<HTMLElement>("[data-testid=message-contact] a[href^='http']")!;
    const bubble = link.closest<HTMLElement>(".agent-markdown")!.parentElement!;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(bubble).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const fg = luminance(rgb(getComputedStyle(link).color));
    const bg = luminance(rgb("transparent"));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
}

for (const accent of ["blue", "gold"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`link colour reads at 4.5:1 on the ${theme} bubble with the ${accent} accent`, async ({ page }) => {
      await mount(page, 393, { theme, accent });
      expect(await contrastOfLinkOnBubble(page)).toBeGreaterThanOrEqual(4.5);
    });
  }
}

type GridReport = {
  offGrid: string[];
  asymmetric: string[];
  offRhythm: string[];
  icons: Array<{ where: string; dx: number; dy: number }>;
  chipBaselines: Array<{ chip: string; delta: number }>;
  citationCentres: Array<{ citation: string; delta: number }>;
  chipLineHeights: number[];
  insets: Record<string, [number, number]>;
};

/**
 * The pixel grid, measured: every padding, margin and gap in an answer is a
 * multiple of 4, every inset is the same on the left and the right, every
 * line box is on the 4px rhythm, every copy glyph is centred in its button,
 * and an inline chip shares its sentence's baseline.
 */
async function measureGrid(page: Page): Promise<GridReport> {
  return page.evaluate(() => {
    const px = (value: string) => Number.parseFloat(value) || 0;
    const onGrid = (value: number) => Math.abs(value / 4 - Math.round(value / 4)) < 0.01;
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).slice(0, 2).join(".")}` : ""}`;
    const report: GridReport = {
      offGrid: [],
      asymmetric: [],
      offRhythm: [],
      icons: [],
      chipBaselines: [],
      citationCentres: [],
      chipLineHeights: [],
      insets: {},
    };
    const bubbles = [...document.querySelectorAll<HTMLElement>(".agent-markdown")].map((md) => md.parentElement!);
    const userBubbles = [...document.querySelectorAll<HTMLElement>("[data-message-role=user] span")].map(
      (span) => span.parentElement!,
    );
    const elements = [
      ...bubbles,
      ...userBubbles,
      ...bubbles.flatMap((bubble) => [...bubble.querySelectorAll<HTMLElement>(".agent-markdown *")]),
    ].filter((el) => !el.closest(".sr-only, md-ripple") && !(el instanceof SVGElement));

    for (const el of elements) {
      const style = getComputedStyle(el);
      const spacing = {
        "padding-top": px(style.paddingTop),
        "padding-right": px(style.paddingRight),
        "padding-bottom": px(style.paddingBottom),
        "padding-left": px(style.paddingLeft),
        "margin-top": px(style.marginTop),
        "margin-right": px(style.marginRight),
        "margin-bottom": px(style.marginBottom),
        "margin-left": px(style.marginLeft),
        ...(/(flex|grid)/.test(style.display) ? { "row-gap": px(style.rowGap), "column-gap": px(style.columnGap) } : {}),
      };
      for (const [property, value] of Object.entries(spacing)) {
        if (!onGrid(value)) report.offGrid.push(`${describe(el)} ${property}=${value}`);
      }
      // Symmetry is a property of surfaces (a fill or an all-round ring). A
      // list's marker gutter and a quote's rule are indentation, not insets.
      const surface =
        (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") ||
        /0px 0px 0px 1px/.test(style.boxShadow) ||
        el.matches("[data-agent-code-block] > div, [data-agent-code-scroll], th, td");
      if (surface && Math.abs(spacing["padding-left"] - spacing["padding-right"]) > 0.5) {
        report.asymmetric.push(`${describe(el)} ${spacing["padding-left"]}/${spacing["padding-right"]}`);
      }
      const block = style.display === "block" || style.display === "list-item" || style.display === "table-cell";
      if (block && el.textContent?.trim() && !onGrid(px(style.lineHeight))) {
        report.offRhythm.push(`${describe(el)} line-height=${style.lineHeight}`);
      }
    }
    for (const pill of document.querySelectorAll<HTMLElement>(".agent-md-source")) {
      const before = getComputedStyle(pill, "::before");
      if (Math.abs(px(before.paddingLeft) - px(before.paddingRight)) > 0.5) report.asymmetric.push("source pill");
      if (!onGrid(px(before.marginTop))) report.offGrid.push(`source pill margin-top=${before.marginTop}`);
    }
    const inset = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return;
      const style = getComputedStyle(el);
      report.insets[selector] = [px(style.paddingLeft), px(style.paddingRight)];
    };
    inset("[data-message-role=assistant] .agent-markdown");
    report.insets["assistant bubble"] = (() => {
      const style = getComputedStyle(bubbles[0]);
      return [px(style.paddingLeft), px(style.paddingRight)] as [number, number];
    })();
    inset("[data-agent-code-scroll]");
    inset("[data-agent-code-block] > div");
    inset("[data-agent-link-chip]");
    inset(".agent-md-table td");
    delete report.insets["[data-message-role=assistant] .agent-markdown"];

    // Copy glyphs sit dead centre in their buttons; the code header's glyph
    // shares the language label's vertical centre.
    for (const button of document.querySelectorAll<HTMLElement>("[data-agent-copy-code],[data-agent-copy-link]")) {
      const box = button.getBoundingClientRect();
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      report.icons.push({
        where: button.hasAttribute("data-agent-copy-code") ? "code copy" : "link copy",
        dx: +(icon.left + icon.width / 2 - (box.left + box.width / 2)).toFixed(2),
        dy: +(icon.top + icon.height / 2 - (box.top + box.height / 2)).toFixed(2),
      });
    }
    for (const label of document.querySelectorAll<HTMLElement>("[data-agent-code-language]")) {
      const header = label.parentElement!.getBoundingClientRect();
      const icon = label.parentElement!.querySelector("svg")!.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      report.icons.push({
        where: "code header label vs glyph",
        dx: 0,
        dy: +(icon.top + icon.height / 2 - (text.top + text.height / 2)).toFixed(2),
      });
      report.icons.push({
        where: "code header glyph vs header",
        dx: 0,
        dy: +(icon.top + icon.height / 2 - (header.top + header.height / 2)).toFixed(2),
      });
    }

    // The exact baseline: a zero-size inline-block's top edge sits on it.
    const X_HEIGHT = 0.5459; // Inter, as a fraction of the font size
    const textRect = (node: Text, start: number) => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      return range.getBoundingClientRect();
    };
    const baselineOf = (node: Text, start: number) => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      const range = document.createRange();
      range.setStart(node, start + 1);
      range.collapse(true);
      range.insertNode(probe);
      const baseline = probe.getBoundingClientRect().top;
      const parent = probe.parentNode!;
      probe.remove();
      parent.normalize();
      return baseline;
    };
    for (const chip of document.querySelectorAll<HTMLElement>("[data-agent-link-chip]")) {
      const label = chip.querySelector("a .truncate")!.firstChild as Text;
      const after = chip.nextSibling;
      if (!(after instanceof Text) || !after.data.trim()) continue;
      const first = after.data.search(/\S/);
      if (Math.abs(textRect(after, first).top - textRect(label, 0).top) > 12) continue; // wrapped to the next line
      const chipName = label.data;
      const afterBaseline = baselineOf(after, first);
      const labelBaseline = baselineOf(chip.querySelector("a .truncate")!.firstChild as Text, 0);
      report.chipBaselines.push({ chip: chipName, delta: +(labelBaseline - afterBaseline).toFixed(2) });
      report.chipLineHeights.push(chip.parentElement!.getBoundingClientRect().height);
    }
    for (const citation of document.querySelectorAll<HTMLElement>(".agent-md-citation")) {
      const before = citation.previousSibling;
      if (!(before instanceof Text) || !before.data.trim()) continue;
      const size = px(getComputedStyle(citation.parentElement!).fontSize);
      const xMiddle = baselineOf(before, before.data.length - 1) - (X_HEIGHT * size) / 2;
      const pill = citation.firstElementChild!.getBoundingClientRect();
      report.citationCentres.push({
        citation: citation.textContent ?? "",
        delta: +(pill.top + pill.height / 2 - xMiddle).toFixed(2),
      });
    }
    return report;
  });
}

for (const width of [320, 393, 1440]) {
  test(`answers sit on the 4pt grid with symmetric insets at ${width}px`, async ({ page }) => {
    await mount(page, width);
    const report = await measureGrid(page);
    console.log(`grid ${width}px ${JSON.stringify(report)}`);
    expect(report.offGrid, "every padding, margin and gap is a multiple of 4").toEqual([]);
    expect(report.asymmetric, "left and right insets match within 0.5px").toEqual([]);
    expect(report.offRhythm, "every line box sits on the 4px rhythm").toEqual([]);
    for (const icon of report.icons) {
      expect(Math.abs(icon.dx), `${icon.where} centred horizontally`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(icon.dy), `${icon.where} centred vertically`).toBeLessThanOrEqual(0.5);
    }
    expect(report.chipBaselines.length, "at least one chip shares a line with its sentence").toBeGreaterThan(0);
    for (const chip of report.chipBaselines) {
      expect(Math.abs(chip.delta), `${chip.chip} sits on the sentence baseline`).toBeLessThanOrEqual(0.5);
    }
    // A chip never stretches its line: the paragraph stays a whole number of 24px lines.
    for (const height of report.chipLineHeights) {
      expect(height % 24, `a paragraph holding a chip keeps the 24px rhythm (${height}px)`).toBeCloseTo(0, 1);
    }
    expect(report.citationCentres.length).toBe(2);
    for (const citation of report.citationCentres) {
      expect(Math.abs(citation.delta), `citation ${citation.citation} centred on the x-height`).toBeLessThanOrEqual(1);
    }
  });
}

const RENDERS_DIR = process.env.CHAT_FORMATTING_RENDERS_DIR;
const RENDERS_LABEL = process.env.CHAT_FORMATTING_RENDERS_LABEL ?? "after";

for (const [width, theme] of [
  [320, "light"],
  [393, "light"],
  [393, "dark"],
  [1440, "light"],
  [1440, "dark"],
] as const) {
  test(`renders ${width} ${theme}`, async ({ page, browserName }) => {
    test.skip(!RENDERS_DIR || browserName !== "chromium", "design-review renders only");
    await mount(page, width, { theme });
    fs.mkdirSync(RENDERS_DIR!, { recursive: true });
    await page.screenshot({
      path: path.join(RENDERS_DIR!, `${RENDERS_LABEL}-${width}-${theme}.png`),
      fullPage: true,
    });
  });
}
