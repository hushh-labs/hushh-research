import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../components/app-ui/signed-in-shell-content-offset";

/** Real Wallet components with synthetic service boundaries; no owner vault information. */
const WIDTHS = [320, 393, 1440] as const;
const ISO_RATIO = 85.6 / 53.98;
const THEMES = ["light", "dark"] as const;
const BOTTOM_SHELL_HEIGHT_PX = 132;

const BOUNDARY_MODULES = [
  "next/navigation",
  "@/hooks/use-auth",
  "@/lib/vault/vault-context",
  "@/lib/services/wallet-service",
  "@/lib/pkm/secrets-vault-service",
  "@/lib/observability/client",
  "@/components/app-ui/native-test-beacon",
  "@/components/vault/vault-unlock-dialog",
];

let css = "";
let script = "";
let walletHero: Buffer;

test.beforeAll(async () => {
  const root = process.cwd();
  walletHero = fs.readFileSync(path.join(root, "public/wallet/wallet-cards-hero.png"));
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-workspace-"));
  try {
    await build({
      configFile: false,
      logLevel: "error",
      publicDir: false,
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
          ...BOUNDARY_MODULES.map((find) => ({
            find,
            replacement: path.join(root, "e2e/fixtures/wallet-workspace-boundaries.tsx"),
          })),
          { find: "@", replacement: root },
        ],
      },
      define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      build: {
        outDir,
        emptyOutDir: false,
        lib: {
          entry: path.join(root, "e2e/fixtures/wallet-workspace.tsx"),
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
      fs
        .readdirSync(outDir)
        .filter((name) => name.endsWith(".css"))
        .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
        .join("\n");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

type Scenario = { cards?: number; locked?: boolean; delayMs?: number };

const PROBES = `
window.__walletFrames = [];
window.__walletCls = 0;
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__walletCls += entry.value;
  }).observe({ type: "layout-shift", buffered: true });
} catch {}
window.__sampleWallet = (ms) => {
  const start = performance.now();
  window.__walletFrames = [];
  const rect = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const step = () => {
    const cards = [...document.querySelectorAll('[data-testid="wallet-card"]')].map((li) => {
      const transform = getComputedStyle(li).transform;
      const y = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
      return { y, o: Number(getComputedStyle(li).opacity) };
    });
    window.__walletFrames.push({
      t: performance.now() - start,
      title: rect('[data-slot="wallet-heading-line"]'),
      introduction: rect('[data-testid="one-wallet-loading"]'),
      face: rect('[data-testid="wallet-card-face"]'),
      cards,
    });
    if (performance.now() - start < ms) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
`;

type FixtureOptions = { height?: number; shell?: boolean };

function inlineStyle(style: Record<string, unknown>): string {
  return Object.entries(style)
    .map(([name, value]) => `${name}: ${String(value)};`)
    .join(" ");
}

function shellMarkup(): string {
  const offset = resolveSignedInShellContentOffset({
    shellVisible: true,
    routeLayoutMode: "standard",
    localOffset: "0px",
  });
  const shellStyle = inlineStyle({
    ...offset.style,
    ...resolveTopShellGeometryStyle({ hasTabs: false }),
    "--app-bottom-shell-height": `${BOTTOM_SHELL_HEIGHT_PX}px`,
    "--bottom-chrome-stack-height": "var(--app-bottom-shell-height)",
    "--app-scroll-bottom-pad": "var(--bottom-chrome-stack-height)",
  });

  return `<div data-app-shell-root="true" style="${shellStyle}; position: fixed; inset: 0; display: flex; flex-direction: column;">
    <div
      data-app-scroll-root="true"
      style="flex: 1 1 0%; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-bottom: var(--app-scroll-bottom-pad);"
    >
      <div data-app-shell-top-spacer="true" aria-hidden></div>
      <div data-app-shell-content="true" style="min-height: 0;"><div id="root"></div></div>
    </div>
    <div
      data-bottom-chrome
      style="position: fixed; inset-inline: 0; bottom: 0; height: var(--bottom-chrome-stack-height);"
    ></div>
  </div>`;
}

async function open(
  page: Page,
  width: number,
  theme: string,
  scenario: Scenario = {},
  options: FixtureOptions = {},
) {
  const { height = 852, shell = false } = options;
  await page.setViewportSize({ width, height });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://wallet-fixture.local/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const assetPath = requestUrl.searchParams.get("url") ?? requestUrl.pathname;
    if (assetPath === "/wallet/wallet-cards-hero.png") {
      await route.fulfill({ body: walletHero, contentType: "image/png" });
      return;
    }
    await route.abort();
  });
  const fixture = shell ? shellMarkup() : '<div id="root"></div>';
  await page.setContent(
    `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><base href="http://wallet-fixture.local/"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" data-ambient-chrome-primed="true" style="margin:0">${fixture}</body></html>`,
  );
  await awaitProductFont(page);
  await page.addScriptTag({ content: `window.__walletScenario = ${JSON.stringify(scenario)};${PROBES}` });
  return errors;
}

async function mount(page: Page) {
  await page.addScriptTag({ content: script });
}

for (const width of [320, 393, 1440]) {
  test(`Wallet matches Location header and tab geometry at ${width}px`, async ({ page }) => {
    const source = fs.readFileSync(path.join(process.cwd(), "components/one-location/redesign/location-redesign-hub.tsx"), "utf8");
    const hubClass = source.match(/data-location-hub\s+className="([^"]+)"/)?.[1];
    const headerClass = source.slice(source.indexOf('title="Location"')).match(/className="([^"]+)"/)?.[1];
    expect(hubClass).toBeTruthy();
    expect(headerClass).toBeTruthy();
    const geometry = () => page.evaluate(() => {
      const title = document.querySelector("h1")!;
      const header = document.querySelector('[data-slot="page-header"]')!;
      const tabs = document.querySelector('[role="tablist"]')!;
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return { header: box(header), tabs: box(tabs), titleY: box(title).y,
        titleSize: getComputedStyle(title).fontSize,
        tabWidths: Array.from(tabs.children).filter((el) => el.getAttribute("role") === "tab").map((el) => box(el).width) };
    });
    await open(page, width, "light", {}, { shell: true });
    await mount(page);
    await expect(page.getByRole("tab", { name: "Cards", exact: true })).toBeEnabled();
    const wallet = await geometry();
    await open(page, width, "light", {}, { shell: true });
    await page.addScriptTag({ content: `window.__locationReference=${JSON.stringify({ hubClass, headerClass })}` });
    await mount(page);
    await expect(page.getByRole("heading", { name: "Location", exact: true })).toBeVisible();
    const location = await geometry();
    for (const part of ["header", "tabs"] as const) {
      for (const coordinate of ["x", "y", "width", "height"] as const) {
        expect(Math.abs(wallet[part][coordinate] - location[part][coordinate]), `${part}.${coordinate}`).toBeLessThanOrEqual(0.5);
      }
    }
    expect(wallet.titleSize).toBe(location.titleSize);
    expect(Math.abs(wallet.titleY - location.titleY)).toBeLessThanOrEqual(0.5);
    expect(wallet.tabWidths).toEqual(location.tabWidths);
  });
}

for (const [width, count] of [[320, 10], [375, 10], [390, 10], [430, 10], [1440, 10], [390, 0], [390, 1], [390, 2], [390, 3], [390, 5]]) {
  test(`Add collection contains ${count} cards at ${width}px without overlapping its actions`, async ({ page }) => {
    const errors = await open(page, width, "light", { cards: count }, { height: 844, shell: true });
    await mount(page);
    await page.getByRole("tab", { name: "Add", exact: true }).click();
    const collection = page.getByTestId("wallet-add-collection");
    await expect(collection).toBeVisible();
    await expect.poll(() => page.evaluate(() => Math.abs(
      document.querySelector("#top-shell-wallet-panel-add")!.getBoundingClientRect().x -
      document.querySelector('[data-swipe-views-root="true"]')!.getBoundingClientRect().x
    ))).toBeLessThan(1);
    await expect.poll(() => collection.evaluate((el) => el.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
    const add = collection.getByRole("button", { name: count ? "Add another card" : "Add your first card", exact: true });
    if (count) {
      const stack = page.getByTestId("wallet-add-stack");
      const layers = stack.locator("li:not([inert])");
      await expect(layers).toHaveCount(Math.min(count, 4));
      const geometry = await stack.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const faces = [...el.querySelectorAll('li:not([inert]) [data-testid="wallet-card-face"]')].map((face) => {
          const r = face.getBoundingClientRect();
          return { x: r.x, right: r.right, bottom: r.bottom, ratio: r.width / r.height };
        });
        return { x: box.x, right: box.right, bottom: box.bottom, width: box.width, faces };
      });
      expect(geometry.width).toBeLessThanOrEqual(420);
      for (const face of geometry.faces) {
        expect(face.x).toBeGreaterThanOrEqual(geometry.x - 1);
        expect(face.right).toBeLessThanOrEqual(geometry.right + 1);
        expect(face.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
        expect(Math.abs(face.ratio - ISO_RATIO)).toBeLessThan(0.01);
      }
      expect((await add.boundingBox())!.y).toBeGreaterThan(geometry.bottom);
      if (width === 390 && count === 3) await page.screenshot({ path: test.info().outputPath("add-collection.png") });
      if (count > 1) {
        await collection.getByRole("button", { name: `View all ${count} cards` }).click();
        await expect(layers).toHaveCount(count);
        await expect(stack).toHaveAttribute("data-expanded", "true");
        const last = stack.locator("li").last().getByRole("button");
        await last.click();
        await expect(last).toHaveAttribute("aria-pressed", "true");
        await expect(stack).toHaveAttribute("data-expanded", "false");
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await stack.locator("li").first().evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
    } else {
      await expect(page.getByTestId("wallet-add-stack")).toHaveCount(0);
      await expect(page.getByTestId("wallet-add-preview")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("empty-add-preview.png") });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await add.click();
    await expect(page.getByTestId("secure-card-add-form")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("Wallet tabs preserve a draft and cancel to the Add collection", async ({ page }) => {
  const errors = await open(page, 393, "light");
  await mount(page);
  await expect(page.getByTestId("one-wallet-card-4242")).toBeVisible();
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add another card", exact: true }).click();
  await expect(page.getByTestId("secure-card-add-form")).toBeVisible();
  await page.getByLabel("Nickname", { exact: true }).fill("Travel");
  await page.getByRole("tab", { name: "Cards", exact: true }).click();
  await expect(page.getByTestId("one-wallet-card-4242")).toBeVisible();
  await expect(page.getByTestId("secure-card-add-form")).not.toBeInViewport();
  await expect(page.locator("#top-shell-wallet-panel-add")).toHaveAttribute("inert", "");
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Nickname", { exact: true })).toHaveValue("Travel");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wallet-add-collection")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Wallet Add scrolls in the page and swipes back to Cards without a tall blank tail", async ({ page }) => {
  await open(page, 393, "light", {}, { height: 667, shell: true });
  await mount(page);
  await expect(page.getByTestId("one-wallet-card-4242")).toBeInViewport();
  const scroll = page.locator('[data-app-scroll-root="true"]');
  const cardsOverflow = await scroll.evaluate((el) => el.scrollHeight - el.clientHeight);
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add another card", exact: true }).click();
  await expect(page.getByTestId("secure-card-add-form")).toBeInViewport();
  await expect.poll(() => page.evaluate(() => {
    const panel = document.querySelector("#top-shell-wallet-panel-add")!;
    const pager = document.querySelector('[data-swipe-views-root="true"]')!;
    return pager.clientHeight >= panel.scrollHeight;
  })).toBe(true);
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByTestId("secure-card-save")).toBeInViewport();
  const formScrollers = await page.getByTestId("secure-card-add-form").evaluate((form) =>
    [form, ...Array.from(form.querySelectorAll("*"))].filter((el) =>
      /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1
    ).length);
  expect(formScrollers).toBe(0);
  await scroll.evaluate((el) => { el.scrollTop = 0; });
  const panel = await page.locator("#top-shell-wallet-panel-add").boundingBox();
  if (!panel) throw new Error("Add panel is missing");
  await page.mouse.move(35, panel.y + 8);
  await page.mouse.down();
  await page.mouse.move(350, panel.y + 8, { steps: 20 });
  await page.mouse.up();
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("one-wallet-card-4242")).toBeInViewport();
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(cardsOverflow + 1);
});

/** Everything the geometry contract reads, in one pass. */
async function measure(page: Page) {
  return page.evaluate(() => {
    // Tailwind v4 emits oklab() and color() values; let the engine resolve
    // any CSS colour to sRGB through a canvas instead of parsing text.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const parse = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r: r!, g: g!, b: b!, a: a! / 255 };
    };
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: { r: number; g: number; b: number }) =>
      0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    const column = document.querySelector('[data-testid="one-wallet-workspace"]')!.getBoundingClientRect();
    const title = document.querySelector('[data-slot="wallet-heading-line"]')!.getBoundingClientRect();
    const action = document.querySelector('[data-slot="wallet-header-action"]')!.getBoundingClientRect();
    const stack = document.querySelector('[data-testid="wallet-stack"]')?.getBoundingClientRect() ?? null;
    const faces = [...document.querySelectorAll<HTMLElement>('[data-testid="wallet-card-face"]')].map((face) => {
      const box = face.getBoundingClientRect();
      const part = (slot: string) => face.querySelector(`[data-slot="${slot}"]`)!.getBoundingClientRect();
      const top = part("wallet-card-top");
      const number = part("wallet-card-number");
      const bottom = part("wallet-card-bottom");
      const background = parse(getComputedStyle(face).backgroundColor);
      let minContrast = Infinity;
      const outside: string[] = [];
      for (const el of face.querySelectorAll<HTMLElement>("span")) {
        if (el.classList.contains("sr-only")) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
        if (!own) continue;
        const fg = parse(getComputedStyle(el).color);
        const blended = {
          r: fg.r * fg.a + background.r * (1 - fg.a),
          g: fg.g * fg.a + background.g * (1 - fg.a),
          b: fg.b * fg.a + background.b * (1 - fg.a),
        };
        const [hi, lo] = [luminance(blended), luminance(background)].sort((a, b) => b - a);
        minContrast = Math.min(minContrast, (hi! + 0.05) / (lo! + 0.05));
        const r = el.getBoundingClientRect();
        if (r.left < box.left + 20 - 0.5 || r.right > box.right - 20 + 0.5) outside.push(el.textContent!);
      }
      return {
        x: box.left,
        y: box.top,
        w: box.width,
        h: box.height,
        insetTop: top.top - box.top,
        insetLeft: top.left - box.left,
        insetRight: box.right - top.right,
        insetBottom: box.bottom - bottom.bottom,
        numberLeft: number.left - box.left,
        numberHeight: number.height,
        minContrast,
        outside,
      };
    });
    const cardTops = [...document.querySelectorAll('[data-testid="wallet-card"]')].map(
      (li) => li.getBoundingClientRect().top,
    );
    const smallTargets = [...document.querySelectorAll<HTMLElement>('[data-testid="one-wallet-workspace"] button, [data-slot="wallet-header-action"] button')]
      // Module tabs use Location's shared compact 36px strip; card actions
      // retain their separate 44px touch target contract.
      .filter((el) => el.getAttribute("role") !== "tab")
      .filter((el) => el.getBoundingClientRect().width > 0)
      .filter((el) => el.getBoundingClientRect().height < 44 - 0.5)
      .map((el) => el.textContent);
    return {
      column: { x: column.left, w: column.width },
      titleLeft: title.left,
      titleMid: title.top + title.height / 2,
      actionMid: action.top + action.height / 2,
      stack: stack && { y: stack.top, h: stack.height },
      faces,
      cardTops,
      smallTargets,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

type Geometry = Awaited<ReturnType<typeof measure>>;

function assertGeometry(g: Geometry, label: string, count: number) {
  expect(g.overflowX, `${label}: page overflow`).toBeLessThanOrEqual(0);
  expect(Math.abs(g.titleMid - g.actionMid)).toBeLessThanOrEqual(.5);
  expect(g.smallTargets).toEqual([]);
  expect(g.faces).toHaveLength(count);
  for (const face of g.faces) {
    expect(Math.abs(face.w / face.h / ISO_RATIO - 1)).toBeLessThanOrEqual(.005);
    expect(Math.abs(face.x + face.w / 2 - g.column.x - g.column.w / 2)).toBeLessThanOrEqual(.5);
    expect(face.w).toBeLessThanOrEqual(420);
    expect(face.minContrast).toBeGreaterThanOrEqual(4.5);
    expect(face.numberHeight).toBeLessThanOrEqual(22.5);
  }
}

const WIDENED = `
[data-testid="wallet-card-face"] span,
[data-slot="page-header"] *,
[data-testid="one-wallet-workspace"] button { letter-spacing: 0.3px !important; }
`;

for (const width of [320, 375, 390, 430, 1440]) {
  for (const count of [1, 2, 3, 7]) {
    test(`Cards deck at ${width}px with ${count} cards selects and expands safely`, async ({ page }) => {
      const errors = await open(page, width, "light", { cards: count }, { shell: true });
      await mount(page);
      await expect(page.getByTestId("wallet-stack")).toBeVisible();
      assertGeometry(await measure(page), `${width}`, count);
      expect(await page.locator('[data-testid="wallet-card"]:not([inert])').count()).toBe(Math.min(4, count));
      if (count > 1) {
        await page.getByRole("button", { name: "Next card", exact: true }).click();
        await expect(page.locator('[data-testid="wallet-card"][data-card-id="card_b"]')).toHaveAttribute("data-focused", "true");
        await page.getByRole("button", { name: "View all cards", exact: true }).click();
        await expect(page.getByTestId("wallet-stack")).toHaveAttribute("data-state", "expanded");
        await page.waitForTimeout(400);
        expect(await page.locator('[data-testid="wallet-card"]:not([inert])').count()).toBe(count);
        const target = page.getByTestId("one-wallet-card-4242").first();
        await target.evaluate((node) => node.scrollIntoView({ block: "center" }));
        // A two-card feed can fit entirely without scrolling; selection then
        // stays deliberate. Longer feeds exercise observer-driven focus.
        if (count >= 3) await expect(page.locator('[data-testid="wallet-card"][data-card-id="card_a"]')).toHaveAttribute("data-focused", "true");
        await target.click();
        await expect(page.getByTestId("wallet-stack")).toHaveAttribute("data-state", "collapsed");
        await page.getByRole("button", { name: "View all cards", exact: true }).click();
        await page.getByRole("button", { name: "Collapse cards", exact: true }).click();
        await expect(page.getByTestId("wallet-stack")).toHaveAttribute("data-state", "collapsed");
      }
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => (window.__walletEvents ?? []).filter((event) => event.startsWith("reveal:")))).toEqual([]);
      await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const chrome = page.locator('[data-bottom-chrome]');
      expect(await chrome.evaluate((el) => { const box = el.getBoundingClientRect(); return document.elementFromPoint(box.x + 10, box.bottom - 10) === el; })).toBe(true);
      if (width === 390 && count === 3) {
        await page.locator('[data-app-scroll-root="true"]').evaluate((node) => { node.scrollTop = 0; });
        await page.screenshot({ path: test.info().outputPath("cards-deck.png") });
      }
      expect(errors).toEqual([]);
    });
  }
}

for (const theme of THEMES) {
  test(`Cards contrast and wider text in ${theme}`, async ({ page }) => {
    await open(page, 320, theme, { cards: 4 });
    await mount(page);
    await expect(page.getByTestId("wallet-stack")).toBeVisible();
    await page.addStyleTag({ content: WIDENED });
    assertGeometry(await measure(page), theme, 4);
  });
}

test("Cards touch gestures preserve vertical scroll and never switch Wallet tabs", async ({ page, browserName }) => {
  const errors = await open(page, 390, "light", { cards: 3 }, { shell: true });
  await mount(page);
  const face = page.getByTestId("one-wallet-card-4242");
  await expect(face).toBeVisible();
  const gesture = async (dx: number, dy: number) => {
    const box = (await page.locator('[data-testid="wallet-card"][data-focused="true"] button').boundingBox())!;
    const x = box.x + box.width * .65, y = box.y + box.height / 2;
    if (browserName === "chromium") {
      const session = await page.context().newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 5; step++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 5, y: y + dy * step / 5 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await session.detach();
    } else {
      await page.locator('[data-testid="wallet-card"][data-focused="true"] button').evaluate((node, delta) => {
        const send = (type: string, x: number, y: number) => {
          const event = new Event(type, { bubbles: true });
          Object.defineProperties(event, {
            touches: { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] },
            changedTouches: { value: [{ clientX: x, clientY: y }] },
          });
          node.dispatchEvent(event);
        };
        send("touchstart", 200, 250);
        send("touchmove", 200 + delta.dx, 250 + delta.dy);
        send("touchend", 200 + delta.dx, 250 + delta.dy);
      }, { dx, dy });
    }
  };
  await gesture(-100, 5);
  await expect(page.locator('[data-testid="wallet-card"][data-card-id="card_b"]')).toHaveAttribute("data-focused", "true");
  await page.waitForTimeout(400);
  await gesture(100, 5);
  await expect(page.locator('[data-testid="wallet-card"][data-card-id="card_a"]')).toHaveAttribute("data-focused", "true");
  await page.waitForTimeout(400);
  await gesture(4, -80);
  await expect(page.locator('[data-testid="wallet-card"][data-card-id="card_a"]')).toHaveAttribute("data-focused", "true");
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("Cards search, secure reveal, removal and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = await open(page, 390, "dark", { cards: 7 }, { shell: true });
  await mount(page);
  await page.getByRole("button", { name: "Search cards", exact: true }).click();
  await page.getByTestId("one-wallet-search").fill("Travel");
  await page.getByRole("list", { name: "Card search results" }).getByRole("button", { name: /Travel/ }).click();
  await expect(page.getByTestId("one-wallet-search")).toHaveCount(0);
  const selected = page.locator('[data-testid="wallet-card"][data-card-id="card_b"]');
  await expect(selected).toHaveAttribute("data-focused", "true");
  expect(await selected.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
  await page.getByTestId("one-wallet-reveal-0005").click();
  await expect(page.getByTestId("secure-card-reveal")).toBeVisible();
  await expect(page.getByTestId("secure-card-reveal-pan")).toContainText("3782");
  const attributes = await page.locator('[aria-label], [id]').evaluateAll((nodes) => nodes.map((node) => `${node.id} ${node.getAttribute("aria-label")}`).join(" "));
  expect(attributes).not.toContain("378282246310005");
  await page.getByRole("button", { name: "Next card", exact: true }).click();
  await expect(page.getByTestId("secure-card-reveal")).toHaveCount(0);
  await page.getByTestId("one-wallet-remove").click();
  await page.getByTestId("one-wallet-remove-cancel").click();
  expect(await page.evaluate(() => window.__walletEvents)).not.toContain("delete:card_c");
  await page.getByTestId("one-wallet-remove").click();
  await page.getByTestId("one-wallet-remove-confirm-action").click();
  await expect(page.locator('[data-testid="wallet-card"][data-card-id="card_c"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="wallet-card"][data-card-id="card_d"]')).toHaveAttribute("data-focused", "true");
  expect(errors).toEqual([]);
});

for (const theme of THEMES) {
  test(`the locked Wallet keeps the card's shape at 393px ${theme}`, async ({ page }) => {
    await open(page, 393, theme, { locked: true });
    await mount(page);
    const state = page.getByTestId("one-wallet-locked");
    await expect(state).toBeVisible();
    const frame = await state.locator(".aspect-\\[85\\.6\\/53\\.98\\]").boundingBox();
    expect(Math.abs(frame!.width / frame!.height / ISO_RATIO - 1)).toBeLessThanOrEqual(0.005);
    expect((await state.getByRole("button").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // A locked vault never shows a card, masked or otherwise.
    await expect(page.getByTestId("wallet-stack")).toHaveCount(0);
    await expect(page.getByTestId("secure-card-reveal")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test(`the empty Wallet hero matches its responsive layout at ${width}px ${theme}`, async ({ page }) => {
      const errors = await open(page, width, theme, { cards: 0 });
      await mount(page);

      const state = page.getByTestId("one-wallet-empty");
      const art = page.getByTestId("one-wallet-empty-art");
      const title = page.getByTestId("one-wallet-empty-display-title");
      const subtitle = state.getByText(
        "Cards you add are encrypted on this device and kept in your vault.",
      );
      const action = page.getByTestId("one-wallet-empty-action");

      await expect(state).toBeVisible();
      await expect(art).toBeVisible();
      await expect(title).toBeVisible();
      await expect(title).toHaveClass(/\bui-text-page-title\b/);
      await expect(subtitle).toBeVisible();
      await expect(action).toHaveText("Add a Card");

      const geometry = await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        const typography = (selector: string) => {
          const style = getComputedStyle(document.querySelector(selector)!);
          return {
            family: style.fontFamily,
            size: style.fontSize,
            lineHeight: style.lineHeight,
            weight: style.fontWeight,
          };
        };
        const titleElement = document.querySelector<HTMLElement>('[data-testid="one-wallet-empty-display-title"]')!;
        const titleLines = [...titleElement.querySelectorAll<HTMLElement>("span")].map((span) => {
          const rect = span.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        });
        return {
          workspace: box('[data-testid="one-wallet-workspace"]'),
          art: box('[data-testid="one-wallet-empty-art"]'),
          image: box('[data-testid="one-wallet-empty-art"] img'),
          imageIntrinsic: {
            width: document.querySelector<HTMLImageElement>('[data-testid="one-wallet-empty-art"] img')!.naturalWidth,
            height: document.querySelector<HTMLImageElement>('[data-testid="one-wallet-empty-art"] img')!.naturalHeight,
          },
          title: box('[data-testid="one-wallet-empty-display-title"]'),
          titleLines,
          titleFits: titleElement.scrollWidth <= titleElement.clientWidth + 1,
          titleTypography: typography('[data-testid="one-wallet-empty-display-title"]'),
          subtitle: box('[data-testid="one-wallet-empty"] .ui-text-page-subtitle'),
          subtitleTypography: typography('[data-testid="one-wallet-empty"] .ui-text-page-subtitle'),
          action: box('[data-testid="one-wallet-empty-action"]'),
          actionTypography: typography('[data-testid="one-wallet-empty-action"]'),
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
        };
      });

      const desktop = width >= 1024;
      const expectedArtHeight = desktop
        ? Math.min(304, Math.max(160, 852 - 33 * 16))
        : Math.min(width * 0.7, 304) / (698 / 894);
      expect(Math.abs(geometry.art.height - expectedArtHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.art.width / geometry.art.height - 698 / 894)).toBeLessThanOrEqual(0.005);
      expect(Math.abs(geometry.image.width / geometry.art.width - 1.7393)).toBeLessThanOrEqual(0.005);
      expect(geometry.imageIntrinsic.width).toBeGreaterThanOrEqual(geometry.image.width);
      expect(
        Math.abs(geometry.imageIntrinsic.width / geometry.imageIntrinsic.height - 1214 / 1295),
      ).toBeLessThanOrEqual(0.005);
      expect(
        Math.abs(geometry.title.y - (geometry.art.y + geometry.art.height) - (desktop ? 24 : 32)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.subtitle.y - (geometry.title.y + geometry.title.height) - (desktop ? 12 : 16)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.action.y - (geometry.subtitle.y + geometry.subtitle.height) - (desktop ? 20 : 28)),
      ).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.action.width - Math.min(geometry.workspace.width, 244))).toBeLessThanOrEqual(0.5);
      expect(geometry.action.height).toBeGreaterThanOrEqual(44);
      expect(geometry.titleLines).toHaveLength(2);
      if (desktop) {
        expect(Math.abs(geometry.titleLines[1]!.top - geometry.titleLines[0]!.top)).toBeLessThanOrEqual(1);
      } else {
        expect(geometry.titleLines[1]!.top - geometry.titleLines[0]!.top).toBeGreaterThan(20);
      }
      expect(geometry.titleFits).toBe(true);
      expect(geometry.titleTypography).toMatchObject({
        size: "28px",
        lineHeight: "34px",
        weight: "700",
      });
      expect(geometry.subtitleTypography).toMatchObject({
        size: "15px",
        lineHeight: "20px",
        weight: "400",
      });
      expect(geometry.actionTypography).toMatchObject({
        size: "17px",
        lineHeight: "22px",
        weight: "600",
      });
      expect(geometry.titleTypography.family).toBe(geometry.subtitleTypography.family);
      expect(geometry.overflowX).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
}

test("the empty Wallet fits one desktop shell viewport", async ({ page }) => {
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1440, height: 852 },
  ]) {
    const errors = await open(page, viewport.width, "light", { cards: 0 }, { ...viewport, shell: true });
    await mount(page);
    await expect(page.getByTestId("one-wallet-empty-action")).toBeVisible();

    const measured = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('[data-app-scroll-root="true"]')!;
      const action = document.querySelector<HTMLElement>('[data-testid="one-wallet-empty-action"]')!;
      const chrome = document.querySelector<HTMLElement>("[data-bottom-chrome]")!;
      return {
        overflow: root.scrollHeight - root.clientHeight,
        actionBottom: action.getBoundingClientRect().bottom,
        chromeTop: chrome.getBoundingClientRect().top,
      };
    });

    expect(measured.overflow, `${viewport.width}x${viewport.height} scroll overflow`).toBeLessThanOrEqual(1);
    expect(measured.actionBottom, `${viewport.width}x${viewport.height} action clears chrome`)
      .toBeLessThanOrEqual(measured.chromeTop + 1);
    expect(errors).toEqual([]);
  }
});

test("the empty Wallet remains reachable in a short phone shell", async ({ page }) => {
  const errors = await open(page, 393, "light", { cards: 0 }, { height: 667, shell: true });
  await mount(page);
  await expect(page.getByTestId("one-wallet-empty-action")).toBeVisible();

  const measured = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-app-scroll-root="true"]')!;
    const action = document.querySelector<HTMLElement>('[data-testid="one-wallet-empty-action"]')!;
    const chrome = document.querySelector<HTMLElement>("[data-bottom-chrome]")!;
    const scrollable = root.scrollHeight > root.clientHeight + 1;
    root.scrollTop = root.scrollHeight;
    return {
      scrollable,
      actionBottom: action.getBoundingClientRect().bottom,
      chromeTop: chrome.getBoundingClientRect().top,
    };
  });

  expect(measured.scrollable).toBe(true);
  expect(measured.actionBottom).toBeLessThanOrEqual(measured.chromeTop + 1);
  expect(errors).toEqual([]);
});
