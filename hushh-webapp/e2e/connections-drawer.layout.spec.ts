import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  productFontStyle,
  stripAppFontFaces,
  awaitProductFont,
} from "./fixtures/product-font";

let script: string;
let css: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "connections-drawer-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
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
          "@/lib/capacitor",
          "@/lib/profile/gmail-connector-store",
          "@/lib/services/gmail-receipts-service",
          "@/lib/calendar/use-calendar-connection-status",
          "@/lib/pkm/pkm-domain-resource",
          "@/lib/kai/plaid-vault/vault-sync",
          "@/lib/connections/custom-connector-configuration",
          "next/navigation",
        ].map((find) => ({
          // Vite string aliases match subpaths; every boundary mock is exact.
          find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
          replacement: path.join(
            root,
            "e2e/fixtures/connections-boundaries.tsx",
          ),
        })),
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
        entry: path.join(root, "e2e/fixtures/connections-drawer.tsx"),
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
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

test.beforeEach(async ({ page }) => {
  const fixtureErrors: string[] = [];
  page.on("pageerror", (error) => fixtureErrors.push(error.message));
  let status = "connected";
  let documents: { documentId: string; name: string; status: string; backgroundProcessing: boolean }[] = [];
  await page.route(/\/icons\/connectors\/(?:gmail|drive|calendar|plaid)\.svg$/, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: fs.readFileSync(path.join(process.cwd(), "public", new URL(route.request().url()).pathname), "utf8"),
    }),
  );
  await page.route("http://localhost/connections-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>One Connectors contract</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }),
  );
  await page.route("**/api/connectors**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = {};
    if (url.pathname === "/api/connectors")
      body = {
        features: {
          connections_panel_v2: true,
          google_drive_connection: true,
          google_drive_live: true,
          google_drive_picker: true,
          drive_document_indexing: true,
        },
        connectors: [
          {
            connectorId: "google_drive",
            status,
            available: true,
            accountLabel: "drive-owner@synthetic.invalid",
            authStyle: "oauth",
          },
        ],
      };
    else if (url.pathname.endsWith("/disconnect")) {
      status = "revoked";
      documents = [];
      body = {
        status,
        connectorId: "google_drive",
        revocationOutcome: "failed",
      };
    } else if (url.pathname.endsWith("/picker/session"))
      body = {
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        accessToken: "synthetic-picker-token",
        appId: "12345678",
        developerKey: "synthetic-browser-key",
        origin: "http://localhost",
      };
    else if (url.pathname.endsWith("/documents/select")) {
      expect(request.postDataJSON()).toMatchObject({
        confirmed: true,
        fileIds: ["synthetic-file"],
      });
      documents = [
        {
          documentId: "550e8400-e29b-41d4-a716-446655440001",
          name: "<script>untrusted filename</script>",
          status: "queued",
          backgroundProcessing: request.postDataJSON().processingConsent === "selected-files-background-v1",
        },
      ];
      body = { documents };
    } else if (url.pathname.endsWith("/processing")) {
      const input = request.postDataJSON();
      expect(input).toEqual(input.enabled
        ? { enabled: true, confirmed: true, disclosure: "selected-files-background-v1" }
        : { enabled: false, confirmed: true });
      documents = documents.map((document) => ({ ...document, backgroundProcessing: input.enabled }));
      body = { status: input.enabled ? "enabled" : "paused" };
    } else if (url.pathname.endsWith("/sync")) {
      body = { status: "queued" };
    } else if (request.method() === "DELETE") {
      documents = [];
      body = { status: "removed" };
    } else if (url.pathname.endsWith("/documents")) body = { documents };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
      headers: { "Cache-Control": "no-store" },
    });
  });
  await page.goto("http://localhost/connections-fixture");
  await page.addScriptTag({ content: script });
  expect(fixtureErrors, "Connections fixture initialized").toEqual([]);
  await awaitProductFont(page);
});

for (const width of [390, 1440])
  test(`Profile Connectors section keeps the reading width at ${width}px`, async ({ page }) => {
    // The shipped section uses Profile's reading-width shell. Keep this
    // bounded on desktop and viewport-wide without overflow on a phone.
    await page.setViewportSize({ width, height: 820 });
    await page.evaluate(() => (window as unknown as { __renderConnectorsSettingsPage: () => void }).__renderConnectorsSettingsPage());
    const shell = page.locator('main[data-app-shell-width]');
    await expect(shell.getByRole("heading", { name: "Connected" })).toBeVisible();
    const readingMeasure = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-shell-reading")) *
      parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(readingMeasure).toBeGreaterThan(0);
    const box = (await shell.boundingBox())!;
    if (width > readingMeasure) {
      expect(box.width).toBeLessThanOrEqual(readingMeasure + 1);
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
    } else {
      expect(Math.abs(box.x)).toBeLessThan(1);
      expect(Math.abs(box.width - width)).toBeLessThan(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

for (const width of [390, 768])
  test(`chat sidebar keeps Connectors in a visible footer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const search = chats.getByRole("searchbox", { name: "Search chats" });
    const connectors = chats.getByRole("button", { name: "Open Connectors" });
    await expect(search).toBeVisible();
    await expect(connectors).toBeVisible();
    const searchBox = (await search.boundingBox())!;
    const connectorBox = (await connectors.boundingBox())!;
    const drawerBox = (await chats.boundingBox())!;
    expect(connectorBox.y).toBeGreaterThan(searchBox.y + searchBox.height);
    expect(connectorBox.y + connectorBox.height).toBeLessThanOrEqual(drawerBox.y + drawerBox.height + 1);
    expect(await chats.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    // A full-height side drawer flush to the leading edge (founder direction,
    // 2026-09-28): only the trailing corners round.
    const corners = await chats.locator("aside").evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
    });
    expect(corners).toEqual(["0px", "24px", "24px", "0px"]);
  });

/**
 * The real app, reduced to the two things that decide this drawer's stacking:
 * the routed content (the chat workspace, header included) sits in a
 * `relative z-10` wrapper (app/providers.tsx), and the bottom bar is a fixed
 * sibling on the chrome tier (components/app-ui/app-bottom-shell.tsx, z-118).
 * A drawer left inside the workspace can never rise above that bar.
 */
async function mountAppChrome(page: import("@playwright/test").Page, barHeight: number) {
  await page.evaluate((height) => {
    document.documentElement.style.setProperty("--app-bottom-shell-height", `${height}px`);
    const main = document.querySelector("main")!;
    main.style.position = "relative";
    main.style.zIndex = "10";
    const bar = document.createElement("nav");
    bar.setAttribute("data-fixture-bottom-bar", "");
    bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${height}px;z-index:var(--z-chrome);background:var(--background)`;
    document.body.append(bar);
  }, barHeight);
}

/** What a finger at (x, y) would land on: the scrim, the panel, or chrome. */
function hitAt(page: import("@playwright/test").Page, x: number, y: number) {
  return page.evaluate(([px, py]) => {
    const element = document.elementFromPoint(px, py);
    if (!element) return "none";
    if (element.closest("[data-agent-history-scrim]")) return "scrim";
    if (element.closest("[data-agent-history-drawer]")) return "panel";
    if (element.closest("[data-fixture-bottom-bar]")) return "bottom-bar";
    if (element.closest("button")?.textContent === "Open drawer") return "header";
    return element.tagName.toLowerCase();
  }, [x, y] as const);
}

for (const width of [390, 768, 1440])
  test(`chat sidebar spans the full viewport over the shared sheet scrim at ${width}px`, async ({ page }) => {
    // REVERSAL (founder direction, 2026-09-28): "Extend the chat sidebar end to
    // end, and the bottom bar is behind the chat sidebar (z-index), so that it
    // looks like a proper UX." This test used to pin a panel floating inset
    // between the chat header and the bottom bar. It now pins a modal side
    // drawer: panel and scrim cover the whole viewport, header and bar included.
    // The chat behind recedes exactly as it does behind a sheet or dialog: the
    // same --app-scrim-color dim and --app-scrim-filter blur.
    const barHeight = 88;
    const height = 720;
    await page.setViewportSize({ width, height });
    await mountAppChrome(page, barHeight);
    const bottomBarBefore = await page.locator("[data-fixture-bottom-bar]").boundingBox();
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const panel = chats.locator("aside");
    await expect(panel).toBeVisible();
    // Let the slide-in settle before measuring geometry.
    await expect.poll(async () => (await chats.boundingBox())!.x).toBe(0);
    expect(await page.locator("[data-fixture-bottom-bar]").boundingBox()).toEqual(bottomBarBefore);
    const scrim = page.locator("[data-agent-history-scrim]");
    const readScrim = () =>
      scrim.evaluate((element) => {
        const style = getComputedStyle(element);
        // Resolve the canonical tokens through a probe so the comparison is
        // computed-to-computed, whatever the pointer media query picked.
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--app-scrim-color)";
        probe.style.backdropFilter = "var(--app-scrim-filter)";
        document.body.appendChild(probe);
        const canonical = getComputedStyle(probe);
        const result = {
          background: style.backgroundColor,
          filter: style.backdropFilter,
          canonicalBackground: canonical.backgroundColor,
          canonicalFilter: canonical.backdropFilter,
          opacity: style.opacity,
          visibility: style.visibility,
          pointer: style.pointerEvents,
        };
        probe.remove();
        return result;
      });
    await expect.poll(async () => (await readScrim()).opacity).toBe("1");
    const scrimStyle = await readScrim();
    expect(scrimStyle.filter).toContain("blur(");
    expect(scrimStyle.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(scrimStyle.background).toBe(scrimStyle.canonicalBackground);
    expect(scrimStyle.filter).toBe(scrimStyle.canonicalFilter);
    expect(scrimStyle.visibility).toBe("visible");
    expect(scrimStyle.pointer).toBe("auto");

    // The scrim is the whole viewport, top to bottom.
    expect(await scrim.boundingBox()).toEqual({ x: 0, y: 0, width, height });
    // The panel (and its surface) runs from the top edge to the bottom edge.
    const box = (await chats.boundingBox())!;
    const surface = (await panel.boundingBox())!;
    expect(box.y).toBe(0);
    expect(box.height).toBe(height);
    expect(surface.y).toBe(0);
    expect(surface.height).toBe(height);
    // Phones: nearly full width, min(88vw, 360px). From md up: the drawer's 336px.
    const expectedWidth = width < 768 ? Math.min(width * 0.88, 360) : 336;
    expect(Math.abs(box.width - expectedWidth)).toBeLessThanOrEqual(1);
    expect(box.x + box.width).toBeLessThan(width);

    // Stacking, as a finger finds it: the header and the bottom bar are behind
    // the scrim to the right of the panel, and behind the panel on its left.
    const beside = (box.width + width) / 2;
    expect(await hitAt(page, beside, 20)).toBe("scrim");
    expect(await hitAt(page, beside, height - barHeight / 2)).toBe("scrim");
    expect(await hitAt(page, 20, 20)).toBe("panel");
    expect(await hitAt(page, 20, height - barHeight / 2)).toBe("panel");

    // A tap on the scrim beside the panel closes it.
    await page.mouse.click(beside, height / 2);
    await expect(page.getByRole("dialog", { name: "Agent chat history", exact: true })).toHaveCount(0);
    // Closed, the panel and its shadow sit fully off-screen.
    await expect
      .poll(async () => {
        const closed = await page.locator("[aria-label='Agent chat history'][role='dialog']").boundingBox();
        return closed ? closed.x + closed.width : 0;
      })
      .toBeLessThanOrEqual(-24);
    // Closed, the scrim fades out and leaves no live backdrop filter behind.
    await expect.poll(async () => (await readScrim()).visibility).toBe("hidden");
    expect((await readScrim()).opacity).toBe("0");
    // And the chrome underneath is reachable again.
    expect(await hitAt(page, beside, height - barHeight / 2)).toBe("bottom-bar");
    expect(await hitAt(page, 20, 20)).toBe("header");
  });

test("chat sidebar scrim does not animate under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Agent chat history", exact: true })).toBeVisible();
  const transition = await page
    .locator("[data-agent-history-scrim]")
    .evaluate((element) => getComputedStyle(element).transitionProperty);
  expect(transition).toBe("none");
});

for (const width of [390, 768])
  test(`chat sidebar runs over the fixed bottom bar with Connectors reachable at ${width}px`, async ({ page }) => {
    // REVERSAL (founder direction, 2026-09-28): this used to assert the drawer
    // ENDED where the bottom bar began, because the bar was a stacking context
    // the drawer could not out-z. Portalled to <body> on the sheet tier, the
    // drawer now covers the bar, and its footer control sits over it, tappable.
    const barHeight = 88;
    const height = 640;
    await page.setViewportSize({ width, height });
    await mountAppChrome(page, barHeight);
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const connectors = chats.getByRole("button", { name: "Open Connectors" });
    await expect(connectors).toBeVisible();
    await expect.poll(async () => (await chats.boundingBox())!.x).toBe(0);
    const drawerBox = (await chats.boundingBox())!;
    const connectorBox = (await connectors.boundingBox())!;
    expect(drawerBox.y + drawerBox.height).toBe(height);
    // The footer control lives in the band the bar occupies, and wins the hit test.
    expect(connectorBox.y + connectorBox.height).toBeGreaterThan(height - barHeight);
    expect(connectorBox.y + connectorBox.height).toBeLessThanOrEqual(height);
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest('[aria-label="Open Connectors"]') != null,
        [connectorBox.x + connectorBox.width / 2, connectorBox.y + connectorBox.height / 2] as const,
      ),
    ).toBe(true);
    await connectors.click();
    await expect(page.getByRole("dialog", { name: "Connectors", exact: true })).toBeVisible();
  });

test("chat sidebar closes from its own control and returns focus to the trigger", async ({ page }) => {
  // Full height, the panel covers the header's hamburger-to-cross, so it carries
  // its own close control (a 44px hit area around a 32px well).
  await page.setViewportSize({ width: 390, height: 720 });
  const trigger = page.getByRole("button", { name: "Open drawer", exact: true });
  await trigger.click();
  const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
  const close = chats.getByRole("button", { name: "Close chat history" });
  await expect(close).toBeVisible();
  const hit = await close.evaluate((element) => {
    const after = getComputedStyle(element, "::after");
    const rect = element.getBoundingClientRect();
    return { width: rect.width - parseFloat(after.left) - parseFloat(after.right), position: after.position };
  });
  expect(hit.position).toBe("absolute");
  expect(hit.width).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(chats).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const width of [320, 390, 768, 1440])
  test(`Mail reconnect receipt preserves draft and returns focus at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 820 });
    await expect(page).toHaveTitle("One Connectors contract");
    await expect(page).toHaveURL("http://localhost/connections-fixture");
    const draft = page.getByRole("textbox", { name: "Chat draft" });
    await draft.fill("Keep this draft and conversation");
    const original = await draft.elementHandle();
    const receipt = page.getByRole("region", { name: "Mail read details" });
    await expect(receipt).toHaveText(/Reconnect Mail to continue/);
    // The receipt names the connector and what the person will do there.
    const button = receipt.getByRole("button", { name: "Review Gmail access" });
    const bounds = (await button.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await button.click();
    await expect(page.getByRole("dialog", { name: "Connectors", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Connectors", exact: true })).not.toBeVisible();
    await expect(button).toBeFocused();
    await expect(draft).toHaveValue("Keep this draft and conversation");
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByTestId("stream")).toHaveText("Streaming turn 1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await testInfo.attach("Mail reconnect receipt", { body: await page.screenshot({ path: testInfo.outputPath("mail-receipt.png") }), contentType: "image/png" });
  });

for (const width of [320, 390, 768, 1440])
  test(`mounted drawer retains chat and wraps controls at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 820 });
    const draft = page.getByRole("textbox", { name: "Chat draft" });
    await draft.fill("Keep my unsent draft");
    const handle = await draft.elementHandle();
    await page
      .getByRole("button", { name: "Open drawer", exact: true })
      .click();
    // Opening moves focus to Open Connectors one frame later. `fill` focuses
    // the box and then inserts text in a separate step, so typing before that
    // frame lands sent the text to the button about 1 run in 60 on WebKit and
    // left the search empty. Wait for the drawer's own focus to settle first.
    await expect(
      page.getByLabel("Open Connectors", { exact: true }),
    ).toBeFocused();
    const chatSearch = page.getByRole("searchbox", { name: "Search chats" });
    await chatSearch.fill("History filter");
    await expect(chatSearch).toHaveValue("History filter");
    await page.getByLabel("Open Connectors", { exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Connectors", exact: true });
    await expect(page.getByRole("dialog", { name: "Agent chat history", exact: true })).not.toBeVisible();
    await expect(drawer).toHaveAttribute("data-slot", width < 768 ? "sheet-content" : "dialog-content");
    if (width >= 768) {
      expect((await drawer.boundingBox())!.width).toBeLessThanOrEqual(448);
      await expect.poll(async () => {
        const box = (await drawer.boundingBox())!;
        return Math.abs(box.x + box.width / 2 - width / 2);
      }).toBeLessThan(2);
    } else {
      await expect.poll(async () => {
        const box = (await drawer.boundingBox())!;
        return Math.abs(box.y + box.height - 820);
      }).toBeLessThan(2);
    }
    await expect(drawer.getByRole("heading", { name: "Connected" })).toBeVisible();
    const overlay = page.locator('[data-slot="dialog-overlay"], [data-slot="sheet-overlay"]').last();
    await expect(overlay).toBeVisible();
    expect(await overlay.evaluate((element) => getComputedStyle(element).backdropFilter)).toContain("blur(");
    await expect(drawer.getByRole("heading", { name: "Available" })).toBeVisible();
    await expect(drawer.getByRole("searchbox", { name: "Search connectors" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Gmail", exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Google Drive", exact: true })).toBeVisible();
    await drawer.getByRole("searchbox", { name: "Search connectors" }).fill("drive");
    await expect(drawer.getByRole("button", { name: "Gmail", exact: true })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Google Drive", exact: true })).toBeVisible();
    await drawer.getByRole("searchbox", { name: "Search connectors" }).clear();
    for (const [connector, account, names] of [
      ["Gmail", "mail-owner@synthetic.invalid", ["Disconnect Mail"]],
      ["Google Drive", "drive-owner@synthetic.invalid", ["Disconnect Drive", "Choose files"]],
    ] as const) {
      await drawer.getByRole("button", { name: connector, exact: true }).click();
      await expect(drawer.getByRole("button", { name: "Back to connectors" })).toBeFocused();
      await expect(drawer.getByText(account)).toBeVisible();
      if (connector === "Google Drive") {
        await expect(drawer.getByRole("button", { name: "Retry Drive" })).toHaveCount(0);
        if (width === 1440) expect((await drawer.boundingBox())!.height).toBeLessThan(600);
        if (width === 1440) await testInfo.attach("Drive connected details", {
          body: await page.screenshot({ path: testInfo.outputPath("drive-connected-details.png") }),
          contentType: "image/png",
        });
        await expect(drawer.getByRole("button", { name: "Choose files", exact: true })).not.toBeVisible();
        await drawer.getByText("Previously added files", { exact: true }).click();
      }
      for (const name of names) {
        const button = drawer.getByRole("button", { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const bounds = (await button.boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      }
      await drawer.getByRole("button", { name: "Back to connectors" }).click();
      await expect(drawer.getByRole("searchbox", { name: "Search connectors" })).toBeFocused();
    }
    for (const name of ["Gmail", "Google Drive"]) {
      const button = drawer.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const bounds = (await button.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    expect(
      await drawer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await testInfo.attach("mounted connections", {
      body: await page.screenshot({
        path: testInfo.outputPath("connections.png"),
      }),
      contentType: "image/png",
    });
    await drawer.getByRole("button", { name: "Close connectors" }).click();
    await expect(drawer).not.toBeVisible();
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    await expect(
      page.getByRole("searchbox", { name: "Search chats" }),
    ).toHaveValue("History filter");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Open drawer", exact: true }),
    ).toBeFocused();
    expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(draft).toHaveValue("Keep my unsent draft");
    await page
      .getByRole("button", { name: "Advance synthetic stream" })
      .click();
    await expect(page.getByTestId("stream")).toHaveText("Streaming turn 2");
  });

for (const width of [320, 390, 1440])
  test(`connectors remain scrollable with a short ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 440 });
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    await page.getByLabel("Open Connectors", { exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Connectors", exact: true });
    const scrollRegion = dialog.locator('[data-connections-panel] > div').last();
    await expect(dialog.locator('[data-connections-panel] header h2')).toBeVisible();
    expect(await scrollRegion.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    const plaid = dialog.getByRole("button", { name: "Plaid" });
    await plaid.scrollIntoViewIfNeeded();
    await expect(plaid).toBeVisible();
    const action = await plaid.boundingBox();
    const bounds = await dialog.boundingBox();
    expect(action).not.toBeNull();
    expect(bounds).not.toBeNull();
    expect(action!.y).toBeGreaterThanOrEqual(bounds!.y);
    expect(action!.y + action!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
    expect(action!.x).toBeGreaterThanOrEqual(0);
    expect(action!.x + action!.width).toBeLessThanOrEqual(width + 1);
  });

test("dismissing Connectors returns the next hamburger open to chat history", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 820 });
  const hamburger = page.getByRole("button", { name: "Open drawer", exact: true });
  const connectors = page.getByRole("dialog", { name: "Connectors", exact: true });
  const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });

  // Radix attaches its outside-pointer listener after the open transition
  // starts; clicking the scrim mid-animation was a race (flaky on chromium).
  const settled = () =>
    expect
      .poll(() =>
        page.evaluate(
          () => document.getAnimations().filter((a) => a.playState === "running").length,
        ),
      )
      .toBe(0);

  await hamburger.click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await expect(connectors).toBeVisible();
  await settled();
  await page.mouse.click(24, 400);
  await expect(connectors).not.toBeVisible();
  await hamburger.click();
  await expect(chats.getByRole("searchbox", { name: "Search chats" })).toBeVisible();

  await page.getByLabel("Open Connectors", { exact: true }).click();
  await expect(connectors).toBeVisible();
  await settled();
  await page.keyboard.press("Escape");
  await expect(connectors).not.toBeVisible();
  await hamburger.click();
  await expect(chats.getByRole("searchbox", { name: "Search chats" })).toBeVisible();
});

test("Picker focus, explicit admission, removal, and independent disconnect", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByRole("button", { name: "Google Drive", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose files", exact: true })).not.toBeVisible();
  await page.getByText("Previously added files", { exact: true }).click();
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Synthetic Google Picker" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Connectors", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose files", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await page.getByRole("button", { name: "Pick synthetic file" }).click();
  await expect(
    page.getByRole("region", { name: "Confirm selected files" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add selected files" }),
  ).toBeFocused();
  await expect(
    page.getByRole("list", { name: "Selected Drive files" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Add selected files" }).click();
  await expect(
    page.getByRole("list", { name: "Selected Drive files" }),
  ).toContainText("Background processing is off");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toMatch(/synthetic-picker-token|untrusted filename|synthetic-owner/);
  await page
    .getByRole("button", { name: "Remove <script>untrusted filename</script>" })
    .click();
  await page.getByRole("alertdialog", { name: "Remove this file from One?" }).getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByRole("list", { name: "Selected Drive files" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Disconnect Drive" }).click();
  await expect(page.getByText(/Existing Google sharing stays active until you revoke it/)).toBeVisible();
  await page.getByRole("alertdialog", { name: "Disconnect Google Drive?" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(
    page.getByText(/Google revocation was not confirmed/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to connectors" }).click();
  await page.getByRole("button", { name: "Gmail", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect Mail" }),
  ).toBeEnabled();
});

test("background processing needs explicit consent and can be paused without removing files", async ({ page }) => {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /documents\/(select|[^/]+\/processing)/.test(request.url()))
      writes.push({ url: request.url(), body: request.postDataJSON() });
  });
  await page.getByRole("textbox", { name: "Chat draft" }).fill("Keep my draft");
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByRole("button", { name: "Google Drive", exact: true }).click();
  await page.getByText("Previously added files", { exact: true }).click();
  const selectFile = async () => {
    await page.getByRole("button", { name: "Choose files", exact: true }).click();
    await page.getByRole("button", { name: "Pick synthetic file" }).click();
  };
  await selectFile();
  const consent = page.getByRole("checkbox", { name: /Prepare these files while the app is closed/ });
  await expect(page.getByText(/Relevant excerpts may be sent to Gemini/)).toBeVisible();
  await expect(page.getByText(/Prepared file information is stored outside your vault/)).toBeVisible();
  await expect(consent).not.toBeChecked();
  await consent.check();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel selection" }).click();
  await selectFile();
  await expect(consent).not.toBeChecked();
  await consent.check();
  await expect(consent).toBeChecked();
  await page.getByRole("button", { name: "Add selected files" }).click();
  const processing = page.getByRole("checkbox", { name: /^Background processing for / });
  await expect(processing).toBeChecked();
  await expect(page.getByText(/Turning this off stops new preparation; remove the file to clear what was prepared/)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 440 });
  const dialog = page.getByRole("dialog", { name: "Connectors", exact: true });
  const remove = dialog.getByRole("button", { name: /^Remove .+$/ });
  await remove.scrollIntoViewIfNeeded();
  const removeBox = (await remove.boundingBox())!;
  const dialogBox = (await dialog.boundingBox())!;
  expect(removeBox.y).toBeGreaterThanOrEqual(dialogBox.y);
  expect(removeBox.y + removeBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1);
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(writes[0].body.processingConsent).toBe("selected-files-background-v1");
  await expect(page.getByRole("button", { name: /^Sync .+ now$/ })).toBeVisible();
  await processing.click();
  await expect(processing).not.toBeChecked();
  await expect(page.getByRole("button", { name: /^Sync .+ now$/ })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Selected Drive files" })).toBeVisible();
  expect(writes[1].body).toEqual({ enabled: false, confirmed: true });
  await processing.click();
  await expect(processing).toBeChecked();
  expect(writes[2].body).toEqual({ enabled: true, confirmed: true, disclosure: "selected-files-background-v1" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Chat draft" })).toHaveValue("Keep my draft");
});

for (const readiness of ["busy", "unavailable"] as const)
test(`blocked Drive popup fails closed when chat recovery is ${readiness}`, async ({ page }) => {
  const attemptId = "synthetic-blocked-popup-attempt";
  let starts = 0;
  page.on("request", (request) => {
    if (request.url().includes("/oauth/start")) starts++;
  });
  await page.route("**/api/connectors/google_drive/connect/oauth/start", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connectorId: "google_drive",
        attemptId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=blocked",
      }),
    }),
  );
  await page.getByRole("textbox", { name: "Chat draft" }).fill("Unsent draft");
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByRole("button", { name: "Google Drive", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Drive" }).click();
  await page.getByRole("alertdialog", { name: "Disconnect Google Drive?" }).getByRole("button", { name: "Disconnect" }).click();
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.evaluate((value) => {
    (window as Window & { __driveRecoveryReadiness?: string }).__driveRecoveryReadiness = value;
  }, readiness);
  await page
    .getByRole("button", { name: "Connect Drive", exact: true })
    .click();
  await expect(page.getByText(readiness === "busy"
    ? "Finish the current chat action or allow popups before connecting Drive."
    : "Your draft could not be saved safely. Allow popups or try again.")).toBeVisible();
  expect(starts).toBe(1);
  expect(await page.evaluate(() =>
    (window as Window & { __driveRecoveryRequests?: unknown[] }).__driveRecoveryRequests,
  )).toEqual([{ attemptId, reason: "web_full_page" }]);
  expect(page.url()).toBe("http://localhost/connections-fixture");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Chat draft" })).toHaveValue(
    "Unsent draft",
  );
});

test("real popup ignores forged settlement and stays revoked when sign-in is cancelled", async ({
  page,
  context,
}) => {
  const attemptId = "synthetic-oauth-attempt";
  const expiresAt = Date.now() + 60_000;
  let statusReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/connectors") statusReads++;
  });
  await page.route(
    "**/api/connectors/google_drive/connect/oauth/start",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          connectorId: "google_drive",
          attemptId,
          expiresAt: new Date(expiresAt).toISOString(),
          authorizeUrl:
            "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1",
        }),
      }),
  );
  await context.route(
    "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic consent</title><p>External consent fixture, not live Google proof</p>",
      }),
  );
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByRole("button", { name: "Google Drive", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Drive" }).click();
  await page.getByRole("alertdialog", { name: "Disconnect Google Drive?" }).getByRole("button", { name: "Disconnect" }).click();
  const popupEvent = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Connect Drive", exact: true })
    .click();
  const popup = await popupEvent;
  await popup.waitForURL(
    "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1",
  );
  const before = statusReads;
  await page.evaluate(
    ({ attemptId, expiresAt }) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: location.origin,
          source: window,
          data: {
            type: "drive_oauth_settlement",
            connectorId: "google_drive",
            attemptId,
            expiresAt,
            outcome: "succeeded",
          },
        }),
      ),
    { attemptId, expiresAt },
  );
  expect(popup.isClosed()).toBe(false);
  expect(statusReads).toBe(before);
  // Closing the window is not a completion signal: Google's COOP can sever the
  // popup's WindowProxy, so `popup.closed` can read true for a live consent
  // screen. The attempt stays pending until the callback settles it or the
  // person cancels it explicitly.
  await popup.close();
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.getByText("Drive connection cancelled.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Drive", exact: true }),
  ).toBeEnabled();
  expect(statusReads).toBe(before);
  // Neither the forged message nor the cancelled window implied authorization;
  // the server still says revoked.
  await expect(
    page.getByRole("button", { name: "Disconnect Drive", exact: true }),
  ).toHaveCount(0);
});

// Calendar connects from the chat drawer without navigating the chat window.
// The vault key is memory-only, so a reload would drop it; a JS-heap sentinel
// stands in for it and proves the window was never reloaded or navigated.
async function armCalendarConnect(page: import("@playwright/test").Page) {
  const calendar = { connected: false, statusReads: 0, starts: 0 };
  await page.route("**/api/one/calendar/connect/start", (route) => {
    calendar.starts++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar",
        redirect_uri: "http://localhost/one/profile/google/oauth/return",
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/one/calendar/status/**", (route) => {
    calendar.statusReads++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        connected: calendar.connected,
        status: calendar.connected ? "connected" : "disconnected",
        access_level: calendar.connected ? "read" : null,
      }),
    });
  });
  await page.context().route(
    "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic consent</title><p>External consent fixture, not live Google proof</p>",
      }),
  );
  // The synthetic callback: same origin as the chat, like the real return URI.
  await page.context().route(
    "http://localhost/one/profile/google/oauth/return**",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Finishing Google connection</title><div id=\"root\"></div>",
      }),
  );
  await page.evaluate(() => {
    (window as Window & { __vaultKeySentinel?: string }).__vaultKeySentinel = "in-memory-only";
  });
  let chatNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) chatNavigations++;
  });
  await page.getByRole("textbox", { name: "Chat draft" }).fill("Unsent draft");
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  return { calendar, navigations: () => chatNavigations };
}

async function finishCallback(
  consent: import("@playwright/test").Page,
  options: { severOpener?: boolean } = {},
) {
  await consent.waitForURL("https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar");
  // Google redirects the consent window back to the registered return URI.
  // Navigate from inside the page, as Google's redirect does: a harness
  // `goto` is browser-initiated, which WebKit treats as severing the opener.
  const callback = "http://localhost/one/profile/google/oauth/return?code=synthetic&state=synthetic";
  await consent.evaluate((url) => location.replace(url), callback);
  await consent.waitForURL(callback);
  await consent.addScriptTag({ content: script });
  return consent.evaluate((sever) => {
    // Google's opener policy can null `window.opener`; storage is then the channel.
    if (sever) (window as { opener: Window | null }).opener = null;
    return (window as Window & {
      __settleGoogleOAuthCallback: (outcome: "succeeded") => boolean;
    }).__settleGoogleOAuthCallback("succeeded");
  }, options.severOpener ?? false);
}

async function expectChatStateIntact(
  page: import("@playwright/test").Page,
  navigations: () => number,
) {
  expect(navigations()).toBe(0);
  expect(page.url()).toBe("http://localhost/connections-fixture");
  expect(
    await page.evaluate(
      () => (window as Window & { __vaultKeySentinel?: string }).__vaultKeySentinel,
    ),
  ).toBe("in-memory-only");
  await expect(page.getByRole("region", { name: "Calendar details" })).toBeVisible();
  // The chat is inert behind the open drawer, so read the draft from the DOM.
  await expect(page.locator('textarea[aria-label="Chat draft"]')).toHaveValue("Unsent draft");
}

test("Calendar connects in a popup and the drawer updates in place", async ({ page }) => {
  const { calendar, navigations } = await armCalendarConnect(page);
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Calendar", exact: true }).click();
  const consent = await popupEvent;
  await expect(page.getByText("Finish signing in with Google in the window that opened.")).toBeVisible();
  // A forged same-window message never settles the attempt.
  await page.evaluate(() =>
    window.dispatchEvent(new MessageEvent("message", {
      origin: location.origin,
      source: window,
      data: { schemaVersion: 1, type: "google_oauth_settlement", attemptId: "forged-attempt-id", service: "calendar", outcome: "succeeded" },
    })),
  );
  expect(calendar.statusReads).toBe(0);
  calendar.connected = true;
  const closed = consent.waitForEvent("close");
  expect(await finishCallback(consent)).toBe(true);
  await closed;
  await expect(page.getByText("Calendar connected.")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Calendar details" }).getByText("Connected", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect Calendar" }).first()).toBeVisible();
  expect(calendar.starts).toBe(1);
  await expectChatStateIntact(page, navigations);
});

test("Calendar falls back to a new tab and settles through storage when the opener is severed", async ({ page }) => {
  const { calendar, navigations } = await armCalendarConnect(page);
  await page.evaluate(() => {
    const original = window.open.bind(window);
    // Refuse only the sized popup, as a strict popup policy would.
    window.open = (url, target, features) => (features ? null : original(url, target));
  });
  const tabEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Calendar", exact: true }).click();
  const tab = await tabEvent;
  calendar.connected = true;
  expect(await finishCallback(tab, { severOpener: true })).toBe(true);
  await expect(page.getByText("Calendar connected.")).toBeVisible();
  await expectChatStateIntact(page, navigations);
});

test("Calendar stays in place when both popup and tab are refused", async ({ page }) => {
  const { calendar, navigations } = await armCalendarConnect(page);
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole("button", { name: "Connect Calendar", exact: true }).click();
  await expect(page.getByText("Allow pop-ups for One, then try again. Your chat and draft stay here.")).toBeVisible();
  expect(calendar.starts).toBe(0);
  await expectChatStateIntact(page, navigations);
});

test("closing Calendar consent without finishing ends quietly as not connected", async ({ page }) => {
  const { calendar, navigations } = await armCalendarConnect(page);
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Calendar", exact: true }).click();
  const consent = await popupEvent;
  await consent.waitForURL("https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar");
  await consent.close();
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(page.getByText("Calendar not connected.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect Calendar", exact: true }).last()).toBeEnabled();
  expect(calendar.statusReads).toBe(0);
  await expectChatStateIntact(page, navigations);
});

// In-chat connect cards: Gmail send upgrade and the Calendar card One shows.
// Real cards, real connector and hook; only Google's pages are synthetic.
async function armChatConnect(page: import("@playwright/test").Page) {
  const server = { gmailSend: false, calendarManage: false, calendarStarts: 0, gmailReads: 0, calendarReads: 0 };
  await page.route("**/api/gmail/status/**", (route) => {
    server.gmailReads++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connected: true, send_permission_granted: server.gmailSend }),
    });
  });
  await page.route("**/api/one/calendar/connect/start", (route) => {
    server.calendarStarts++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar",
        redirect_uri: "http://localhost/one/profile/google/oauth/return",
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/one/calendar/status/**", (route) => {
    server.calendarReads++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        connected: true,
        status: "connected",
        access_level: server.calendarManage ? "manage" : "read",
      }),
    });
  });
  for (const consent of ["fixture=mail", "synthetic=calendar"])
    await page.context().route(`https://accounts.google.com/o/oauth2/v2/auth?${consent}`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic consent</title><p>External consent fixture, not live Google proof</p>",
      }),
    );
  for (const callback of ["gmail", "google"])
    await page.context().route(`http://localhost/one/profile/${callback}/oauth/return**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Finishing Google connection</title><div id=\"root\"></div>",
      }),
    );
  await page.evaluate(() => {
    (window as Window & { __vaultKeySentinel?: string }).__vaultKeySentinel = "in-memory-only";
  });
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.getByRole("textbox", { name: "Chat draft" }).fill("Unsent draft");
  return { server, navigations: () => navigations };
}

async function returnFromGoogle(
  consent: import("@playwright/test").Page,
  callbackPath: "gmail" | "google",
  settle: "__settleGmailOAuthCallback" | "__settleGoogleOAuthCallback",
) {
  await consent.waitForURL(/accounts\.google\.com/);
  const callback = `http://localhost/one/profile/${callbackPath}/oauth/return?code=synthetic&state=synthetic`;
  // Content-initiated, as Google's redirect is; a harness goto severs the opener in WebKit.
  await consent.evaluate((url) => location.replace(url), callback);
  await consent.waitForURL(callback);
  await consent.addScriptTag({ content: script });
  return consent.evaluate(
    (name) => (window as unknown as Record<string, (outcome: "succeeded") => boolean>)[name]("succeeded"),
    settle,
  );
}

async function expectChatIntact(
  page: import("@playwright/test").Page,
  navigations: () => number,
) {
  expect(navigations()).toBe(0);
  expect(page.url()).toBe("http://localhost/connections-fixture");
  expect(
    await page.evaluate(() => (window as Window & { __vaultKeySentinel?: string }).__vaultKeySentinel),
  ).toBe("in-memory-only");
  await expect(page.getByRole("textbox", { name: "Chat draft" })).toHaveValue("Unsent draft");
}

test("Gmail send upgrade connects in place and reopens the reviewed draft", async ({ page }) => {
  const { server, navigations } = await armChatConnect(page);
  const history = page.getByTestId("one-email-history-failed");
  await history.getByText("Mail activity").click();
  const popupEvent = page.waitForEvent("popup");
  await history.getByRole("button", { name: "Enable sending" }).click();
  const consent = await popupEvent;
  await expect(history.getByRole("button", { name: "Waiting for Google…" })).toBeDisabled();
  await expect(page.getByText("Draft reopened for review")).toHaveCount(0);
  server.gmailSend = true;
  expect(await returnFromGoogle(consent, "gmail", "__settleGmailOAuthCallback")).toBe(true);
  await expect(page.getByText("Draft reopened for review: The plan")).toBeVisible();
  await expect(page.getByTestId("chat-connect-notice")).toHaveText(
    "Gmail sending enabled. Review your message, then send.",
  );
  expect(server.gmailReads).toBe(1);
  await expectChatIntact(page, navigations);
});

test("Calendar card connects in place, clears, and a forged settlement is ignored", async ({ page }) => {
  const { server, navigations } = await armChatConnect(page);
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Allow Calendar scheduling" }).click();
  const consent = await popupEvent;
  await expect(page.getByRole("button", { name: "Waiting for Google…" })).toBeDisabled();
  await page.evaluate(() =>
    window.dispatchEvent(new MessageEvent("message", {
      origin: location.origin,
      source: window,
      data: { schemaVersion: 1, type: "google_oauth_settlement", attemptId: "forged-attempt-id", service: "calendar", outcome: "succeeded" },
    })),
  );
  expect(server.calendarReads).toBe(0);
  server.calendarManage = true;
  expect(await returnFromGoogle(consent, "google", "__settleGoogleOAuthCallback")).toBe(true);
  await expect(page.getByTestId("chat-connect-notice")).toHaveText(
    "Google Calendar connected. Ask One again to continue.",
  );
  await expect(page.getByTestId("specialist-directive-card")).toHaveCount(0);
  expect(server.calendarStarts).toBe(1);
  await expectChatIntact(page, navigations);
});

test("Calendar card keeps a read-only grant as not connected for scheduling", async ({ page }) => {
  const { navigations } = await armChatConnect(page);
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Allow Calendar scheduling" }).click();
  const consent = await popupEvent;
  expect(await returnFromGoogle(consent, "google", "__settleGoogleOAuthCallback")).toBe(true);
  await expect(page.getByTestId("chat-connect-notice")).toHaveText("Google Calendar was not connected.");
  await expect(page.getByTestId("specialist-directive-card")).toBeVisible();
  await expectChatIntact(page, navigations);
});

test("cancelling the Calendar card while Google is open ends quietly and ignores the late callback", async ({ page }) => {
  const { server, navigations } = await armChatConnect(page);
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Allow Calendar scheduling" }).click();
  const consent = await popupEvent;
  await consent.waitForURL(/accounts\.google\.com/);
  await page.getByTestId("specialist-directive-cancel").click();
  await expect(page.getByTestId("chat-connect-notice")).toHaveText(
    "Calendar change cancelled. Nothing was changed.",
  );
  await expect(page.getByTestId("specialist-directive-card")).toHaveCount(0);
  expect(server.calendarReads).toBe(0);
  await expectChatIntact(page, navigations);
});

test("in-chat connects stay in place when pop-ups and tabs are refused", async ({ page }) => {
  const { server, navigations } = await armChatConnect(page);
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole("button", { name: "Allow Calendar scheduling" }).click();
  await expect(page.getByTestId("chat-connect-notice")).toHaveText(
    "Allow pop-ups for One, then try again. Your chat and draft stay here.",
  );
  const history = page.getByTestId("one-email-history-failed");
  await history.getByText("Mail activity").click();
  await history.getByRole("button", { name: "Enable sending" }).click();
  await expect(page.getByTestId("chat-connect-notice")).toHaveText(
    "Allow pop-ups for One, then try again. Your chat and draft stay here.",
  );
  expect(server.calendarStarts).toBe(0);
  await expectChatIntact(page, navigations);
});
