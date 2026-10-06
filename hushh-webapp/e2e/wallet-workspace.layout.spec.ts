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
  if (enter && await next.count()) await next.click();
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
  test(`Cards collection contains ${count} cards at ${width}px without overlapping its actions`, async ({ page }) => {
    const errors = await open(page, width, "light", { cards: count }, { height: 844, shell: true });
    await mount(page);
    const collection = page.getByTestId("wallet-add-collection");
    await expect(collection).toBeVisible();
    await expect.poll(() => page.evaluate(() => Math.abs(
      document.querySelector("#top-shell-wallet-panel-cards")!.getBoundingClientRect().x -
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
    await expect(page.getByTestId("wallet-add-preview")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("collapsed collection releases expanded scroll space", async ({ page }) => {
  await open(page, 390, "light", { cards: 0 }, { height: 844, shell: true });
  await mount(page);
  const next = page.getByRole("button", { name: "Continue", exact: true });
  if (await next.count()) await next.click();
  const preview = page.getByTestId("wallet-add-preview");
  if (!(await preview.isVisible())) {
    await page.getByRole("tab", { name: "Add", exact: true }).click();
  }
  await expect(preview).toBeVisible();
  const pager = page.locator('[data-swipe-views-root="true"]');
  const settleCards = async () => {
    await expect.poll(() => preview.evaluate((element) =>
      element.getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running").length,
    )).toBe(0);
  };
  await settleCards();
  const height = await pager.evaluate((element) => element.getBoundingClientRect().height);
  await preview.getByRole("button", { name: "View all 3 cards" }).click();
  await settleCards();
  await expect.poll(() => pager.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(height + 100);
  await preview.getByRole("button", { name: "Collapse cards", exact: true }).click();
  await expect(page.getByTestId("wallet-preview-stack")).toHaveAttribute("data-expanded", "false");
  await settleCards();
  await expect.poll(() => pager.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThanOrEqual(height + 1);
  await expect.poll(() => preview.evaluate((element) => {
    const panel = element.closest('[role="tabpanel"]')!;
    const root = element.closest('[data-swipe-views-root="true"]')!;
    return Math.abs(root.getBoundingClientRect().height - panel.getBoundingClientRect().height);
  })).toBeLessThan(1);
});
