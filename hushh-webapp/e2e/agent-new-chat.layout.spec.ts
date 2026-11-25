import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

let script: string;
let css: string;
let directory: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-new-chat-"));
  const boundary = path.join(root, "e2e/fixtures/agent-new-chat-boundaries.tsx");
  await build({
    configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic" } },
    plugins: [{ name: "new-chat-fixture-css", transform(source, id) {
      if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
        for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
    } }],
    resolve: { alias: [
      ...["@/hooks/use-auth", "@/lib/firebase/auth-context", "@/lib/vault/vault-context", "@/lib/persona/persona-context",
        "@/lib/agent/chat-onboarding/use-chat-onboarding", "@/lib/profile/gmail-connector-store",
        "@/lib/navigation/use-root-chat-deferred-ready", "@/lib/one-voice/readiness", "@/hooks/use-effective-avatar-url",
        "@/lib/agent/use-one-display-name", "@/lib/agent/use-entry-welcome", "@/lib/services/model-preference-service", "@/lib/agent/use-one-model-preference",
        "@/lib/services/auth-service", "./auth-service", "@/lib/firebase/config", "@/lib/firebase", "@/components/vault/vault-unlock-dialog", "next/navigation",
      ].map(find => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement: boundary })),
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: { outDir: directory, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/agent-new-chat.tsx"), name: "NewChatFixture", formats: ["iife"], fileName: () => "fixture.js" } },
  });
  script = fs.readFileSync(path.join(directory, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"), loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle()
    + fs.readdirSync(directory).filter(file => file.endsWith(".css")).map(file => fs.readFileSync(path.join(directory, file), "utf8")).join("\n");
}, 120_000);
test.afterAll(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

test("owner AI identifies its provider in the header and a sheet-sized frame", async ({ page }) => {
  await page.route("http://localhost/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/new-chat-fixture") return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script>`,
    });
    if (url.pathname.startsWith("/one-presence/")) {
      const file = path.resolve(process.cwd(), "public", `.${url.pathname}`);
      if (file.startsWith(path.join(process.cwd(), "public/one-presence/")) && fs.existsSync(file))
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".riv") ? "application/octet-stream" : "image/webp" });
    }
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
  const label = "One's AI: Azure AI · a-long-private-deployment-name";
  await page.setViewportSize({ width: 768, height: 844 });
  await page.goto("http://localhost/new-chat-fixture?model=1");
  const headerModel = page.getByRole("group", { name: label });
  await expect(headerModel).toBeVisible();
  const headerBox = (await headerModel.boundingBox())!;
  expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(768);
  await page.setViewportSize({ width: 393, height: 844 });
  await page.goto("http://localhost/new-chat-fixture?model_frame=1");
  const sheetModel = page.getByRole("group", { name: label });
  await expect(sheetModel).toBeVisible();
  const modelText = sheetModel.getByText("Azure AI · a-long-private-deployment-name");
  expect(await modelText.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

for (const [width, anonymous, entry] of [[393, false, "Create new chat"], [768, true, "Start new chat"], [1440, false, "Start new chat"]] as const) {
  test(`new chat resets and recovers after a failed turn at ${width}px (anonymous=${anonymous})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let turns = 0;
    let finishFirst: (() => void) | undefined;
    const history: string[] = [];
    await page.route("http://localhost/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/new-chat-fixture") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script>` });
      if (url.pathname === "/api/one/personal-agent/status" && route.request().method() === "GET")
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ hostingMode: "shared" }) });
      if (url.pathname === "/api/one/agent-chat" && route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        const turn = ++turns;
        if (turn === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
        const events = [
          { type: "RUN_STARTED", threadId: body.threadId, runId: `run-${turn}` },
          ...(turn === 1 ? [{ type: "RUN_ERROR", code: "TEMPORARILY_UNAVAILABLE", message: "Please try again." }]
            : [{ type: "TEXT_MESSAGE_START", messageId: `answer-${turn}`, role: "assistant" },
              { type: "TEXT_MESSAGE_CONTENT", messageId: `answer-${turn}`, delta: "Ready for your new question." },
              { type: "TEXT_MESSAGE_END", messageId: `answer-${turn}` },
              { type: "RUN_FINISHED", threadId: body.threadId, runId: `run-${turn}` }]),
        ];
        return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
      }
      if (/agent-chat\/conversations|agent-chat\/history/.test(url.pathname)) history.push(url.pathname);
      const asset = url.pathname === "/_next/image" ? url.searchParams.get("url") : url.pathname;
      if (asset?.startsWith("/one-presence/")) {
        const file = path.resolve(process.cwd(), "public", `.${asset}`);
        if (file.startsWith(path.join(process.cwd(), "public/one-presence/")) && fs.existsSync(file))
          return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".riv") ? "application/octet-stream" : "image/webp" });
      }
      return route.fulfill({ contentType: "application/json", body: "{}" });
    });
    await page.goto(`http://localhost/new-chat-fixture?anonymous=${anonymous ? 1 : 0}&long=${width === 393 ? 1 : 0}`);
    if (!anonymous) {
      const greeting = page.getByRole("heading", { name: width === 393 ? /^Hi Alexandria/ : "Hi Test" });
      await expect(greeting).toBeVisible();
      const greetingStyle = await greeting.evaluate((node) => {
        const style = getComputedStyle(node);
        return { size: style.fontSize, weight: style.fontWeight, line: style.lineHeight };
      });
      expect(greetingStyle).toEqual({
        size: width < 475 ? "19px" : "24px",
        weight: "600",
        line: width < 475 ? "20.9px" : "26.4px",
      });
      await expect(page.locator('[data-agent-chat-header-region="identity"] [data-profile-role="label"]')).toHaveText("One");
      await page.screenshot({ path: testInfo.outputPath("chat-welcome.png"), animations: "disabled" });
      if (width === 393) {
        // Browser zoom halves the effective CSS layout width. Keep height
        // stable here so this tests wrapping and horizontal clearance.
        await page.setViewportSize({ width: 196, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await expect(page.getByRole("textbox", { name: "Message One" })).toBeVisible();
        await page.getByRole("region", { name: "Agent conversation history" }).evaluate((node) => { node.scrollTop = node.scrollHeight; });
        const lastSuggestion = (await page.getByTestId("agent-chat-suggestions").getByRole("button").last().boundingBox())!;
        const composerTop = (await page.getByRole("textbox", { name: "Message One" }).boundingBox())!.y;
        expect(lastSuggestion.y + lastSuggestion.height).toBeLessThanOrEqual(composerTop + 1);
        await page.screenshot({ path: testInfo.outputPath("chat-welcome-200-percent.png"), animations: "disabled" });
        await page.setViewportSize({ width: 393, height: 844 });
      }
    }
    const composer = page.getByRole("textbox", { name: "Message One" });
    await composer.fill("First question 👋");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => typeof finishFirst).toBe("function");
    await page.getByRole("button", { name: "Open chat history", exact: true }).click();
    await expect(page.getByRole("button", { name: entry, exact: true })).toBeDisabled();
    finishFirst!();
    await page.getByLabel("Agent chat history", { exact: true }).getByRole("button", { name: "Close chat history", exact: true }).click();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await composer.fill("Unsaved draft مرحبا");
    await page.getByRole("button", { name: "Open chat history", exact: true }).click();
    const create = page.getByRole("button", { name: entry, exact: true });
    await expect(create).toBeEnabled();
    await create.focus();
    await expect(create).toBeFocused();
    const box = await create.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.context().setOffline(true);
    await create.press("Enter");
    await expect(page.getByRole("button", { name: "Close chat history", exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue("");
    await expect(page.getByText("First question 👋", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open chat history", exact: true })).toBeFocused();
    await page.context().setOffline(false);
    await composer.fill("A new question");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("Ready for your new question.", { exact: true })).toBeVisible();
    expect(turns).toBe(2);
    expect(history).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("new-chat-recovered.png") });
  });
}

test("market gainers open Market stock details without leaving One chat", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  const quoteTime = "2026-11-19T20:00:00Z";
  const selectedReads: string[] = [];
  let marketReads = 0;
  let chatTurns = 0;
  const gainer = {
    symbol: "DEMO",
    company_name: "Sample Company",
    price: 18.25,
    change_pct: 9.5,
    as_of: quoteTime,
  };
  const json = (payload: unknown) => ({
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
  await page.route("http://localhost/**", async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname === "/new-chat-fixture") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script>` });
    }
    if (pathname === "/api/one/personal-agent/status") return route.fulfill(json({ hostingMode: "shared" }));
    if (pathname.startsWith("/api/kai/market/insights/baseline/")) {
      marketReads += 1;
      if (marketReads === 1) return route.fulfill({ status: 503, ...json({}) });
      return route.fulfill(json({ movers: { gainers: [gainer], losers: [], active: [], stale: true } }));
    }
    if (pathname === "/api/market/quotes") {
      return route.fulfill(json({ quotes: [{ ...gainer, quoted_at: quoteTime }] }));
    }
    if (pathname.startsWith("/api/kai/market/history/")) {
      selectedReads.push("history:" + searchParams.get("symbol"));
      const date = Date.parse(quoteTime) / 1000;
      return route.fulfill(json({ points: [14, 3, 0].map((days, i) => ({ t: date - days * 86400, p: 16 + i })) }));
    }
    if (pathname.startsWith("/api/kai/market/news/")) {
      selectedReads.push("news:" + searchParams.get("symbols"));
      return route.fulfill(json({ items: [{
        symbol: "DEMO", title: "Sample Company reports quarterly results", url: "https://example.test/sample",
        source_name: "Sample News", published_at: quoteTime,
      }] }));
    }
    if (pathname === "/api/one/agent-chat" && route.request().method() === "POST") {
      chatTurns += 1;
      const { threadId } = route.request().postDataJSON();
      const runId = "gainers-run";
      const toolCallId = "gainers-call";
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "TOOL_CALL_START", toolCallId, toolCallName: "show_market_gainers" },
        { type: "TOOL_CALL_ARGS", toolCallId, delta: "{}" },
        { type: "TOOL_CALL_END", toolCallId },
        { type: "TOOL_CALL_RESULT", toolCallId, messageId: "gainers-result", role: "tool",
          content: JSON.stringify({ status: "card_offered", structured: { type: "one.finance_top_gainers.v1" } }) },
        { type: "TEXT_MESSAGE_START", messageId: "gainers-answer", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "gainers-answer", delta: "I opened the Top Gainers card in Chat." },
        { type: "TEXT_MESSAGE_END", messageId: "gainers-answer" },
        { type: "RUN_FINISHED", threadId, runId },
      ];
      return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
    }
    return route.fulfill(json({}));
  });

  await page.goto("http://localhost/new-chat-fixture?vault=1");
  const chatUrl = page.url();
  const composer = page.getByRole("textbox", { name: "Message One" });
  await composer.fill("Show me today's top gainers");
  await page.getByRole("button", { name: "Send message", exact: true }).click();

  const transcript = page.getByRole("region", { name: "Agent conversation history" });
  await expect(transcript.getByRole("heading", { name: "Top Gainers" })).toBeVisible();
  await expect(transcript.getByText("Market gainers are unavailable right now.", { exact: true })).toBeVisible();
  await transcript.getByRole("button", { name: "Retry market gainers", exact: true }).click();
  await expect(transcript.getByText(/Saved prices/)).toBeVisible();
  expect(marketReads).toBe(2);
  expect(chatTurns).toBe(1);
  const row = transcript.getByRole("button", { name: /DEMO/ });
  await expect(row).toContainText("+9.50%");
  expect(selectedReads).toEqual([]);
  await row.click();
  const detail = page.getByRole("dialog", { name: "Sample Company", exact: true });
  await expect(detail.getByRole("region", { name: "Stock quote" })).toContainText("$18.25");
  await expect(detail.getByRole("region", { name: "Price history" })).toBeVisible();
  await detail.getByRole("button", { name: "1W", exact: true }).click();
  await expect(detail.getByRole("button", { name: "1W", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(detail.getByRole("heading", { name: "Company facts" })).toBeVisible();
  await expect(detail.getByRole("region", { name: "Company news" })).toContainText("Sample Company reports quarterly results");
  expect(selectedReads.sort()).toEqual(["history:DEMO", "news:DEMO"]);
  await expect(page).toHaveURL(chatUrl);

  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(transcript.getByRole("heading", { name: "Top Gainers" })).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(page).toHaveURL(chatUrl);
});
