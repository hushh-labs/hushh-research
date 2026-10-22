import { expect, test, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import { measureTabSelection } from "./fixtures/tab-motion";
import { openWalletSharingReview } from "./fixtures/wallet-sharing-review";
import os from "node:os";
import path from "node:path";
import type { WalletCardPayload } from "../lib/services/wallet-card-service";
import { createEncryptedCardFile } from "../lib/wallet/wallet-card-file";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../components/app-ui/signed-in-shell-content-offset";

/** Production Wallet with inert service boundaries: entry artwork/CTA fit, shared
 * workspace header geometry, collection motion/geometry, and direct Add flow. */

const ISO_RATIO = 85.6 / 53.98;
const BOTTOM_SHELL_HEIGHT_PX = 132;

async function expectCompactPrimary(action: Locator, height = 50) {
  const geometry = await action.evaluate(el => {
    const box = el.getBoundingClientRect();
    const parent = el.parentElement!.getBoundingClientRect();
    return { width: box.width, height: box.height, center: box.x + box.width / 2, parentCenter: parent.x + parent.width / 2 };
  });
  expect(geometry.width).toBeCloseTo(244, 0);
  expect(geometry.height).toBeCloseTo(height, 0);
  expect(geometry.center).toBeCloseTo(geometry.parentCenter, 0);
}

const BOUNDARY_MODULES = [
  "next/navigation",
  "@/hooks/use-auth",
  "@/hooks/use-effective-avatar-url",
  "@/lib/referral/use-referral-stream",
  "@/lib/vault/vault-context",
  "@/lib/services/wallet-service",
  "@/lib/services/wallet-card-share-service",
  "@/lib/services/api-service",
  "@/lib/cache/cache-sync-service",
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

type Scenario = { cards?: number; networkCards?: boolean; locked?: boolean; delayMs?: number; profile?: WalletCardPayload; artworkGallery?: boolean; sharingHistory?: boolean; revokeFailure?: boolean; cardRequest?: boolean };

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
    if (assetPath === "/wallet/apple-wallet-transparent-v1.png") {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: "image/png" });
      return;
    }
    if (assetPath === "/wallet/wallet-cards-hero.webp") {
      await route.fulfill({ body: walletHero, contentType: "image/webp" });
      return;
    }
    if (assetPath === "/wallet/card-scan-complete-v4.webp") {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: "image/webp" });
      return;
    }
    if (/^\/wallet\/artwork\/(profile|referral|nws)-v[123]\.svg$/.test(assetPath)) {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: "image/svg+xml" });
      return;
    }
    if (/^\/brand\/cards\/[a-z]+(?:-[a-z]+)*\.(svg|png)$/.test(assetPath)) {
      await route.fulfill({ body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType: assetPath.endsWith(".svg") ? "image/svg+xml" : "image/png" });
      return;
    }
    await route.abort();
  });
  const fixture = shell ? shellMarkup() : '<div id="root"></div>';
  const html = `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><base href="${origin}/"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" data-ambient-chrome-primed="true" style="margin:0">${fixture}</body></html>`;
  await page.route(`${origin}/`, route => route.fulfill({ body: html, contentType: "text/html" }));
  await page.goto(`${origin}/`);
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

for (const width of [390, 1024]) {
  test(`tab clicks settle without a spring overshoot at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if (width === 1024) await page.clock.install();
    const errors = await open(page, width, "light", { cards: 3 }, { shell: true });
    await page.addScriptTag({ content: "window.__walletPagerOnly = true;" });
    await mount(page, false);
    await expect(page.getByRole("tabpanel", { name: "Cards", exact: true })).toBeVisible();
    if (width === 1024) await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
    const add = page.getByRole("tab", { name: "Add", exact: true });
    // Bound delayed startup on the animation clock; keep ordinary mobile motion
    // on real time. Both cases observe the shipping spring and DOM geometry.
    const { frames, rendering } = await measureTabSelection(add, width === 1024 ? 150 : 0,
      width === 1024 ? () => page.clock.runFor(816) : undefined);
    const diagnostics = JSON.stringify({ ...rendering, frameCount: frames.length,
      maxFrameGap: Math.max(...frames.map((frame, index) => frame.time - (frames[index - 1]?.time ?? 0))),
      first: frames.slice(0, 3), last: frames.slice(-3) });
    const arrived = frames.find((frame, index) => Math.abs(frame.offset) < 3 && frames.slice(index).every((later) => Math.abs(later.offset) < 3));
    expect(arrived, `the selected pane must arrive: ${diagnostics}`).toBeDefined();
    expect(arrived!.time, `tab presses should not wait out the drag spring: ${diagnostics}`).toBeLessThan(400);
    expect(Math.min(...frames.map((frame) => frame.offset)), `the pane must not overshoot its snap: ${diagnostics}`).toBeGreaterThanOrEqual(-3);
    expect(frames.some(frame => frame.offset > 3 && frame.offset < rendering.viewportWidth - 3), `tab selection must animate rather than jump: ${diagnostics}`).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 393, 1440]) {
  test(`Wallet keeps compact mobile spacing and shared desktop geometry at ${width}px`, async ({ page }, testInfo) => {
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
    await expect(page.getByTestId("wallet-card-browser")).toHaveCSS("padding-top", width < 640 ? "20px" : "32px");
    await page.screenshot({ path: testInfo.outputPath(`wallet-${width}.png`) });
    await open(page, width, "light", {}, { shell: true });
    await page.addScriptTag({ content: "window.__workspaceHeaderReference=true;" });
    await mount(page, false);
    await expect(page.getByRole("heading", { name: "Reference", exact: true })).toBeVisible();
    const reference = await geometry();
    const referenceHeaderGap = reference.tabs.y - reference.header.y - reference.header.height;
    // Wallet retains the shared compact workspace header contract. Location
    // now places its title in the top shell and has a separate header contract.
    // The 56px tab rail contributes 10px above its visible 36px pill.
    expect(referenceHeaderGap).toBeCloseTo(width < 640 ? 10 : 16, 1);
    if (width >= 640) {
      const walletHeaderGap = wallet.tabs.y - wallet.header.y - wallet.header.height;
      expect(walletHeaderGap).toBeCloseTo(16, 1);
    }
    if (width < 640) {
      expect(wallet.header.height).toBe(44);
      expect(wallet.header.y).toBe(reference.header.y);
      expect(wallet.tabs.y - wallet.header.y - wallet.header.height).toBeGreaterThanOrEqual(6);
      expect(wallet.tabs.y - wallet.header.y - wallet.header.height).toBeLessThanOrEqual(16);
    }
    for (const part of ["header", "tabs"] as const) {
      for (const coordinate of ["x", "y", "width", "height"] as const) {
        if (width < 640 && (coordinate === "y" || (part === "header" && coordinate === "height"))) continue;
        expect(Math.abs(wallet[part][coordinate] - reference[part][coordinate]), `${part}.${coordinate}`).toBeLessThanOrEqual(0.5);
      }
    }
    expect(wallet.titleSize).toBe(reference.titleSize);
    if (width >= 640) expect(Math.abs(wallet.titleY - reference.titleY)).toBeLessThanOrEqual(0.5);
    expect(wallet.tabWidths).toEqual(reference.tabWidths);
  });
}

for (const width of [393, 1440]) {
  test(`Calendar workspace centers its action below the heading at ${width}px`, async ({ page }) => {
    await open(page, width, "light", {}, { shell: true });
    await page.addScriptTag({ content: "window.__calendarHeading=true;" });
    await mount(page, false);
    const action = page.getByRole("button", { name: "Connect your calendar", exact: true });
    await expect(action).toBeVisible();
    const measured = await action.evaluate((button) => {
      const heading = button.closest("section")!.querySelector("#calendar-connect-title")!;
      const rect = button.getBoundingClientRect();
      const title = heading.getBoundingClientRect();
      return {
        gap: rect.top - title.bottom,
        centerOffset: rect.x + rect.width / 2 - title.x - title.width / 2,
        height: rect.height,
      };
    });
    expect(measured.gap).toBeCloseTo(24, 1);
    expect(Math.abs(measured.centerOffset)).toBeLessThanOrEqual(0.5);
    expect(measured.height).toBeGreaterThanOrEqual(44);
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
    await expectCompactPrimary(add);
    {
      const stack = page.getByTestId("wallet-add-stack");
      const layers = stack.locator("li:not([inert])");
      await expect(layers).toHaveCount(count + 3);
      await expect(stack.locator('[data-stack-details] button')).toHaveCount(count + 3);
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
        await lastCard.getByRole("button", { name: /^View details for/ }).click();
        await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
        const details = page.getByRole("region", { name: "Saved card details", exact: true });
        await expect(details).toBeVisible();
        const selectedFace = page.getByTestId("wallet-selected-card").getByTestId("wallet-card-face");
        await expect(selectedFace).toHaveAttribute("data-revealed", "false");
        const fullNumber = (await selectedFace.locator('[data-slot="wallet-card-number"] > [aria-hidden="true"]').allTextContents()).join(" ");
        expect(fullNumber).toBe(maskedNumber);
        expect(fullNumber.replace(/ /g, "").endsWith(maskedNumber.slice(-4))).toBe(true);
        await expect(details.getByText(fullNumber, { exact: true })).toBeVisible();
        await expect(details.getByTestId("wallet-owner-cvv")).toHaveText("•••");
    await expect(details).not.toContainText(/CVC|PIN/);
        expect(await page.evaluate(() => window.__walletEvents ?? [])).not.toContain(`reveal:${lastCardId}`);
        await page.getByRole("button", { name: "Back", exact: true }).click();
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
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("TRAVEL");
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
  await awaitWalletCardsSettled(page);
  await expect.poll(() => page.evaluate(async () => {
    const cards = document.querySelector("#top-shell-wallet-panel-cards")!;
    const pager = document.querySelector('[data-swipe-views-root="true"]')!;
    const baseline = [cards.scrollHeight, pager.clientHeight];
    for (let i = 0; i < 3; i += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return Math.abs(pager.clientHeight - cards.scrollHeight) <= 1 &&
      cards.scrollHeight === baseline[0] && pager.clientHeight === baseline[1];
  })).toBe(true);
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
    await expect(page.getByRole("heading", { name: "All your cards in one place", exact: true })).toBeAttached();
    await expect(page.getByTestId("one-wallet-empty-display-title")).toHaveText("All your cards in one place");
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

async function assertWalletNavigationInViewport(page: Page) {
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("heading", { name: "Wallet", exact: true })).toBeInViewport({ ratio: 1 });
}

async function awaitWalletCardsSettled(page: Page) {
  await expect.poll(() => page.getByTestId("wallet-card-browser").evaluate((element) =>
    element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" && !((animation.effect as KeyframeEffect)?.target as Element | null)?.closest("[data-wallet-swipe-hint]")).length,
  )).toBe(0);
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
    await awaitWalletCardsSettled(page);
    await assertWalletNavigationInViewport(page);
    await expectScreenReaderSwitcher(page);
    const browser = page.getByTestId("wallet-card-browser");
    await expect(browser).toHaveAttribute("data-mode", "all");
    await expect(page.getByTestId("wallet-add-stack")).toHaveAttribute("data-unfolded", "false");
    await page.screenshot({ path: testInfo.outputPath("cards-overview.png") });
    const profile = page.getByTestId("wallet-add-collection").getByRole("button", { name: "Agent One Profile", exact: true });
    await expect(profile).toBeInViewport();
    await profile.click();
    await expect(browser).toHaveAttribute("data-mode", "card");
    const detail = page.getByTestId("wallet-selected-card");
    const allCards = detail.getByRole("button", { name: "Back", exact: true });
    await allCards.scrollIntoViewIfNeeded();
    await expect(allCards).toBeInViewport();
    const next = detail.getByRole("button", { name: "Next card", exact: true });
    await next.scrollIntoViewIfNeeded();
    await expect(next).toBeInViewport();
    await next.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
    await expect(next).not.toHaveCSS("box-shadow", "none");
    await next.click();
    await expect(page.getByRole("region", { name: "Referral card details" })).toBeVisible();
    await expect(page.getByTestId("wallet-demo-activity")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Payment", exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Wallet card switcher" }).getByRole("button", { name: "Open Agent One Referral" })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: testInfo.outputPath("cards-detail.png") });
    await expect(page.getByRole("link", { name: "Preview referral page" })).toHaveAttribute("href", "https://example.test/r/fixture-referral");
    expect(await page.evaluate(() => window.__walletEvents ?? [])).not.toContain("reveal:card_a");
    await detail.getByRole("button", { name: "Back", exact: true }).click();
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
  await page.getByTestId("wallet-add-collection").getByRole("button", { name: "Agent One Profile", exact: true }).click();
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
    const errors = await open(page, width, "light", {}, { shell: true });
    await mount(page);
    await page.getByRole("tab", { name: "Add", exact: true }).click();
    const form = page.getByTestId("secure-card-add-form");
    const scan = page.getByRole("button", { name: "Scan card", exact: true });
    await expect(scan).toBeVisible();
    await expect(scan.getByText("Scan to add card", { exact: true })).toBeVisible();
    const artwork = scan.locator("img");
    await expect(artwork).toHaveCount(1);
    await expect(artwork).toBeVisible();
    await expect(artwork).toHaveAttribute("src", "/wallet/card-scan-complete-v4.webp");
    await expect.poll(() => artwork.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    if (await page.evaluate(() => typeof navigator.mediaDevices?.getUserMedia === "function")) {
      await scan.click();
      await expect(page.getByRole("region", { name: "Photograph your card" })).toBeVisible();
      await page.getByRole("region", { name: "Photograph your card" }).getByRole("button", { name: "Cancel", exact: true }).click();
    } else {
      const chooser = page.waitForEvent("filechooser"); await scan.click();
      expect((await chooser).isMultiple()).toBe(false);
    }
    const number = form.getByLabel("Card number", { exact: true });
    const holder = form.getByLabel("Name on card", { exact: true });
    const expiry = form.getByLabel("Expiry (MM/YY)", { exact: true });
    await expect(form.getByLabel("CVV", { exact: true })).toHaveAttribute("type", "password");
    await expect(form.getByLabel("PIN (optional)", { exact: true })).toHaveCount(0);
    for (const field of [number, holder, expiry]) {
      await expect(field).toBeVisible();
      await expect(field).toHaveAttribute("required", "");
      expect(await field.evaluate(node => Boolean(node.closest("details")))).toBe(false);
    }
    const bounds = await Promise.all([number, holder, expiry].map(field => field.boundingBox()));
    for (const [first, second] of [[0, 2]]) {
      expect(Math.abs(bounds[first]!.height - bounds[second]!.height)).toBeLessThan(1);
      expect(Math.abs(bounds[first]!.x - bounds[second]!.x)).toBeLessThan(1);
    }
    await page.screenshot({ path: test.info().outputPath("wallet-add-profile-scanner.png") });
    await expect(form.getByRole("button", { name: "Choose photo", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => {
      const box = await form.boundingBox();
      return Boolean(box && box.x >= 0 && box.x + box.width <= width);
    }).toBe(true);
    const network = form.getByTestId("secure-card-network-select");
    await expect(network).toBeVisible();
    expect(await network.evaluate(el => el.closest("details"))).toBeNull();
    const networkBounds = (await network.boundingBox())!;
    for (const label of ["Expiry (MM/YY)"]) {
      const box = (await form.getByLabel(label, { exact: true }).boundingBox())!;
      expect(Math.abs(networkBounds.y - box.y)).toBeLessThan(1);
      expect(Math.abs(networkBounds.width - box.width)).toBeLessThan(1);
      expect(Math.abs(networkBounds.height - box.height)).toBeLessThan(1);
      expect(networkBounds.x).toBeGreaterThanOrEqual(box.x + box.width);
      expect(networkBounds.y).toBeGreaterThanOrEqual(bounds[1]!.y + bounds[1]!.height);
    }
    for (const label of ["Name on card", "Card network", "Expiry (MM/YY)", "Issuing region"]) {
      await expect(form.getByLabel(label, { exact: true })).toBeAttached();
    }
    const save = form.getByTestId("secure-card-save");
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();
    const cancel = form.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeVisible();
    const saveBox = (await save.boundingBox())!, cancelBox = (await cancel.boundingBox())!;
    const formBox = (await form.boundingBox())!;
    for (const box of [cancelBox, saveBox]) {
      expect(box.height).toBeCloseTo(50, 0);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeLessThanOrEqual(244);
      expect(box.x).toBeGreaterThanOrEqual(formBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(formBox.x + formBox.width);
    }
    expect(saveBox.width).toBeCloseTo(cancelBox.width, 0);
    expect(saveBox.y).toBeCloseTo(cancelBox.y, 0);
    expect(saveBox.x).toBeGreaterThan(cancelBox.x + cancelBox.width);
    expect((cancelBox.x + saveBox.x + saveBox.width) / 2).toBeCloseTo(formBox.x + formBox.width / 2, 0);
    if (width === 1440) expect(saveBox.width).toBeCloseTo(244, 0);
    await expect(cancel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({ path: test.info().outputPath("wallet-add-compact-actions.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("profile swipe details keep a compact header gap and a full close target", async ({ page }) => {
  await open(page, 393, "light", {}, { shell: true });
  await mount(page);
  const card = page.getByTestId("wallet-add-collection").getByRole("button", { name: "Agent One Profile", exact: true });
  await card.press("ArrowLeft");
  const close = page.getByRole("button", { name: "Back to card", exact: true });
  await expect(close).toBeVisible();
  const geometry = await close.evaluate(button => {
    const header = button.parentElement!;
    const box = header.parentElement!.querySelector('[data-slot="settings-group-shell"]')!;
    return { gap: box.getBoundingClientRect().top - header.getBoundingClientRect().bottom, textGap: box.querySelector('[data-slot="settings-row-title"]')!.getBoundingClientRect().top - header.querySelector("p")!.getBoundingClientRect().bottom, target: button.getBoundingClientRect().height };
  });
  expect(geometry.gap).toBeCloseTo(3, 0);
  expect(geometry.textGap).toBeLessThanOrEqual(12);
  expect(geometry.target).toBeCloseTo(44, 1);
  await page.screenshot({ path: test.info().outputPath("wallet-profile-compact-header.png") });
});

test("typing groups card numbers and inserts expiry separators while allowing middle edits", async ({ page }) => {
  await open(page, 393, "light", {}, { shell: true });
  await mount(page);
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  const input = page.getByTestId("secure-card-pan-input");
  await input.pressSequentially("42424242");
  await expect(input).toHaveValue("4242 4242");
  await input.evaluate((node: HTMLInputElement) => { node.focus(); node.setSelectionRange(5, 5); });
  await input.press("Backspace");
  await expect(input).toHaveValue("4244 242");
  expect(await input.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(3);
  await input.press("9");
  await expect(input).toHaveValue("4249 4242");
  for (const [digits, grouped] of [["911111111116", "9111 1111 1116"], ["378282246310005", "3782 8224 6310 005"], ["4242424242424242", "4242 4242 4242 4242"]]) {
    await input.fill("");
    await input.pressSequentially(digits);
    await expect(input).toHaveValue(grouped);
  }
  const expiry = page.getByLabel("Expiry (MM/YY)", { exact: true });
  await expiry.pressSequentially("12");
  await expect(expiry).toHaveValue("12/");
  await expiry.press("Backspace");
  await expect(expiry).toHaveValue("1");
  await expiry.pressSequentially("230");
  await expect(expiry).toHaveValue("12/30");
  await expiry.fill("08/2032");
  await expect(expiry).toHaveValue("08/2032");
  await input.fill("");
  expect(await input.evaluate((node) => node.matches(":placeholder-shown"))).toBe(true);
});

test("Back unwinds Add and Sharing to the previous selected Wallet card", async ({ page }) => {
  await open(page, 393, "light", {}, { shell: true });
  await mount(page);
  await page.getByRole("button", { name: "Everyday", exact: true }).click();
  await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  await page.getByLabel("Name on card", { exact: true }).fill("Draft Owner");
  await page.getByRole("tab", { name: "Sharing", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __walletBack: () => boolean }).__walletBack())).toBe(true);
  await expect(page.getByRole("tab", { name: "Add", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("DRAFT OWNER");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Everyday, ending 4242" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.__walletEvents ?? [])).not.toContain("reveal:card_a");
  await page.screenshot({ path: test.info().outputPath("wallet-back-restored-card.png") });
});

test("Add saves typed card details, keeps optional fields empty, and preserves its finish after remount", async ({ page }) => {
  const errors = await open(page, 320, "light", { cards: 0, delayMs: 40 }, { shell: true });
  await mount(page);
  await page.getByRole("tab", { name: "Add", exact: true }).click();
  const form = page.getByTestId("secure-card-add-form");
  await form.getByLabel("Card number", { exact: true }).fill("5555 5555 5555 4444");
  await form.getByLabel("Name on card", { exact: true }).fill("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await form.getByLabel("Card network", { exact: true }).click();
  await page.getByRole("option", { name: "Mastercard", exact: true }).click();
  await form.getByLabel("Expiry (MM/YY)", { exact: true }).fill("09/32");
  await form.getByRole("button", { name: "Add to Wallet", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  const selected = page.getByTestId("wallet-selected-card");
  const face = selected.getByTestId("wallet-card-face");
  await expect(face).toBeVisible();
  await expect(face.locator('[data-slot="wallet-card-holder"]')).toContainText("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await expect(face.locator('[data-slot="wallet-card-expiry"]')).toContainText("09/32");
  await expect(face.getByTestId("card-network-wordmark-mastercard")).toBeVisible();
  await expect(face.locator('[data-slot="wallet-card-number"]')).toContainText("4444");
  await expect(face).not.toContainText("5555555555554444");
  await expect(face).toHaveAttribute("data-revealed", "false");
  const artwork = await face.getAttribute("data-card-artwork");
  await selected.getByRole("button", { name: "Back", exact: true }).click();
  const saved = page.locator('[data-gesture-card="card_saved_1"]');
  await expect(saved.getByTestId("wallet-card-face")).toHaveAttribute("data-card-artwork", artwork!);
  await expect(page.getByTestId("wallet-add-stack").locator("li:not([inert])")).toHaveCount(4);
  await page.evaluate(() => window.__walletRemount!());
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(saved.getByTestId("wallet-card-face")).toHaveAttribute("data-card-artwork", artwork!);
  await expect(saved.locator('[data-slot="wallet-card-holder"]')).toContainText("SAMIRA ALEXANDRA RIVERA-WASHINGTON");
  await expect(saved.locator('[data-slot="wallet-card-expiry"]')).toContainText("09/32");
  expect(await page.evaluate(() => window.__walletEvents?.filter(event => !event.startsWith("history-loaded:")))).toEqual(["add"]);
  expect(errors).toEqual([]);
});

test("neutral payment cards fit long names and a revealed 19-digit number at 320px", async ({ page }) => {
  const errors = await open(page, 320, "light", { artworkGallery: true });
  await mount(page, false);
  const faces = page.getByTestId("wallet-card-face");
  await expect(faces).toHaveCount(2);
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
  expect(new Set(measurements.map((entry) => entry.artwork)).size).toBe(1);
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
  test(`Wallet Sharing keeps history and revocation reachable at ${width}px`, async ({ page }) => {
    // This journey opens both histories and exercises cancel, Escape, and revoke.
    // Shared WebKit runners need room for the full sequence; each assertion
    // retains its normal timeout so a stalled dialog still fails promptly.
    test.setTimeout(60_000);
    const errors = await open(page, width, "light", { cards: 3, sharingHistory: true }, { height: 844, shell: true });
    await mount(page);
    await expect(page.getByTestId("wallet-card-face").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("history-loaded:")).length)).toBe(2);
    await page.getByRole("tab", { name: "Sharing", exact: true }).click();
    await expect.poll(() => page.evaluate(() => Math.abs(
      document.querySelector("#top-shell-wallet-panel-sharing")!.getBoundingClientRect().x -
      document.querySelector('[data-swipe-views-root="true"]')!.getBoundingClientRect().x
    ))).toBeLessThan(2);
    const sharing = page.getByTestId("wallet-sharing-content");
    await expect(sharing.getByText("Sample requester")).toHaveCount(0);
    const history = sharing.getByRole("region", { name: "Card sharing history", exact: true });
    await expect(history).toBeVisible();
    await expect(sharing.getByText("Loading shared cards...")).toHaveCount(0);
    await page.getByRole("tab", { name: "Cards", exact: true }).click();
    await page.getByRole("tab", { name: "Sharing", exact: true }).click();
    await expect(history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).getByText("Sample recipient", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("history-loaded:")).length)).toBe(2);
    const received = sharing.getByRole("region", { name: "Received card history", exact: true });
    await expect(received.getByText("Example Sender", { exact: true })).toBeVisible();
    await expect(received.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
    await expect(sharing.getByRole("button", { name: /^(Sent|Received) cards$/ })).toHaveCount(0);
    await expect(history.getByRole("heading", { name: "Shared cards | 1", exact: true })).toBeVisible();
    await expect(history.getByRole("heading", { name: "Shared cards | 1", exact: true })).toHaveCSS("font-size", "13px");
    await expect(received.getByRole("heading", { name: "Cards shared with you", exact: true })).toHaveCSS("font-size", "13px");
    await expect(history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).getByText("Sample recipient", { exact: true })).toBeVisible();
    const profileFont = await history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).getByText("Sample recipient", { exact: true }).evaluate(el => getComputedStyle(el).fontFamily);
    await expect(history.getByText(/15 minutes/)).toBeHidden();
    await expect(history.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
    await received.getByRole("button", { name: "View Everyday •••• 4242 from Example Sender", exact: true }).click();
    const receivedDetail = page.getByRole("dialog", { name: "Example Sender", exact: true });
    await expect(receivedDetail.getByText(/15 minutes/)).toBeVisible();
    await expect(receivedDetail.getByRole("heading", { name: "Example Sender", exact: true })).toHaveCSS("font-size", "13px");
    await expect(receivedDetail.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
    await receivedDetail.getByRole("button", { name: "Back to sharing history" }).click();
    await expect(receivedDetail).toBeHidden();
    await history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "Sample recipient", exact: true });
    await expect(detail.getByText(/15 minutes/)).toBeVisible();
    const name = detail.getByRole("heading", { name: "Sample recipient", exact: true });
    await expect(name).toHaveCSS("font-size", "13px");
    await expect(name).toHaveCSS("font-weight", "550");
    await expect(name).toHaveCSS("font-family", /Plus Jakarta Sans/);
    await expect(name).toHaveCSS("font-family", profileFont);
    await expect(detail.getByText("Shared card", { exact: true })).toHaveCSS("font-size", "12px");
    await expect(detail.locator('[data-slot$="-header"] .ui-text-row-description')).toHaveCSS("font-size", "12px");
    if (width < 768) {
      // WebKit rounds dvh to fractional CSS pixels.
      await expect.poll(async () => Math.abs((await detail.boundingBox())!.height - 844)).toBeLessThan(1);
      await expect.poll(async () => Math.abs((await detail.boundingBox())!.y)).toBeLessThan(1);
    }
    await page.screenshot({ path: test.info().outputPath("wallet-sharing-detail.png") });
    const revoke = detail.getByRole("button", { name: "Revoke Everyday •••• 4242 shared with Sample recipient", exact: true });
    await expect(revoke).toBeEnabled();
    await revoke.scrollIntoViewIfNeeded();
    const revokeBounds = (await revoke.boundingBox())!;
    expect(revokeBounds.height).toBeGreaterThanOrEqual(44);
    const backBounds = (await detail.getByRole("button", { name: "Back to sharing history" }).boundingBox())!;
    expect(backBounds.width).toBeGreaterThanOrEqual(44);
    expect(backBounds.height).toBeGreaterThanOrEqual(44);
    expect(revokeBounds.x).toBeGreaterThanOrEqual(0);
    expect(revokeBounds.x + revokeBounds.width).toBeLessThanOrEqual(width);
    await detail.getByRole("button", { name: "Back to sharing history" }).click();
    await expect(detail).toBeHidden();
    const historyRecipient = history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true })
      .getByText("Sample recipient", { exact: true });
    await expect(historyRecipient).toBeVisible();
    // Terminal settle must remove fractional interpolation so the Sharing
    // pane remains fully inside the viewport; live drag keeps its own transform.
    await expect.poll(() => sharing.evaluate((el) => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
    const recipientBounds = (await historyRecipient.boundingBox())!;
    expect(recipientBounds.x).toBeGreaterThanOrEqual(0);
    expect(recipientBounds.x + recipientBounds.width).toBeLessThanOrEqual(width);
    await page.locator('[data-app-scroll-root="true"]').evaluate((el) => { el.scrollTop = 0; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("wallet-sharing.png") });
    expect(errors).toEqual([]);
  });

  // Dismissal and confirmed revocation retain all assertions with separate clocks.
  test(`Wallet Sharing dismissal keeps access and restores focus at ${width}px`, async ({ page }) => {
    const { errors, revoke, revocations } = await openWalletSharingReview(page, width, { open, mount });
    await revoke.click();
    const confirmation = page.getByRole("alertdialog", { name: "Revoke this card share?", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled();
    expect(await revocations()).toEqual([]);
    await confirmation.getByRole("button", { name: "Keep sharing", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(revoke).toBeFocused();
    expect(await revocations()).toEqual([]);
    await revoke.click();
    await expect(confirmation).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(revoke).toBeFocused();
    expect(await revocations()).toEqual([]);
    await revoke.click();
    await expect(confirmation).toBeVisible();
    expect(await revocations()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`Wallet Sharing revocation requires confirmation at ${width}px`, async ({ page }) => {
    const { errors, sharing, history, detail, revoke, revocations } = await openWalletSharingReview(page, width, { open, mount });
    await revoke.click();
    const confirmation = page.getByRole("alertdialog", { name: "Revoke this card share?", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled();
    expect(await revocations()).toEqual([]);
    await confirmation.getByRole("button", { name: "Revoke access", exact: true }).click();
    await expect.poll(revocations).toEqual(["sharing-revoke:fixture-history-grant"]);
    await expect(confirmation).toBeHidden();
    await expect(detail.getByText("Revoked", { exact: true }).first()).toBeVisible();
    await expect(detail.getByText("Connection", { exact: true }).first()).toBeVisible();
    await expect(revoke).toHaveCount(0);
    const back = detail.getByRole("button", { name: "Back to sharing history" });
    await expect(back).toBeFocused();
    await back.click();
    await expect(detail).toBeHidden();
    await expect(history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Sharing", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).getByText("Sample recipient", { exact: true })).toBeVisible();
    // Terminal settle must remove fractional interpolation so the Sharing
    // pane remains fully inside the viewport; live drag keeps its own transform.
    await expect.poll(() => sharing.evaluate((el) => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
    const recipientBounds = (await history.getByRole("button", { name: "View Everyday •••• 4242 shared with Sample recipient", exact: true }).getByText("Sample recipient", { exact: true }).boundingBox())!;
    expect(recipientBounds.x).toBeGreaterThanOrEqual(0);
    expect(recipientBounds.x + recipientBounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
          await expect(page.getByRole("button", { name: "Use a simple design", exact: true })).toHaveCount(0);
          for (let press = 0; press < 4; press++) {
            const button = page.getByRole("button", { name: "Add to Wallet", exact: true });
            await button.evaluate(el => {
              const root = el.closest<HTMLElement>('[data-app-scroll-root="true"]')!;
              root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 2;
            });
            const box = await button.boundingBox();
            if (!box) throw new Error("Add control missing");
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            expect(await alignment()).toBeLessThan(2);
            // Probe the held-control geometry without opening the camera.
            await page.mouse.move(0, 0);
            await page.mouse.up();
            await expect(button).toBeVisible();
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
    await expect(details).toContainText("•••• •••• •••• 4242");
    await expect(page.getByRole("button", { name: "Change card design", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("wallet-selected-card").getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
    await expect(details.getByRole("button", { name: "Copy card number" })).toBeVisible();
    await expect(details.getByTestId("wallet-owner-cvv")).toHaveText("•••");
    await expect(details).not.toContainText(/CVC|PIN/);
    const icons = details.locator('[data-slot="settings-row-icon"] svg');
    await expect(icons).toHaveCount(7);
    expect(await icons.evaluateAll(elements => elements.slice(0, 6).every(icon => {
      const keyAccent = icon.querySelector('defs pattern circle');
      if (keyAccent) {
        const ink = icon.querySelector('defs pattern rect');
        return ink && getComputedStyle(keyAccent).fill === 'rgb(0, 122, 255)' &&
          getComputedStyle(ink).fill !== getComputedStyle(keyAccent).fill &&
          !icon.querySelector('[opacity="0.2"]');
      }
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
    const rupay = page.getByTestId("wallet-add-stack").getByRole("button", { name: "RuPay", exact: true });
    await rupay.focus();
    await rupay.press("Enter");
    const face = page.getByTestId("wallet-selected-card").getByTestId("wallet-card-face");
    await expect(face).toHaveAttribute("data-revealed", "false");
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
    await expectCompactPrimary(dialog.getByRole("button", { name: "Share with 2", exact: true }), 44);
    await expect(dialog).toContainText("Trusted Circle");
    await expect(dialog.getByRole("button", { name: "15 minutes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "1 hour", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "1 hour", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "2 hours", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "2 hours", exact: true })).toHaveAttribute("aria-pressed", "true");
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
    for (const [tab, selector] of [["Cards", '[data-testid="wallet-card-browser"]'], ["Add", '[data-testid="secure-card-add-form"]'], ["Sharing", '[data-testid="wallet-sharing-content"] > section[aria-label="Card sharing history"]']] as const) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const panel = page.locator(selector);
      await expect(panel).toBeVisible();
      await expect(page.getByTestId("one-wallet-add")).toHaveCount(0);
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
        } else if (tab === "Add") {
          await expect(panel.getByRole("heading", { name: "Add your card" })).toHaveCount(0);
          await expect(panel.getByLabel("Card number", { exact: true })).toBeVisible();
          await expect(panel.getByText("Encrypted on this device. Never enters chat.")).toHaveCount(0);
        } else {
          await expect(panel.getByRole("button", { name: "Sent cards", exact: true })).toHaveCount(0);
          await expect(page.getByTestId("wallet-sharing-content").getByRole("region", { name: "Received card history", exact: true })).toBeVisible();
        }
        await expect(panel).toHaveCSS('background-image', 'none');
      }
      await page.screenshot({ path: test.info().outputPath(`wallet-${tab.toLowerCase()}-mail-style.png`) });
    }
  });
}

test("Wallet onboarding opens stacked cards directly", async ({ page }) => {
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
  await expect(page.getByTestId("wallet-add-stack").locator('[data-stack-details] button')).toHaveCount(6);
  const profileDetails = page.getByRole("button", { name: "View details for Agent One Profile", exact: true });
  await expect(profileDetails).toBeInViewport();
  expect((await profileDetails.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await profileDetails.click();
  await expect(page.getByTestId("wallet-selected-card")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await scrollRoot.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const last = page.getByTestId("wallet-add-stack").locator("li").last().getByRole("button").first();
  await last.focus();
  await last.press("Enter");
  await expect(page.getByRole("region", { name: "Saved card details", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("tab", { name: "Sharing", exact: true }).click();
  const sharing = page.getByTestId("wallet-sharing-content");
  await expect(sharing.locator("figure")).toHaveCount(0);
  await expect(sharing.getByRole("button", { name: "Sent cards", exact: true })).toHaveCount(0);
  await expect(sharing.getByRole("region", { name: "Received card history", exact: true })).toBeInViewport();
});

for (const width of [320, 1024]) {
  test(`timed shared profile displays the real card artwork at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light");
    await page.addScriptTag({ content: 'window.__visitorPreview={photo:"",shared:true};' });
    await mount(page, false);
    const face = page.getByTestId("shared-profile-card-face");
    await expect(face.locator('[data-agent-card="profile"]')).toHaveAttribute("data-artwork-ready", "true");
    await expect(face.getByRole("img", { name: "Agent One Profile", exact: true })).toBeVisible();
    const rendered = await face.locator("img").evaluate(async (img: HTMLImageElement) => ({ width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height, svg: await (await fetch(img.src)).text() }));
    expect(rendered.width / rendered.height).toBeCloseTo(ISO_RATIO, 2);
    expect(rendered.svg).toContain("Alex Morgan");
    expect(rendered.svg).not.toContain("data-wallet-qr");
    expect(rendered.svg).not.toContain("MEMBER SINCE");
    expect(rendered.svg).not.toContain("WALLET ID");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("wallet-shared-profile-card.png"), fullPage: true });
  });
}

for (const width of [320, 393, 1024]) {
  test(`Visitor preview keeps photo, details and QR readable at ${width}px`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleErrors.push(message.text()); });
    const errors = await open(page, width, "light", {}, { secure: true });
    const photo = `data:image/webp;base64,${fs.readFileSync(path.join(process.cwd(), "public/ria/onboarding/adv1f.webp")).toString("base64")}`;
    await page.addScriptTag({ content: `window.__visitorPreview = ${JSON.stringify({ photo, long: width === 320 })};` });
    await mount(page, false);
    const card = page.getByTestId("visitor-profile-card");
    await expect(card).toBeVisible();
    await expect(card.locator('[data-slot="avatar-image"]')).toBeVisible();
    await expect(card.getByRole("img", { name: "Hushh profile badge" })).toBeVisible();
    await expect(card.getByRole("img", { name: "Profile QR code", exact: true })).toBeVisible();
    const email = card.locator('a[href^="mailto:"]');
    await email.focus();
    await expect(email).toBeFocused();
    await expect(card.getByRole("link", { name: /Website/ })).toHaveAttribute("rel", "noopener noreferrer");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const overflowing = await card.locator('h1, p, a, figure').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).length);
    expect(overflowing).toBe(0);
    await expect(card.locator('h1')).toHaveCSS('font-size', '20px');
    await expect(card.getByRole('heading', { name: 'About', exact: true })).toHaveCSS('font-size', '11px');
    await expect(email).toHaveCSS('font-size', '13px');
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await email.blur();
    await page.screenshot({ path: testInfo.outputPath(`visitor-${width}.png`), fullPage: true });
  });
  // Keep each real preview → editor → collection journey inside the existing
  // 30s budget. The CI trace completed both kinds but exhausted that compound
  // case; do not raise the timeout, skip a viewport or remove return assertions.
  for (const [kind, title] of [["profile", "Agent One Profile"], ["nws", "Agent One NWS"]] as const) {
    test(`owner ${kind} visitor preview and editor return at ${width}px`, async ({ page }, testInfo) => {
      const errors = await open(page, width, "light", { cards: 0 }, { shell: true, secure: true });
      await mount(page);
      await page.getByRole("button", { name: title, exact: true }).click();
      const face = page.getByTestId("wallet-selected-card").locator("[data-agent-card]");
      await expect(face).toHaveAttribute("data-agent-card", kind);
      await expect(face).toHaveAttribute("data-artwork-ready", "true");
      await page.getByRole("button", { name: /Preview as visitor/ }).click();
      await expect(page.getByTestId("visitor-profile-card")).toBeVisible();
      await expect(face).toBeVisible();
      await expect(page.getByText("Profile card preview", { exact: true })).toHaveCount(0);
      const order = await page.getByTestId("wallet-selected-card").evaluate(el => {
        const face = el.querySelector('[data-agent-card]')!.getBoundingClientRect();
        const visitor = el.querySelector('[data-testid="visitor-profile-card"]')!.getBoundingClientRect();
        return face.bottom <= visitor.top;
      });
      expect(order).toBe(true);
      await expect(page.getByTestId("visitor-profile-card").locator("h1")).toHaveCSS("font-size", "20px");
      await page.screenshot({ path: testInfo.outputPath(`owner-preview-${kind}-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByTestId("visitor-profile-card")).toHaveCount(0);
      await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "card");
      await expect(face).toHaveAttribute("data-agent-card", kind);
      await expect(page.getByRole("button", { name: /Preview as visitor/ })).toBeVisible();
      await page.getByRole("button", { name: /^Edit shared information/ }).click();
      await expect(page.getByTestId("wallet-card-setup-form")).toBeVisible();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByTestId("wallet-card-setup-form")).toHaveCount(0);
      await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "card");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "all");
      expect(errors).toEqual([]);
    });
  }
}
for (const width of [320, 1440]) {
  for (const kind of ["Profile", "Referral", "NWS"] as const) {
    test(`default ${kind} QR revocation updates the link and counts at ${width}px`, async ({ page }, testInfo) => {
      const errors = await open(page, width, "light", { cards: 0 }, { height: 900, shell: true, secure: true });
      await mount(page);
      await page.getByRole("button", { name: "Agent One Profile", exact: true }).click();
      if (kind !== "Profile") await page.getByRole("button", { name: "Next card", exact: true }).click();
      if (kind === "NWS") await page.getByRole("button", { name: "Next card", exact: true }).click();
      const counter = page.getByTestId(kind === "Referral" ? "wallet-referral-opens" : "wallet-profile-scans");
      await expect(counter).toHaveText(kind === "Referral" ? "7" : "3");
      const qr = page.getByRole("img", { name: kind === "Referral" ? "Your referral QR code" : "Your Wallet Profile QR code", exact: true });
      const originalQr = await qr.evaluate(el => el.innerHTML);
      const qrActions = page.getByTestId("wallet-qr-actions");
      const geometry = await qrActions.evaluate(el => {
        const qr = el.querySelector('svg[role="img"]')!.getBoundingClientRect();
        const actions = [...el.querySelectorAll("button")].map(button => {
          const box = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return { x: box.x, right: box.right, y: box.y, bottom: box.bottom, height: box.height, cssHeight: Number.parseFloat(style.height), font: style.fontSize };
        });
        return { qrWidth: qr.width, qrRight: qr.right, right: el.getBoundingClientRect().right, actions };
      });
      expect(geometry.actions).toHaveLength(4);
      expect(geometry.qrWidth).toBeLessThanOrEqual(96);
      geometry.actions.forEach((action, i) => {
        expect(action.x).toBeGreaterThan(geometry.qrRight);
        expect(action.right).toBeLessThanOrEqual(geometry.right);
        expect(action.right - action.x).toBeGreaterThanOrEqual(76);
        // Rect subtraction can yield 43.99994px for a 44px control.
        // Keep the authored height strict and allow only numerical noise.
        expect(action.cssHeight).toBeGreaterThanOrEqual(44);
        expect(action.height).toBeGreaterThanOrEqual(44 - 0.001);
        expect(action.font).toBe("13px");
        if (i % 2 === 1) {
          expect(action.y).toBeCloseTo(geometry.actions[i - 1].y, 0);
          expect(action.x).toBeGreaterThanOrEqual(geometry.actions[i - 1].right);
        }
        if (i >= 2) expect(action.y).toBeGreaterThanOrEqual(geometry.actions[i - 2].bottom);
      });
      await expect(page.getByRole("button", { name: /^Rotate QR access/ })).toHaveCount(0);
      await qrActions.scrollIntoViewIfNeeded();
      await qrActions.screenshot({ path: testInfo.outputPath(`qr-actions-${kind.toLowerCase()}-${width}.png`) });
      if (kind === "Profile") {
        await page.getByRole("button", { name: /^Edit shared information/ }).click();
        const form = page.getByTestId("wallet-card-setup-form");
        await expect(form.getByRole("heading", { name: "Shared information" })).toHaveCount(0);
        await expect(form.locator('[data-wallet-grid-item="photo-row"]')).toHaveCount(0);
        await expect(form.getByLabel("Name", { exact: true })).toBeVisible();
        await form.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      const revoke = page.getByRole("button", { name: "Revoke access", exact: true });
      await revoke.click();
      let dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText(kind === "Referral" ? "earned referrals" : "reset scans for Profile and NWS");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(counter).toHaveText(kind === "Referral" ? "7" : "3");
      expect(await page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("qr-revoke:")))).toEqual([]);
      await revoke.click();
      dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: "Revoke access", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(counter).toHaveText("0");
      await expect.poll(() => qr.evaluate(el => el.innerHTML)).not.toBe(originalQr);
      if (kind === "Referral") {
        await expect(page.getByRole("link", { name: "Preview referral page" })).toHaveAttribute("href", "https://example.test/r/fixture-referral-new");
        await expect(page.getByText("Qualified referrals", { exact: true })).toBeVisible();
        await expect(page.getByText("2", { exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await counter.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`revoke-${kind.toLowerCase()}-${width}.png`) });
      if (kind !== "Referral") {
        if (kind === "NWS") {
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await page.getByRole("button", { name: "Agent One Profile", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "Next card", exact: true }).click();
          await page.getByRole("button", { name: "Next card", exact: true }).click();
        }
        await expect(page.getByTestId("wallet-profile-scans")).toHaveText("0");
      }
      expect(errors).toEqual([]);
    });
  }
}

test("a failed default QR revoke retains the existing link and scans", async ({ page }) => {
  await open(page, 393, "light", { cards: 0, revokeFailure: true }, { shell: true, secure: true });
  await mount(page);
  await page.getByRole("button", { name: "Agent One Profile", exact: true }).click();
  await expect(page.getByTestId("wallet-profile-scans")).toHaveText("3");
  const qr = page.getByRole("img", { name: "Your Wallet Profile QR code", exact: true });
  const originalQr = await qr.evaluate(el => el.innerHTML);
  await page.getByRole("button", { name: "Revoke access", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Revoke access", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.__walletEvents ?? []).filter(event => event.startsWith("qr-revoke:")).length)).toBe(1);
  await expect(dialog.getByRole("button", { name: "Revoke access", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("wallet-profile-scans")).toHaveText("3");
  expect(await qr.evaluate(el => el.innerHTML)).toBe(originalQr);
});

for (const width of [320, 390, 714, 1440]) {
  test(`Wallet Add footer has balanced insets and separate left/right actions at ${width}px`, async ({ page }) => {
    const errors = await open(page, width, "light", { cards: 1 });
    await mount(page);
    await page.getByRole("tab", { name: "Add", exact: true }).click();
    const add = page.getByRole("button", { name: "Add to Wallet", exact: true });
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await expect(add).toBeVisible(); await expect(cancel).toBeVisible();
    // Capture all geometry in one frame; the tab's entering motion translates
    // the whole form and cannot change the footer's relative alignment.
    const geometry = await add.evaluate(el => {
      const form = el.closest("form")!;
      const f = form.getBoundingClientRect(), a = el.getBoundingClientRect();
      const c = form.querySelector('[data-action-priority="secondary"] button')!.getBoundingClientRect();
      return { left: c.left - f.left, right: f.right - a.right, gap: a.left - c.right, y: a.top - c.top };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(19);
    expect(geometry.right).toBeGreaterThanOrEqual(19);
    expect(geometry.gap).toBeGreaterThanOrEqual(11);
    expect(Math.abs(geometry.y)).toBeLessThan(1);
    expect(Math.abs(geometry.left - geometry.right)).toBeLessThan(2);
    expect(errors).toEqual([]);
  });
}

test("Card request review selects a card, sends only to the requester, and clears its route on dismissal", async ({ page }) => {
  const errors = await open(page, 390, "light", { cards: 2, cardRequest: true });
  await mount(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Choose a card to share" })).toBeVisible();
  const send = dialog.getByRole("button", { name: "Share card", exact: true });
  await expect(send).toBeDisabled();
  await dialog.getByRole("radio", { name: /Everyday/ }).check();
  await send.click();
  await expect(dialog.getByText("Card sent", { exact: true })).toBeVisible();
  const sent = await page.evaluate(() => window.__walletEvents?.filter(e => e.startsWith("request-response:")) ?? []);
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0].slice("request-response:".length))).toMatchObject({ cardRequestId: "33333333-3333-4333-8333-333333333333", recipientPersonRefs: ["11111111-1111-4111-8111-111111111111"], durationMinutes: 15 });
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.__walletEvents?.includes("navigate:/one/wallet"))).toBe(true);
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});
