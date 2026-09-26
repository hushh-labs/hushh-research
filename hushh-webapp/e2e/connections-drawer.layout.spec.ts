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
          "next/navigation",
        ].map((find) => ({
          // Vite string aliases also match subpaths. Keep the Capacitor
          // boundary mock exact so imports such as /stream use the real module.
          find: find === "@/lib/capacitor" ? /^@\/lib\/capacitor$/ : find,
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
  let status = "connected";
  let documents: { documentId: string; name: string; status: string; backgroundProcessing: boolean }[] = [];
  await page.route(/\/icons\/agents\/(?:gmail|calendar)\.svg$/, (route) =>
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
  await awaitProductFont(page);
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
    const button = receipt.getByRole("button", { name: "Open Connectors" });
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
    const historySearch = page.getByRole("searchbox", { name: "Search chats" });
    await historySearch.fill("History filter");
    // Wait for React's controlled value to commit before switching the
    // still-mounted drawer view. WebKit can otherwise click the next control
    // in the same frame as the input event and expose an empty stale value on
    // the next open even though the component itself stayed mounted.
    await expect(historySearch).toHaveValue("History filter");
    await page.getByLabel("Open Connectors", { exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Connectors", exact: true });
    await expect(drawer.getByRole("heading", { name: "Connected" })).toBeVisible();
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
      ["Google Drive", "drive-owner@synthetic.invalid", ["Disconnect Drive", "Choose files", "Retry Drive"]],
    ] as const) {
      await drawer.getByRole("button", { name: connector, exact: true }).click();
      await expect(drawer.getByRole("button", { name: "Back to connectors" })).toBeFocused();
      await expect(drawer.getByText(account)).toBeVisible();
      if (connector === "Google Drive") {
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

test("dismissing Connectors returns the next hamburger open to chat history", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 820 });
  const hamburger = page.getByRole("button", { name: "Open drawer", exact: true });
  const connectors = page.getByRole("dialog", { name: "Connectors", exact: true });
  const chats = page.getByRole("dialog", { name: "Agent chat history", exact: true });

  await hamburger.click();
  await page.getByLabel("Open Connectors", { exact: true }).click();
  await expect(connectors).toBeVisible();
  await page.mouse.click(24, 400);
  await expect(connectors).not.toBeVisible();
  await hamburger.click();
  await expect(chats.getByRole("searchbox", { name: "Search chats" })).toBeVisible();

  await page.getByLabel("Open Connectors", { exact: true }).click();
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
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Selected Drive files" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Disconnect Drive" }).click();
  await expect(page.getByText(/Existing Google sharing stays active until you revoke it/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
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
  const consent = page.getByRole("checkbox", { name: /Allow Hushh to process these files on its servers/ });
  await expect(page.getByText(/Relevant excerpts may be sent to Gemini to prepare suggestions/)).toBeVisible();
  await expect(page.getByText(/encrypted file index is held by Hushh, not your vault/)).toBeVisible();
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
  await expect(page.getByText(/Turning this off stops new processing but keeps the index until you remove the file/)).toBeVisible();
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
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
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

test("real popup ignores forged settlement and reconciles server status after closing", async ({
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
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
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
  await popup.close();
  await expect.poll(() => statusReads).toBeGreaterThan(before);
  await expect(
    page.getByRole("button", { name: "Connect Drive", exact: true }),
  ).toBeEnabled();
  // Closing a window did not imply successful authorization; server still says revoked.
  await expect(
    page.getByRole("button", { name: "Disconnect Drive", exact: true }),
  ).toHaveCount(0);
});
