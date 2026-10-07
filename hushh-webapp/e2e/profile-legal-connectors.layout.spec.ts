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
 * Legal and Connectors are Profile sections, read and managed inside the
 * Profile pane (founder, 2026-10-02). The production ProfilePane, legal
 * reader, Legal and Connectors stack entries and pane navigation run here;
 * only routing, the vault gate and the heavy Profile workspace are stood in
 * for (e2e/fixtures/profile-legal-connectors-boundaries.tsx).
 *
 * Before: Profile's Legal rows left the pane for the full-screen /terms page,
 * and chat's Connectors opened a drawer of its own. Every test below fails on
 * that code.
 */

let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-legal-connectors-"));
  const boundary = path.join(root, "e2e/fixtures/profile-legal-connectors-boundaries.tsx");
  const exact = (id: string) => new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
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
    resolve: {
      alias: [
        ...[
          "@/hooks/use-auth",
          "@/lib/vault/vault-context",
          "@/lib/services/api-service",
          "./api-service",
          "@/lib/services/auth-service",
          "./auth-service",
          "./agent-chat-client",
          "@/lib/capacitor",
          "@/lib/profile/gmail-connector-store",
          "@/lib/services/gmail-receipts-service",
          "@/lib/calendar/use-calendar-connection-status",
          "@/lib/pkm/pkm-domain-resource",
          "@/lib/kai/plaid-vault/vault-sync",
          "@/lib/connections/custom-connector-configuration",
          "@/components/profile/profile-workspace-page",
          "next/navigation",
        ].map((find) => ({ find: exact(find), replacement: boundary })),
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
        entry: path.join(root, "e2e/fixtures/profile-legal-connectors.tsx"),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

async function mount(
  page: Page,
  options: { width?: number; theme?: "light" | "dark"; at?: string } = {},
) {
  const { width = 393, theme = "light", at = "/" } = options;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 852 });
  await page.route(/\/icons\/connectors\/(?:gmail|drive|calendar|plaid)\.svg$/, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }),
  );
  await page.route("**/api/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ features: {}, connectors: [], documents: [] }),
    }),
  );
  await page.route(/^http:\/\/localhost\/(?!api\/|icons\/)/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><title>Profile Legal and Connectors</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
  await page.goto(`http://localhost${at}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  return errors;
}

const pane = (page: Page) => page.getByTestId("profile-pane");
const paneTitle = (page: Page) => pane(page).locator("h2").first();

function query(page: Page) {
  return new URL(page.url()).searchParams;
}

test("Profile root and nested screens share one gutter", async ({ page }) => {
  for (const width of [320, 393, 768]) {
    await mount(page, { width, at: "/one?profile_pane=1" });
    // A visible sheet can still be travelling in from the right. Measure
    // only its settled grid, not the opening animation's translated frame.
    await expect.poll(async () => {
      const frame = await pane(page).boundingBox();
      return frame ? Math.abs(frame.x + frame.width - width) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(0.5);
    const cardEdges = () => pane(page).locator("[data-profile-stack-active='true'] [data-slot='settings-group-shell']").first().evaluate(node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right };
    });
    const root = await cardEdges();
    await page.getByTestId("profile-account-row").getByRole("button").click();
    await expect(paneTitle(page)).toHaveText(/account/i);
    await expect.poll(async () => Math.abs((await cardEdges()).left - root.left)).toBeLessThanOrEqual(0.5);
    await expect.poll(async () => Math.abs((await cardEdges()).right - root.right)).toBeLessThanOrEqual(0.5);
    await pane(page).getByRole("button", { name: /back/i }).click();
    await page.getByTestId("profile-legal-terms-row").getByRole("button").click();
    const reader = pane(page).getByTestId("legal-reader-terms");
    await expect(reader).toBeVisible();
    await expect.poll(async () => Math.abs((await reader.boundingBox())!.x - root.left)).toBeLessThanOrEqual(0.5);
    const legal = await reader.boundingBox();
    expect(Math.abs(legal!.x - root.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(legal!.x + legal!.width - root.right)).toBeLessThanOrEqual(0.5);
  }
});

test("Legal opens in place in the Profile pane and Back returns to Profile", async ({ page }) => {
  const errors = await mount(page, { at: "/one" });
  await page.getByTestId("open-profile").click();
  await expect(pane(page)).toBeVisible();

  await page.getByTestId("profile-legal-terms-row").getByRole("button").click();
  await expect(paneTitle(page)).toHaveText("Terms of Use");
  await expect(pane(page).getByTestId("legal-reader-terms")).toBeVisible();
  // Still the screen under the pane; never the public page.
  expect(new URL(page.url()).pathname).toBe("/one");
  expect(query(page).get("profile_panel")).toBe("legal");
  expect(query(page).get("profile_detail")).toBe("terms");

  // The other document swaps in place, without stacking a history entry.
  await pane(page).getByTestId("legal-reader-open-privacy").getByRole("button").click();
  await expect(paneTitle(page)).toHaveText("Privacy Policy");
  expect(query(page).get("profile_detail")).toBe("privacy");

  await page.getByRole("button", { name: "Back in Profile" }).click();
  await expect(paneTitle(page)).toHaveText("Profile");
  await expect(
    pane(page).locator("[data-profile-stack-active='true']").getByTestId("profile-legal-terms-row"),
  ).toBeVisible();
  expect(query(page).get("profile_panel")).toBeNull();
  expect(new URL(page.url()).pathname).toBe("/one");
  expect(errors).toEqual([]);
});

test("a direct Legal address climbs to the Legal section, then Profile", async ({ page }) => {
  await mount(page, { at: "/one?profile_pane=1&profile_panel=legal&profile_detail=privacy" });
  await expect(paneTitle(page)).toHaveText("Privacy Policy");
  await page.getByRole("button", { name: "Back in Profile" }).click();
  await expect(paneTitle(page)).toHaveText("Legal");
  await expect(
    pane(page).locator("[data-profile-stack-active='true']").getByTestId("profile-legal-privacy-row"),
  ).toBeVisible();
});

for (const [entry, act, expectedDetail] of [
  ["the Profile row", async (page: Page) => {
    await page.getByTestId("open-profile").click();
    await pane(page).getByTestId("profile-connectors-row").getByRole("button").click();
  }, null],
  ["a Drive card's reconnect link", async (page: Page) => {
    await page.getByTestId("drive-card-reconnect").click();
  }, "connector:google_drive"],
  ["chat's Open connectors", async (page: Page) => {
    await page.getByTestId("chat-open-connectors").click();
  }, null],
] as const) {
  test(`Connectors from ${entry} lands in the Profile pane`, async ({ page }) => {
    const errors = await mount(page, { at: "/" });
    await act(page);
    await expect(pane(page)).toBeVisible();
    await expect(pane(page).locator("[data-surface='profile']")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    expect(query(page).get("profile_pane")).toBe("1");
    expect(query(page).get("profile_panel")).toBe("connectors");
    expect(query(page).get("profile_detail")).toBe(expectedDetail);
    expect(errors).toEqual([]);
  });
}

test("Back from Connectors opened in chat returns to the chat", async ({ page }) => {
  await mount(page, { at: "/" });
  await page.getByTestId("chat-open-connectors").click();
  await expect(paneTitle(page)).toHaveText("Connectors");
  await page.getByRole("button", { name: "Back in Profile" }).click();
  await expect(pane(page)).toHaveCount(0);
  expect(query(page).get("profile_pane")).toBeNull();
  await expect(page.getByTestId("host-screen")).toBeVisible();
});

for (const at of ["/?profile_pane=1&profile_panel=connectors", "/one?profile_pane=1&profile_panel=connectors"]) {
  test(`a connector sign-in return (${at.split("?")[0]}) lands on Connectors in the pane`, async ({ page }) => {
    await mount(page, { at });
    await expect(paneTitle(page)).toHaveText("Connectors");
    await expect(pane(page).locator("[data-surface='profile']")).toBeVisible();
  });
}

type ReaderGeometry = {
  left: number;
  right: number;
  overflow: number;
  articleGap: string;
  sectionGap: string;
  minRowHeight: number;
};

async function readerGeometry(page: Page): Promise<ReaderGeometry> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-profile-pane-scroll-root='true']")!;
    const article = root.querySelector<HTMLElement>("[data-legal-document]")!;
    const r = root.getBoundingClientRect();
    const a = article.getBoundingClientRect();
    const innerLeft = r.left + root.clientLeft;
    const innerRight = innerLeft + root.clientWidth;
    const rows = [...article.querySelectorAll<HTMLElement>("[data-testid^='legal-reader-contents-'] button")];
    return {
      left: a.left - innerLeft,
      right: innerRight - a.right,
      overflow: root.scrollWidth - root.clientWidth,
      articleGap: getComputedStyle(article).rowGap,
      sectionGap: getComputedStyle(article.querySelector("[data-testid='legal-reader-body'] > section")!).rowGap,
      minRowHeight: Math.min(...rows.map((row) => row.getBoundingClientRect().height)),
    };
  });
}

function assertReaderGeometry(geometry: ReaderGeometry, label: string) {
  expect(Math.abs(geometry.left - geometry.right), `${label}: equal side insets`).toBeLessThanOrEqual(0.5);
  expect(geometry.left % 4, `${label}: inset on the 4pt grid`).toBeLessThanOrEqual(0.5);
  expect(geometry.overflow, `${label}: no sideways scroll`).toBeLessThanOrEqual(0);
  expect(geometry.articleGap, `${label}: 32px between reader blocks`).toBe("32px");
  expect(geometry.sectionGap, `${label}: 12px inside a section`).toBe("12px");
  expect(geometry.minRowHeight, `${label}: contents rows are 44px targets`).toBeGreaterThanOrEqual(44);
}

for (const width of [320, 393, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`the in-pane reader is symmetric on the 4pt grid at ${width}px ${theme}`, async ({ page }) => {
      const errors = await mount(page, {
        width,
        theme,
        at: "/one?profile_pane=1&profile_panel=legal&profile_detail=terms",
      });
      await expect(pane(page).getByTestId("legal-reader-terms")).toBeVisible();
      assertReaderGeometry(await readerGeometry(page), `${width}px ${theme}`);
      // CI's Linux faces set wider than a Mac. Widen on purpose.
      await page.addStyleTag({ content: "[data-legal-document] *{letter-spacing:0.03em}" });
      assertReaderGeometry(await readerGeometry(page), `${width}px ${theme} widened`);
      expect(errors).toEqual([]);
    });
  }
}

// Review renders for the founder, written only when LEGAL_RENDER_DIR is set.
test.describe("review renders", () => {
  test.skip(!process.env.LEGAL_RENDER_DIR, "set LEGAL_RENDER_DIR to write review renders");
  for (const [width, theme] of [[393, "light"], [393, "dark"], [1440, "light"]] as const) {
    test(`pane renders at ${width}px ${theme}`, async ({ page }) => {
      const dir = process.env.LEGAL_RENDER_DIR!;
      for (const [name, at] of [
        ["pane-legal-terms", "/one?profile_pane=1&profile_panel=legal&profile_detail=terms"],
        ["pane-legal-section", "/one?profile_pane=1&profile_panel=legal"],
        ["pane-connectors", "/?profile_pane=1&profile_panel=connectors"],
      ] as const) {
        await mount(page, { width, theme, at });
        await expect(pane(page)).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(dir, `${name}-${width}-${theme}.png`) });
      }
    });
  }
});
