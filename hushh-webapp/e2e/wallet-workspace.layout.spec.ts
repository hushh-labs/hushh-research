import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEncryptedCardFile } from "../lib/wallet/wallet-card-file";
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
  "@/hooks/use-effective-avatar-url",
  "@/lib/referral/use-referral-stream",
  "@/lib/vault/vault-context",
  "@/lib/services/wallet-service",
  "@/lib/services/wallet-card-share-service",
  "@/lib/services/api-service",
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

type Scenario = { cards?: number; networkCards?: boolean; locked?: boolean; delayMs?: number; artworkGallery?: boolean };

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

type FixtureOptions = { height?: number; shell?: boolean; secure?: boolean; reader?: boolean };

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
  const { height = 852, shell = false, secure = false, reader = false } = options;
  await page.setViewportSize({ width, height });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = secure ? "https://wallet-fixture.test" : "http://wallet-fixture.local";
  await page.route(`${origin}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    const assetPath = requestUrl.searchParams.get("url") ?? requestUrl.pathname;
    if (assetPath === "/wallet/wallet-cards-hero.webp") {
      await route.fulfill({ body: walletHero, contentType: "image/webp" });
      return;
    }
    if (/^\/brand\/cards\/[a-z]+\.(svg|png)$/.test(assetPath)) {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: assetPath.endsWith(".svg") ? "image/svg+xml" : "image/png" });
      return;
    }
    await route.abort();
  });
  const fixture = shell ? shellMarkup() : '<div id="root"></div>';
  const html = `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><base href="${origin}/"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" data-ambient-chrome-primed="true" style="margin:0">${fixture}</body></html>`;
  if (secure) {
    await page.route(`${origin}/`, route => route.fulfill({ body: html, contentType: "text/html" }));
    await page.goto(`${origin}/`);
  } else await page.setContent(html);
  await awaitProductFont(page);
  await page.addScriptTag({ content: `window.__walletScenario = ${JSON.stringify(scenario)};${PROBES}` });
  if (reader) await page.addScriptTag({ content: "window.__encryptedCardReader = true;" });
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
  test(`Cards collection contains three system cards and ${count} payment cards at ${width}px without overlapping its actions`, async ({ page }) => {
    const errors = await open(page, width, "light", { cards: count }, { height: 844, shell: true });
    await mount(page);
    const collection = page.getByTestId("wallet-add-collection");
    await expect(collection).toBeVisible();
    await expect.poll(() => page.evaluate(() => Math.abs(
      document.querySelector("#top-shell-wallet-panel-cards")!.getBoundingClientRect().x -
      document.querySelector('[data-swipe-views-root="true"]')!.getBoundingClientRect().x
    ))).toBeLessThan(1);
    await expect.poll(() => collection.evaluate((el) => el.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" && !((animation.effect as KeyframeEffect)?.target as Element | null)?.closest("[data-wallet-swipe-hint]")).length)).toBe(0);
    const add = page.getByTestId("wallet-card-browser").getByRole("button", { name: count ? "Add another card" : "Add a payment card", exact: true });
    {
      const stack = page.getByTestId("wallet-add-stack");
      const layers = stack.locator("li:not([inert])");
      await expect(layers).toHaveCount(count + 3);
      await expect(stack.locator("[data-agent-card]")).toHaveCount(3);
      await expect(stack.locator("li[data-gesture-card^=card_]")).toHaveCount(count);
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
      if (count > 0) {
        await page.locator("[data-app-scroll-root]").evaluate(root => {
          const stack = root.querySelector('[data-testid="wallet-add-stack"]')!;
          root.scrollTop += stack.getBoundingClientRect().top - root.getBoundingClientRect().top + 350;
        });
        await expect(layers).toHaveCount(count + 3);
        await expect(stack).toHaveAttribute("data-expanded", "true");
        // Exercise a saved payment record independently of the system cards.
        const lastCard = stack.locator("li[data-gesture-card^=card_]").last();
        const lastCardId = await lastCard.getAttribute("data-gesture-card");
        const last = lastCard.getByRole("button").first();
        const maskedNumber = (await last.locator('[data-slot="wallet-card-number"] > [aria-hidden="true"]').allTextContents()).join(" ");
        // Keep the details consistent with the face across network groupings,
        // while independently requiring only the final four digits to appear.
        expect(maskedNumber).toMatch(/^(?:•+ )+•?\d{4}$/);
        await last.click();
        await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
        const details = page.getByRole("region", { name: "Saved card details", exact: true });
        await expect(details).toBeVisible();
        const selectedFace = page.getByTestId("wallet-selected-card").getByTestId("wallet-card-face");
        await expect(selectedFace).toHaveAttribute("data-revealed", "true");
        const fullNumber = (await selectedFace.locator('[data-slot="wallet-card-number"] > [aria-hidden="true"]').allTextContents()).join(" ");
        expect(fullNumber).toMatch(/^\d[\d ]+\d$/);
        expect(fullNumber.replace(/ /g, "").endsWith(maskedNumber.slice(-4))).toBe(true);
        await expect(details.getByText(fullNumber, { exact: true })).toBeVisible();
        await expect(details.getByText("Hidden", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.__walletEvents ?? [])).toContain(`reveal:${lastCardId}`);
        await page.getByRole("button", { name: "All cards", exact: true }).click();
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await stack.locator("li").first().evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
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
  await page.getByLabel("Name on card", { exact: true }).fill("Travel");
  await page.getByRole("tab", { name: "Cards", exact: true }).click();
  await expect(page.getByTestId("wallet-add-layer-4242")).toBeVisible();
  await expect(page.locator("#top-shell-wallet-panel-add")).toHaveAttribute("inert", "");
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("Travel");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wallet-add-collection")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Wallet Add scrolls in the page and swipes back to Cards without a tall blank tail", async ({ page }) => {
  await open(page, 393, "light", {}, { height: 667, shell: true });
  await mount(page);
  await expect(page.getByTestId("wallet-add-layer-agent-one-profile")).toBeInViewport();
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
  await expect(page.getByTestId("wallet-add-layer-agent-one-profile")).toBeInViewport();
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
    await expect(page.getByTestId("wallet-add-collection")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

// PR #7574 removed the visual thumbnail dock and duplicate section title.
// Exercise the card faces and detail controls that people can actually see.
async function expectScreenReaderSwitcher(page: Page) {
  const dock = page.getByRole("navigation", { name: "Wallet card switcher" });
  await expect(dock).toHaveClass(/sr-only/);
  await expect(dock.getByRole("button", { name: "Open Agent One Profile" })).toBeEnabled();
}

for (const width of [320, 390, 1024]) {
  test(`card faces and detail controls navigate without selector chrome at ${width}px`, async ({ page }, testInfo) => {
    const errors = await open(page, width, "light", { cards: 0 }, { height: 844, shell: true });
    await mount(page);
    await expectScreenReaderSwitcher(page);
    const browser = page.getByTestId("wallet-card-browser");
    await expect(browser).toHaveAttribute("data-mode", "all");
    await expect(page.getByTestId("wallet-add-stack")).toHaveAttribute("data-unfolded", "false");
    await page.screenshot({ path: testInfo.outputPath("cards-overview.png") });
    const profile = page.getByTestId("wallet-add-collection").getByRole("button", { name: "View details for Agent One Profile", exact: true });
    await expect(profile).toBeInViewport();
    await profile.click();
    await expect(browser).toHaveAttribute("data-mode", "card");
    const detail = page.getByTestId("wallet-selected-card");
    const allCards = detail.getByRole("button", { name: "All cards", exact: true });
    await allCards.scrollIntoViewIfNeeded();
    await expect(allCards).toBeInViewport();
    const next = detail.getByRole("button", { name: "Next card", exact: true });
    await next.scrollIntoViewIfNeeded();
    await expect(next).toBeInViewport();
    await next.click();
    await expect(page.getByRole("region", { name: "Referral card details" })).toBeVisible();
    await expect(page.getByTestId("wallet-demo-activity")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Payment", exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Wallet card switcher" }).getByRole("button", { name: "Open Agent One Referral" })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: testInfo.outputPath("cards-detail.png") });
    await expect(page.getByRole("link", { name: "Preview referral page" })).toHaveAttribute("href", "https://example.test/r/fixture-referral");
    expect(await page.evaluate(() => window.__walletEvents ?? [])).not.toContain("reveal:card_a");
    await detail.getByRole("button", { name: "All cards", exact: true }).click();
    await expect(browser).toHaveAttribute("data-mode", "all");
    const add = browser.getByRole("button", { name: "Add a payment card", exact: true });
    await add.scrollIntoViewIfNeeded();
    await expect(add).toBeInViewport();
    const bounds = await add.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(bounds.overflow).toBeLessThanOrEqual(1);
    await add.click();
    await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("secure-card-add-form")).toBeVisible();
    await expect(page.getByTestId("wallet-card-switcher")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("card face browsing supports reduced motion and dark mode", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, 390, "dark", { cards: 0 }, { height: 844, shell: true });
  await mount(page);
  await page.getByTestId("wallet-add-collection").getByRole("button", { name: "View details for Agent One Profile", exact: true }).click();
  const face = page.locator('[data-testid="wallet-selected-card"] [data-swipe-views-horizontal-scroll]');
  await face.evaluate((element) => {
    const start = new Event("touchstart", { bubbles: true });
    Object.defineProperty(start, "touches", { value: [{ clientX: 280, clientY: 180 }] });
    element.dispatchEvent(start);
    const end = new Event("touchend", { bubbles: true });
    Object.defineProperty(end, "changedTouches", { value: [{ clientX: 100, clientY: 190 }] });
    element.dispatchEvent(end);
  });
  await expect(page.getByRole("region", { name: "Referral card details" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  const moving = await page.getByTestId("wallet-selected-card").evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" && !((animation.effect as KeyframeEffect)?.target as Element | null)?.closest("[data-wallet-swipe-hint]")).length);
  expect(moving).toBe(0);
});

test("scrolling keeps selector chrome clipped and the visible Add action keyboard accessible", async ({ page }) => {
  await open(page, 390, "light", { cards: 0 }, { height: 844, shell: true });
  await mount(page);
  await expectScreenReaderSwitcher(page);
  const root = page.locator("[data-app-scroll-root]");
  const add = page.getByTestId("wallet-card-browser").getByRole("button", { name: "Add a payment card", exact: true });
  await add.scrollIntoViewIfNeeded();
  await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByTestId("wallet-card-switcher")).toHaveClass(/sr-only/);
  await root.evaluate((element) => { element.scrollTop = 0; });
  await expectScreenReaderSwitcher(page);
  await add.focus();
  await expect(add).toBeFocused();
  await add.press("Enter");
  await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("secure-card-add-form")).toBeVisible();
});

for (const width of [320, 393, 1440]) {
  test(`single-screen Add form fits at ${width}px`, async ({ page }) => {
    await open(page, width, "light", {}, { shell: true });
    await mount(page);
    await page.getByRole("tab", { name: "Add", exact: true }).click();
    const form = page.getByTestId("secure-card-add-form");
    await expect(form.getByRole("button", { name: "Scan card", exact: true })).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Choose photo", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => {
      const box = await form.boundingBox();
      return Boolean(box && box.x >= 0 && box.x + box.width <= width);
    }).toBe(true);
    for (const label of ["Name on card", "Card network (optional)", "Expiry (MM/YY)", "CVV", "PIN (optional)", "Issuing region (optional)"]) {
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

test("Add saves typed card details, keeps optional fields empty, and preserves its finish after remount", async ({ page }) => {
  const errors = await open(page, 320, "light", { cards: 0, delayMs: 40 }, { shell: true });
  await mount(page);
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  const form = page.getByTestId("secure-card-add-form");
  await form.getByLabel("Card number", { exact: true }).fill("5555 5555 5555 4444");
  await form.getByLabel("Name on card", { exact: true }).fill("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await form.getByLabel("Card network (optional)", { exact: true }).click();
  await page.getByRole("option", { name: "Mastercard", exact: true }).click();
  await form.getByLabel("Expiry (MM/YY)", { exact: true }).fill("09/32");
  await form.getByLabel("CVV", { exact: true }).fill("321");
  await form.getByRole("button", { name: "Save card", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  const selected = page.getByTestId("wallet-selected-card");
  const face = selected.getByTestId("wallet-card-face");
  await expect(face).toBeVisible();
  await expect(face.locator('[data-slot="wallet-card-holder"]')).toContainText("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await expect(face.locator('[data-slot="wallet-card-expiry"]')).toContainText("09/32");
  await expect(face.getByTestId("card-network-wordmark-mastercard")).toBeVisible();
  await expect(face.locator('[data-slot="wallet-card-number"]')).toContainText("4444");
  await expect(face).toContainText("5555555555554444");
  await expect(face).toHaveAttribute("data-revealed", "true");
  const artwork = await face.getAttribute("data-card-artwork");
  await selected.getByRole("button", { name: "All cards", exact: true }).click();
  const saved = page.locator('[data-gesture-card="card_saved_1"]');
  await expect(saved.getByTestId("wallet-card-face")).toHaveAttribute("data-card-artwork", artwork!);
  await expect(page.getByTestId("wallet-add-stack").locator("li:not([inert])")).toHaveCount(4);
  await page.evaluate(() => window.__walletRemount!());
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeVisible();
  await next.click();
  await expect(saved.getByTestId("wallet-card-face")).toHaveAttribute("data-card-artwork", artwork!);
  await expect(saved.locator('[data-slot="wallet-card-holder"]')).toContainText("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await expect(saved.locator('[data-slot="wallet-card-expiry"]')).toContainText("09/32");
  expect(await page.evaluate(() => window.__walletEvents)).toEqual(["add", "reveal:card_saved_1"]);
  expect(errors).toEqual([]);
});

test("all twenty payment finishes fit long names and a revealed 19-digit number at 320px", async ({ page }) => {
  const errors = await open(page, 320, "light", { artworkGallery: true });
  await mount(page, false);
  const faces = page.getByTestId("wallet-card-face");
  await expect(faces).toHaveCount(40);
  const measurements = await faces.evaluateAll((elements) => elements.map((face) => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const number = face.querySelector('[data-slot="wallet-card-number"]')!;
    const fields = [...face.querySelectorAll('[data-slot="wallet-card-bottom"] > span')].map(box);
    const text = [...number.querySelectorAll('[aria-hidden="true"]')].map(box);
    return { artwork: face.getAttribute("data-card-artwork"), face: box(face), number: box(number), fields, text,
      top: [...face.querySelector('[data-slot="wallet-card-top"]')!.children].map(box) };
  }));
  expect(new Set(measurements.map((entry) => entry.artwork)).size).toBe(20);
  for (const entry of measurements) {
    expect(Math.abs(entry.face.width / entry.face.height - ISO_RATIO)).toBeLessThan(0.01);
    for (const part of [...entry.fields, ...entry.text, ...entry.top]) {
      expect(part.left, `${entry.artwork} left edge`).toBeGreaterThanOrEqual(entry.face.left);
      expect(part.right, `${entry.artwork} right edge`).toBeLessThanOrEqual(entry.face.right);
      expect(part.bottom, `${entry.artwork} bottom edge`).toBeLessThanOrEqual(entry.face.bottom);
    }
    expect(entry.top[0]!.right).toBeLessThanOrEqual(entry.top[1]!.left);
    for (let index = 1; index < entry.fields.length; index += 1) {
      expect(entry.fields[index - 1]!.right).toBeLessThanOrEqual(entry.fields[index]!.left);
    }
    expect(entry.number.bottom).toBeLessThan(entry.fields[0]!.top);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
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

for (const width of [390, 1440]) {
  test(`Wallet card actions: tab highlight stays centered during form presses and tab switches at ${width}px`, async ({ page }) => {
    // Six tab switches and twelve press/release cycles share this budget.
    // Keep each alignment poll's default deadline and strict geometry check.
    test.setTimeout(60_000);
    const errors = await open(page, width, "light", { cards: 3 }, { height: 844, shell: true });
    await mount(page);
    const alignment = () => page.evaluate(() => {
      const selected = document.querySelector('[role="tab"][aria-selected="true"]')!.getBoundingClientRect();
      const indicator = document.querySelector('[data-testid="top-shell-tab-indicator"]')!.getBoundingClientRect();
      return Math.abs(selected.x + selected.width / 2 - indicator.x - indicator.width / 2);
    });
    const expectAligned = async () => {
      try {
        await expect.poll(alignment).toBeLessThan(2);
      } catch (error) {
        // Only synthetic fixture geometry is logged; assertions stay strict.
        console.error("Wallet tab alignment geometry", await page.evaluate(() => {
          const geometry = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].map(el => {
            const bounds = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return { id: el.id, selected: el.getAttribute("aria-selected"),
              x: bounds.x, width: bounds.width, scrollLeft: el.scrollLeft,
              transform: style.transform, transition: style.transition };
          });
          const strip = document.querySelector<HTMLElement>('[data-top-shell-tab-set="wallet"]');
          return {
            position: strip?.style.getPropertyValue("--top-shell-tab-swipe-wallet-position"),
            tabs: geometry('[role="tab"]'),
            indicator: geometry('[data-testid="top-shell-tab-indicator"]'),
            pager: geometry('[data-swipe-views-root="true"]'),
            panels: geometry('[role="tabpanel"]'),
            visibility: document.visibilityState,
          };
        }));
        throw error;
      }
    };
    for (const [switchIndex, name] of ["Add", "Sharing", "Cards", "Add", "Sharing", "Add"].entries()) {
      await test.step(`Switch ${switchIndex + 1}: ${name} and form presses`, async () => {
        await page.getByRole("tab", { name, exact: true }).click();
        await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
        await expectAligned();
        if (name === "Add") {
          for (const label of ["Show", "Hide", "Show", "Hide"]) {
            const button = page.getByRole("button", { name: `${label} CVV and PIN`, exact: true });
            await button.evaluate(el => {
              const root = el.closest<HTMLElement>('[data-app-scroll-root="true"]')!;
              root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 2;
            });
            const box = await button.boundingBox();
            if (!box) throw new Error("PIN visibility control missing");
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            expect(await alignment()).toBeLessThan(2);
            await page.mouse.up();
            await expect(page.getByRole("button", { name: `${label === "Show" ? "Hide" : "Show"} CVV and PIN`, exact: true })).toBeVisible();
            await expectAligned();
            expect(await page.locator('[data-swipe-views-root="true"]').evaluate(el => el.scrollLeft)).toBe(0);
          }
        }
      });
    }
    await page.screenshot({ path: test.info().outputPath("wallet-add-stable-tabs.png") });
    expect(errors).toEqual([]);
  });

  test(`Wallet card actions: saved card rows align at ${width}px`, async ({ page }) => {
    await open(page, width, "light", { cards: 3 }, { height: 844, shell: true });
    await mount(page);
    await page.getByRole("button", { name: "Everyday", exact: true }).click();
    const details = page.getByRole("region", { name: "Saved card details" });
    await expect(details).toContainText("4242 4242 4242 4242");
    await expect(page.getByTestId("wallet-selected-card").getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "true");
    await expect(details.getByRole("button", { name: "Copy card number" })).toBeVisible();
    await expect(details.getByText("Hidden", { exact: true })).toBeVisible();
    const icons = details.locator('[data-slot="settings-row-icon"] svg');
    await expect(icons).toHaveCount(8);
    expect(await icons.evaluateAll(elements => elements.slice(0, 7).every(icon => {
      const accent = icon.querySelector('.profile-pane-icon-accent');
      return accent && getComputedStyle(accent).stroke !== getComputedStyle(icon).stroke;
    }))).toBe(true);
    const sharing = page.getByRole("region", { name: "Card sharing", exact: true });
    expect(await sharing.evaluate((el) => {
      const details = document.querySelector('[aria-label="Saved card details"]')!;
      const a = details.querySelector('[data-slot="settings-group-shell"]')!.getBoundingClientRect();
      return [...el.querySelectorAll('[data-slot="settings-group-shell"]')].every(group => {
        const b = group.getBoundingClientRect();
        return Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1;
      });
    })).toBe(true);
    const remove = details.getByRole("button", { name: "Remove card", exact: true });
    await remove.evaluate(el => {
      const root = el.closest<HTMLElement>('[data-app-scroll-root="true"]')!;
      root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 2;
    });
    await expect(remove).toBeVisible();
    expect(await details.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect.poll(() => details.evaluate(el => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth;
    })).toBe(true);
    expect(await page.locator('[data-swipe-views-root="true"]').evaluate(el => el.scrollLeft)).toBe(0);
    await expect.poll(() => page.getByTestId("wallet-card-browser").evaluate(el => {
      const box = el.getBoundingClientRect();
      const tabs = document.querySelector('[role="tablist"]')!.getBoundingClientRect();
      return Math.max(Math.abs(box.left - tabs.left), Math.abs(box.right - tabs.right));
    })).toBeLessThan(1);
    await page.screenshot({ path: test.info().outputPath("wallet-saved-card-actions.png") });
    await remove.click();
    await expect(page.getByTestId("one-wallet-remove-confirm")).toBeVisible();
    await page.getByTestId("one-wallet-remove-cancel").click();
    await expect(details).toBeVisible();
  });

  test(`Temporary card sharing: logos and recipient selection fit at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", { networkCards: true }, { height: 844, shell: true, secure: true });
    await mount(page);
    await page.getByRole("button", { name: "Search cards" }).click();
    await page.getByRole("textbox", { name: "Search cards" }).fill("RuPay");
    await page.getByRole("button", { name: /^RuPay ·/ }).click();
    const face = page.getByTestId("wallet-selected-card").getByTestId("wallet-card-face");
    await expect(face).toHaveAttribute("data-revealed", "true");
    const logo = face.getByTestId("card-network-wordmark-rupay").locator("img");
    await expect.poll(() => logo.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    expect(await logo.evaluate(el => { const box = el.getBoundingClientRect(), card = el.closest('[data-testid="wallet-card-face"]')!.getBoundingClientRect(); return box.left >= card.left && box.right <= card.right && box.top >= card.top && box.bottom <= card.bottom; })).toBe(true);
    await face.screenshot({ path: test.info().outputPath("wallet-rupay-card.png") });
    await page.getByRole("button", { name: "Share card Temporary access for your connections.", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Search connections" })).toBeVisible();
    expect(await dialog.getByRole("tab", { name: "Anyone", exact: true }).count()).toBe(0);
    await dialog.getByRole("checkbox", { name: "Share with Test Recipient", exact: true }).check();
    await dialog.getByRole("checkbox", { name: "Share with Trusted Recipient", exact: true }).check();
    await expect(dialog.getByRole("button", { name: "Share with 2", exact: true })).toBeEnabled();
    await expect(dialog).toContainText("Trusted Circle");
    await dialog.getByRole("button", { name: "5 minutes", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "5 minutes", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("wallet-encrypted-card-sharing.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390, 1440]) {
  test(`Anonymous encrypted file reader opens a synthetic card locally at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", {}, { secure: true, reader: true });
    await page.addScriptTag({ content: script });
    const file = await createEncryptedCardFile({ pan: "6200000000000001234", cardholderName: "SYNTHETIC RECIPIENT WITH A LONG NAME ".repeat(3).slice(0, 100), brand: "unionpay", expiryMonth: 4, expiryYear: 2030, issuingRegion: "US" }, "synthetic-long-password");
    await page.getByLabel("Encrypted card file").setInputFiles({ name: file.name, mimeType: file.type, buffer: Buffer.from(await file.arrayBuffer()) });
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Open card", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open card", exact: true })).toBeEnabled();
    await expect(page.getByRole("region", { name: "Shared card details" })).not.toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("synthetic-long-password");
    await page.getByRole("button", { name: "Open card", exact: true }).click();
    const details = page.getByRole("region", { name: "Shared card details" });
    await expect(details).toContainText("6200000000000001234".replace(/(.{4})(?=.)/g, "$1 "));
    await expect(details).not.toContainText("CVV");
    await expect(details).not.toContainText("PIN");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await details.locator('[data-slot="settings-row-trailing"]').evaluateAll(elements => elements.slice(0, 2).every(el => { const value = el.firstElementChild as HTMLElement; return value.scrollWidth <= value.clientWidth + 1 && getComputedStyle(value).textOverflow !== "ellipsis"; }))).toBe(true);
    await page.getByRole("button", { name: "Hide card", exact: true }).click();
    await expect(details).not.toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
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
        if (tab === "Cards") {
          const heading = panel.getByRole("heading", { name: "Your cards", level: 2, exact: true }).first();
          await expect(heading).toHaveClass(/sr-only/);
        } else {
          await expect(panel.locator('h2').first()).toHaveClass(/ui-text-section-title/);
        }
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
  await expect(page.getByTestId("wallet-sharing-content").locator('figure [data-agent-card="profile"]')).toBeVisible();
  await expect(page.getByTestId("wallet-sharing-content").locator("figure")).toBeInViewport();
});
