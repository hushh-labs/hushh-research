import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../components/app-ui/signed-in-shell-content-offset";

/** Production Wallet with inert service boundaries: entry artwork/CTA fit, Location
 * header parity after Continue, collection motion/geometry, and direct Add flow. */

const ISO_RATIO = 85.6 / 53.98;
const BOTTOM_SHELL_HEIGHT_PX = 132;

const BOUNDARY_MODULES = [
  "next/navigation",
  "@/hooks/use-auth",
  "@/lib/vault/vault-context",
  "@/lib/services/wallet-service",
  "@/lib/services/consent-center-service",
  "@/lib/consent/use-consent-actions",
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
  walletHero = fs.readFileSync(path.join(root, "public/wallet/wallet-cards-hero.webp"));
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
    if (assetPath === "/wallet/wallet-cards-hero.webp") {
      await route.fulfill({ body: walletHero, contentType: "image/webp" });
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

async function mount(page: Page, enter = true) {
  await page.addScriptTag({ content: script });
  await expect(page.locator("#root")).not.toBeEmpty();
  const next = page.getByRole("button", { name: "Continue", exact: true });
  if (enter) { await expect(next).toBeVisible(); await next.click(); }
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
    await mount(page, false);
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
  test(`Cards collection contains ${count} cards at ${width}px without overlapping its actions`, async ({ page }) => {
    const errors = await open(page, width, "light", { cards: count }, { height: 844, shell: true });
    await mount(page);
    const collection = page.getByTestId(count ? "wallet-add-collection" : "wallet-preview-collection");
    await expect(collection).toBeVisible();
    await expect.poll(() => page.evaluate(() => Math.abs(
      document.querySelector("#top-shell-wallet-panel-cards")!.getBoundingClientRect().x -
      document.querySelector('[data-swipe-views-root="true"]')!.getBoundingClientRect().x
    ))).toBeLessThan(1);
    await expect.poll(() => collection.evaluate((el) => el.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" && !((animation.effect as KeyframeEffect)?.target as Element | null)?.closest("[data-wallet-swipe-hint]")).length)).toBe(0);
    const add = page.getByTestId("wallet-card-browser").getByRole("button", { name: count ? "Add another card" : "Add your first card", exact: true });
    if (count) {
      const stack = page.getByTestId("wallet-add-stack");
      const layers = stack.locator("li:not([inert])");
      await expect(layers).toHaveCount(count);
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
        await page.locator("[data-app-scroll-root]").evaluate(root => {
          const stack = root.querySelector('[data-testid="wallet-add-stack"]')!;
          root.scrollTop += stack.getBoundingClientRect().top - root.getBoundingClientRect().top + 350;
        });
        await expect(layers).toHaveCount(count);
        if (await page.getByRole("button", { name: "View all 3 cards", exact: true }).count()) await page.getByRole("button", { name: "View all 3 cards", exact: true }).click();
  await expect(stack).toHaveAttribute("data-expanded", "true");
        const last = stack.locator("li").last().getByRole("button").first();
        await last.click();
        await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
        await page.getByRole("button", { name: "All cards", exact: true }).click();
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await stack.locator("li").first().evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
    } else {
      await expect(page.getByTestId("wallet-add-stack")).toHaveCount(0);
      await expect(page.getByTestId("wallet-preview-collection")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("empty-add-preview.png") });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await add.click();
    await expect(page.getByTestId("secure-card-add-form")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("Wallet tabs preserve a draft and cancel to the Cards collection", async ({ page }) => {
  const errors = await open(page, 393, "light");
  await mount(page);
  await expect(page.getByTestId("wallet-add-layer-4242")).toBeVisible();
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("secure-card-add-form")).toBeVisible();
  await page.getByLabel("Nickname", { exact: true }).fill("Travel");
  await page.getByRole("tab", { name: "Cards", exact: true }).click();
  await expect(page.getByTestId("wallet-add-layer-4242")).toBeVisible();
  await expect(page.getByTestId("secure-card-add-form")).not.toBeInViewport();
  await expect(page.locator("#top-shell-wallet-panel-add")).toHaveAttribute("inert", "");
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Nickname", { exact: true })).toHaveValue("Travel");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wallet-add-collection")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Wallet Add scrolls in the page and swipes back to Cards without a tall blank tail", async ({ page }) => {
  await open(page, 393, "light", {}, { height: 667, shell: true });
  await mount(page);
  await expect(page.getByTestId("wallet-add-layer-4242")).toBeInViewport();
  const scroll = page.locator('[data-app-scroll-root="true"]');
  const cardsOverflow = await scroll.evaluate((el) => el.scrollHeight - el.clientHeight);
  await page.getByRole("tab", { name: "Add", exact: true }).click();
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
  await expect(page.getByTestId("wallet-add-layer-4242")).toBeInViewport();
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(cardsOverflow + 1);
});


for (const [width, height] of [[320, 667], [390, 844], [714, 668], [1440, 900]]) {
  test(`Wallet introduction fits image and Continue at ${width}x${height}`, async ({ page }) => {
    const errors = await open(page, width!, "light", { cards: 0 }, { height, shell: true });
    await mount(page, false);
    await expect(page.getByRole("heading", { name: "Wallet", exact: true })).toHaveCount(0);
    const image = page.getByTestId("one-wallet-empty-art").locator("img");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("loading", "eager");
    await expect(image).toHaveAttribute("fetchpriority", "high");
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
    const next = page.getByRole("button", { name: "Continue", exact: true });
    await expect(next).toBeInViewport();
    expect((await next.boundingBox())!.y + (await next.boundingBox())!.height).toBeLessThan(height! - BOTTOM_SHELL_HEIGHT_PX);
    await page.screenshot({ path: test.info().outputPath("wallet-introduction.png") });
    await next.click();
    await expect(page.getByRole("heading", { name: "Wallet", exact: true })).toBeVisible();
    await expect(page.getByTestId("wallet-preview-collection")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390, 1024]) {
  test(`video card browser switches and clears chrome at ${width}px`, async ({ page }, testInfo) => {
    const errors = await open(page, width, "light", { cards: 0 }, { height: 844, shell: true });
    await mount(page, false);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const dock = page.getByTestId("wallet-card-switcher");
    await expect(dock).toBeVisible();
    await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "all");
    await expect(page.getByTestId("wallet-preview-stack")).toHaveAttribute("data-unfolded", "false");
    const geometry = () => dock.evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      top: element.getBoundingClientRect().top,
      chrome: document.querySelector('[data-bottom-chrome]')!.getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    let bounds = await geometry();
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.chrome);
    expect(bounds.top).toBeGreaterThan(0);
    expect(bounds.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("cards-overview.png") });
    await dock.getByRole("button", { name: "Open Travel, ending 4444" }).click();
    await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "card");
    await expect(page.getByTestId("wallet-demo-details")).toContainText("Travel card");
    await expect(page.getByTestId("wallet-demo-activity")).toContainText("₹8,640.00");
    await expect(dock.getByRole("button", { name: "Open Travel, ending 4444" })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: testInfo.outputPath("cards-detail.png") });
    await page.getByRole("button", { name: "Payment", exact: true }).first().click();
    await expect(page.getByRole("dialog")).toContainText("No money moves and no payment is scheduled");
    await page.getByRole("button", { name: "Got it", exact: true }).click();
    await page.locator("[data-app-scroll-root]").evaluate((element) => { element.scrollTop = 0; });
    await dock.getByRole("button", { name: "All (3)", exact: true }).click();
    await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "all");
    await expect.poll(() => page.getByTestId("wallet-card-browser").evaluate((element) =>
      element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" && !((animation.effect as KeyframeEffect)?.target as Element | null)?.closest("[data-wallet-swipe-hint]")).length,
    )).toBe(0);
    await page.locator('[data-app-scroll-root]').evaluate((element) => { element.scrollTop = 0; });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId("wallet-card-dock-host")).toHaveAttribute("data-scrolling-down", "false");
    // Finish the programmatic return-to-overview before testing user scroll direction.
    await page.waitForTimeout(400);
    await page.locator('[data-app-scroll-root]').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(page.getByTestId("wallet-card-dock-host")).toHaveAttribute("data-scrolling-down", "true");
    bounds = await geometry();
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.chrome);
    await page.locator("[data-app-scroll-root]").evaluate((element) => { element.scrollTop -= 20; });
    await dock.getByRole("button", { name: "Add a card", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dock).not.toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("video card browser supports reduced motion and dark mode", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, 390, "dark", { cards: 0 }, { height: 844, shell: true });
  await mount(page, false);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const dock = page.getByTestId("wallet-card-switcher");
  await dock.getByRole("button", { name: "Open Everyday, ending 4242" }).click();
  const face = page.locator('[data-testid="wallet-selected-card"] [data-swipe-views-horizontal-scroll]');
  await face.evaluate((element) => {
    const start = new Event("touchstart", { bubbles: true });
    Object.defineProperty(start, "touches", { value: [{ clientX: 280, clientY: 180 }] });
    element.dispatchEvent(start);
    const end = new Event("touchend", { bubbles: true });
    Object.defineProperty(end, "changedTouches", { value: [{ clientX: 100, clientY: 190 }] });
    element.dispatchEvent(end);
  });
  await expect(page.getByTestId("wallet-demo-details")).toContainText("Travel card");
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  const moving = await page.getByTestId("wallet-selected-card").evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" && !((animation.effect as KeyframeEffect)?.target as Element | null)?.closest("[data-wallet-swipe-hint]")).length);
  expect(moving).toBe(0);
});

test("card thumbnail bar stays hidden after scrolling down and returns on scrolling up", async ({ page }) => {
  await open(page, 390, "light", { cards: 0 }, { height: 844, shell: true });
  await mount(page, false);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const dock = page.getByTestId("wallet-card-switcher");
  await expect(dock).toBeVisible();
  const root = page.locator("[data-app-scroll-root]");
  await root.evaluate(async (element) => {
    for (let step = 0; step < 8; step++) {
      element.scrollTop += 8;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  });
  await expect(page.getByTestId("wallet-card-dock-host")).toHaveAttribute("data-scrolling-down", "true");
  await expect(dock).toBeHidden();
  await page.waitForTimeout(250);
  await expect(dock).toBeHidden();
  await root.evaluate((element) => { element.scrollTop -= 20; });
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "Add a card", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
});

for (const width of [320, 393, 1440]) {
  test(`single-screen Add form fits at ${width}px`, async ({ page }) => {
    await open(page, width, "light", {}, { shell: true });
    await mount(page);
    await page.getByRole("tab", { name: "Add", exact: true }).click();
    const form = page.getByTestId("secure-card-add-form");
    await expect(form.getByRole("button", { name: "Scan card", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => {
      const box = await form.boundingBox();
      return Boolean(box && box.x >= 0 && box.x + box.width <= width);
    }).toBe(true);
    for (const label of ["Name on card", "Nickname", "Expiry (MM/YY)", "CVV", "PIN (optional)", "Issuing region"]) {
      await expect(form.getByLabel(label, { exact: true })).toBeAttached();
    }
    await form.getByTestId("secure-card-save").scrollIntoViewIfNeeded();
    await expect(form.getByTestId("secure-card-save")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("typing replaces the card-number placeholder instead of appending to Xs", async ({ page }) => {
  await open(page, 393, "light", {}, { shell: true });
  await mount(page);
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  const input = page.getByTestId("secure-card-pan-input");
  await input.click();
  await input.pressSequentially("4242");
  await expect(input).toHaveValue("4242");
  expect(await input.evaluate((node) => node.matches(":placeholder-shown"))).toBe(false);
  await input.fill("5555 5555 5555 4444");
  await expect(input).toHaveValue("5555555555554444");
  await input.fill("");
  expect(await input.evaluate((node) => node.matches(":placeholder-shown"))).toBe(true);
});

for (const width of [320, 390, 1440]) {
  test(`Wallet Sharing keeps requests and grants reachable at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", { cards: 3 }, { height: 844, shell: true });
    await mount(page);
    await expect(page.getByTestId("wallet-card-face").first()).toBeVisible();
    await page.getByRole("tab", { name: "Sharing", exact: true }).click();
    await expect.poll(() => page.evaluate(() => Math.abs(
      document.querySelector("#top-shell-wallet-panel-sharing")!.getBoundingClientRect().x -
      document.querySelector('[data-swipe-views-root="true"]')!.getBoundingClientRect().x
    ))).toBeLessThan(2);
    const sharing = page.getByTestId("wallet-sharing-content");
    await expect(sharing.getByText("Sample requester")).toHaveCount(0);
    await expect(sharing.getByText("Sample recipient")).toBeVisible();
    await expect(sharing.getByRole("button", { name: "Manage" })).toBeVisible();
    await sharing.getByRole("button", { name: "Manage" }).click();
    await expect(page.getByRole("dialog", { name: "Manage access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect.poll(() => sharing.evaluate((el) => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
    await page.locator('[data-app-scroll-root="true"]').evaluate((el) => { el.scrollTop = 0; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("wallet-sharing.png") });
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 820, 1440]) {
  test(`Wallet Mail-style panels align with tabs at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, width, "light", { cards: 3 }, { shell: true });
    await mount(page);
    await expect(page.getByTestId("wallet-card-face").first()).toBeVisible();
    for (const [tab, selector] of [["Cards", '[data-testid="wallet-card-browser"]'], ["Add", '[data-testid="secure-card-add-form"]'], ["Sharing", '[data-testid="wallet-sharing-content"] > section:first-child']] as const) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const panel = page.locator(selector);
      await expect(panel).toBeVisible();
      await expect.poll(async () => page.evaluate((target) => {
        const box = document.querySelector(target)!.getBoundingClientRect();
        const tabs = document.querySelector('[role="tablist"]')!.getBoundingClientRect();
        return Math.max(Math.abs(box.left - tabs.left), Math.abs(box.right - tabs.right));
      }, selector)).toBeLessThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 1440) {
        const heading = panel.locator('h2').first();
        await expect(heading).toHaveClass(/ui-text-section-title/);
        await expect(panel).toHaveCSS('background-image', 'none');
      }
      await page.screenshot({ path: test.info().outputPath(`wallet-${tab.toLowerCase()}-mail-style.png`) });
    }
  });
}

test("Wallet sharp onboarding and stacked detail links", async ({ page }) => {
  await open(page, 390, "light", { cards: 3 }, { height: 844, shell: true });
  await mount(page, false);
  const intro = page.getByTestId("one-wallet-empty");
  const artwork = intro.locator("img");
  await expect.poll(() => artwork.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  await expect(artwork).toHaveCSS("filter", "none");
  expect(await artwork.getAttribute("style") || "").not.toContain("blur");
  await expect(intro.getByText("Cards you add are encrypted on this device and kept in your vault.")).toHaveCount(0);
  await expect(intro.getByRole("button", { name: "Continue" })).toBeInViewport();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByTestId("wallet-card-face").first()).toBeVisible();
  const scrollRoot = page.locator('[data-app-scroll-root="true"]');

  await expect.poll(() => page.getByTestId("wallet-card-browser").evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation.playState === "running" && !((animation.effect as KeyframeEffect)?.target as Element | null)?.closest("[data-wallet-swipe-hint]")).length)).toBe(0);
  await expect.poll(() => page.locator('[data-swipe-views-root="true"]').evaluate(el => Math.abs(el.getBoundingClientRect().height - document.querySelector('#top-shell-wallet-panel-cards')!.getBoundingClientRect().height))).toBeLessThan(1);
  const max = await scrollRoot.evaluate(el => el.scrollHeight - el.clientHeight);
  let hiddenSeen = false;
  for (let y = 0; y <= max + 180; y += 180) {
    await scrollRoot.evaluate((el, top) => { el.scrollTop = top; }, y);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.locator('[data-stack-details]').evaluateAll(nodes => {
      const visible = nodes.filter(node => getComputedStyle(node).visibility !== "hidden").map(node => node.getBoundingClientRect()).sort((a,b) => a.top - b.top);
      return { hidden: nodes.some(node => getComputedStyle(node).visibility === "hidden"), overlap: visible.some((box,i) => i > 0 && box.top < visible[i-1].bottom - 1) };
    });
    hiddenSeen ||= result.hidden;
    expect(result.overlap).toBe(false);
  }
  expect(hiddenSeen).toBe(true);
  if (await page.getByRole("button", { name: "Collapse cards", exact: true }).count()) await page.getByRole("button", { name: "Collapse cards", exact: true }).click();
  await scrollRoot.evaluate(el => { el.scrollTop = 0; });
  await scrollRoot.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => page.locator('[data-stack-details]').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).visibility !== "hidden"))).toBe(true);
  await page.getByRole("tab", { name: "Sharing", exact: true }).click();
  await expect(page.getByTestId("wallet-sharing-content").locator('figure [data-demo-card="true"]')).toBeVisible();
  await expect(page.getByText("Illustrative card · Your saved details stay private")).toBeVisible();
});
