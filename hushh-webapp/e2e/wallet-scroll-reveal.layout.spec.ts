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

const BOTTOM_SHELL_HEIGHT_PX = 132;

const BOUNDARY_MODULES = [
  "next/navigation",
  "@/hooks/use-auth",
  "@/hooks/use-effective-avatar-url",
  "@/lib/referral/use-referral-stream",
  "@/lib/vault/vault-context",
  "@/lib/services/wallet-service",
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

test.use({ hasTouch: true });

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
    if (/^\/wallet\/artwork\/(profile|referral|nws)-v1\.svg$/.test(assetPath)) {
      await route.fulfill({ body:fs.readFileSync(path.join(process.cwd(), "public", assetPath)), contentType:"image/svg+xml", headers:{ "Access-Control-Allow-Origin":"*" } });
      return;
    }
    if (/^\/wallet\/agent-one-card-(profile|referral|nws)\.html$/.test(assetPath)) {
      await route.fulfill({
        body: fs.readFileSync(path.join(process.cwd(), "public", assetPath)),
        contentType: "text/html",
      });
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


for (const viewport of [{ width:390, height:844 }, { width:900, height:600 }, { width:1366, height:768, savedCards:5 }, { width:900, height:1200 }]) {
test(`Wallet scroll reveals lower cards and a left swipe opens the touched card ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await open(page, viewport.width, "light", { cards: viewport.savedCards ?? 0 }, { height: viewport.height, shell: true });
  await mount(page);
  const stack = page.getByTestId("wallet-add-stack");
  await expect(stack).toBeVisible();
  await expect(stack.locator('[data-agent-card][data-artwork-ready="true"]')).toHaveCount(3);
  const scrollRoot = page.locator('[data-app-scroll-root="true"]');
  const layers = stack.locator("li");

  await expect.poll(async () => {
    const boxes = await layers.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
    return boxes[1] - boxes[0];
  }).toBeGreaterThan(180);
  await expect.poll(async () => {
    const boxes = await layers.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
    return boxes[2] - boxes[1];
  }).toBeLessThan(35);
  await expect(page.getByText("Swipe left to see card controls")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("wallet-lower-stack.png") });
  await expect.poll(() => page.locator('[data-swipe-views-root="true"]').evaluate(el => Math.abs(el.getBoundingClientRect().height - document.querySelector('#top-shell-wallet-panel-cards')!.getBoundingClientRect().height))).toBeLessThan(1);
  // Let the initial short-window positioning finish before simulating user scroll.
  await page.waitForTimeout(400);
  const initialGeometry = await layers.evaluateAll(nodes => {
    const first = nodes[0].querySelector('[data-agent-card]')!.getBoundingClientRect();
    const edges = nodes.slice(1, 3).map(node => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.top + 6);
      return { top:box.top, hitOwnCard:hit?.closest('[data-gesture-card]') === node };
    });
    return { first:{ top:first.top, bottom:first.bottom, width:first.width }, edges,
      dockTop:document.querySelector('[data-bottom-chrome]')!.getBoundingClientRect().top,
      zoom:window.visualViewport?.scale ?? 1 };
  });
  expect(initialGeometry.zoom).toBe(1);
  expect(initialGeometry.first.width).toBeGreaterThanOrEqual(260);
  expect(initialGeometry.first.bottom).toBeLessThan(initialGeometry.dockTop - 8);
  expect(initialGeometry.edges[0].top - initialGeometry.first.bottom).toBeGreaterThanOrEqual(44);
  expect(initialGeometry.edges[1].top - initialGeometry.edges[0].top).toBeGreaterThanOrEqual(11.9);
  expect(initialGeometry.edges[1].top + 12).toBeLessThanOrEqual(initialGeometry.dockTop - 7);
  expect(initialGeometry.edges.every(edge => edge.hitOwnCard)).toBe(true);
  const geometryPath = test.info().outputPath("initial-deck-geometry.json");
  fs.writeFileSync(geometryPath, JSON.stringify(initialGeometry, null, 2));
  await test.info().attach("initial-deck-geometry", { path:geometryPath, contentType:"application/json" });
  const firstFace = await layers.first().locator('[data-agent-card]').boundingBox();
  if (!firstFace) throw new Error("Featured card bounds missing");
  const previousScroll = await scrollRoot.evaluate(root => root.scrollTop);
  await page.mouse.move(firstFace.x + firstFace.width / 2, firstFace.y + firstFace.height / 2);
  await page.mouse.wheel(0, 220);
  await expect.poll(() => scrollRoot.evaluate(root => root.scrollTop)).toBeGreaterThan(previousScroll);
  // Continue over the surrounding gutter: native scrolling owns both surfaces.
  const rootBox = await scrollRoot.boundingBox();
  if (!rootBox) throw new Error("Scroll root bounds missing");
  await page.mouse.move(rootBox.x + 8, rootBox.y + rootBox.height / 2);
  await page.mouse.wheel(0, 2000);
  await expect(stack).toHaveAttribute("data-unfolded", "true");
  await expect(page.getByRole("tab", { name:"Cards", exact:true })).toHaveAttribute("aria-selected","true");
  await expect.poll(() => layers.evaluateAll(nodes => {
    const boxes = nodes.map(n => n.getBoundingClientRect());
    return boxes.slice(1).every((box,i) => box.top >= boxes[i].bottom + 15 && Math.abs(box.left - boxes[0].left) < 1 && Math.abs(box.right - boxes[0].right) < 1);
  })).toBe(true);
  expect(await scrollRoot.evaluate(root => root.scrollWidth <= root.clientWidth + 1)).toBe(true);
  // WebKit can report 43.99997 after transform composition; CSS still owns 44px.
  expect(await stack.locator('[data-stack-details] button').evaluateAll(buttons => buttons.every(button => parseFloat(getComputedStyle(button).height) >= 44 && Math.round(button.getBoundingClientRect().height) >= 44))).toBe(true);
  await expect(stack.locator('[data-card-details-label]')).toHaveCount(3 + (viewport.savedCards ?? 0));
  expect(await stack.locator('[data-card-details-label]').evaluateAll(labels => labels.every(label => label.getBoundingClientRect().height <= 28))).toBe(true);
  await page.screenshot({ path: test.info().outputPath("wallet-unfolded.png") });
  const card = layers.nth(1);
  await card.scrollIntoViewIfNeeded();
  const face = card.locator('[data-agent-card]').first();
  const box = await face.boundingBox();
  if (!box) throw new Error("Card bounds missing");
  await page.mouse.move(box.x + box.width - 25, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 35, box.y + 82, { steps:12 });
  await page.mouse.up();
  await expect(card.locator('[data-controls-open="true"]')).toBeVisible();
  await expect(page.getByRole("tab", { name:"Cards", exact:true })).toHaveAttribute("aria-selected","true");
  await card.getByRole("button", { name:"Back to card", exact:true }).click();
  await expect(card.locator('[data-controls-open="false"]')).toBeVisible();
  // Focus can scroll the card into a new position in WebKit. Hit its current
  // surface rather than replaying coordinates from before the close action.
  await card.locator('[data-controls-open]').hover({ position: { x: box.width / 2, y: 80 } });
  await page.mouse.wheel(170, 0);
  await expect(card.locator('[data-controls-open="true"]')).toBeVisible();
  await page.mouse.wheel(-220, 0);
  await expect(card.locator('[data-controls-open="false"]')).toBeVisible();
  await page.mouse.wheel(170, 0);
  await expect(card.locator('[data-controls-open="true"]')).toBeVisible();
  await expect(card.locator('[data-card-controls]').getByText("Username", { exact:true })).toBeVisible();
  await expect(card.locator('[data-card-controls]').getByRole("button", { name:"View details", exact:true })).toHaveCount(0);
  await card.getByRole("button", { name:"Back to card", exact:true }).click();
  await card.getByRole("button", { name:"View details for Agent One Referral", exact:true }).click();
  await expect(page.getByRole("region", { name: "Referral card details" })).toBeVisible();
  expect(await page.evaluate(() => window.__walletEvents ?? [])).toEqual([]);
  await page.getByRole("button", { name:"All cards", exact:true }).click();
  await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "all");
});

}

test("A native vertical touch pan scrolls the deck without opening details", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Native touch injection uses the Chromium input protocol.");
  await open(page, 390, "light", { cards: 0 }, { height: 844, shell: true });
  await mount(page);
  const root = page.locator('[data-app-scroll-root="true"]');
  await page.waitForTimeout(400);
  const before = await root.evaluate(element => element.scrollTop);
  const face = await page.locator('[data-agent-card="profile"]').boundingBox();
  if (!face) throw new Error("Featured card bounds missing");
  const cdp = await context.newCDPSession(page);
  const x = face.x + face.width / 2;
  const y = face.y + face.height - 20;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 24 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => root.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
  await expect(page.getByTestId("wallet-card-browser")).toHaveAttribute("data-mode", "all");
  await expect(page.getByRole("tab", { name: "Cards", exact: true })).toHaveAttribute("aria-selected", "true");
  await cdp.detach();
});

test("Reduced motion shows an accessible vertical list without requiring a gesture", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, 390, "dark", { cards: 0 }, { height: 844, shell: true });
  await mount(page);
  const stack = page.getByTestId("wallet-add-stack");
  await expect(stack).toHaveAttribute("data-unfolded", "true");
  await expect.poll(() => stack.locator("li").evaluateAll(nodes => {
    const boxes = nodes.map(node => node.getBoundingClientRect());
    return boxes.slice(1).every((box, index) => box.top >= boxes[index].bottom + 15);
  })).toBe(true);
});
