import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";
let script: string;
let css: string;
test.beforeEach(async ({ page }) => {
  await page.route("**/api/connectors", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connectors: [],
        features: { drive_document_sharing: true },
      }),
    }),
  );
});
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "document-share-review-"),
  );
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
          "@/lib/services/auth-service",
          "@/lib/cache/cache-sync-service",
          "@/lib/connections/custom-connector-configuration",
          "next/link",
        ].map((find) => ({
          find,
          replacement: path.join(
            root,
            "e2e/fixtures/document-share-boundaries.tsx",
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
        entry: path.join(root, "e2e/fixtures/document-share-review.tsx"),
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

for (const width of [320, 390, 768, 1440])
  test(`requesting files preserves chat and bounds the form at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 820 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const submissions: unknown[] = [];
    await page.route("http://localhost/document-request-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
      }),
    );
    await page.route(
      "**/api/connectors/google_drive/sharing/requests",
      async (route) => {
        submissions.push(route.request().postDataJSON());
        expect(route.request().headers().authorization).toBe(
          "Bearer synthetic-firebase-proof",
        );
        expect(route.request().headers()["x-hushh-consent"]).toBe(
          "synthetic-vault-owner",
        );
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            requestId: "11111111-1111-4111-8111-111111111111",
            status: "pending",
            revision: 0,
          }),
        });
      },
    );
    await page.goto("http://localhost/document-request-fixture");
    await page.addScriptTag({ content: script });
    expect(errors).toEqual([]);
    await awaitProductFont(page);
    const draft = page.getByRole("textbox", { name: "Chat draft" });
    await draft.fill("Keep this chat draft");
    const original = await draft.elementHandle();
    await page
      .getByRole("button", { name: "Request files", exact: true })
      .click();
    const panel = page.getByRole("dialog", {
      name: "Request files",
      exact: true,
    });
    const purpose = `${"UntrustedLongPurpose".repeat(20)} <script>text only</script>`;
    await panel.getByLabel("What do you need?").fill(purpose);
    await panel.getByLabel("Start date").fill("2026-01-01");
    await expect(
      panel.getByRole("button", { name: "Send request" }),
    ).toBeDisabled();
    await panel.getByLabel("End date").fill("2026-06-30");
    expect(submissions).toHaveLength(0);
    for (const control of [
      panel.getByLabel("What do you need?"),
      panel.getByLabel("Start date"),
      panel.getByLabel("End date"),
      panel.getByRole("button", { name: "Send request" }),
      panel.getByRole("button", { name: "Cancel" }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      const bounds = (await control.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    expect(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    const submit = panel.getByRole("button", { name: "Send request" });
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(
      panel.getByText(
        "Request sent. No files have been shared yet.",
      ),
    ).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      ownerPersonRef: "33333333-3333-4333-8333-333333333333",
      purpose: { purpose, periodStart: "2026-01-01", periodEnd: "2026-06-30" },
    });
    await expect(
      panel.getByRole("link", { name: "View request" }),
    ).toHaveAttribute("href", /requestView=sent/);
    await page.keyboard.press("Escape");
    await expect(draft).toHaveValue("Keep this chat draft");
    expect(
      await original!.evaluate(
        (node) => node === document.querySelector("textarea"),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    expect(errors).toEqual([]);
  });

for (const width of [320, 390, 768, 1440])
  test(`asking a question preserves chat and bounds the form at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 820 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const submissions: unknown[] = [];
    const questionId = "11111111-1111-4111-8111-111111111111";
    const pendingQuestion = (query: string) => ({
      requestId: questionId,
      direction: "outgoing",
      status: "pending",
      revision: 1,
      query,
      counterpartName: "A",
      createdAt: "2026-09-24T10:00:00Z",
      expiresAt: "2099-10-01T10:00:00Z",
      decidedAt: null,
      answer: null,
      canDecide: false,
      lastError: null,
    });
    let asked = "";
    await page.route("http://localhost/document-request-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
      }),
    );
    await page.route(
      "**/api/connectors/google_drive/sharing/queries",
      async (route) => {
        const body = route.request().postDataJSON();
        submissions.push(body);
        asked = body.query;
        // The asker proves only vault ownership; no Google identity is sent.
        expect(route.request().headers().authorization).toBe(
          "Bearer synthetic-vault-owner",
        );
        expect(route.request().headers()["x-hushh-consent"]).toBeUndefined();
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify(pendingQuestion(asked)),
        });
      },
    );
    await page.route(
      `**/api/connectors/google_drive/sharing/queries/${questionId}`,
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(pendingQuestion(asked)),
        }),
    );
    await page.goto("http://localhost/document-request-fixture");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const draft = page.getByRole("textbox", { name: "Chat draft" });
    await draft.fill("Keep this chat draft");
    const original = await draft.elementHandle();
    await page
      .getByRole("button", { name: "Ask about files", exact: true })
      .click();
    const panel = page.getByRole("dialog", {
      name: "Ask about their Drive",
      exact: true,
    });
    const question = `${"UntrustedLongQuestion".repeat(20)} <script>text only</script>`;
    await expect(panel.getByRole("button", { name: "Send" })).toBeDisabled();
    await panel.getByLabel("Your question").fill(question);
    expect(submissions).toHaveLength(0);
    for (const control of [
      panel.getByLabel("Your question"),
      panel.getByRole("button", { name: "Send" }),
      panel.getByRole("button", { name: "Cancel" }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      const bounds = (await control.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    expect(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    const submit = panel.getByRole("button", { name: "Send" });
    await submit.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByText("Waiting for A to allow")).toBeVisible();
    await expect(panel.getByText(`“${question}”`)).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      ownerPersonRef: "33333333-3333-4333-8333-333333333333",
      query: question,
    });
    expect(Object.keys(submissions[0] as object).sort()).toEqual([
      "clientRequestId",
      "ownerPersonRef",
      "query",
    ]);
    await expect(
      panel.getByRole("link", { name: "View question" }),
    ).toHaveAttribute("href", /requestView=sent/);
    expect(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(draft).toHaveValue("Keep this chat draft");
    expect(
      await original!.evaluate(
        (node) => node === document.querySelector("textarea"),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    expect(errors).toEqual([]);
  });

for (const width of [320, 390, 768, 1440])
  test(`exact review, explicit approval and recovery at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 820 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const id = "11111111-1111-4111-8111-111111111111";
    const documentId = "22222222-2222-4222-8222-222222222222";
    const filename = `${"LongUntrustedFileName".repeat(8)}.pdf`;
    let approvals = 0;
    let state = "review_ready";
    await page.route("http://localhost/document-review-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
      }),
    );
    await page.route(
      "**/api/connectors/google_drive/sharing/requests/**",
      async (route) => {
        const url = new URL(route.request().url());
        // A backend without the streamed route: FastAPI's own Not Found.
        if (url.pathname.endsWith("/prepare/stream"))
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Not Found" }),
          });
        let result: unknown = {
          requestId: id,
          status: state,
          direction: "incoming",
          revision: 2,
        };
        if (url.pathname.endsWith("/review"))
          result = {
            requestId: id,
            status: state,
            revision: 2,
            recipientEmail:
              "verified-recipient-with-long-email@synthetic.invalid",
            purpose: {
              purpose: "Please share six months of statements",
              periodStart: "2026-01-01",
              periodEnd: "2026-06-30",
            },
            files: [{ documentId, name: filename }],
            coverage: {
              coverage_summary: "January only",
              coverage_status: "partial",
              gaps: ["February–June missing"],
              truncated: false,
            },
            canApprove: true,
            reviewDigest: "a".repeat(64),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        if (url.pathname.endsWith("/approve")) {
          approvals++;
          expect(route.request().postDataJSON()).toEqual({
            revision: 2,
            reviewDigest: "a".repeat(64),
            documentIds: [documentId],
            confirmed: true,
          });
          state = "approved";
          result = { requestId: id, status: state, revision: 2 };
        }
        if (url.pathname.endsWith("/delivery"))
          result = {
            requestId: id,
            status: state,
            files: [{ name: filename, status: "queued", managed: false }],
          };
        await route.fulfill({
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify(result),
        });
      },
    );
    await page.goto("http://localhost/document-review-fixture");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const draft = page.getByRole("textbox", { name: "Chat draft" });
    await draft.fill("Preserve this unsent draft");
    const original = await draft.elementHandle();
    await page.getByRole("button", { name: "Review document request" }).click();
    const panel = page.getByRole("dialog", { name: "Document request" });
    await expect(panel.getByText("February–June missing")).toBeVisible();
    expect(approvals).toBe(0);
    // A ready review has one refresh action, not two.
    await expect(
      panel.getByRole("button", { name: "Refresh status" }),
    ).toHaveCount(0);
    const controls = ["Share files", "Decline", "Refresh suggestions"];
    for (const name of controls) {
      const button = panel.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const bounds = (await button.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
    expect(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await testInfo.attach("mounted exact-file review", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    // The whole row toggles its file, and the box toggles exactly once.
    const box = panel.getByRole("checkbox", { name: filename });
    await expect(box).toHaveAttribute("aria-checked", "true");
    await panel.getByText(filename, { exact: true }).click();
    await expect(box).toHaveAttribute("aria-checked", "false");
    await expect(
      panel.getByRole("button", { name: "Share 0 of 1 files" }),
    ).toBeDisabled();
    await box.click();
    await expect(box).toHaveAttribute("aria-checked", "true");
    await panel.getByRole("button", { name: "Lock test vault" }).click();
    await expect(panel.getByText("Unlock your vault to review.")).toBeVisible();
    await expect(panel.getByText(filename)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Unlock test vault" }).click();
    await page.getByRole("button", { name: "Review document request" }).click();
    const share = panel.getByRole("button", {
      name: "Share files",
      exact: true,
    });
    await share.focus();
    await page.keyboard.press("Enter");
    await expect(
      panel.getByText("Waiting to share", { exact: true }),
    ).toBeVisible();
    expect(approvals).toBe(1);
    await expect(panel.getByRole("status")).toBeFocused();
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      ),
    ).not.toMatch(/LongUntrusted|synthetic-vault-owner|verified-recipient/);
    await page.keyboard.press("Escape");
    await expect(draft).toHaveValue("Preserve this unsent draft");
    expect(await original!.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });

const fixtureHtml = () =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`;
const reviewId = "11111111-1111-4111-8111-111111111111";
const reviewDocumentId = "22222222-2222-4222-8222-222222222222";
const reviewBody = (status: string, revision: number) => ({
  requestId: reviewId,
  status,
  revision,
  recipientEmail: "verified-recipient@synthetic.invalid",
  purpose: {
    purpose: "Last three standup notes",
    periodStart: null,
    periodEnd: null,
  },
  files:
    status === "review_ready"
      ? [{ documentId: reviewDocumentId, name: "Standup notes.pdf" }]
      : [],
  coverage:
    status === "review_ready"
      ? {
          coverage_summary: "The three latest notes.",
          coverage_status: "complete",
          gaps: [],
          truncated: false,
        }
      : null,
  canApprove: status === "review_ready",
  reviewDigest: status === "review_ready" ? "a".repeat(64) : null,
  expiresAt:
    status === "review_ready"
      ? new Date(Date.now() + 60_000).toISOString()
      : null,
  preparationError: null,
});

for (const colorScheme of ["light", "dark"] as const)
  test(`progressive preparation shows the request before its files (${colorScheme}, 390px)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 820 });
    await page.emulateMedia({ colorScheme });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let state = "pending";
    let posts = 0;
    let streams = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("http://localhost/document-review-fixture", (route) =>
      route.fulfill({ contentType: "text/html", body: fixtureHtml() }),
    );
    await page.route(
      "**/api/connectors/google_drive/sharing/requests/**",
      async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/prepare/stream")) {
          streams++;
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Not Found" }),
          });
        }
        if (url.pathname.endsWith("/prepare")) {
          posts++;
          await held;
          state = "review_ready";
          return route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ status: "review_ready" }),
          });
        }
        const revision = state === "pending" ? 0 : 1;
        const result = url.pathname.endsWith("/review")
          ? reviewBody(state, revision)
          : { requestId: reviewId, status: state, direction: "incoming", revision };
        await route.fulfill({
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify(result),
        });
      },
    );
    await page.goto("http://localhost/document-review-fixture");
    if (colorScheme === "dark")
      await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    await page.getByRole("button", { name: "Review document request" }).click();
    const panel = page.getByRole("dialog", { name: "Document request" });
    // Who asked and why arrive before the search finishes.
    await expect(
      panel.getByText("verified-recipient@synthetic.invalid"),
    ).toBeVisible();
    await expect(panel.getByRole("status")).toContainText("Finding files…");
    const decline = panel.getByRole("button", { name: "Decline", exact: true });
    await expect(decline).toBeEnabled();
    const bounds = (await decline.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(
      panel.getByRole("button", { name: "Share files", exact: true }),
    ).toBeDisabled();
    expect(streams).toBe(1);
    await expect.poll(() => posts).toBe(1);
    await testInfo.attach(`finding files (${colorScheme})`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    release();
    await expect(
      panel.getByRole("checkbox", { name: "Standup notes.pdf" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Share files", exact: true }),
    ).toBeEnabled();
    expect(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    // Consent copy stays readable: at least WCAG AA against the sheet it sits on.
    const note = panel.getByText(
      "Originals stay in Drive. The recipient sees later edits.",
    );
    const ratio = await note.evaluate((node) => {
      const rgba = (value: string) =>
        (value.match(/[\d.]+/g) ?? []).map(Number) as number[];
      const luminance = ([r, g, b]: number[]) => {
        const channel = (c: number) => {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      let background = node.parentElement;
      while (
        background &&
        rgba(getComputedStyle(background).backgroundColor)[3] === 0
      )
        background = background.parentElement;
      const bg = rgba(getComputedStyle(background!).backgroundColor);
      const fg = rgba(getComputedStyle(node).color);
      const alpha = fg[3] ?? 1;
      const blended = [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha));
      const [hi, lo] = [luminance(blended), luminance(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    await testInfo.attach(`ready for review (${colorScheme})`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(posts).toBe(1);
    expect(errors).toEqual([]);
  });

test("a streamed preparation needs no fallback request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let state = "pending";
  let posts = 0;
  await page.route("http://localhost/document-review-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: fixtureHtml() }),
  );
  await page.route(
    "**/api/connectors/google_drive/sharing/requests/**",
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/prepare/stream")) {
        expect(route.request().headers().accept).toBe("text/event-stream");
        state = "review_ready";
        const frame = (event: string, payload: Record<string, unknown>) =>
          `event: ${event}\ndata: ${JSON.stringify({ event, ...payload })}\n\n`;
        return route.fulfill({
          contentType: "text/event-stream",
          body:
            frame("stage", { stage: "starting" }) +
            frame("stage", { stage: "searching" }) +
            frame("heartbeat", {}) +
            frame("stage", { stage: "choosing" }) +
            frame("stage", { stage: "checking" }) +
            frame("complete", { status: "review_ready" }),
        });
      }
      if (url.pathname.endsWith("/prepare")) posts++;
      const revision = state === "pending" ? 0 : 1;
      const result = url.pathname.endsWith("/review")
        ? reviewBody(state, revision)
        : { requestId: reviewId, status: state, direction: "incoming", revision };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    },
  );
  await page.goto("http://localhost/document-review-fixture");
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Review document request" }).click();
  const panel = page.getByRole("dialog", { name: "Document request" });
  await expect(
    panel.getByRole("checkbox", { name: "Standup notes.pdf" }),
  ).toBeVisible();
  await expect(panel.getByText("Looks complete")).toBeVisible();
  expect(posts).toBe(0);
  expect(errors).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const)
  test(`a sent request renders flat inside the chat card (${colorScheme}, 390px)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 820 });
    await page.emulateMedia({ colorScheme });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://localhost/document-review-fixture", (route) =>
      route.fulfill({ contentType: "text/html", body: fixtureHtml() }),
    );
    const sentId = "44444444-4444-4444-8444-444444444444";
    await page.route(
      "**/api/connectors/google_drive/sharing/requests/**",
      async (route) => {
        const url = new URL(route.request().url());
        const result = url.pathname.endsWith("/delivery")
          ? {
              requestId: sentId,
              status: "completed",
              files: [
                {
                  name: "Standup notes.pdf",
                  status: "succeeded",
                  managed: true,
                  grantId: "33333333-3333-4333-8333-333333333333",
                  openUrl: "https://drive.google.com/file/d/synthetic/view",
                },
              ],
            }
          : {
              requestId: sentId,
              status: "completed",
              direction: "outgoing",
              revision: 2,
            };
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(result),
        });
      },
    );
    await page.goto("http://localhost/document-review-fixture");
    if (colorScheme === "dark")
      await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    await page.getByRole("button", { name: "Show sent request" }).click();
    const card = page.getByRole("region", { name: "Sent request card" });
    const open = card.getByRole("link", { name: "Open in Google Drive" });
    await expect(open).toBeVisible();
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Flat inside the chat card: no second card surface.
    const shells = card.locator('[data-slot="settings-group-shell"]');
    await expect(shells).toHaveCount(1);
    expect(
      await shells.first().evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    expect(
      await card.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await testInfo.attach(`sent request in chat (${colorScheme})`, {
      body: await card.screenshot(),
      contentType: "image/png",
    });
    expect(errors).toEqual([]);
  });
