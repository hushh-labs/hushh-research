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
          "@/lib/services/auth-service",
          "@/lib/vault/vault-context",
          "@/lib/services/api-service",
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
      copyPublicDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/profile-legal-connectors.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const componentCss = fs.readdirSync(outDir)
    .filter((name) => name.endsWith(".css"))
    .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
    .join("\n");
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
  const { transform } = await import("lightningcss");
  css = transform({ filename: "profile-legal.css", code: Buffer.from(stripAppFontFaces(compiler.build([...candidates])) + componentCss + productFontStyle()), minify: true }).code.toString();
});

async function mount(
  page: Page,
  options: { width?: number; theme?: "light" | "dark"; at?: string; regions?: { top: number; bottom: number; fullWindow?: boolean } } = {},
) {
  const { width = 393, theme = "light", at = "/", regions } = options;
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
      body: `<!doctype html><html class="${theme === "dark" ? "dark" : ""} ${regions ? "native-reserved-chrome" : ""} ${regions?.fullWindow ? "native-full-window-overlays" : ""}" ${regions ? `style="--native-overlay-top:${regions.fullWindow ? 0 : regions.top}px;--native-overlay-bottom:${regions.fullWindow ? 0 : regions.bottom}px"` : ""} ${regions?.fullWindow ? "data-native-full-window-covered" : ""}><head><title>Profile Legal and Connectors</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
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

for (const theme of ["light", "dark"] as const) for (const width of [390, 1440]) {
  test(`Profile header has one smaller round surface per control at ${width}px ${theme}`, async ({ page }) => {
    const errors = await mount(page, { width, theme, at: "/one?profile_pane=1&profile_panel=account" });
    await expect(paneTitle(page)).toHaveText("Your account");
    const close = pane(page).getByRole("button", { name: "Close Profile", exact: true });
    const back = pane(page).getByRole("button", { name: "Back in Profile", exact: true });
    const material = () => pane(page).evaluate(node => {
      const slot = node.querySelector('.profile-pane-close')!;
      const style = getComputedStyle(slot);
      return { background: style.backgroundColor, border: style.borderTopWidth, transform: style.transform };
    });
    for (const control of [back, close]) {
      const geometry = await control.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const circle = getComputedStyle(node, "::before");
        const ripple = node.querySelector('.morphy-ripple-host')!.getBoundingClientRect();
        return { width: rect.width, height: rect.height, background: style.backgroundColor,
          border: style.borderTopWidth, diameter: rect.width - parseFloat(circle.left) - parseFloat(circle.right),
          radius: circle.borderRadius, rippleWidth: ripple.width };
      });
      expect(geometry.width).toBe(44);
      expect(geometry.height).toBe(44);
      expect(geometry.background).toBe("rgba(0, 0, 0, 0)");
      expect(geometry.border).toBe("0px");
      expect(geometry.diameter).toBeCloseTo(44 * 0.78, 1);
      expect(geometry.rippleWidth).toBeCloseTo(44 * 0.78, 1);
      expect(geometry.radius).toBe("50%");
    }
    await close.hover();
    await expect.poll(material).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", transform: "none" });
    await pane(page).locator('.profile-pane-header').screenshot({ path: test.info().outputPath("profile-header.png") });
    // The retained invisible outer edge still activates Back, not just the
    // smaller painted circle. Closing then remains available from the keyboard.
    await back.click({ position: { x: 1, y: 22 } });
    await expect(paneTitle(page)).toHaveText("Profile");
    await close.focus();
    await page.keyboard.press("Enter");
    await expect(pane(page)).not.toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("Profile header, Preferences and body follow one whole-panel pull without replaying entrance", async ({ page }) => {
  await mount(page, { at: "/one?profile_pane=1&profile_panel=preferences" });
  const preferences = pane(page).locator("[data-profile-stack-active='true']");
  await expect(preferences.getByText("Appearance", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const box = await pane(page).boundingBox();
    return box ? Math.abs(box.x + box.width - page.viewportSize()!.width) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(1);
  const controlEdges = await preferences.evaluate(node => {
    const theme = node.querySelector('[role="radiogroup"]')!;
    const appearance = theme.getBoundingClientRect();
    const accent = node.querySelector('[role="combobox"]')!.getBoundingClientRect();
    return { appearance: appearance.right, accent: accent.right,
      appearanceWidth: appearance.width, accentWidth: accent.width,
      appearanceTargetHeight: appearance.height, accentTargetHeight: accent.height,
      appearanceTrackHeight: theme.firstElementChild!.getBoundingClientRect().height,
      accentTrackHeight: node.querySelector('[data-slot="accent-control-surface"]')!.getBoundingClientRect().height };
  });
  expect(Math.abs(controlEdges.appearance - controlEdges.accent)).toBeLessThanOrEqual(1);
  expect(controlEdges.accentWidth).toBe(138);
  expect(controlEdges.accentWidth).toBe(controlEdges.appearanceWidth);
  expect(controlEdges.accentTargetHeight).toBeGreaterThanOrEqual(44);
  expect(controlEdges.accentTargetHeight).toBe(controlEdges.appearanceTargetHeight);
  expect(controlEdges.accentTrackHeight).toBe(36);
  expect(controlEdges.accentTrackHeight).toBe(controlEdges.appearanceTrackHeight);
  const accentChoice = preferences.getByRole("combobox", { name: "App accent color" });
  await accentChoice.click();
  await page.getByRole("option", { name: "Molten Gold", exact: true }).click();
  await expect(accentChoice).toContainText("Molten Gold");
  const label = accentChoice.getByText("Molten Gold", { exact: true });
  // Linux's product face is wider; reserve space beyond the local font metric.
  await label.evaluate(node => { (node as HTMLElement).style.letterSpacing = "0.03em"; });
  expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await accentChoice.click();
  await page.getByRole("option", { name: "Blue", exact: true }).click();
  await expect(accentChoice).toContainText("Blue");
  await preferences.screenshot({ path: test.info().outputPath("profile-appearance-controls.png") });
  const measured = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-testid="profile-pane"]')!;
    const body = frame.querySelector<HTMLElement>('[data-profile-pane-scroll-root="true"]')!;
    const title = frame.querySelector("h2")!;
    const controls = frame.querySelector("[data-profile-stack-active='true']")!;
    const before = [title.getBoundingClientRect().x, controls.getBoundingClientRect().x, body.getBoundingClientRect().x];
    const dispatch = (type: string, x: number, time: number) => {
      const point = { identifier: 1, clientX: x, clientY: 320 };
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { touches: { value: [point] }, changedTouches: { value: [point] }, timeStamp: { value: time } });
      body.dispatchEvent(event);
    };
    dispatch("touchstart", 120, 100); dispatch("touchmove", 170, 220);
    const after = [title.getBoundingClientRect().x, controls.getBoundingClientRect().x, body.getBoundingClientRect().x];
    const frameTransform = frame.style.transform;
    dispatch("touchcancel", 170, 240);
    return { before, after, frameTransform, appearanceCount: frame.querySelectorAll('[role="radiogroup"][aria-label="Theme"]').length };
  });
  expect(measured.after[0]! - measured.before[0]!).toBeCloseTo(50, 0);
  expect(measured.after[1]! - measured.before[1]!).toBeCloseTo(50, 0);
  expect(measured.after[2]! - measured.before[2]!).toBeCloseTo(50, 0);
  expect(measured.frameTransform).toBe("translate3d(50px, 0px, 0px)");
  expect(measured.appearanceCount).toBe(1);
  await expect(pane(page)).toBeVisible(); // Cancellation never commits dismissal.
  // Observe settlement cleanup, where removing animation suppression used to
  // replay the entire opening slide. A settled screenshot cannot catch it.
  const afterCancellation = await pane(page).evaluate(async frame => {
    const parentRight = frame.parentElement!.getBoundingClientRect().right;
    let worstSettledOffset = 0;
    const started = performance.now();
    while (performance.now() - started < 550) {
      await new Promise(requestAnimationFrame);
      if (!frame.style.transform) worstSettledOffset = Math.max(worstSettledOffset,
        Math.abs(frame.getBoundingClientRect().right - parentRight));
    }
    return { worstSettledOffset, inlineTransform: frame.style.transform };
  });
  expect(afterCancellation.inlineTransform).toBe("");
  expect(afterCancellation.worstSettledOffset).toBeLessThanOrEqual(1);
});

test("Accent stays coherent through repeated selection and Profile close/reopen", async ({ page }) => {
  // Ten full open/menu/selection/close cycles, not one 30s interaction.
  test.setTimeout(60_000);
  const errors = await mount(page, { at: "/one?profile_pane=1&profile_panel=preferences" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const trigger = page.getByRole("combobox", { name: "App accent color" });
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const accent = cycle % 2 === 0 ? "Molten Gold" : "Blue";
    await trigger.click();
    const option = page.getByRole("option", { name: accent, exact: true });
    await expect(option).toBeVisible();
    expect(await option.evaluate(node => {
      const frame = node.getBoundingClientRect();
      const hit = document.elementFromPoint(frame.x + frame.width / 2, frame.y + frame.height / 2);
      return !!hit && node.contains(hit);
    })).toBe(true);
    await option.click();
    await expect(trigger).toContainText(accent);
    if (accent === "Molten Gold") await expect(page.locator("html")).toHaveAttribute("data-accent", "gold");
    else await expect(page.locator("html")).not.toHaveAttribute("data-accent", /.+/);
    await page.getByRole("button", { name: "Close Profile", exact: true }).click();
    await expect(pane(page)).not.toBeVisible();
    await page.getByTestId("open-profile").click();
    await expect(pane(page)).toBeVisible();
    await page.getByTestId("profile-preferences-row").click();
    await expect(trigger).toContainText(accent);
  }
  expect(errors).toEqual([]);
});

function query(page: Page) {
  return new URL(page.url()).searchParams;
}

for (const width of [390, 1280])
  for (const theme of ["light", "dark"] as const)
    test(`Profile keeps the opaque theme canvas at ${width}px in ${theme}`, async ({ page }, info) => {
      const errors = await mount(page, { width, theme });
      const readCanvas = () => page.evaluate(() => {
        const swatch = document.createElement("div");
        swatch.style.backgroundColor = "var(--background)";
        document.body.append(swatch);
        const color = getComputedStyle(swatch).backgroundColor;
        swatch.remove();
        return { color, route: [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor] };
      });
      const before = await readCanvas();
      await page.getByTestId("open-profile").click();
      await expect(page.getByTestId("profile-account-row")).toBeVisible();
      await expect(pane(page)).toHaveCSS("background-color", before.color);
      expect(before.color).toMatch(/^rgb\([^)]+\)$/);
      expect((await readCanvas()).route).toEqual(before.route);
      await pane(page).screenshot({ path: info.outputPath("profile-theme-canvas.png"), animations: "disabled" });
      await pane(page).getByRole("button", { name: "Close Profile", exact: true }).click();
      await expect(pane(page)).not.toBeVisible();
      expect((await readCanvas()).route).toEqual(before.route);
      expect(errors).toEqual([]);
    });

test("Profile root and nested screens share one gutter", async ({ page }) => {
  for (const options of [{ width: 320 }, { width: 393 }, { width: 768 },
    { width: 393, regions: { top: 120, bottom: 280 } },
    { width: 393, regions: { top: 120, bottom: 280, fullWindow: true } }]) {
    const { width, regions } = options;
    const fullWindow = regions?.fullWindow || !regions && width < 640;
    const rightInset = fullWindow ? 0 : width < 640 ? 12 : 18;
    await mount(page, { ...options, at: "/one?profile_pane=1" });
    // A visible sheet can still be travelling in from the right. Measure
    // only its settled grid, not the opening animation's translated frame.
    // Phones are edge-to-edge unless a bounded native reservation is active;
    // desktop and bounded native panes retain their independent outer gutter.
    await expect.poll(async () => {
      const frame = await pane(page).boundingBox();
      return frame ? Math.abs(frame.x + frame.width - (width - rightInset)) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(0.5);
    if (regions) {
      const box = (await pane(page).boundingBox())!;
      expect(box.y).toBeCloseTo(regions.fullWindow ? 0 : regions.top, 0);
      expect(box.y + box.height).toBeCloseTo(regions.fullWindow ? 852 : 852 - regions.bottom, 0);
    }
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

for (const width of [320, 390, 768, 1440])
  test(`Mail reconnect receipt preserves draft and returns focus at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mount(page, { width });
    const draft = page.getByRole("textbox", { name: "Chat draft" });
    await draft.fill("Keep this draft and conversation");
    const original = await draft.elementHandle();
    const receipt = page.getByRole("region", { name: "Mail read details" });
    await expect(receipt).toHaveText(/Reconnect Mail to continue/);
    // The receipt names the connector and what the person will do there.
    const button = receipt.getByRole("button", { name: "Review Gmail access" });
    const bounds = (await button.boundingBox())!;
    expect(bounds.height + 0.0001).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await button.click();
    await expect(paneTitle(page)).toHaveText("Gmail");
    await page.getByRole("button", { name: "Close Profile", exact: true }).click();
    await expect(pane(page)).not.toBeVisible();
    await expect(button).toBeFocused();
    await expect(draft).toHaveValue("Keep this draft and conversation");
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByTestId("stream")).toHaveText("Streaming turn 1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await testInfo.attach("Mail reconnect receipt", { body: await page.screenshot({ path: testInfo.outputPath("mail-receipt.png") }), contentType: "image/png" });
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

test("Connector pane text uses the Profile account scale", async ({ page }) => {
  await mount(page, { at: "/?profile_pane=1&profile_panel=connectors" });
  const size = (selector: string) =>
    pane(page).locator(selector).first().evaluate((element) => getComputedStyle(element).fontSize);

  await expect(pane(page).getByTestId("profile-connector-row-calendar")).toBeVisible();
  expect(await size('[data-testid="profile-connectors-available"] [data-slot="settings-group-heading"]')).toBe("10px");
  expect(await size('[data-testid="profile-connector-row-calendar"] [data-slot="settings-row-title"]')).toBe("13px");
  expect(await size('[data-testid="profile-connector-row-calendar"] [data-slot="settings-row-description"]')).toBe("12px");

  await mount(page, {
    at: "/?profile_pane=1&profile_panel=connectors&profile_detail=connector:calendar",
  });
  const detail = pane(page).locator('[data-connector-detail="calendar"]');
  await expect(detail).toBeVisible();
  expect(await size('[data-connector-detail="calendar"] h3')).toBe("13px");
  expect(await size('[data-connector-detail="calendar"] p.text-muted-foreground')).toBe("12px");
});

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
    for (const type of ["terms", "privacy"] as const) {
    test(`the in-pane ${type} reader is symmetric on the 4pt grid at ${width}px ${theme}`, async ({ page }) => {
      const errors = await mount(page, {
        width,
        theme,
        at: `/one?profile_pane=1&profile_panel=legal&profile_detail=${type}`,
      });
      const reader = pane(page).getByTestId(`legal-reader-${type}`);
      await expect(reader).toBeVisible();
      assertReaderGeometry(await readerGeometry(page), `${width}px ${theme}`);
      const typography = await reader.evaluate(article => {
        const size = (selector: string) => [...article.querySelectorAll(selector)].map(node => getComputedStyle(node).fontSize);
        const weights = (selector: string) => [...article.querySelectorAll(selector)].map(node => getComputedStyle(node).fontWeight);
        // The same production markup outside Profile keeps the public scale.
        const publicArticle = article.cloneNode(true) as HTMLElement;
        document.body.appendChild(publicArticle);
        const publicBody = getComputedStyle(publicArticle.querySelector('.ui-text-body')!).fontSize;
        const publicHeading = getComputedStyle(publicArticle.querySelector('.ui-text-section-title')!).fontSize;
        publicArticle.remove();
        return { body: size('.ui-text-body'), headings: size('.ui-text-section-title, .ui-text-headline'),
          weights: weights('.ui-text-section-title, .ui-text-headline'),
          metadata: getComputedStyle(article.querySelector('[data-testid="legal-reader-meta"]')!).fontSize,
          publicBody, publicHeading };
      });
      expect(typography.body.length).toBeGreaterThan(0);
      expect(typography.body.every(size => size === "13px")).toBe(true);
      expect(typography.headings.every(size => size === "13px")).toBe(true);
      expect(typography.weights.every(weight => weight === "600")).toBe(true);
      expect(typography.metadata).toBe("12px");
      expect(typography.publicBody).toBe("17px");
      // Public section headings retain the larger responsive foundation role.
      expect(parseFloat(typography.publicHeading)).toBeGreaterThanOrEqual(22);
      // CI's Linux faces set wider than a Mac. Widen on purpose.
      await page.addStyleTag({ content: "[data-legal-document] *{letter-spacing:0.03em}" });
      assertReaderGeometry(await readerGeometry(page), `${width}px ${theme} widened`);
      expect(errors).toEqual([]);
    });
    }

    test(`request pricing has no inner divider and compact spacing at ${width}px ${theme}`, async ({ page }) => {
      const errors = await mount(page, { width, theme, at: "/one?profile_pane=1&profile_panel=request-pricing" });
      const pricing = pane(page).getByRole("region", { name: "Request pricing" });
      const field = pricing.getByRole("textbox", { name: "Default price (USD)" });
      await expect(field).toBeVisible();
      const geometry = await pricing.evaluate(root => {
        const form = root.querySelector("form")!;
        const firstRow = root.querySelector('[data-row-layout="settings"]')!;
        const rowGrid = firstRow.querySelector(':scope > .grid')!;
        const description = firstRow.querySelector('[data-slot="settings-row-description"]')!.getBoundingClientRect();
        const label = form.querySelector("label")!.getBoundingClientRect();
        return { formBorder: getComputedStyle(form).borderTopWidth, rowBorder: getComputedStyle(firstRow).borderBottomWidth,
          separator: getComputedStyle(firstRow, "::after").content, rowPadding: getComputedStyle(rowGrid).paddingTop,
          labelGap: label.top - description.bottom,
          overflow: root.scrollWidth > root.clientWidth };
      });
      expect(geometry.formBorder).toBe("0px");
      expect(geometry.rowBorder).toBe("0px");
      expect(geometry.separator).toBe("none");
      expect(geometry.rowPadding).toBe("4px");
      expect(geometry.labelGap).toBeGreaterThanOrEqual(0);
      expect(geometry.labelGap).toBeLessThanOrEqual(8);
      expect(geometry.overflow).toBe(false);
      await expect(pricing.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await field.fill("0.49");
      await expect(pricing.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await field.fill("0.50");
      await expect(pricing.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      expect(errors).toEqual([]);
      if (width === 393 && theme === "light") await pricing.screenshot({ path: test.info().outputPath("request-pricing.png") });
    });
  }
}

// Review renders for the founder, written only when LEGAL_RENDER_DIR is set.
test.describe("review renders", () => {
  test.skip(!process.env.LEGAL_RENDER_DIR, "set LEGAL_RENDER_DIR to write review renders");
  for (const [width, theme] of [[393, "light"], [393, "dark"], [820, "light"], [1440, "light"]] as const) {
    test(`pane renders at ${width}px ${theme}`, async ({ page }) => {
      const dir = process.env.LEGAL_RENDER_DIR!;
      for (const [name, at] of [
        ["pane-preferences", "/one?profile_pane=1&profile_panel=preferences"],
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
