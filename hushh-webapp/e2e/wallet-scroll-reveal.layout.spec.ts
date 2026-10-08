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


for (const viewport of [{ width:390, height:844 }, { width:900, height:600 }]) {
test(`Wallet scroll reveals lower cards and a left swipe opens the touched card ${viewport.width}`, async ({ page }) => {
  await open(page, viewport.width, "light", { cards: 0 }, { height: viewport.height, shell: true });
  await mount(page);
  const stack = page.getByTestId("wallet-preview-stack");
  await expect(stack).toBeVisible();
  const dockHost = page.getByTestId("wallet-card-dock-host");
  await expect.poll(async () => (await dockHost.boundingBox())?.height ?? 999).toBeLessThanOrEqual(56);
  await expect(dockHost).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect.poll(() => dockHost.evaluate(host => {
    const bounds = host.getBoundingClientRect();
    const bar = host.querySelector("nav")!.getBoundingClientRect();
    return bounds.left <= bar.left && bounds.right >= bar.right && bounds.bottom > bar.bottom;
  })).toBe(true);
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
  await expect.poll(async () => {
    const face = await layers.first().locator('[data-demo-card]').boundingBox();
    const dock = await dockHost.boundingBox();
    return Boolean(face && dock && face.y + face.height < dock.y);
  }).toBe(true);
  await page.screenshot({ path: test.info().outputPath("wallet-lower-stack.png") });
  await expect.poll(() => page.locator('[data-swipe-views-root="true"]').evaluate(el => Math.abs(el.getBoundingClientRect().height - document.querySelector('#top-shell-wallet-panel-cards')!.getBoundingClientRect().height))).toBeLessThan(1);
  // Let the initial short-window positioning finish before simulating user scroll.
  await page.waitForTimeout(400);
  await page.locator("[data-app-scroll-root]").evaluate(root => {
    const stack = root.querySelector('[data-testid="wallet-preview-stack"]')!;
    root.scrollTop += stack.getBoundingClientRect().top - root.getBoundingClientRect().top + 350;
  });
  await expect(stack).toHaveAttribute("data-unfolded", "true");
  await expect(page.getByTestId("wallet-card-switcher")).toBeHidden();
  await page.locator("[data-app-scroll-root]").evaluate(root => { root.scrollTop -= 10; });
  await expect(page.getByTestId("wallet-card-switcher")).toBeVisible();
  await expect.poll(() => layers.evaluateAll(nodes => {
    const boxes = nodes.map(n => n.getBoundingClientRect());
    return boxes.slice(1).every((box,i) => box.top >= boxes[i].bottom + 15);
  })).toBe(true);
  const card = layers.nth(1);
  await card.scrollIntoViewIfNeeded();
  const face = card.locator('[data-demo-card]').first();
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
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  await page.mouse.wheel(170, 0);
  await expect(card.locator('[data-controls-open="true"]')).toBeVisible();
  await page.mouse.wheel(-220, 0);
  await expect(card.locator('[data-controls-open="false"]')).toBeVisible();
  await page.mouse.wheel(170, 0);
  await expect(card.locator('[data-controls-open="true"]')).toBeVisible();
  await card.getByRole("button", { name:"View card details", exact:true }).click();
  await expect(page.getByTestId("wallet-demo-details")).toContainText("Travel card");
  await page.getByRole("button", { name:"All cards", exact:true }).click();
  await expect(page.getByTestId("wallet-card-switcher")).toBeVisible();
});

}
