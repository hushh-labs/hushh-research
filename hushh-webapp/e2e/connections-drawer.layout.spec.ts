import { expectHeaderControl, verifyChatHeaderControls } from "./helpers/header-control-geometry";
import { verifyHistoryMovement } from "./helpers/history-motion";
import { expectPaneRestingAtFrame, mountAppChrome, hitAt, awaitClosedHistoryGeometry } from "./helpers/drawer-geometry";
import { expect, test, type ElementHandle, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HUSHH_MARK_PATH } from "../lib/brand/hushh-mark";
import {
  productFontStyle,
  stripAppFontFaces,
  awaitProductFont,
} from "./fixtures/product-font";

let script: string;
let css: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const workspace = fs.readFileSync(path.join(root, "components/agent/agent-chat-workspace.tsx"), "utf8");
  const profileTriggerClass = workspace.match(/data-agent-chat-one-profile-trigger[\s\S]*?className="([^"]+)"/)?.[1];
  if (!profileTriggerClass) throw new Error("Missing production One profile trigger");
  const identityClass = workspace.match(/data-agent-chat-header-region="identity"\s+className="([^"]+)"/)?.[1];
  const nameClass = workspace.match(/<div[^>]*className="(truncate text-base[^"]+)"[^>]*>\s*\{isPuppySurface/)?.[1];
  if (!identityClass || !nameClass) throw new Error("Missing production One header identity");
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  for (const className of [profileTriggerClass, identityClass, nameClass])
    for (const candidate of className.split(/\s+/)) candidates.add(candidate);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "connections-drawer-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        name: "fixture-css-candidates",
        enforce: "pre",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
          if (id.endsWith("/components/agent/one-presence-avatar.tsx")) {
            // Observe the actual runtime without changing its clock or poses.
            const hook = "onLoad: () => {";
            if (!source.includes(hook)) throw new Error("Missing Rive playback diagnostic boundary");
            return source.replace(hook, `assetLoader: (_asset, bytes) => {
              if (bytes.length > 24 && bytes[0] === 137 && bytes[1] === 80) {
                const scope = window as any;
                const registry = scope.__onePresenceTextures ??= new WeakMap();
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                registry.set(canvas, [...(registry.get(canvas) ?? []), [view.getUint32(16), view.getUint32(20)]]);
              }
              return false;
            }, onAdvance: (event) => {
              const scope = window as any;
              const registry = scope.__onePresenceRuntime ??= new WeakMap();
              const previous = registry.get(canvas);
              const elapsed = Number(event.data ?? 0);
              const gaps = previous?.gaps ?? [];
              if (elapsed > 0.05) {
                gaps.push({ from: previous?.elapsed ?? 0, elapsed });
                if (gaps.length > 16) gaps.shift();
              }
              registry.set(canvas, {
                advances: (previous?.advances ?? 0) + 1,
                elapsed: (previous?.elapsed ?? 0) + elapsed,
                gaps,
                frameCount: instance?.frameCount,
                fps: instance?.fps,
                playing: instance?.isPlaying,
                at: performance.now(),
              });
            }, ${hook}`);
          }
        },
      },
    ],
    resolve: {
      alias: [
        ...[
          "@/hooks/use-auth",
          "@/lib/services/auth-service",
          "@/lib/firebase/config",
          "@/lib/vault/vault-context",
          "@/lib/services/api-service",
          "./api-service",
          "./auth-service",
          "./agent-chat-client",
          "@/lib/services/todo-list-pkm-service",
          "@/lib/cache/cache-sync-service",
          "@/lib/capacitor",
          "@/lib/profile/gmail-connector-store",
          "@/lib/services/gmail-receipts-service",
          "@/lib/calendar/use-calendar-connection-status",
          "@/lib/pkm/pkm-domain-resource",
          "@/lib/kai/plaid-vault/vault-sync",
          "@/lib/connections/custom-connector-configuration",
          "@/lib/pkm/use-live-mirror-view",
          "next/navigation",
        ].map((find) => ({
          // Vite string aliases match subpaths; every boundary mock is exact.
          find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
          replacement: path.join(
            root,
            "e2e/fixtures/connections-boundaries.tsx",
          ),
        })),
        // PKM imports these same providers as siblings. Keep their boundary
        // synthetic for both import spellings instead of loading Firebase.
        {
          find: /^\.\/(?:api-service|auth-service)$/,
          replacement: path.join(root, "e2e/fixtures/connections-boundaries.tsx"),
        },
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
      __ONE_PROFILE_TRIGGER_CLASS__: JSON.stringify(profileTriggerClass),
      __ONE_HEADER_IDENTITY_CLASS__: JSON.stringify(identityClass),
      __ONE_HEADER_NAME_CLASS__: JSON.stringify(nameClass),
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
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle() +
    fs.readdirSync(outDir).filter(name => name.endsWith(".css"))
      .map(name => fs.readFileSync(path.join(outDir, name), "utf8")).join("\n");
});

test.beforeEach(async ({ page }) => {
  const fixtureErrors: string[] = [];
  page.on("pageerror", (error) => fixtureErrors.push(error.message));
  const mark = fs.readFileSync(path.join(process.cwd(), "public", new URL(HUSHH_MARK_PATH, "http://localhost").pathname));
  await page.route("**/_next/image?**", route => {
    if (new URL(route.request().url()).searchParams.get("url") === HUSHH_MARK_PATH)
      return route.fulfill({ contentType: "image/png", body: mark });
    return route.continue();
  });
  await page.route(`**${HUSHH_MARK_PATH}`, route => route.fulfill({ contentType: "image/png", body: mark }));
  await page.route("http://localhost/one-presence/*.png", route =>
    route.fulfill({
      contentType: "image/png",
      body: fs.readFileSync(path.join(process.cwd(), "public", new URL(route.request().url()).pathname)),
    }),
  );
  await page.route(/^http:\/\/localhost\/one-presence\/(?:(?:hd\/)?[a-z]+\.riv|rive\.wasm)$/, route =>
    route.fulfill({
      contentType: route.request().url().endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
      body: fs.readFileSync(path.join(process.cwd(), "public", new URL(route.request().url()).pathname)),
    }),
  );
  await page.route(/^http:\/\/localhost\/one-presence\/(?:still|connected|thinking|working|answering)\.webp$/, route =>
    route.fulfill({
      contentType: "image/webp",
      body: fs.readFileSync(path.join(process.cwd(), "public", new URL(route.request().url()).pathname)),
    }),
  );
  let status = "connected";
  let documents: { documentId: string; name: string; status: string; backgroundProcessing: boolean }[] = [];
  await page.route(/^http:\/\/localhost\/icons\/connectors\/[a-z0-9-]+\.(?:svg|png|jpg)$/, (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith(".svg") ? "image/svg+xml" : route.request().url().endsWith(".png") ? "image/png" : "image/jpeg",
      body: fs.readFileSync(path.join(process.cwd(), "public", new URL(route.request().url()).pathname)),
    }),
  );
  await page.route("http://localhost/connections-fixture*", (route) =>
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
          drive_four_group_index: new URL(page.url()).searchParams.has("data-packets"),
        },
        connectors: [
          {
            connectorId: "google_drive",
            status,
            available: true,
            accountLabel: "drive-owner@synthetic.invalid",
            profile: new URL(page.url()).searchParams.has("data-packets") ? "live" : null,
            authStyle: "oauth",
          },
        ],
      };
    else if (url.pathname === "/api/connectors/google_drive/groups") body = {
      status: { enabled: true, state: "ready", revision: 1, timeZone: "UTC", listedFiles: 54, indexedFiles: 54,
        counts: { financial_statements: 51, insurance_statements: 0, non_financial_statements: 0, personal_documents: 0, kept: 3 }, listingComplete: true, limited: false, lastRunAt: null },
      groups: [{ shelf: "financial_statements", name: "Financial Assets" }, { shelf: "insurance_statements", name: "Insurance" },
        { shelf: "non_financial_statements", name: "Non-Financial Records" }, { shelf: "personal_documents", name: "Personal Documents" }], folders: [],
    };
    else if (url.pathname.startsWith("/api/connectors/google_drive/groups/") && url.pathname.endsWith("/files")) {
      const cursor = Number(url.searchParams.get("cursor") || 0), total = url.pathname.includes("financial_statements") ? 51 : 0;
      body = { items: Array.from({ length: Math.min(50, Math.max(0, total - cursor)) }, (_, index) => ({
        ref: (cursor + index + 1).toString(16).padStart(64, "0"), title: `Synthetic statement ${cursor + index + 1} — a long document title for the phone layout`,
        viewUrl: `https://drive.google.com/file/d/synthetic-file-${cursor + index}/view`, day: "2026-10-22",
      })), total, nextCursor: cursor + 50 < total ? cursor + 50 : null };
    }
    else if (url.pathname.endsWith("/live/background")) body = { enabled: true };
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
  try {
    await expect(page.getByRole("button", { name: "Open drawer", exact: true })).toBeVisible();
  } catch (error) {
    // Distinguish a synthetic startup failure from product geometry failures.
    expect(fixtureErrors, "Connections fixture initialization errors").toEqual([]);
    throw error;
  }
  expect(fixtureErrors, "Connections fixture initialized").toEqual([]);
  await expect(page.getByRole("button", { name: "Open drawer", exact: true })).toBeVisible();
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
    const readingMeasure = await page.evaluate(() => {
      // Ask CSS to resolve the authored measure; custom properties preserve
      // their units, so multiplying a px value by the root font size is wrong.
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;visibility:hidden;width:var(--app-shell-reading);padding:0;border:0";
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    });
    expect(readingMeasure).toBeGreaterThan(0);
    const rootFontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(readingMeasure).toBeCloseTo(54 * rootFontSize, 0);
    const box = (await shell.boundingBox())!;
    if (width > readingMeasure) {
      expect(box.width).toBeCloseTo(readingMeasure, 0);
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
    } else {
      expect(Math.abs(box.x)).toBeLessThan(1);
      expect(Math.abs(box.width - width)).toBeLessThan(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

async function profileFrame(page: import("@playwright/test").Page, safeSidePane = false) {
  return page.evaluate(({ safeSidePane }) => {
    const reference = document.createElement("div");
    reference.className = safeSidePane ? "" : "profile-pane-sheet";
    reference.dataset.slot = "sheet-content";
    // The real Profile frame uses this shared material/geometry marker too.
    reference.dataset.appSidePane = "";
    if (safeSidePane) reference.dataset.chatDetailPane = "";
    reference.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
    // Measure the authored leading inset independently: landscape safe-area
    // left/right values need not be symmetric.
    reference.style.setProperty("left", "var(--app-side-pane-left-inset)", "important");
    reference.style.setProperty("right", "auto", "important");
    const card = document.createElement("div");
    const stack = document.createElement("div");
    stack.className = "profile-pane-scroll-root";
    const content = document.createElement("div");
    content.dataset.profileStackContent = "true";
    card.dataset.slot = "settings-group-shell";
    content.append(card);
    stack.append(content);
    reference.append(stack);
    const canvas = document.createElement("div");
    canvas.style.backgroundColor = "var(--background)";
    reference.append(canvas);
    document.body.append(reference);
    const bounds = reference.getBoundingClientRect();
    const style = getComputedStyle(reference);
    const result = { canvas: getComputedStyle(canvas).backgroundColor,
      x: bounds.x, y: bounds.y,
      width: bounds.width, height: bounds.height,
      radius: style.borderTopLeftRadius,
      card: { background: getComputedStyle(card).backgroundColor,
        radius: getComputedStyle(card).borderTopLeftRadius, shadow: getComputedStyle(card).boxShadow },
      material: {
        background: style.backgroundColor, border: style.borderTopColor,
        shadow: style.boxShadow, blur: style.backdropFilter,
        webkitBlur: style.getPropertyValue("-webkit-backdrop-filter"),
      } };
    reference.remove();
    return result;
  }, { safeSidePane });
}

for (const width of [390, 1440]) for (const dark of [false, true])
  test(`New chat stays a plain action at ${width}px in ${dark ? "dark" : "light"}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(enabled => {
      document.documentElement.classList.toggle("dark", enabled);
      (window as unknown as { __seedChatHistory: () => void }).__seedChatHistory();
    }, dark);
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const newChat = chats.getByRole("button", { name: "Create new chat", exact: true });
    await page.mouse.move(0, 0);
    await expect(newChat).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(newChat).toHaveCSS("border-top-width", "0px");
    const shadow = await newChat.evaluate(element => getComputedStyle(element).boxShadow);
    expect(shadow === "none" || shadow.split(/,(?![^()]*\))/)
      .every(layer => layer.trim().endsWith("0px 0px 0px 0px"))).toBe(true);
    expect((await newChat.boundingBox())!.height + 0.001).toBeGreaterThanOrEqual(44);
    await chats.screenshot({ path: info.outputPath("new-chat-plain.png"), animations: "disabled" });
    const requests = () => page.evaluate(() => (window as unknown as { __newChatRequests: () => number }).__newChatRequests());
    await newChat.click();
    expect(await requests()).toBe(1);
    await page.keyboard.press("Tab");
    await newChat.focus();
    expect(await newChat.evaluate(element => element.matches(":focus-visible"))).toBe(true);
    await page.keyboard.press("Enter");
    expect(await requests()).toBe(2);
  });

for (const width of [320, 1440]) for (const dark of [false, true])
  test(`Drive sharing stays on the Chats side with Profile detail material and returns safely at ${width}px in ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 820 });
    const shareId = "22222222-2222-4222-8222-222222222222";
    const now = new Date().toISOString();
    const share = {
      shareId, searchJobId: "11111111-1111-4111-8111-111111111111", status: "review_ready", revision: 1,
      reviewDigest: "a".repeat(64), fileCount: 14, recipientCount: 1,
      recipients: [{ name: "Fixture recipient", email: "recipient@synthetic.invalid" }], excluded: [],
      counts: { total: 14, processed: 0, shared: 0, alreadyShared: 0, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 14 },
      notifications: { settled: 0, pending: 0, unavailable: 0 },
      canApprove: true, canStop: true, createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const writes: string[] = [];
    await page.route("**/api/connectors/google_drive/sharing/bulk**", route => {
      if (route.request().method() !== "GET") {
        writes.push(route.request().url());
        return route.fulfill({ status: 403, json: {} });
      }
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ json: pathname.endsWith("/files") ? {
        shareId, files: Array.from({ length: 14 }, (_, index) => ({ position: index + 1,
          name: `Fixture document ${index + 1}.pdf`, mimeType: "application/pdf", modifiedTime: null, openUrl: null })), nextCursor: null,
      } : pathname.endsWith(shareId) ? share : { shares: [share] } });
    });
    await page.goto("http://localhost/connections-fixture?drive-sharing=1");
    await page.evaluate(enabled => document.documentElement.classList.toggle("dark", enabled), dark);
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const row = page.getByRole("button", { name: "Review files. 14 files to review. View details" });
    const history = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    await row.click();
    // The nested modal makes Chats inert; read its mounted frame during motion.
    const historyFrame = page.locator("[data-agent-history-drawer]");
    const detail = page.getByRole("dialog", { name: "Drive sharing", exact: true });
    await expect(detail.getByRole("button", { name: "Share 14 files with 1 person" })).toBeVisible();
    // Nested translucent panes use the existing safe WebKit side-pane material.
    const reference = await profileFrame(page, true);
    await expect.poll(async () => {
      const box = (await detail.boundingBox())!;
      const parent = (await historyFrame.boundingBox())!;
      return Math.abs(box.x - parent.x);
    }).toBeLessThan(2);
    const box = (await detail.boundingBox())!;
    const historyBox = (await historyFrame.boundingBox())!;
    expect(Math.abs(box.width - reference.width)).toBeLessThan(2);
    expect(Math.abs(box.height - reference.height)).toBeLessThan(2);
    expect(Math.abs(box.y - historyBox.y)).toBeLessThan(2);
    expect(Math.abs(box.width - historyBox.width)).toBeLessThan(2);
    expect(Math.abs(box.height - historyBox.height)).toBeLessThan(2);
    expect(await detail.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(reference.material.background);
    expect(await detail.getByRole("region", { name: "Drive sharing", exact: true }).evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, radius: style.borderTopLeftRadius, shadow: style.boxShadow };
    })).toEqual(reference.card);
    for (const name of ["Back to Chats", "Close Drive sharing"])
      await expectHeaderControl(detail.getByRole("button", { name, exact: true }), detail.getByRole("heading", { name: "Drive sharing" }));
    const title = (await detail.getByRole("heading", { name: "Drive sharing" }).boundingBox())!;
    expect(Math.abs(title.x + title.width / 2 - box.x - box.width / 2)).toBeLessThan(2);
    expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const overlay = page.locator("[data-slot=sheet-overlay]").last();
    const historyZ = await page.locator("[data-agent-history-drawer]").evaluate(element => Number(getComputedStyle(element).zIndex));
    expect(await overlay.evaluate(element => Number(getComputedStyle(element).zIndex))).toBeGreaterThan(historyZ);
    const approve = detail.getByRole("button", { name: "Share 14 files with 1 person" });
    const buttonBox = (await approve.boundingBox())!;
    const labelBox = (await approve.locator(":scope > span").first().boundingBox())!;
    expect(labelBox.x).toBeGreaterThanOrEqual(buttonBox.x);
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(buttonBox.x + buttonBox.width + 1);
    await page.screenshot({ path: testInfo.outputPath("drive-sharing-profile.png") });
    await detail.getByRole("button", { name: "Back to Chats" }).click();
    await expect(detail).not.toBeVisible();
    await expect(history).toBeVisible();
    await expect(row).toBeFocused();
    for (const close of ["Close Drive sharing", "Escape"]) {
      await row.click();
      await expect(detail).toBeVisible();
      if (close === "Escape") await page.keyboard.press("Escape");
      else await detail.getByRole("button", { name: close, exact: true }).click();
      await expect(detail).not.toBeVisible();
      await expect(history).toBeVisible();
      await expect(row).toBeFocused();
    }
    expect(writes).toEqual([]);
  });

for (const width of [320, 390, 1440]) for (const dark of [false, true])
  test(`Chats keeps Profile material through row actions at ${width}px in ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(enabled => {
      document.documentElement.classList.toggle("dark", enabled);
      const fixture = document.querySelector<HTMLElement>("main")!;
      fixture.style.background = "linear-gradient(135deg, #86b6ed, #dcaa9d 55%, #94c4b3)";
      (window as unknown as { __seedChatHistory: () => void }).__seedChatHistory();
    }, dark);
    const routeBackgrounds = () => page.evaluate(() => [
      getComputedStyle(document.documentElement).backgroundColor,
      getComputedStyle(document.body).backgroundColor,
    ]);
    // Capture the theme after its root/body color transitions have settled.
    await page.waitForFunction(() => [document.documentElement, document.body]
      .every(element => element.getAnimations().every(animation => animation.playState !== "running")));
    const beforeOpen = await routeBackgrounds();
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const reference = await profileFrame(page);
    expect(reference.material.background).toBe(reference.canvas);
    expect(reference.material.background).toMatch(/^rgb\([^)]+\)$/);
    expect(await chats.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(reference.canvas);
    expect(await routeBackgrounds()).toEqual(beforeOpen);
    const row = chats.locator('[data-agent-history-row][data-state="active"]');
    const actions = row.getByRole("button", { name: "Open actions for Weekly planning" });
    await expect(actions).toBeVisible();
    const hit = (await actions.boundingBox())!;
    // WebKit's translated matrices can round a 44px box down by 0.00002px.
    expect(hit.width + 0.0001).toBeGreaterThanOrEqual(44);
    expect(hit.height + 0.0001).toBeGreaterThanOrEqual(44);
    await actions.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await page.waitForFunction(() => document.querySelector('[role="menu"]')?.getAnimations().every(animation => animation.playState !== "running"));
    const menuBounds = (await menu.boundingBox())!;
    expect(menuBounds.width).toBeLessThan(180);
    expect(menuBounds.x).toBeGreaterThanOrEqual(12);
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width - 12);
    for (const item of await menu.getByRole("menuitem").all()) {
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    if (width === 390 && !dark) {
      await page.screenshot({ path: testInfo.outputPath("chats-compact-menu.png"), animations: "disabled" });
    }
    expect(await menu.evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, radius: style.borderTopLeftRadius, shadow: style.boxShadow };
    })).toEqual(reference.card);
    expect(await menu.evaluate(element => getComputedStyle(element).backdropFilter)).toBe(reference.material.blur);
    expect(await page.evaluate(() => (window as unknown as { __chatHistorySelections: string[] }).__chatHistorySelections)).toEqual([]);
    await menu.getByRole("menuitem", { name: "Rename" }).click();
    const rename = row.getByRole("textbox", { name: "Rename chat" });
    await expect(rename).toBeFocused();
    for (const target of [rename, row.getByRole("button", { name: "Save chat name" }), row.getByRole("button", { name: "Cancel rename" })]) {
      const bounds = (await target.boundingBox())!;
      // WebKit's translated matrices can round a 44px box down by 0.00002px.
      expect(bounds.width + 0.0001).toBeGreaterThanOrEqual(44);
      expect(bounds.height + 0.0001).toBeGreaterThanOrEqual(44);
    }
    await expect(chats.getByRole("heading", { name: "Chats", exact: true })).toBeVisible();
    expect(await chats.evaluate(element => element.scrollTop)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("chats-profile-rename.png") });
    await row.getByRole("button", { name: "Cancel rename" }).click();
    await page.screenshot({ path: testInfo.outputPath("chats-profile-material.png") });
    await chats.getByRole("button", { name: /^Draft email/ }).click();
    await expect(chats).not.toBeVisible();
    expect(await page.locator("[data-agent-history-drawer]").evaluate(element =>
      element.getAnimations().filter(animation =>
        animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
    await expect(page.locator("[data-agent-history-drawer]")).toHaveCSS("visibility", "hidden");
    expect(await routeBackgrounds()).toEqual(beforeOpen);
    expect(await page.evaluate(() => (window as unknown as { __chatHistorySelections: string[] }).__chatHistorySelections)).toEqual(["history-two"]);
  });

for (const dark of [false, true])
  test(`Chats and Profile keep a solid material in Android blur-free mode (${dark ? "dark" : "light"})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.evaluate(enabled => {
      document.documentElement.classList.add("native-android");
      document.documentElement.classList.toggle("dark", enabled);
      (window as unknown as { __seedChatHistory: () => void }).__seedChatHistory();
    }, dark);
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const reference = await profileFrame(page);
    // With the platform's intentional blur-off policy, alpha must not expose
    // sharp transcript text through either pane or its portaled action menu.
    expect(reference.material.background).toMatch(/^rgb\([^)]+\)$/);
    expect(reference.material.background).toBe(reference.canvas);
    expect(await chats.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(reference.material.background);
    expect(await chats.evaluate(element => getComputedStyle(element).backdropFilter)).toBe("none");
    await chats.getByRole("button", { name: "Open actions for Weekly planning" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    expect(reference.card.background).toMatch(/^rgb\([^)]+\)$/);
    expect(await menu.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(reference.card.background);
    expect(await menu.evaluate(element => getComputedStyle(element).backdropFilter)).toBe("none");
  });

for (const { width, native } of [...[390, 768, 1440].map(width => ({ width, native: false })), { width: 390, native: true }])
  test(`chat sidebar keeps Connectors in a visible footer at ${width}px${native ? " with iOS safe area" : ""}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 640 });
    if (native) await page.evaluate(() => {
      document.documentElement.classList.add("native-ios");
      document.documentElement.style.setProperty("--app-safe-area-top-effective", "59px");
    });
    // Exercise the production opener and injected Close, not fixture buttons.
    const opener = page.getByRole("button", { name: "Open chat history", exact: true });
    await opener.click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const search = chats.getByRole("searchbox", { name: "Search chats" });
    const connectors = chats.getByRole("button", { name: "Open Connectors" });
    await expect(search).toBeVisible();
    await expect(connectors).toBeVisible();
    const reference = await profileFrame(page);
    await expect.poll(async () => (await chats.boundingBox())!.x).toBeCloseTo(reference.x, 0);
    const searchBox = (await search.boundingBox())!;
    const connectorBox = (await connectors.boundingBox())!;
    const drawerBox = (await chats.boundingBox())!;
    expect(connectorBox.y).toBeGreaterThan(searchBox.y + searchBox.height);
    expect(connectorBox.y + connectorBox.height).toBeLessThanOrEqual(drawerBox.y + drawerBox.height + 1);
    expect(await chats.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    // Both app panes share the reference's four rounded corners.
    const corners = await chats.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
    });
    expect(corners).toEqual(Array(4).fill(reference.radius));
    const close = chats.getByRole("button", { name: "Close chat history", exact: true });
    const closeBox = (await close.boundingBox())!;
    const target = await close.evaluate(element => {
      const style = getComputedStyle(element);
      return { width: parseFloat(style.width), height: parseFloat(style.height) };
    });
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    // Preserve rendered hitbox coverage without treating matrix roundoff as shrinkage.
    expect(closeBox.width).toBeCloseTo(target.width, 4);
    expect(closeBox.height).toBeCloseTo(target.height, 4);
    const leadingInset = await chats.evaluate(node => {
      const header = node.querySelector("[data-agent-history-header]")!;
      return parseFloat(getComputedStyle(header).paddingLeft) + parseFloat(getComputedStyle(node).borderLeftWidth);
    });
    expect(closeBox.x - drawerBox.x).toBeCloseTo(leadingInset, 0);
    expect(await close.evaluate(element => parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThanOrEqual(closeBox.width / 2);
    const title = chats.getByText("A weekend idea", { exact: true });
    const age = chats.locator("time");
    const titleBox = (await title.boundingBox())!, ageBox = (await age.boundingBox())!;
    expect(ageBox.x - (titleBox.x + titleBox.width)).toBeLessThanOrEqual(9);
    await page.screenshot({ path: testInfo.outputPath("public-history-leading-slot.png") });
    const titleStyle = await chats.getByRole("heading", { name: "Chats", exact: true }).evaluate(element => {
      const style = getComputedStyle(element);
      return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight };
    });
    expect(titleStyle).toEqual({ size: "20px", line: "23px", weight: "600" });
    // Match the side-pane renderer, including WebKit's intentional opaque
    // fallback. Floating Profile and portaled menus retain their glass policy.
    for (const dark of [false, true]) {
      await page.evaluate(enabled => document.documentElement.classList.toggle("dark", enabled), dark);
      const reference = await profileFrame(page);
      const material = await chats.evaluate(element => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor, border: style.borderTopColor,
          shadow: style.boxShadow, blur: style.backdropFilter,
          webkitBlur: style.getPropertyValue("-webkit-backdrop-filter"),
        };
      });
      expect(material).toEqual(reference.material);
    }
    await close.click();
    await expect(opener).toBeFocused();
  });


test("History tap and interrupted pulls settle the entire panel without shifting Chat", async ({ page }) => {
  await verifyHistoryMovement(page, false);
});

for (const { width, safeLeft } of [
  { width: 390, safeLeft: 0 },
  { width: 1440, safeLeft: 0 },
  { width: 844, safeLeft: 59 },
])
  test(`body swipe reveals the realtime drawer without shifting chat or bottom chrome at ${width}px (safe left ${safeLeft}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    if (safeLeft) await page.addStyleTag({ content: `[data-agent-history-drawer] { --app-side-pane-left-inset: ${safeLeft}px; }` });
    await mountAppChrome(page, 64);
    await expect(page.locator("[data-agent-history-drawer]")).toBeAttached();
    await awaitClosedHistoryGeometry(page);
    const result = await page.evaluate(async () => {
      const body = document.querySelector<HTMLElement>("[data-gesture-body]")!;
      const frame = document.querySelector<HTMLElement>("[data-agent-history-drawer]")!;
      const panel = frame;
      const header = panel.querySelector<HTMLElement>("[data-stationary-panel-chrome]")!;
      const scrim = document.querySelector<HTMLElement>("[data-agent-history-scrim]")!;
      const bar = document.querySelector<HTMLElement>("[data-fixture-bottom-bar]")!;
      const before = { body: body.getBoundingClientRect().x, bar: bar.getBoundingClientRect().x,
        header: header.getBoundingClientRect().x - panel.getBoundingClientRect().x };
      const closed = panel.getBoundingClientRect().x;
      let time = 0;
      function finger(type: string, dx: number) {
        const event = new Event(type, { bubbles: true });
        const point = { identifier: 1, clientX: 80 + dx, clientY: 500, target: body };
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
        Object.defineProperty(event, "changedTouches", { value: [point] });
        Object.defineProperty(event, "timeStamp", { value: time += 120 });
        body.dispatchEvent(event);
      }
      finger("touchstart", 0);
      const samples: { offset: number; expected: number; opacity: number; visible: boolean; headerInset: number }[] = [];
      for (const dx of [24, 48, 72, 96, 120]) {
        finger("touchmove", dx);
        await new Promise(requestAnimationFrame);
        samples.push({ offset: panel.getBoundingClientRect().x, expected: closed + dx,
          opacity: Number(getComputedStyle(scrim).opacity), visible: getComputedStyle(scrim).visibility === "visible",
          headerInset: header.getBoundingClientRect().x - panel.getBoundingClientRect().x });
      }
      const stationary = body.getBoundingClientRect().x === before.body && bar.getBoundingClientRect().x === before.bar;
      const filter = getComputedStyle(scrim).backdropFilter || getComputedStyle(scrim).webkitBackdropFilter;
      const inertDuringPull = frame.inert;
      finger("touchend", 120);
      return { samples, stationary, filter, inertDuringPull, headerInset: before.header };
    });
    for (const sample of result.samples) {
      expect(sample.offset).toBeCloseTo(sample.expected, 0);
      expect(sample.visible).toBe(true);
      expect(sample.opacity).toBeGreaterThan(0);
      expect(sample.opacity).toBeLessThan(1);
      expect(sample.headerInset).toBeCloseTo(result.headerInset, 0);
    }
    expect(result.stationary).toBe(true);
    expect(result.inertDuringPull).toBe(true);
    expect(result.filter).toContain("blur");
    const drawer = page.getByRole("dialog", { name: "Agent chat history" });
    await expect(drawer).toBeVisible();
    // Let the opening settle, then exercise the same owner in the other
    // direction. WebKit and Chromium must follow the finger, not wait for up.
    await expect(page.locator('[data-agent-history-drawer]')).not.toHaveAttribute("style", /will-change/);
    // Removing the gesture hint is not a rendered-position receipt. WebKit
    // can still be completing the CSS handoff; that is a valid interrupted
    // re-grab, tested separately, not this fully-open closing contract.
    await expectPaneRestingAtFrame(page, page.locator('[data-agent-history-drawer]'), safeLeft);
    await expect(page.locator("[data-agent-history-drawer]")).not.toHaveAttribute("style", /will-change/);
    // Auth freshness can temporarily disable the gesture while the drawer
    // remains open. Reattaching must preserve the same closed endpoint.
    for (const enabled of [false, true]) {
      await page.evaluate(value => {
        (window as unknown as { __setHistoryGestureEnabled: (enabled: boolean) => void }).__setHistoryGestureEnabled(value);
      }, enabled);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await expect.poll(() => page.locator("[data-agent-history-drawer]").evaluate(panel =>
      Math.abs(panel.getBoundingClientRect().x - (panel as HTMLElement).offsetLeft),
    )).toBeLessThanOrEqual(1);
    const closing = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLElement>("[data-agent-history-drawer]")!;
      const panel = frame;
      const scrim = document.querySelector<HTMLElement>("[data-agent-history-scrim]")!;
      const body = document.querySelector<HTMLElement>("[data-gesture-body]")!;
      const bar = document.querySelector<HTMLElement>("[data-fixture-bottom-bar]")!;
      const before = { body: body.getBoundingClientRect().x, bar: bar.getBoundingClientRect().x, panel: panel.getBoundingClientRect().x };
      let time = 0;
      function finger(type: string, dx: number) {
        const event = new Event(type, { bubbles: true });
        const point = { identifier: 1, clientX: 250 + dx, clientY: 500, target: panel };
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
        Object.defineProperty(event, "changedTouches", { value: [point] });
        Object.defineProperty(event, "timeStamp", { value: time += 120 });
        panel.dispatchEvent(event);
      }
      finger("touchstart", 0);
      const samples = [];
      for (const dx of [-24, -48, -72, -96, -120]) {
        finger("touchmove", dx);
        await new Promise(requestAnimationFrame);
        samples.push({ offset: panel.getBoundingClientRect().x, expected: before.panel + dx,
          opacity: Number(getComputedStyle(scrim).opacity), inert: panel.inert });
      }
      const stationary = body.getBoundingClientRect().x === before.body && bar.getBoundingClientRect().x === before.bar;
      finger("touchend", -120);
      // Measure the declared settlement endpoint rather than racing its
      // animation timer against browser scheduling.
      const closedRight = panel.offsetLeft + panel.offsetWidth + new DOMMatrix(panel.style.transform).m41;
      return { samples, stationary, closedRight };
    });
    for (const sample of closing.samples) {
      expect(sample.offset).toBeCloseTo(sample.expected, 0);
      expect(sample.opacity).toBeGreaterThan(0);
      expect(sample.opacity).toBeLessThan(1);
      expect(sample.inert).toBe(false);
    }
    expect(closing.stationary).toBe(true);
    expect(closing.closedRight).toBeLessThanOrEqual(-24);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Chat draft" })).toBeEnabled();
  });

for (const width of [390, 768, 1440])
  test(`chat sidebar matches Profile insets over the shared sheet scrim at ${width}px`, async ({ page }) => {
    // The reference card is inset; its modal scrim still protects the full
    // viewport, including the shared header and bottom navigation.
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
    const reference = await profileFrame(page);
    await expect.poll(async () => (await chats.boundingBox())!.x).toBeCloseTo(reference.x, 0);
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
    // The panel and the inner content have the same size as Profile, with
    // mirrored left/right screen gaps.
    const box = (await chats.boundingBox())!;
    const surface = (await panel.boundingBox())!;
    expect(box.y).toBeCloseTo(reference.y, 0);
    expect(box.height).toBeCloseTo(reference.height, 0);
    expect(box.width).toBeCloseTo(reference.width, 0);
    const border = await chats.evaluate(node => parseFloat(getComputedStyle(node).borderTopWidth));
    expect(surface.y).toBeCloseTo(box.y + border, 0);
    expect(surface.height).toBeCloseTo(box.height - 2 * border, 0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await chats.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe(reference.radius);

    // The gaps around the card still belong to the modal scrim; underlying
    // navigation cannot become active while the drawer is open.
    const beside = (box.x + box.width + width) / 2;
    const bounded = box.width < width;
    if (bounded) {
      expect(await hitAt(page, beside, 20)).toBe("scrim");
      expect(await hitAt(page, beside, height - barHeight / 2)).toBe("scrim");
      expect(await hitAt(page, box.x + box.width / 2, 2)).toBe("scrim");
      expect(await hitAt(page, box.x + box.width / 2, height - 2)).toBe("scrim");
    }
    expect(await hitAt(page, box.x + 40, box.y + 40)).toBe("panel");
    expect(await hitAt(page, box.x + 40, box.y + box.height - 40)).toBe("panel");

    // A tap on the scrim beside the panel closes it.
    if (bounded) await page.mouse.click(beside, height / 2);
    else await chats.getByRole("button", { name: "Close chat history" }).click();
    await expect(page.getByRole("dialog", { name: "Agent chat history", exact: true })).toHaveCount(0);
    // Header and body translate as one full-height panel. Closed, the whole
    // presentation is hidden/inert and clears the viewport, not a split body.
    await expect(page.locator("[data-agent-history-drawer]")).toHaveAttribute("inert", "");
    await expect.poll(() => page.locator("[data-agent-history-drawer]")
      .evaluate(element => getComputedStyle(element).visibility)).toBe("hidden");
    await expect
      .poll(async () => {
        const closed = await page.locator("[data-agent-history-drawer]").boundingBox();
        return closed ? closed.x + closed.width : 0;
      })
      .toBeLessThanOrEqual(1);
    // Closed, the scrim fades out and leaves no live backdrop filter behind.
    await expect.poll(async () => (await readScrim()).visibility).toBe("hidden");
    expect((await readScrim()).opacity).toBe("0");
    // And the chrome underneath is reachable again.
    expect(await hitAt(page, width / 2, height - barHeight / 2)).toBe("bottom-bar");
    expect(await hitAt(page, 20, 20)).toBe("header");
  });

test("chat sidebar scrim does not animate under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => (window as unknown as { __seedChatHistory: () => void }).__seedChatHistory());
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Agent chat history", exact: true })).toBeVisible();
  const transition = await page
    .locator("[data-agent-history-scrim]")
    .evaluate((element) => getComputedStyle(element).transitionProperty);
  expect(transition).toBe("none");
  const drawer = page.getByRole("dialog", { name: "Agent chat history", exact: true });
  const row = drawer.locator('[data-agent-history-row][data-state="active"]');
  await row.getByRole("button", { name: /^Weekly planning/ }).hover();
  expect(await row.evaluate(element => getComputedStyle(element).transform)).toBe("none");
  const close = drawer.getByRole("button", { name: "Close chat history" });
  await close.hover();
  expect(await close.evaluate(element => getComputedStyle(element).transform)).toBe("none");
});

for (const width of [390, 768])
  test(`chat sidebar runs over the fixed bottom bar with Connectors reachable at ${width}px`, async ({ page }) => {
    // The bounded frame is still above fixed navigation, so its footer
    // controls remain tappable and the gaps remain modal.
    const barHeight = 88;
    const height = 640;
    await page.setViewportSize({ width, height });
    await mountAppChrome(page, barHeight);
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const connectors = chats.getByRole("button", { name: "Open Connectors" });
    await expect(connectors).toBeVisible();
    const reference = await profileFrame(page);
    await expect.poll(async () => (await chats.boundingBox())!.x).toBeCloseTo(reference.x, 0);
    const drawerBox = (await chats.boundingBox())!;
    const connectorBox = (await connectors.boundingBox())!;
    expect(drawerBox.y + drawerBox.height).toBeCloseTo(reference.y + reference.height, 0);
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

for (const theme of ["light", "dark"] as const)
  test(`chat sidebar closes from its own control and returns focus to the trigger in ${theme}`, async ({ page }) => {
    await verifyChatHeaderControls(page, theme);
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
    // Opening moves focus to Open Connectors after body entry. `fill` focuses
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
    await expect(drawer).toHaveAttribute("data-slot", width < 640 ? "sheet-content" : "dialog-content");
    if (width >= 640) {
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
    for (const [connector, account, names] of [
      ["Gmail", "mail-owner@synthetic.invalid", ["Disconnect Mail"]],
      ["Google Drive", "drive-owner@synthetic.invalid", ["Disconnect Drive", "Choose files"]],
    ] as const) {
      await drawer.getByRole("button", { name: new RegExp(`^${connector}\\b`) }).click();
      await expect(drawer.locator(`[data-connector-detail="${connector === "Gmail" ? "gmail" : "google_drive"}"]`)).toBeFocused();
      await expect(drawer.getByText(account)).toBeVisible();
      if (connector === "Google Drive") {
        await expect(drawer.getByRole("button", { name: "Retry Drive" })).toHaveCount(0);
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
        expect(bounds.height + 0.0001).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      }
      await drawer.getByRole("button", { name: "Back to connectors" }).click();
      await expect(drawer.getByTestId(`profile-connector-row-${connector === "Gmail" ? "gmail" : "google_drive"}`).getByRole("button").first()).toBeFocused();
    }
    for (const name of ["Gmail", "Google Drive"]) {
      const button = drawer.getByRole("button", { name: new RegExp(`^${name}\\b`) });
      await button.scrollIntoViewIfNeeded();
      const bounds = (await button.boundingBox())!;
      expect(bounds.height + 0.0001).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    const overflow = await drawer.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { scroll: element.scrollWidth, client: element.clientWidth,
        children: [...element.querySelectorAll<HTMLElement>("*")].filter(child => {
          const box = child.getBoundingClientRect();
          return box.width > 0 && box.right > bounds.right + 1;
        }).slice(0, 8).map(child => ({ tag: child.tagName, role: child.getAttribute("role"),
          className: child.className, right: child.getBoundingClientRect().right - bounds.right })) };
    });
    expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.client + 1);
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
    // Escape is allowed during entry, before delayed body focus. An old
    // connector dismissal cannot make this newly opened layer unclosable.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Agent chat history", exact: true })).not.toBeVisible();
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
    const scrollRegion = dialog.locator('[data-history-connectors-scroll]');
    await expect(dialog.getByRole("banner").getByRole("heading", { name: "One access", exact: true })).toBeVisible();
    await expect.poll(() => scrollRegion.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    const plaid = dialog.getByTestId("profile-connector-row-plaid").getByRole("button").first();
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

for (const width of [390, 768, 1024]) {
  test(`dismissing Connectors returns the next hamburger open to chat history at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    const hamburger = page.getByRole("button", { name: "Open drawer", exact: true });
    const connectors = page.getByRole("dialog", { name: "Connectors", exact: true });
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });

    // Mobile uses the bottom Sheet; desktop uses the centered Dialog. Exercise
    // their actual dismissal targets after motion, then retain Escape coverage.
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
    if (width < 640) await connectors.getByRole("button", { name: "Close connectors", exact: true }).click();
    else {
      const bounds = (await connectors.boundingBox())!;
      expect(bounds.x).toBeGreaterThan(0);
      const x = bounds.x / 2;
      expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-slot="dialog-overlay"]') != null, [x, 400])).toBe(true);
      await page.mouse.click(x, 400);
    }
    await expect(connectors).not.toBeVisible();
    await hamburger.click();
    await expect(chats.getByRole("searchbox", { name: "Search chats" })).toBeVisible();

    await page.getByLabel("Open Connectors", { exact: true }).click();
    await expect(connectors).toBeVisible();
    await settled();
    await page.keyboard.press("Escape");
    await expect(connectors).not.toBeVisible();
    await expect(chats.getByRole("searchbox", { name: "Search chats" })).toBeVisible();
    await expect(chats.getByRole("button", { name: "Open Connectors" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(chats).not.toBeVisible();
    await hamburger.click();
    await expect(chats.getByRole("searchbox", { name: "Search chats" })).toBeVisible();
  });
}

test("Picker focus, explicit admission, and removal", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByTestId("profile-connector-row-google_drive").getByRole("button").first().click();
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
});

test("failed Drive revocation preserves the independent Mail connection", async ({ page }) => {
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByTestId("profile-connector-row-google_drive").getByRole("button").first().click();
  await page.getByRole("button", { name: "Disconnect Drive" }).click();
  await expect(page.getByText(/Existing Google sharing stays active until you revoke it/)).toBeVisible();
  await page.getByRole("alertdialog", { name: "Disconnect Google Drive?" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(
    page.getByText(/Google revocation was not confirmed/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to connectors" }).click();
  await page.getByTestId("profile-connector-row-gmail").getByRole("button").first().click();
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
  await page.getByTestId("profile-connector-row-google_drive").getByRole("button").first().click();
  await page.getByText("Previously added files", { exact: true }).click();
  const selectFile = async () => {
    await page.getByRole("button", { name: "Choose files", exact: true }).click();
    await page.getByRole("button", { name: "Pick synthetic file" }).click();
  };
  await selectFile();
  const consent = page.getByRole("checkbox", { name: "Agent One prepares these files while you’re away." });
  await expect(consent).toBeVisible();
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
  await expect(page.getByText("Agent One prepares this file while you’re away.", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "Close connectors", exact: true }).click();
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
        authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?synthetic=blocked&redirect_uri=${encodeURIComponent("http://localhost/one/profile/connectors/oauth/return")}`,
      }),
    }),
  );
  await page.getByRole("textbox", { name: "Chat draft" }).fill("Unsent draft");
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByTestId("profile-connector-row-google_drive").getByRole("button").first().click();
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
  await page.getByRole("button", { name: "Close connectors", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Chat draft" })).toHaveValue(
    "Unsent draft",
  );
});

test("Drive popup reaches Google with server clock skew and ignores forged settlement", async ({
  page,
  context,
}) => {
  const attemptId = "synthetic-oauth-attempt";
  const serverExpiresAt = Date.now() + 10 * 60_000 + 30_000;
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
          expiresAt: new Date(serverExpiresAt).toISOString(),
          authorizeUrl:
            "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fconnectors%2Foauth%2Freturn",
        }),
      }),
  );
  await context.route(
    "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fconnectors%2Foauth%2Freturn",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic consent</title><p>External consent fixture, not live Google proof</p>",
      }),
  );
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByTestId("profile-connector-row-google_drive").getByRole("button").first().click();
  await page.getByRole("button", { name: "Disconnect Drive" }).click();
  await page.getByRole("alertdialog", { name: "Disconnect Google Drive?" }).getByRole("button", { name: "Disconnect" }).click();
  const popupEvent = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Connect Drive", exact: true })
    .click();
  const popup = await popupEvent;
  await popup.waitForURL(
    "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fconnectors%2Foauth%2Freturn",
  );
  const popupExpiresAt = await page.evaluate(() => {
    const marker = localStorage.getItem("one_drive_popup_attempt_v1");
    return marker ? (JSON.parse(marker) as { expiresAt: number }).expiresAt : null;
  });
  expect(popupExpiresAt).not.toBeNull();
  expect(popupExpiresAt).toBeLessThan(serverExpiresAt);
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
    { attemptId, expiresAt: popupExpiresAt },
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
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fgoogle%2Foauth%2Freturn",
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
        google_email: calendar.connected ? "calendar-owner@synthetic.invalid" : null,
      }),
    });
  });
  await page.context().route(
    "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fgoogle%2Foauth%2Freturn",
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
  await page.getByTestId("profile-connector-row-calendar").getByRole("button").first().click();
  return { calendar, navigations: () => chatNavigations };
}

async function finishCallback(
  consent: import("@playwright/test").Page,
  options: { severOpener?: boolean } = {},
) {
  await consent.waitForURL("https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fgoogle%2Foauth%2Freturn");
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
  await expect(page.getByRole("region", { name: "Calendar details" }).getByText("Connected as calendar-owner@synthetic.invalid", { exact: true })).toBeVisible();
  expect(calendar.starts).toBe(1);
  await expectChatStateIntact(page, navigations);
  await page.getByRole("button", { name: "Back to connectors", exact: true }).click();
  await expect(page.getByText("Connected as calendar-owner@synthetic.invalid", { exact: true })).toBeVisible();
  await expect(page.getByText("Connected as mail-owner@synthetic.invalid", { exact: true })).toBeVisible();
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
  await consent.waitForURL("https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fgoogle%2Foauth%2Freturn");
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
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fgoogle%2Foauth%2Freturn",
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

test("legacy Gmail reconnect stays in place and reopens the reviewed draft", async ({ page }) => {
  const { server, navigations } = await armChatConnect(page);
  const history = page.getByTestId("one-email-history-failed");
  await history.getByText("Mail activity").click();
  const popupEvent = page.waitForEvent("popup");
  await history.getByRole("button", { name: "Reconnect Mail" }).click();
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
  if (process.env.CALENDAR_CHAT_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.CALENDAR_CHAT_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.CALENDAR_CHAT_SCREENSHOT_DIR, "synthetic-inline-calendar-permission.png"), fullPage: true });
  }
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

test("Calendar card reports missing scheduling permission for a read-only grant", async ({ page }) => {
  const { navigations } = await armChatConnect(page);
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Allow Calendar scheduling" }).click();
  const consent = await popupEvent;
  expect(await returnFromGoogle(consent, "google", "__settleGoogleOAuthCallback")).toBe(true);
  await expect(page.getByTestId("chat-connect-notice")).toHaveText("The requested Google Calendar permission was not enabled.");
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
  await history.getByRole("button", { name: "Reconnect Mail" }).click();
  await expect(page.getByTestId("chat-connect-notice")).toHaveText(
    "Allow pop-ups for One, then try again. Your chat and draft stay here.",
  );
  expect(server.calendarStarts).toBe(0);
  await expectChatIntact(page, navigations);
});

async function presencePixels(artwork: Locator, original?: ElementHandle | null) {
  return artwork.evaluate((canvas: HTMLCanvasElement, original) => {
    // Coverage and motion do not need a Retina-sized GPU readback. Keep exact
    // source-corner transparency checks independent of the small CPU probe.
    const scope = window as unknown as { __presencePixelProbe?: CanvasRenderingContext2D };
    const edge = original ? 128 : 32;
    if (!scope.__presencePixelProbe) {
      const probe = document.createElement("canvas");
      scope.__presencePixelProbe = probe.getContext("2d", { willReadFrequently: true })!;
    }
    const context = scope.__presencePixelProbe;
    // Batch the four exact source corners beside the coverage sample. One GPU
    // readback preserves all five probes without five compositor flushes.
    if (context.canvas.width !== edge + 4) {
      context.canvas.width = edge + 4;
      context.canvas.height = edge;
    }
    context.clearRect(0, 0, edge + 4, edge);
    context.drawImage(canvas, 0, 0, edge, edge);
    const { width, height } = canvas;
    const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
    corners.forEach(([x, y], index) => context.drawImage(canvas, x!, y!, 1, 1, edge + index, 0, 1, 1));
    const pixels = context.getImageData(0, 0, edge + 4, edge).data;
    let hash = 0, opaque = 0, bottom = -1;
    for (let row = 0; row < edge; row += 1) for (let col = 0; col < edge; col += 1) {
      const offset = (row * (edge + 4) + col) * 4;
      for (let channel = 0; channel < 4; channel += 1) hash = (Math.imul(hash, 31) + pixels[offset + channel]!) | 0;
      if (pixels[offset + 3]! > 0) opaque += 1;
      if (pixels[offset + 3]! > 20) bottom = row;
    }
    const surface = canvas.closest<HTMLElement>("[data-one-presence-state]")!;
    const style = original ? getComputedStyle(surface) : null;
    const bounds = original ? canvas.getBoundingClientRect() : null;
    const name = original ? surface.parentElement!.parentElement!.querySelector('[data-slot="sheet-title"]')!.getBoundingClientRect() : null;
    const gap = bounds && name ? name.top - (bounds.top + bounds.height * (bottom + 1) / edge) : 0;
    return { hash, opaque,
      resize: original && style ? {
        width: style.width, height: style.height, transform: style.transform,
        visible: getComputedStyle(canvas).visibility === "visible",
        playbackStatus: canvas.dataset.onePresencePlayback,
        playback: /waiting-for-paint|playing|paint-timeout|asset-error|runtime-error/.test(canvas.dataset.onePresencePlayback ?? ""),
        canvasCount: surface.querySelectorAll("canvas").length,
        sameCanvas: canvas === original, bufferWidth: width, bufferHeight: height,
        feetPainted: bottom > 0, nameGap: gap,
        nameClearOfFeet: gap >= -0.5, nameCloseToFeet: gap <= 6,
      } : undefined,
      cornerAlpha: corners.map((_, index) => pixels[(edge + index) * 4 + 3]) };
  }, original);
}

async function expectPresencePlayback(artwork: Locator) {
  try {
    // Cold WASM/asset loading precedes the component's bounded first-paint
    // probe. Diagnose each phase separately instead of timing paint from click.
    await expect(artwork.locator("canvas")).toHaveAttribute("data-one-presence-playback", /waiting-for-paint|playing|paint-timeout|asset-error|runtime-error/, { timeout: 10000 });
    await expect(artwork.locator("canvas")).toHaveCSS("visibility", "visible");
  } catch (error) {
    console.log("One playback failure", await artwork.evaluate(element => ({
      state: element.getAttribute("data-one-presence-artwork") ?? element.getAttribute("data-one-presence-state"),
      hidden: document.hidden,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      canvases: [...element.querySelectorAll("canvas")].map(canvas => ({
        status: canvas.dataset.onePresencePlayback,
        width: canvas.width, height: canvas.height,
        visibility: getComputedStyle(canvas).visibility,
        opacity: getComputedStyle(canvas.parentElement!).opacity,
        runtime: (window as any).__onePresenceRuntime?.get(canvas),
      })),
      posters: [...element.querySelectorAll("img")].map(image => ({ complete: image.complete, width: image.naturalWidth })),
      resources: performance.getEntriesByType("resource").filter(entry => entry.name.includes("/one-presence/")).map(entry => ({ path: new URL(entry.name).pathname, duration: entry.duration })),
    })));
    throw error;
  }
}

async function presenceMotion(canvases: Locator) {
  return canvases.evaluateAll(elements => new Promise(resolve => {
    const sources = elements as HTMLCanvasElement[];
    if (!sources.length) throw new Error("Missing native presence canvases");
    // Sample both real surfaces on the same display frame. A tiny CPU-readable
    // buffer still detects the authored blink without hashing 65,536 bytes per
    // surface per frame or serially waiting for two complete idle loops.
    const probe = document.createElement("canvas");
    probe.width = probe.height = 32;
    const context = probe.getContext("2d", { willReadFrequently: true })!;
    const observations = sources.map(source => {
      const runtime = (window as any).__onePresenceRuntime?.get(source);
      return { source, first: undefined as number | undefined, changed: false, paintedSamples: 0,
        runtimeStart: runtime && { ...runtime, gaps: [...runtime.gaps] } };
    });
    let frames = 0;
    let frame: number;
    let maxReadMs = 0;
    const started = performance.now();
    let lastFrame = started;
    let maxFrameGapMs = 0;
    let visibleFrames = 0;
    let focusedFrames = 0;
    const finish = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      const finished = performance.now();
      maxFrameGapMs = Math.max(maxFrameGapMs, finished - lastFrame);
      resolve(observations.map(({ source, changed, paintedSamples, runtimeStart }) => ({ changed, frames, maxReadMs, paintedSamples,
        maxFrameGapMs, visibleFrames, focusedFrames,
        duration: finished - started, status: source.dataset.onePresencePlayback,
        state: source.parentElement?.dataset.onePresenceArtwork,
        runtimeStart,
        runtime: (window as any).__onePresenceRuntime?.get(source) })));
    };
    const sample = () => {
      frames++;
      const now = performance.now();
      maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame);
      lastFrame = now;
      if (!document.hidden) visibleFrames++;
      if (document.hasFocus()) focusedFrames++;
      for (const observation of observations) {
        if (observation.changed) continue;
        const readStarted = performance.now();
        context.clearRect(0, 0, 32, 32);
        context.drawImage(observation.source, 0, 0, 32, 32);
        const pixels = context.getImageData(0, 0, 32, 32).data;
        let hash = 0, painted = false;
        for (let index = 0; index < pixels.length; index++) {
          const value = pixels[index]!;
          hash = (Math.imul(hash, 31) + value) | 0;
          if (index % 4 === 3 && value > 0) painted = true;
        }
        maxReadMs = Math.max(maxReadMs, performance.now() - readStarted);
        if (painted) {
          observation.paintedSamples++;
          observation.changed = observation.first !== undefined && hash !== observation.first;
          observation.first = hash;
        }
      }
      if (observations.every(observation => observation.changed)) return finish();
      frame = requestAnimationFrame(sample);
    };
    const timer = setTimeout(finish, 6500);
    frame = requestAnimationFrame(sample);
  }));
}

async function expectPresenceMotion(canvases: Locator) {
  const observations = await presenceMotion(canvases) as Array<{ changed: boolean }>;
  for (const motion of observations) expect(motion, JSON.stringify(motion)).toMatchObject({ changed: true });
}

async function expectPresenceNameGap(surface: Locator, profile = false) {
  const proof = await surface.evaluate((trigger, profile) => {
    const layer = trigger.querySelector('[data-one-presence-layer="current"]')!;
    const canvas = layer.querySelector("canvas")!;
    const artwork = getComputedStyle(canvas).visibility === "visible" ? canvas : layer.querySelector("img")!;
    const probe = document.createElement("canvas"); probe.width = probe.height = 128;
    const context = probe.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(artwork, 0, 0, 128, 128);
    const pixels = context.getImageData(0, 0, 128, 128).data;
    let bottom = -1;
    for (let index = 3; index < pixels.length; index += 4)
      if (pixels[index]! > 20) bottom = Math.floor(index / 4 / 128);
    const bounds = artwork.getBoundingClientRect();
    const name = (profile
      ? trigger.parentElement!.parentElement!.querySelector('[data-slot="sheet-title"]')!
      : trigger.closest('[data-agent-chat-header-region="identity"]')!.querySelector('[data-one-presence-name]')!
    ).getBoundingClientRect();
    return { bottom,
      gap: profile ? name.top - (bounds.top + bounds.height * (bottom + 1) / 128) : name.left - bounds.right,
      centerDifference: Math.abs(name.top + name.height / 2 - bounds.top - bounds.height / 2),
    };
  }, profile);
  expect(proof.bottom).toBeGreaterThan(0);
  if (profile) {
    expect(proof.gap, "name must not cover the mascot's feet").toBeGreaterThanOrEqual(-0.5);
    expect(proof.gap, "profile name sits directly beneath painted artwork").toBeLessThanOrEqual(6);
  } else {
    expect(proof.gap, "compact header name remains beside the artwork").toBeGreaterThanOrEqual(0);
    expect(proof.centerDifference, "compact header identity shares one aligned row").toBeLessThanOrEqual(1);
  }
}

test.describe("One profile artwork and animated presence", () => {
  // The npm pack runs these independent cases on one worker so unrelated
  // fixture builds cannot make the native runtime skip its brief idle blink.
  test.use({ deviceScaleFactor: 3 });
  for (const width of [390, 1440]) for (const reducedMotion of [false, true]) {
    test(`shows four distinct activity portraits ${reducedMotion ? "with reduced motion" : "while animations load"} at ${width}px`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
      let release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const requests: string[] = [];
      await page.route(/^http:\/\/localhost\/one-presence\/hd\/[a-z]+\.riv$/, async route => {
        requests.push(new URL(route.request().url()).pathname);
        await waiting;
        await route.fulfill({ contentType: "application/octet-stream", body: fs.readFileSync(path.join(process.cwd(), "public", new URL(route.request().url()).pathname)) });
      });
      await page.route("**/api/one/feed**", route => route.fulfill({ json: { items: [], next_cursor: null, unread_count: 0 } }));
      await page.setViewportSize({ width, height: 850 });
      await page.goto("http://localhost/connections-fixture?one-profile=1");
      await page.addScriptTag({ content: script });
      await page.bringToFront();
      await page.getByRole("button", { name: "Open One profile", exact: true }).click();
      const surfaces = [page.getByTestId("one-presence-header"), page.getByRole("dialog", { name: "One", exact: true })]
        .map(host => host.locator("[data-one-presence-state]"));
      const hashes = surfaces.map(() => new Set<number>());
      try {
        for (const state of ["connected", "thinking", "working", "answering"]) {
          await page.evaluate(state => (window as any).__setOnePresenceWork({
            drafting: state === "working", answering: state === "answering", thinking: state !== "connected",
          }), state);
          for (const [index, surface] of surfaces.entries()) {
            await expect(surface).toHaveAttribute("data-one-presence-state", state);
            const current = surface.locator('[data-one-presence-layer="current"]');
            await expect(current).toHaveAttribute("data-one-presence-artwork", state);
            const image = current.locator("img");
            await expect(image).toHaveCSS("visibility", "visible");
            const pixels = await image.evaluate((image: HTMLImageElement) => {
              const probe = document.createElement("canvas"); probe.width = probe.height = 32;
              const context = probe.getContext("2d", { willReadFrequently: true })!;
              context.drawImage(image, 0, 0, 32, 32);
              const pixels = context.getImageData(0, 0, 32, 32).data;
              let hash = 0, opaque = 0;
              pixels.forEach((value, index) => { hash = (Math.imul(hash, 31) + value) | 0; if (index % 4 === 3 && value > 0) opaque++; });
              return { hash, opaque };
            });
            expect(pixels.opaque).toBeGreaterThan(0);
            hashes[index]!.add(pixels.hash);
          }
          // Header identity is inline; the compact-header regression below verifies nonoverlap.
          await expectPresenceNameGap(surfaces[1]!, true);
          if (!reducedMotion) await expect.poll(() => requests.includes(`/one-presence/hd/${state}.riv`)).toBe(true);
        }
        for (const distinct of hashes) expect(distinct.size).toBe(4);
        if (reducedMotion) expect(requests).toEqual([]);
      } finally {
        release();
      }
      if (!reducedMotion) for (const surface of surfaces) await expectPresencePlayback(surface);
      for (const surface of surfaces) await expect(surface.locator('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "answering");
      expect(errors).toEqual([]);
    });
  }
  for (const density of [1, 2, 3]) {
    test.describe(`${density}x artwork surfaces`, () => {
      test.use({ deviceScaleFactor: density, hasTouch: true });
      test("keeps hover, press and tap clear", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
          if (["warning", "error"].includes(message.type())) errors.push(message.text());
        });
        await page.route("**/api/one/feed**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null, unread_count: 0 }) }));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("http://localhost/connections-fixture?one-profile=1");
        await page.addScriptTag({ content: script });
        await page.bringToFront();
        // The modal correctly hides the underlying trigger from the a11y
        // tree; retain its DOM locator for material checks while it is open.
        const trigger = page.getByTestId("one-presence-header");
        await expect(trigger).toHaveAccessibleName("Open One profile");
        const clearSurface = async () => {
          await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect(trigger).toHaveCSS("border-radius", "0px");
          await expect(trigger.locator(".morphy-ripple-host, md-ripple")).toHaveCount(0);
          await expect(trigger).toHaveCSS("touch-action", "manipulation");
          await expect(trigger).toHaveCSS("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)");
        };
        await trigger.hover();
        await clearSurface();
        await page.keyboard.press("Tab");
        await trigger.focus();
        await clearSurface();
        await expect(trigger).toHaveCSS("outline-width", "1px");
        await expect(trigger).toHaveCSS("outline-style", "solid");
        const bounds = (await trigger.boundingBox())!;
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await clearSurface();
        await expect(trigger).toHaveCSS("outline-style", "none");
        await page.mouse.up();
        const panel = page.getByRole("dialog", { name: "One", exact: true });
        await expect(panel).toBeVisible();
        await page.getByRole("button", { name: "Close One profile", exact: true }).click();
        await expect(panel).toBeHidden();
        // Use the browser's real touch path, including its synthesized click.
        await trigger.tap();
        await expect(panel).toBeVisible();
        await expect(page.getByRole("dialog", { name: "One", exact: true })).toHaveCount(1);
        await clearSurface();
        await expectPresencePlayback(panel.locator('[data-one-presence-state="connected"]'));
        expect(errors).toEqual([]);
      });
      // Keep pointer scene disposal separate from cumulative same-canvas resizing.
      // Each resize retains its own five-second paint deadline.
      test("resizes the same native canvas across phone and desktop widths", async ({ page }) => {
        test.setTimeout(45_000); // Eight resizes and two motion checks share this budget.
        const started = Date.now();
        const checkpoint = (phase: string, width?: number, size?: number) => {
          console.log("One native resize", JSON.stringify({ density, phase, width, size, elapsedMs: Date.now() - started }));
        };
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
          if (["warning", "error"].includes(message.type())) errors.push(message.text());
        });
        await page.route("**/api/one/feed**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null, unread_count: 0 }) }));
        await page.setViewportSize({ width: 390, height: 844 });
        // Isolate resize performance from the separately tested 3.2s state hold
        // and cold outgoing-scene work; keep every bitmap/spacing assertion.
        await page.goto("http://localhost/connections-fixture?one-profile=1&initial-presence=working");
        await page.addScriptTag({ content: script });
        await page.bringToFront();
        const trigger = page.getByTestId("one-presence-header");
        await trigger.click();
        const panel = page.getByRole("dialog", { name: "One", exact: true });
        await expect(panel).toBeVisible();
        checkpoint("mounted");
        const artwork = panel.locator('[data-one-presence-state="working"]');
        await expectPresencePlayback(artwork.locator('[data-one-presence-artwork="working"]'));
        await expect(artwork.locator("canvas")).toHaveCount(1);
        const original = await artwork.locator("canvas").elementHandle();
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await expectPresencePlayback(trigger);
          // Header identity is inline; the compact-header regression below verifies nonoverlap.
          for (const size of [128, 192, 256, 192]) {
            checkpoint("resize started", width, size);
            await artwork.evaluate((node, size) => {
              (node.parentElement as HTMLElement).style.setProperty("--one-presence-size", `${size}px`);
            }, size);
            const canvas = artwork.locator("canvas");
            const expectedBuffer = Math.min(768, size * density);
            // Sample geometry, the native bitmap and painted-foot spacing on
            // the same frame. Separate browser reads repeatedly flush Linux
            // WebKit's software compositor at Retina density.
            let lastSample: Awaited<ReturnType<typeof presencePixels>> | undefined;
            await expect.poll(async () => {
              const pixels = await presencePixels(canvas, original);
              lastSample = pixels;
              return { ...pixels.resize, painted: pixels.opaque > 0, cornerAlpha: pixels.cornerAlpha };
            }, { timeout: 5_000 }).toMatchObject({
              width: `${size}px`, height: `${size}px`, transform: "none",
              visible: true, playback: true, canvasCount: 1, sameCanvas: true,
              bufferWidth: expectedBuffer, bufferHeight: expectedBuffer,
              feetPainted: true, nameClearOfFeet: true, nameCloseToFeet: true,
              painted: true, cornerAlpha: [0, 0, 0, 0],
            }).catch(error => {
              console.log("One native resize failure", JSON.stringify({ density, width, size, elapsedMs: Date.now() - started, sample: lastSample }));
              throw error;
            });
            checkpoint("resized", width, size);
          }
          checkpoint("motion", width);
          await expectPresenceMotion(artwork.locator("canvas"));
          checkpoint("motion verified", width);
        }
        expect(errors).toEqual([]);
      });
    });
  }
  test("retains painted artwork through delayed loads and interrupted transitions", async ({ page }) => {
    test.setTimeout(45_000);
    // Each phase dwells for a full painted loop before its fade can commit.
    // Asset readiness is checked separately from this presentation budget.
    const phaseCommitTimeout = 8_000;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    await page.route("http://localhost/one-presence/hd/working.riv", async route => {
      await waiting;
      await route.fulfill({ contentType: "application/octet-stream", body: fs.readFileSync(path.join(process.cwd(), "public/one-presence/hd/working.riv")) });
    });
    await page.route("http://localhost/one-presence/drafting-hd.png", async route => {
      await waiting;
      await route.fulfill({ contentType: "image/png", body: fs.readFileSync(path.join(process.cwd(), "public/one-presence/drafting-hd.png")) });
    });
    await page.route("**/api/one/feed**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null, unread_count: 0 }) }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://localhost/connections-fixture?one-profile=1");
    await page.addScriptTag({ content: script });
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false);
    await page.getByRole("button", { name: "Open One profile", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "One", exact: true });
    const profile = panel.locator("[data-one-presence-state]");
    await expectPresencePlayback(profile);
    await expect.poll(async () => (await presencePixels(profile.locator("canvas"))).opaque).toBeGreaterThan(0);
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-one-presence-state]")];
      const sample = document.createElement("canvas");
      sample.width = sample.height = 32;
      const context = sample.getContext("2d", { willReadFrequently: true })!;
      const proof = { blank: 0, detached: 0, minPeakAlpha: 255, interrupted: false, interruptedOpacity: 0, minLayers: [] as unknown[], frames: 0, intervals: [] as number[], previous: performance.now(), stop: false };
      // Hold the real CSS transitions halfway before requesting the next phase.
      // Resume when the replacement is committed, independently of RAF cadence.
      const interrupt = new MutationObserver(() => {
        if (proof.interrupted) return;
        const thinking = nodes.at(-1)?.querySelector<HTMLElement>('[data-one-presence-artwork="thinking"]');
        if (thinking?.style.opacity !== "1" || !thinking.getAnimations().length) return;
        const fades = nodes.flatMap(node => [...node.querySelectorAll<HTMLElement>("[data-one-presence-artwork]")].flatMap(layer => layer.getAnimations()));
        for (const fade of fades) {
          fade.pause();
          fade.currentTime = Number(fade.effect!.getComputedTiming().duration) / 2;
        }
        proof.interruptedOpacity = Number(getComputedStyle(thinking).opacity);
        proof.interrupted = true;
        (window as any).__setOnePresenceWork({ drafting: false, answering: true, thinking: true });
        // A new request must not restart or cancel the in-flight fade.
        requestAnimationFrame(() => fades.forEach(fade => fade.play()));
        interrupt.disconnect();
      });
      for (const node of nodes) interrupt.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
      const sampleFrame = (now: number) => {
        if (proof.stop) return;
        proof.frames++;
        proof.intervals.push(now - proof.previous);
        proof.previous = now;
        for (const node of nodes) {
          if (!node.isConnected) proof.detached++;
          context.clearRect(0, 0, 32, 32);
          for (const layer of node.querySelectorAll<HTMLElement>("[data-one-presence-artwork]")) {
            const style = getComputedStyle(layer);
            context.globalAlpha = Number(style.opacity);
            context.globalCompositeOperation = style.mixBlendMode === "plus-lighter" ? "lighter" : "source-over";
            const canvas = layer.querySelector("canvas")!;
            const image = layer.querySelector("img")!;
            if (getComputedStyle(canvas).visibility === "visible") context.drawImage(canvas, 0, 0, 32, 32);
            else if (image.complete && image.naturalWidth) context.drawImage(image, 0, 0, 32, 32);
          }
          const pixels = context.getImageData(0, 0, 32, 32).data;
          let peak = 0;
          for (let index = 3; index < pixels.length; index += 4) peak = Math.max(peak, pixels[index]!);
          if (!peak) proof.blank++;
          if (peak < proof.minPeakAlpha) {
            proof.minPeakAlpha = peak;
            proof.minLayers = [...node.querySelectorAll<HTMLElement>("[data-one-presence-artwork]")].map(layer => {
              const style = getComputedStyle(layer);
              const image = layer.querySelector("img")!;
              return { state: layer.dataset.onePresenceArtwork, layer: layer.dataset.onePresenceLayer, opacity: style.opacity, desiredOpacity: layer.style.opacity, duration: style.transitionDuration, blend: style.mixBlendMode, visible: getComputedStyle(layer.querySelector("canvas")!).visibility,
                poster: { src: image.getAttribute("src"), visible: getComputedStyle(image).visibility, complete: image.complete, width: image.naturalWidth } };
            });
          }
        }
        requestAnimationFrame(sampleFrame);
      };
      Object.assign(window, { __presenceContinuity: proof });
      requestAnimationFrame(sampleFrame);
      (window as any).__setOnePresenceWork({ drafting: true, answering: false, thinking: true });
    });
    let proof: any;
    try {
      await expect(profile.locator('[data-one-presence-layer="incoming"]')).toHaveAttribute("data-one-presence-artwork", "working");
      await page.waitForTimeout(180);
      await expect(profile.locator('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "connected");
      await page.evaluate(() => (window as any).__setOnePresenceWork({ drafting: false, answering: false, thinking: true }));
      release();
      await expectPresencePlayback(profile.locator('[data-one-presence-artwork="working"]'));
      await expect(profile.locator('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "working", { timeout: phaseCommitTimeout });
      await expectPresencePlayback(profile.locator('[data-one-presence-artwork="thinking"]'));
      await expect.poll(() => page.evaluate(() => (window as any).__presenceContinuity.interrupted)).toBe(true);
      await expect(profile.locator('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "thinking", { timeout: phaseCommitTimeout });
      await expectPresencePlayback(profile.locator('[data-one-presence-artwork="answering"]'));
      await expect(profile.locator('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "answering", { timeout: phaseCommitTimeout });
      await expect(profile.locator("[data-one-presence-artwork]")).toHaveCount(1);
      await expectPresencePlayback(profile);
      await expect.poll(() => page.evaluate(() => (window as any).__presenceContinuity.frames)).toBeGreaterThan(5);
    } finally {
      release();
      proof = await page.evaluate(() => {
        const proof = (window as any).__presenceContinuity;
        proof.stop = true;
        return { ...proof, layers: [...document.querySelectorAll<HTMLElement>("[data-one-presence-artwork]")].map(layer => ({
          state: layer.dataset.onePresenceArtwork, role: layer.dataset.onePresenceLayer,
          opacity: getComputedStyle(layer).opacity,
          playback: layer.querySelector("canvas")?.dataset.onePresencePlayback,
          animations: layer.getAnimations().map(animation => ({ state: animation.playState, time: animation.currentTime })),
        })) };
      });
      const probePath = test.info().outputPath("presence-frame-probe.json");
      fs.writeFileSync(probePath, JSON.stringify(proof, null, 2));
      await test.info().attach("presence-transition-frame-probe", { path: probePath, contentType: "application/json" });
    }
    expect(proof.interruptedOpacity).toBeGreaterThan(0);
    expect(proof.interruptedOpacity).toBeLessThan(1);
    expect(proof.blank, "no empty animation frame").toBe(0);
    expect(proof.detached, "avatar geometry stays mounted").toBe(0);
    expect(proof.minPeakAlpha, JSON.stringify(proof.minLayers)).toBeGreaterThanOrEqual(250);
  });
  test("keeps brief activities perceptible in both locations and recovers from an animation load failure", async ({ page }) => {
    test.setTimeout(45000);
    let failWorking = true;
    await page.route("http://localhost/one-presence/hd/working.riv", async route => {
      if (failWorking) return route.abort("failed");
      await route.fulfill({ contentType: "application/octet-stream", body: fs.readFileSync(path.join(process.cwd(), "public/one-presence/hd/working.riv")) });
    });
    await page.route("**/api/one/feed**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null, unread_count: 0 }) }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://localhost/connections-fixture?one-profile=1");
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Open One profile", exact: true }).click();
    const avatars = page.locator("[data-one-presence-state]");
    await expect(avatars).toHaveCount(2);
    await expectPresencePlayback(avatars.last());
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-one-presence-state]")];
      const histories = nodes.map(() => [] as { state: string; start: number; duration: number }[]);
      const proof = { histories, stop: false, blank: 0 };
      const sample = (now: number) => {
        if (proof.stop) return;
        nodes.forEach((node, index) => {
          const layer = node.querySelector<HTMLElement>('[data-one-presence-layer="current"]')!;
          if (Number(getComputedStyle(layer).opacity) < 0.999) return;
          const image = layer.querySelector("img")!;
          const canvas = layer.querySelector("canvas")!;
          if (getComputedStyle(canvas).visibility !== "visible" && !(image.complete && image.naturalWidth)) proof.blank++;
          const history = histories[index]!;
          let entry = history.at(-1);
          if (entry?.state !== layer.dataset.onePresenceArtwork) {
            entry = { state: layer.dataset.onePresenceArtwork!, start: now, duration: 0 };
            history.push(entry);
          }
          entry.duration = now - entry.start;
        });
        requestAnimationFrame(sample);
      };
      Object.assign(window, { __presenceDwell: proof });
      requestAnimationFrame(sample);
    });
    // Separate real event-loop turns so React observes each actual UI phase.
    for (const work of [
      { thinking: true }, { drafting: true, thinking: true },
      { answering: true, thinking: true }, {},
    ]) {
      await page.evaluate(work => (window as any).__setOnePresenceWork(work), work);
      await page.waitForTimeout(80);
    }
    await expect(avatars.first()).toHaveAttribute("data-one-presence-state", "connected");
    for (const state of ["thinking", "working", "answering", "connected"]) {
      for (const avatar of await avatars.all()) {
        await expect(avatar.locator('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", state);
      }
      if (state === "working") {
        for (const avatar of await avatars.all()) await expect(avatar.locator('[data-one-presence-layer="current"] img')).toBeVisible();
      }
    }
    await expect.poll(() => page.evaluate(() => (window as any).__presenceDwell.histories.every((history: any[]) => history.at(-1)?.duration >= 3000))).toBe(true);
    const proof = await page.evaluate(() => {
      const proof = (window as any).__presenceDwell;
      proof.stop = true;
      return proof;
    });
    for (const history of proof.histories) {
      expect(history.slice(1).map((entry: any) => entry.state)).toEqual(["thinking", "working", "answering", "connected"]);
      for (const entry of history.slice(1)) expect(entry.duration, entry.state).toBeGreaterThanOrEqual(3000);
    }
    expect(proof.blank).toBe(0);
    await test.info().attach("presence-visible-intervals", { body: Buffer.from(JSON.stringify(proof)), contentType: "application/json" });
    failWorking = false;
    await page.evaluate(() => (window as any).__setOnePresenceWork({ drafting: true }));
    for (const avatar of await avatars.all()) {
      await expect(avatar.locator('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "working");
      await expectPresencePlayback(avatar);
    }
  });
  test("keeps header and profile presence in sync through all four native Rive states", async ({ page }) => {
    // Cold WASM loading plus two surfaces' three-second idle loops precede
    // the remaining native states; all bounded playback assertions still apply.
    test.setTimeout(45000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/one/feed**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null, unread_count: 0 }) }));
    await page.goto("http://localhost/connections-fixture?one-profile=1");
    await page.addScriptTag({ content: script });
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false);
    await awaitProductFont(page);
    const trigger = page.getByRole("button", { name: "Open One profile", exact: true });
    await trigger.hover();
    await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(trigger).toHaveCSS("border-radius", "0px");
    // A transparent button can still paint Material Web's shadow-DOM hover
    // pseudo-element. This artwork control must not mount that layer at all.
    await expect(trigger.locator(".morphy-ripple-host, md-ripple")).toHaveCount(0);
    // Tailwind composes shadow-none with zero-alpha ring/shadow slots.
    await expect(trigger).toHaveCSS("box-shadow", /^(?:none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(?:, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)*)$/);
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "One", exact: true });
    await expect.poll(() => panel.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).m41)).toBeCloseTo(0, 1);
    const header = page.getByTestId("one-presence-header").locator("[data-one-presence-state]");
    const profile = panel.locator("[data-one-presence-state]");
    for (const phase of [
      { working: false, drafting: false, answering: false, thinking: false, state: "connected" },
      { working: false, drafting: false, answering: false, thinking: true, state: "thinking" },
      { working: true, drafting: false, answering: true, thinking: true, state: "working" },
      { working: false, drafting: false, answering: true, thinking: true, state: "answering" },
      { working: false, drafting: false, answering: false, thinking: false, state: "connected" },
    ]) {
      await page.evaluate(work => {
        (window as unknown as { __setOnePresenceWork: (work: { working: boolean; drafting: boolean; answering: boolean; thinking: boolean }) => void }).__setOnePresenceWork(work);
      }, { working: phase.working, drafting: phase.drafting, answering: phase.answering, thinking: phase.thinking });
      await Promise.all([header, profile].map(artwork =>
        expectPresencePlayback(artwork.locator(`[data-one-presence-artwork="${phase.state}"]`))));
      // One browser read per phase keeps the same geometry, material and
      // settlement proof without dozens of sequential remote round trips.
      const expectedSurface = {
        state: phase.state, artwork: [phase.state],
        canvas: { width: 96, height: 96, visibility: "visible", playback: "playing" },
        poster: "hidden",
      };
      await expect.poll(() => page.locator("[data-one-presence-state]").evaluateAll(nodes => nodes.map((node, index) => {
        const canvas = node.querySelector("canvas");
        const image = node.querySelector("img");
        const bounds = node.getBoundingClientRect();
        return {
          state: node.getAttribute("data-one-presence-state"),
          artwork: [...node.querySelectorAll("[data-one-presence-artwork]")].map(layer => layer.getAttribute("data-one-presence-artwork")),
          canvas: canvas && { width: canvas.width, height: canvas.height,
            visibility: getComputedStyle(canvas).visibility, playback: canvas.dataset.onePresencePlayback },
          poster: image && getComputedStyle(image).visibility,
          ...(index === 1 ? { profile: { width: bounds.width, height: bounds.height,
            background: getComputedStyle(node).backgroundColor,
            parentBackground: getComputedStyle(node.parentElement!).backgroundColor,
            parentRadius: getComputedStyle(node.parentElement!).borderRadius } } : {}),
        };
      }))).toEqual([{ ...expectedSurface, canvas: { ...expectedSurface.canvas, width: 96, height: 96 } }, { ...expectedSurface, canvas: { ...expectedSurface.canvas, width: 672, height: 672 }, profile: {
        width: 224, height: 224, background: "rgba(0, 0, 0, 0)",
        parentBackground: "rgba(0, 0, 0, 0)", parentRadius: "0px",
      } }]);
      const canvases = page.locator(`[data-one-presence-artwork="${phase.state}"] canvas`);
      await expect(canvases).toHaveCount(2);
      await Promise.all([0, 1].map(async index => {
        const canvas = canvases.nth(index);
        const textures = await canvas.evaluate(canvas => (window as any).__onePresenceTextures.get(canvas));
        expect(textures, "native animation must embed genuine source pixels, not enlarge 128px frames").toEqual(phase.state === "working" ? Array.from({ length: 16 }, () => [314, 314]) : [[1254, 1254]]);
        await expect.poll(async () => (await presencePixels(canvas)).opaque).toBeGreaterThan(0);
        expect((await presencePixels(canvas)).cornerAlpha).toEqual([0, 0, 0, 0]);
      }));
      await expectPresenceMotion(canvases);
      // Header identity is inline; the compact-header regression below verifies nonoverlap.
      await expectPresenceNameGap(profile, true);
      await page.screenshot({ path: test.info().outputPath(`presence-${phase.state}.png`) });
    }
    // A cheaper observation must still reject a real frozen native renderer.
    await page.evaluate(() => (window as any).__setOnePresenceLifecycle("background"));
    const frozen = await presenceMotion(page.locator('[data-one-presence-artwork="connected"] canvas')) as Array<{ changed: boolean; frames: number; status: string; paintedSamples: number }>;
    expect(frozen).toHaveLength(2);
    for (const motion of frozen) {
      expect(motion.changed, JSON.stringify(motion)).toBe(false);
      expect(motion.frames).toBeGreaterThan(5);
      expect(motion.status).toBe("paused");
      expect(motion.paintedSamples).toBeGreaterThan(5);
    }
  });
  test("keeps HD reduced-motion artwork and pauses rendering for app lifecycle changes", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/one/feed**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null, unread_count: 0 }) }));
    await page.goto("http://localhost/connections-fixture?one-profile=1");
    await page.addScriptTag({ content: script });
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false);
    await awaitProductFont(page);
    await page.getByRole("button", { name: "Open One profile", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "One", exact: true });
    await page.evaluate(() => (window as any).__setOnePresenceWork({ drafting: true, answering: true, thinking: true }));
    const profile = panel.locator('[data-one-presence-state="working"]');
    const layer = profile.locator('[data-one-presence-artwork="working"]');
    // A single outgoing layer can precede the incoming runtime's React commit.
    // Wait for the requested painted layer before asserting fade settlement.
    await expectPresencePlayback(layer);
    await expect(profile.locator("[data-one-presence-artwork]")).toHaveCount(1);
    const canvas = layer.locator("canvas");
    const poster = layer.locator("img");
    await expect(canvas).toHaveCSS("visibility", "visible");
    await expect.poll(async () => (await presencePixels(canvas)).opaque).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(canvas).toBeHidden();
    await expect(poster).toBeVisible();
    await expect(poster).toHaveAttribute("src", "/one-presence/drafting-hd.png");
    await expect(poster).toHaveCSS("visibility", "visible");
    await expect.poll(() => poster.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth >= image.getBoundingClientRect().width * devicePixelRatio)).toBe(true);
    const reduced = (await presencePixels(canvas)).hash;
    await page.waitForTimeout(200);
    expect((await presencePixels(canvas)).hash).toBe(reduced);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(canvas).toHaveCSS("visibility", "visible");
    await expect(poster).toHaveCSS("visibility", "hidden");
    await expect.poll(async () => (await presencePixels(canvas)).opaque).toBeGreaterThan(0);
    await expect.poll(async () => (await presencePixels(canvas)).hash).not.toBe(reduced);
    await page.evaluate(() => (window as any).__setOnePresenceLifecycle("background"));
    await expect(canvas).toBeHidden();
    await expect(poster).toBeVisible();
    const paused = (await presencePixels(canvas)).hash;
    await page.waitForTimeout(200);
    expect((await presencePixels(canvas)).hash).toBe(paused);
    await page.evaluate(() => (window as any).__setOnePresenceLifecycle("active"));
    await expect(canvas).toBeVisible();
    await expect(poster).toBeHidden();
    await expect.poll(async () => (await presencePixels(canvas)).hash).not.toBe(paused);
    // Exercise Rive's own zero-size recovery, which normally restores device
    // DPR. The avatar must restore its source pixel budget before playback.
    await profile.evaluate(element => { (element as HTMLElement).style.display = "none"; });
    await expect(canvas).toHaveAttribute("data-one-presence-playback", "paused");
    await profile.evaluate(element => { (element as HTMLElement).style.removeProperty("display"); });
    await expectPresencePlayback(profile);
    expect(await canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height }))).toEqual({ width: 672, height: 672 });
    await page.getByRole("button", { name: "Close One profile", exact: true }).click();
    await expect(panel).toBeHidden();
    await page.evaluate(() => (window as any).__setOnePresenceWork({ drafting: false, answering: false, thinking: false }));
    const header = page.getByTestId("one-presence-header");
    // One outgoing layer can still precede the queued idle request's commit.
    await expect(header.locator('[data-one-presence-layer="current"]')).toHaveAttribute("data-one-presence-artwork", "connected");
    await expect(header.locator("[data-one-presence-artwork]")).toHaveCount(1);
    await expect(header.locator("img")).toHaveAttribute("src", "/one-presence/profile-hd.png");
  });
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    test(`One profile keeps its header and tabs stationary while switching at ${viewport.width}px`, async ({ page }) => {
      // HD artwork and three complete tab round trips share this scenario's budget.
      // Geometry/state expectations retain their individual deadlines.
      test.setTimeout(60_000);
      // Layout is independent of playback. Exercise supported reduced motion;
      // the dedicated native cases above verify movement, fades and lifecycle.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(viewport);
      await page.route("**/api/one/feed**", route => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({
          id: String(i + 100), event_type: "connection_accepted", source_domain: "connections",
          actor_label: `Synthetic person ${i + 1}`, metadata: {}, read: false,
          created_at: "2026-10-12T08:00:00Z",
        })), next_cursor: null, unread_count: 20 }),
      }));
      await page.goto("http://localhost/connections-fixture?one-profile=1");
      await page.addScriptTag({ content: script });
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false);
      await awaitProductFont(page);
      const trigger = page.getByRole("button", { name: "Open One profile", exact: true });
      const headerAvatar = trigger.locator("[data-one-presence-state]");
      const headerSize = 32;
      for (const artwork of [headerAvatar, headerAvatar.locator("img"), headerAvatar.locator("canvas")]) {
        // The loading canvas and animated poster can be visibility:hidden;
        // their geometry must still match the owning avatar.
        const bounds = await artwork.evaluate(element => {
          const { width, height } = element.getBoundingClientRect();
          return { width, height };
        });
        expect(bounds.width).toBe(headerSize);
        expect(bounds.height).toBe(headerSize);
      }
      await trigger.click();
      const panel = page.getByRole("dialog", { name: "One", exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("feed-row").first()).toBeVisible();
      // Geometry is measured after the sheet's entrance motion settles.
      await expect.poll(() => panel.evaluate(element =>
        new DOMMatrix(getComputedStyle(element).transform).m41)).toBeCloseTo(0, 1);
      const avatar = panel.locator("[data-one-presence-state]");
      await expect(avatar).toBeVisible();
      // A loaded thumbnail still fails: the source must cover the actual
      // profile presentation at the device's physical pixel density.
      await expect.poll(() => avatar.locator("img").evaluate((image: HTMLImageElement) => {
        const bounds = image.getBoundingClientRect();
        return image.complete &&
          image.naturalWidth >= Math.ceil(bounds.width * devicePixelRatio) &&
          image.naturalHeight >= Math.ceil(bounds.height * devicePixelRatio);
      })).toBe(true);
      const profileSize = Math.min(224, Math.max(208, viewport.width - 112));
      expect((await avatar.boundingBox())!.width).toBe(profileSize);
      expect((await avatar.boundingBox())!.height).toBe(profileSize);
      const rail = panel.getByRole("tablist", { name: "One profile sections" });
      const initial = (await rail.boundingBox())!;
      const frame = (await panel.boundingBox())!;
      const scroll = await panel.getByRole("tabpanel", { name: "Feed" }).evaluate(element => {
        let node = element.parentElement;
        while (node && !["auto", "scroll"].includes(getComputedStyle(node).overflowY)) node = node.parentElement;
        if (!node) throw new Error("Missing active-panel scroller");
        node.scrollTop = node.scrollHeight;
        return node.scrollTop;
      });
      expect(scroll).toBeGreaterThan(80);
      expect((await rail.boundingBox())!.y).toBeCloseTo(initial.y, 1);
      for (let i = 0; i < 3; i += 1) {
        if (i === 2) await page.evaluate(() => document.documentElement.classList.add("dark"));
        await panel.getByRole("tab", { name: "Profile", exact: true }).click();
        // This read-only fixture has a locked vault. Live Mirror replaces the
        // former static card and must not expose an unlocked Memory link.
        await expect(panel.getByTestId("live-mirror-status")).toContainText("Memory locked");
        expect((await rail.boundingBox())!.y).toBeCloseTo(initial.y, 1);
        await panel.getByRole("tab", { name: "Feed", exact: true }).click();
        await expect(panel.getByTestId("feed-row").first()).toBeVisible();
        expect((await rail.boundingBox())!.y).toBeCloseTo(initial.y, 1);
      }
      expect(frame.x).toBeGreaterThan(0);
      expect(frame.x + frame.width).toBeLessThanOrEqual(viewport.width);
      expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height);
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("one-profile-atd.png") });
    });
  }
});

// The account pane's legacy 24-unit stroke overrides must not distort
// Phosphor's filled 256-unit reset glyph. Mount the real row and pane styles.
test("Reset icon colors only its arrowhead and keeps native geometry in the account pane", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://localhost/connections-fixture?reset-icon=1");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  const row = page.getByRole("button", { name: /Reset account/ });
  const icon = row.locator('[data-slot="settings-row-icon"] svg');
  for (const theme of ["light", "dark"]) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await expect(icon).toBeVisible();
    const geometry = await icon.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { width: bounds.width, height: bounds.height, stroke: style.stroke,
        fill: style.fill,
        viewBox: element.getAttribute("viewBox") };
    });
    expect(geometry.viewBox).toBe("0 0 256 256");
    expect(geometry.width).toBe(24);
    expect(geometry.height).toBe(24);
    expect(geometry.stroke).toBe("none");
    expect(geometry.fill).not.toBe("none");
    const pixels = await icon.evaluate(async element => {
      const svg = element as SVGSVGElement;
      const copy = svg.cloneNode(true) as SVGSVGElement;
      copy.setAttribute("width", "256");
      copy.setAttribute("height", "256");
      copy.style.color = getComputedStyle(svg).color;
      const paintedNodes = svg.querySelectorAll("[fill]");
      // Standalone SVG images cannot inherit the page's theme variables.
      copy.querySelectorAll("[fill]").forEach((node, index) => {
        const fill = getComputedStyle(paintedNodes[index]).fill;
        if (!fill.startsWith("url(")) node.setAttribute("fill", fill);
      });
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const sample = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
      const color = (value: string) => {
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        return sample(0, 0);
      };
      return {
        verticalHead: sample(24, 64), horizontalHead: sample(60, 104),
        diagonal: sample(48, 84), arc: sample(216, 128), bottom: sample(128, 216),
        accent: color(getComputedStyle(svg).getPropertyValue("--account-accent")),
        ink: color(getComputedStyle(svg).color),
      };
    });
    expect(pixels.accent).toEqual([0, 122, 255, 255]);
    expect(pixels.verticalHead).toEqual(pixels.accent);
    expect(pixels.horizontalHead).toEqual(pixels.accent);
    for (const sample of [pixels.diagonal, pixels.arc, pixels.bottom]) {
      expect(sample).toEqual(pixels.ink);
    }
    const inkChannels = pixels.ink.slice(0, 3);
    if (theme === "light") expect(Math.max(...inkChannels)).toBeLessThan(64);
    else expect(Math.min(...inkChannels)).toBeGreaterThan(220);
    await expect(row.getByText("Clears saved details")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`reset-icon-${theme}.png`) });
  }
});

for (const width of [320, 390])
  test(`History preserves full long titles at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const title = "Plan the next family holiday and discuss every booking " + "LongReservationReference".repeat(5);
    await page.evaluate(value => (window as unknown as { __seedChatHistory: (title: string) => void }).__seedChatHistory(value), title);
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    await expect(drawer).toBeVisible();
    // Range and element bounds must be sampled after the pane's entrance motion.
    await expect.poll(() => drawer.evaluate(element =>
      new DOMMatrix(getComputedStyle(element).transform).m41)).toBeCloseTo(0, 1);
    const row = page.locator('[data-agent-history-row][data-state="active"]');
    const label = row.locator("[data-agent-history-row-title]");
    await expect(label).toHaveText(title);
    const geometry = await label.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      return { lines: [...range.getClientRects()].map(rect => ({ x: rect.x, right: rect.right, y: rect.y })),
        x: bounds.x, right: bounds.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    expect(new Set(geometry.lines.map(line => Math.round(line.y))).size).toBeGreaterThan(1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    for (const line of geometry.lines) {
      expect(line.x).toBeGreaterThanOrEqual(geometry.x - 1);
      expect(line.right).toBeLessThanOrEqual(geometry.right + 1);
    }
    const actions = row.getByRole("button", { name: `Open actions for ${title}` });
    const box = (await actions.boundingBox())!;
    expect(box.width + 0.0001).toBeGreaterThanOrEqual(44);
    expect(box.height + 0.0001).toBeGreaterThanOrEqual(44);
    expect(geometry.right).toBeLessThanOrEqual(box.x + 1);
    const age = (await row.locator("time").boundingBox())!;
    expect(geometry.right).toBeLessThanOrEqual(age.x + 1);
    await row.getByTitle(title, { exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { __chatHistorySelections: string[] }).__chatHistorySelections)).toEqual(["history-one"]);
  });

for (const dark of [false, true])
  test(`Reduced-transparency History keeps the theme canvas in ${dark ? "dark" : "light"}`, async ({ page }) => {
    await page.evaluate(() => (window as unknown as { __seedChatHistory: () => void }).__seedChatHistory());
    const activated = await page.evaluate(enabled => {
      document.documentElement.classList.toggle("dark", enabled);
      let matched = 0;
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-transparency")) {
            rule.media.mediaText = "all"; matched++;
          }
          if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of document.styleSheets) visit(sheet.cssRules);
      return matched;
    }, dark);
    expect(activated).toBeGreaterThan(0);
    await page.waitForFunction(() => [document.documentElement, document.body]
      .every(element => element.getAnimations().every(animation => animation.playState !== "running")));
    const before = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    await page.getByRole("button", { name: "Open drawer", exact: true }).click();
    const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });
    const reference = await profileFrame(page);
    expect(reference.material.background).toBe(reference.canvas);
    await expect(chats).toHaveCSS("background-color", reference.canvas);
    await expect(chats).toHaveCSS("backdrop-filter", "none");
    await chats.getByRole("button", { name: "Open actions for Weekly planning" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const solidCard = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--app-card-surface-default-solid)";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    await expect(menu).toHaveCSS("background-color", solidCard);
    await expect(menu).toHaveCSS("backdrop-filter", "none");
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await page.getByRole("button", { name: "Close chat history", exact: true }).click();
    await expect(chats).not.toBeVisible();
    expect(await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor])).toEqual(before);
  });

for (const width of [320, 390, 1440]) test(`Drive data packets list and page without overflow at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("http://localhost/connections-fixture?data-packets=1");
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Open drawer", exact: true }).click();
  await expect(page.getByLabel("Open Connectors", { exact: true })).toBeFocused();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await page.getByRole("button", { name: /^Google Drive\b/ }).click();
  const packets = page.getByRole("region", { name: "Data packets", exact: true });
  await expect(packets.getByRole("heading", { name: "Data packets", exact: true })).toBeVisible();
  for (const name of ["Financial Assets", "Insurance", "Non-Financial Records", "Personal Documents"]) {
    const folder = packets.getByRole("button", { name: `Open ${name}`, exact: true });
    await expect(folder).toBeVisible();
    expect((await folder.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const trust = page.getByRole("region", { name: "Trusted documents", exact: true });
  expect((await packets.boundingBox())!.y).toBeGreaterThanOrEqual((await trust.boundingBox())!.y + (await trust.boundingBox())!.height);
  await testInfo.attach(`Data packets ${width}px`, { body: await page.screenshot(), contentType: "image/png" });
  await packets.getByRole("button", { name: "Open Financial Assets", exact: true }).click();
  await expect(packets.getByText("51 indexed files", { exact: true })).toBeVisible();
  await packets.getByRole("button", { name: "Load more files", exact: true }).click();
  await expect(packets.getByText(/^Synthetic statement 51 —/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await packets.getByRole("button", { name: "Back to data packets", exact: true }).click();
  await packets.getByRole("button", { name: "Open Insurance", exact: true }).click();
  await expect(packets.getByText("No indexed files in this folder yet.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to data packets", exact: true }).first().click();
  await expect(packets.getByRole("heading", { name: "Insurance", exact: true })).toHaveCount(0);
});
