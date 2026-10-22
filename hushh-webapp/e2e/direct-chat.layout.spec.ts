import { expect, test, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Production components/styles with synthetic auth/navigation/service ports.
// Device keyboards, signed-in routes and push delivery have separate proofs.
let script: string;
let css: string;
async function touchMessageActions(page: Page) {
  return page.evaluate(() => matchMedia("(max-width: 767px), (hover: none)").matches);
}
async function holdMessage(page: Page, row: Locator) {
  const bubble = row.locator("[data-chat-bubble]");
  // A real hold starts on a stable, uncovered bubble after dialog exit/scroll.
  await bubble.click({ trial: true });
  const box = (await bubble.boundingBox())!;
  await bubble.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, pointerId: 1, button: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu")).toHaveAttribute("data-state", "open");
  await bubble.dispatchEvent("pointerup", { pointerType: "touch", button: 0 });
}
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-chat-layout-"));
  let moduleCss = "";
  try {
    await build({ configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic", development: false } },
      plugins: [{ name: "fixture-css", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      } }], resolve: { alias: [
        { find: "@/hooks/use-auth", replacement: path.join(root, "e2e/fixtures/direct-chat-auth.ts") },
        { find: "@/lib/services/direct-messages-service", replacement: path.join(root, "e2e/fixtures/direct-chat-boundary.ts") },
        { find: "@/lib/services/person-profile-service", replacement: path.join(root, "e2e/fixtures/direct-chat-connections.ts") },
        { find: "@/lib/services/connections-service", replacement: path.join(root, "e2e/fixtures/direct-chat-connections.ts") },
        { find: "@/components/vault/vault-unlock-dialog", replacement: path.join(root, "e2e/fixtures/wallet-workspace-boundaries.tsx") },
        ...["@/lib/one-location/service", "@/lib/vault/vault-context"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/direct-chat-circles.ts") })),
        { find: "@/lib/services/circle-chat-service", replacement: path.join(root, "e2e/fixtures/circle-chat-boundary.ts") },
        { find: "@/lib/services/api-service", replacement: path.join(root, "e2e/fixtures/circle-chat-http-boundary.ts") },
        { find: "@/lib/cache/cache-sync-service", replacement: path.join(root, "e2e/fixtures/circle-chat-cache-boundary.ts") },
        { find: "@/components/consent/notification-provider", replacement: path.join(root, "e2e/fixtures/circle-chat-notification-boundary.ts") },
        { find: "@/lib/firebase/config", replacement: path.join(root, "e2e/fixtures/direct-chat-auth.ts") },
        { find: "@/lib/services/auth-service", replacement: path.join(root, "e2e/fixtures/direct-chat-auth.ts") },
        { find: "next/navigation", replacement: path.join(root, "e2e/fixtures/direct-chat-navigation.tsx") },
        { find: "next/link", replacement: path.join(root, "e2e/fixtures/direct-chat-navigation.tsx") },
        ...["@/lib/consent/use-consent-pending-summary-count", "@/lib/feed/use-feed-unread-count", "@/lib/one-voice/readiness", "@/components/one-voice/voice-session-provider", "@/components/one-voice/tool-result-card", "@/components/one-location/onboarding/location-onboarding-interaction-surface"].map((find) => ({ find, replacement: path.join(root, "e2e/fixtures/bottom-shell-boundaries.tsx") })),
        { find: /^(\.\/|@\/components\/agent\/)location-command-provider$/, replacement: path.join(root, "e2e/fixtures/bottom-shell-boundaries.tsx") },
        { find: /^(\.\/|@\/components\/one-voice\/)tool-result-card$/, replacement: path.join(root, "e2e/fixtures/bottom-shell-boundaries.tsx") },
        { find: "@", replacement: root },
      ] }, define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}",
        __CIRCLE_CHAT_FIXTURE_MEDIA__: JSON.stringify(fs.readFileSync(path.join(root, "public/one-location/onboarding/orbit-office.webp")).toString("base64")) },
      build: { outDir, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/direct-chat.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" } },
    });
    script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    for (const file of fs.readdirSync(outDir).filter((file) => file.endsWith(".css"))) moduleCss += fs.readFileSync(path.join(outDir, file), "utf8");
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"), loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css") : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build([...candidates])) + moduleCss + productFontStyle();
});
async function mount(page: Page, dark = false, delayInbox = false, inbox = false, command = "idle", options: { modal?: boolean; preview?: boolean; overflowInbox?: boolean } = {}) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://localhost/fixture-person-*.webp", (route) => route.fulfill({ contentType: "image/webp", body: fs.readFileSync(path.join(process.cwd(), `public/one-location/onboarding/orbit-person-${Number(route.request().url().match(/person-(\d+)/)![1]) + 1}.webp`)) }));
  await page.route("http://localhost/one/messages*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-command="${command}" data-path="/one/messages" data-modal-fixture="${options.modal === true}" class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
  await page.goto(`http://localhost/one/messages${inbox ? "" : `?conversation=maya${delayInbox ? "&delayInbox=1" : ""}${options.preview ? "&preview=1" : ""}${options.overflowInbox ? "&overflowInbox=1" : ""}`}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  const input = page.getByRole(inbox ? "searchbox" : "textbox", { name: inbox ? "Search conversations" : "Message Maya Rao" });
  await expect(input).toBeVisible();
  await page.bringToFront();
  await input.focus();
  return errors;
}
const fixture = (page: Page, code: string) => page.evaluate((value) => { Function("fixture", value)((window as any).directChatFixture); }, code);
const transcript = (page: Page) => page.getByTestId("direct-message-list");

async function expectSharedDockFrame(page: Page) {
  const shared = await page.evaluate(() => {
    const root = document.documentElement;
    const shell = document.querySelector("[data-app-bottom-shell]")!;
    const style = getComputedStyle(shell);
    return {
      viewport: root.clientWidth,
      maxWidth: parseFloat(getComputedStyle(root).getPropertyValue("--app-bottom-shell-max-width")),
      inset: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
    };
  });
  const dock = (await page.locator("[data-bottom-shell-motion-stack]").boundingBox())!;
  expect(Math.abs(dock.x + dock.width / 2 - shared.viewport / 2), "Messages uses the page-centered footer frame").toBeLessThanOrEqual(1);
  expect(Math.abs(dock.width - Math.min(shared.maxWidth, shared.viewport - shared.inset)), "Messages uses the shared footer width cap").toBeLessThanOrEqual(1);
  for (const selector of ["[data-bottom-shell-navigation-slot]", "[data-agent-bar-shell]"]) {
    const bar = (await page.locator(selector).boundingBox())!;
    expect(Math.abs(bar.x - dock.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bar.width - dock.width)).toBeLessThanOrEqual(1);
  }
}

for (const [width, height] of [[393, 844], [768, 1024], [1024, 768], [1440, 1000], [1920, 1080]]) {
  test(`responsive Messages approval preview at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const errors = await mount(page, false, false, false, "idle", { preview: true });
    await expect(transcript(page).getByText("See you tomorrow 😊", { exact: true })).toBeVisible();
    await page.locator('[data-direct-message-composer-input]').blur();
    await page.mouse.move(0, height!);
    await expectSharedDockFrame(page);
    const navigation = page.locator("[data-bottom-shell-navigation-slot]");
    await expect(navigation.getByRole("radio", { name: "One", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(navigation.getByRole("radio", { name: "Chat", exact: true })).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width!);
    await page.screenshot({ path: test.info().outputPath(`messages-preview-${width}.png`), animations: "disabled" });
    expect(errors).toEqual([]);
  });
}

for (const width of [393, 768, 960, 1920]) {
  test(`Circles shares the complete Messages workspace geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = await mount(page, false, false, true);
    await page.getByRole("tab", { name: "Circles 3" }).click();
    await page.getByRole("button", { name: /Weekend friends/ }).click();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeVisible();
    const navigation = page.locator("[data-bottom-shell-navigation-slot]");
    await expect(navigation.getByRole("radio", { name: "One", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(navigation.getByRole("radio", { name: "Chat", exact: true })).toHaveAttribute("aria-checked", "false");
    const pane = page.locator('[data-circle-messages-pane][data-active="true"]');
    const thread = pane.getByRole("region", { name: "Weekend friends messages" });
    const dock = page.locator('[data-bottom-shell-motion-stack]');
    await expectSharedDockFrame(page);
    if (width >= 768) {
      const listBox = (await pane.getByRole("complementary", { name: "Circles" }).boundingBox())!;
      const threadBox = (await thread.boundingBox())!;
      const dockBox = (await dock.boundingBox())!;
      expect(Math.abs(listBox.width - width * 0.3)).toBeLessThanOrEqual(1);
      const header = pane.getByRole("complementary", { name: "Circles" }).locator("header");
      const heading = (await header.getByRole("heading", { name: "Messages" }).boundingBox())!;
      const actions = (await header.locator('[class*="inboxHeaderActions"]').boundingBox())!;
      if (width < 1100) expect(heading.y + heading.height + 4).toBeLessThanOrEqual(actions.y);
      else expect(heading.x + heading.width + 4).toBeLessThanOrEqual(actions.x);
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(dockBox.y + 1);
      expect(Math.abs(threadBox.x - listBox.x - listBox.width)).toBeLessThanOrEqual(1);
      expect(await page.locator('[data-app-scroll-root]').evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
    }
    await input.fill("A Circle draft above the keyboard");
    await page.evaluate(() => {
      document.documentElement.classList.add("kb-open", "native-keyboard-inset");
      document.documentElement.style.setProperty("--kb-height", "300px");
    });
    await expect.poll(async () => {
      const field = (await input.boundingBox())!;
      return field.y + field.height;
    }).toBeLessThanOrEqual(700);
    await expect.poll(async () => {
      const conversation = (await thread.boundingBox())!;
      return conversation.y + conversation.height - (await page.locator('[data-agent-bar-shell]').boundingBox())!.y;
    }).toBeLessThanOrEqual(1);
    await expectSharedDockFrame(page);
    expect(errors).toEqual([]);
  });
}

for (const lane of ["People", "Circles"] as const) {
  test(`the last ${lane} row stays above the centered dock and keyboard in tablet split mode`, async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1000 });
    const errors = await mount(page, false, false, false, "idle", { overflowInbox: true });
    if (lane === "Circles") {
      await page.getByRole("tab", { name: "Circles 33" }).click();
      await page.getByRole("button", { name: /Weekend friends/ }).click();
    }
    const list = page.getByRole("complementary", { name: lane === "People" ? "Conversations" : "Circles" });
    const lastRow = list.getByRole("button", { name: lane === "People" ? /Connection 30/ : /Circle 30/ });
    await expect(lastRow).toBeAttached();
    for (const inset of [0, 300]) {
      if (inset) await page.evaluate((height) => {
        document.documentElement.classList.add("kb-open", "native-keyboard-inset");
        document.documentElement.style.setProperty("--kb-height", `${height}px`);
      }, inset);
      await list.locator(lane === "People" ? "nav" : '[class*="rows"]').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const row = (await lastRow.boundingBox())!;
      const dock = (await page.locator('[data-agent-bar-shell]').boundingBox())!;
      expect(row.y).toBeGreaterThanOrEqual((await list.boundingBox())!.y);
      expect(row.y + row.height).toBeLessThanOrEqual(Math.min(1000 - inset, dock.y) + 1);
    }
    expect(errors).toEqual([]);
  });
}

for (const width of [768, 820, 1024]) {
  test(`message search controls fit the split conversation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1024 });
    const errors = await mount(page);
    await expect(page.getByRole("button", { name: "Conversation options", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Search messages", exact: true }).click();
    const input = page.getByRole("searchbox", { name: "Search messages" });
    await expect(input).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(input).toBeFocused();
    await page.keyboard.type("friendly");
    await expect(input).toHaveValue("friendly");
    const thread = (await page.locator('[data-direct-message-page] > main').boundingBox())!;
    for (const control of [input, page.getByRole("button", { name: "Close message search" })]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(thread.x);
      expect(box.x + box.width).toBeLessThanOrEqual(thread.x + thread.width);
    }
    await page.getByRole("button", { name: "Close message search" }).click();
    await expect(input).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Maya Rao", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("native session opens a conversation without a browser Firebase user", async ({ page }) => {
  await mount(page, false, false, true);
  await page.evaluate(() => (window as any).directChatAuthFixture.useNativeSession());
  await page.getByRole("button", { name: /Arjun Mehta/ }).click();
  await expect(page.getByRole("textbox", { name: "Message Arjun Mehta with a very long display name" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).directChatAuthFixture.tokenRequests)).toEqual(["fixture-owner"]);
  await expect(page.getByText("This conversation could not be opened. Try again.")).toHaveCount(0);
});

for (const failure of ["token unavailable", "route mint failed"] as const) {
  test(`native session can retry after ${failure}`, async ({ page }) => {
    await mount(page, false, false, true);
    await page.evaluate(() => (window as any).directChatAuthFixture.useNativeSession());
    if (failure === "token unavailable") {
      await page.evaluate(() => (window as any).directChatAuthFixture.setTokenAvailable(false));
    } else {
      await fixture(page, "fixture.failNextRouteMint()");
    }
    const row = page.getByRole("button", { name: /Arjun Mehta/ });
    await row.click();
    await expect(page.getByText("This conversation could not be opened. Try again.")).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).directChatFixture.routeRequests.length)).toBe(failure === "token unavailable" ? 0 : 1);
    await page.evaluate(() => (window as any).directChatAuthFixture.setTokenAvailable(true));
    await row.click();
    await expect(page.getByRole("textbox", { name: "Message Arjun Mehta with a very long display name" })).toBeVisible();
  });
}

test("chat theme follows the device, persists a choice, and keeps the shared navbar centered", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => { document.documentElement.dataset.accent = "gold"; });
  await mount(page, false, false, true);
  const chat = page.locator("[data-direct-message-page]");
  const navigation = page.locator("[data-bottom-shell-navigation-slot]");
  await expect(chat).toHaveAttribute("data-theme", "dark");
  await expect(chat).toHaveAttribute("data-chat-open", "false");
  await expect(page.locator("[data-direct-message-composer-input]")).toBeHidden();
  await expect(navigation).toBeVisible();
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  const lanes = page.getByRole("tablist", { name: "Message lanes" });
  await expect(lanes.getByRole("tab", { name: "People 2" })).toHaveAttribute("aria-selected", "true");
  await expect(lanes.getByRole("tab", { name: "Circles 3" })).toHaveAttribute("aria-selected", "false");
  const activeNav = navigation.getByRole("radio", { name: "One", exact: true });
  await expect(activeNav).toHaveAttribute("aria-checked", "true");
  await expect(navigation.getByRole("radio", { name: "Chat", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(activeNav).toHaveCSS("color", "rgb(10, 132, 255)");
  const navLabels = await navigation.innerText();
  expect(navLabels).toContain("Chat");
  expect(navLabels).toContain("One");
  expect(navLabels).toContain("Connect");
  expect(navLabels).toContain("Feed");
  expect(navLabels).not.toContain("Search");
  await expect(navigation.getByRole("radio")).toHaveCount(4);

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(chat).toHaveAttribute("data-theme", "light");
  await expect(activeNav).toHaveCSS("color", "rgb(0, 113, 227)");
  await expect(lanes.getByRole("tab", { name: "People 2" })).toBeVisible();
  await expect(lanes.getByRole("tab", { name: "Circles 3" })).toBeVisible();
  await page.reload();
  await page.addScriptTag({ content: script });
  await expect(chat).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();

  await page.getByRole("button", { name: /Arjun Mehta/ }).click();
  await expect(chat).toHaveAttribute("data-chat-open", "true");
  await expect(page.locator("[data-direct-message-composer-input]")).toBeVisible();
  expect(await navigation.innerText()).toBe(navLabels);
  const bounds = (await navigation.boundingBox())!;
  expect(Math.abs(bounds.x + bounds.width / 2 - 393 / 2)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectSharedDockFrame(page);
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expectSharedDockFrame(page);
});
for (const [inset, width, height] of [[0, 393, 844], [59, 393, 844], [72, 393, 844], [0, 844, 390]] as const) {
  test(`iOS Messages clears the status bar at ${inset}px in ${width}x${height} without covering the dock`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await mount(page, false, false, true);
    await page.evaluate((value) => {
      document.documentElement.classList.add("native-ios");
      document.documentElement.style.setProperty("--app-native-safe-area-top", `${value}px`);
    }, inset);
    const minimumTop = (height > width ? Math.max(59, inset) : inset) + 8;
    const canvas = page.locator("[data-direct-message-page]");
    await expect.poll(async () => (await page.getByRole("heading", { name: "Messages" }).boundingBox())!.y).toBeGreaterThanOrEqual(minimumTop);
    expect((await canvas.boundingBox())!.y).toBe(minimumTop);
    await page.getByRole("button", { name: /Arjun Mehta/ }).click();
    const title = page.getByRole("heading", { name: "Arjun Mehta with a very long display name", exact: true });
    await expect(title).toBeVisible();
    expect((await title.boundingBox())!.y).toBeGreaterThanOrEqual(minimumTop);
    const dock = page.locator("[data-bottom-shell-agent-slot] > [data-agent-bar-shell]");
    await expect(dock).toHaveCount(1);
    const assertTranscriptClear = async () => {
      const bounds = (await canvas.boundingBox())!;
      expect(bounds.y).toBe(minimumTop);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual((await dock.boundingBox())!.y + 1);
    };
    await assertTranscriptClear();
    await page.screenshot({ path: test.info().outputPath(`messages-ios-${width}-inset-${inset}.png`), animations: "disabled" });
    await page.locator("[data-direct-message-composer-input]").fill("A draft above the keyboard");
    const keyboardHeight = height < 500 ? 140 : 300;
    await page.evaluate((value) => {
      document.documentElement.classList.add("kb-open", "native-keyboard-inset");
      document.documentElement.style.setProperty("--kb-height", `${value}px`);
      window.dispatchEvent(new Event("resize"));
    }, keyboardHeight);
    await expect.poll(async () => {
      const bounds = (await page.getByRole("button", { name: "Send message" }).boundingBox())!;
      return bounds.y + bounds.height;
    }).toBeLessThanOrEqual(height - keyboardHeight + 1);
    await assertTranscriptClear();
  });
}

test("system Back closes message search before returning from a People thread", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  await mount(page);
  const chat = page.locator("[data-direct-message-page]");
  await page.getByRole("button", { name: "Search messages", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search messages" })).toBeVisible();
  const systemBack = () => page.evaluate(() => (window as any).directChatUnwindBack());

  expect(await systemBack()).toBe(true);
  await expect(page.getByRole("searchbox", { name: "Search messages" })).toHaveCount(0);
  await expect(chat).toHaveAttribute("data-chat-open", "true");
  expect(await systemBack()).toBe(true);
  await expect(chat).toHaveAttribute("data-chat-open", "false");
  expect(await systemBack()).toBe(false);
});

test.describe("touch emoji sending", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("New chat sends the first recent and grid emojis as separate messages", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("hushh.direct-messages.recent-emojis", JSON.stringify(["😊", "👋", "😀"])));
    await page.setViewportSize({ width: 393, height: 844 });
    await mount(page, false, false, true);
    await page.evaluate(() => (window as any).directChatAuthFixture.useNativeSession());
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const picker = page.getByRole("dialog", { name: "New chat" });
    await expect(picker).toHaveAttribute("aria-modal", "true");
    await picker.getByRole("searchbox", { name: "Search connections" }).fill("Leah");
    await picker.getByRole("button", { name: "Message Leah Roy" }).click();
    await expect(picker).toHaveCount(0);
    const composer = page.getByRole("textbox", { name: "Message Leah Roy" });
    await expect(composer).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Leah Roy", exact: true })).toBeVisible();
    await expect(page.getByText("Start the conversation with Leah Roy.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Choose emoji", exact: true }).locator("svg")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("connected-person-new-chat.png"), animations: "disabled" });
    const selections = [
      { emoji: "😊", source: "recent" }, { emoji: "😊", source: "recent" },
      { emoji: "😀", source: "grid" }, { emoji: "🐱", source: "search" },
    ];
    for (const [index, { emoji, source }] of selections.entries()) {
      await page.getByRole("button", { name: "Choose emoji", exact: true }).tap();
      if (source === "search") await page.getByPlaceholder("Search emoji").fill("cat");
      const choices = page.getByRole("button", { name: `Use ${emoji}`, exact: true });
      if (source === "recent") {
        const firstRecent = page.getByRole("region", { name: "Recently used emoji" }).getByRole("button").first();
        await expect(firstRecent).toHaveAccessibleName(`Use ${emoji}`);
        await firstRecent.tap();
      } else await choices.last().tap();
      await expect(composer).toHaveValue(emoji);
      await expect(page.getByLabel("Emoji picker", { exact: true })).toHaveCount(0);
      await expect(composer).toBeFocused();
      await page.getByRole("button", { name: "Send message", exact: true }).tap();
      await expect(transcript(page).getByText(emoji, { exact: true }).last()).toBeVisible();
      await expect(composer).toBeEmpty();
      const sends = await page.evaluate(() => (window as any).directChatFixture.sends);
      expect(sends).toHaveLength(index + 1);
      expect(sends[index].content).toBe(emoji);
    }
    const trigger = page.getByRole("button", { name: "Choose emoji", exact: true });
    await trigger.tap();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Emoji picker", { exact: true })).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(composer).toBeEmpty();
  });
});

test("a selected connected person opens their existing thread instead of an empty draft", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  const errors = await mount(page, false, false, true);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  const picker = page.getByRole("dialog", { name: "New chat" });
  await picker.getByRole("searchbox", { name: "Search connections" }).fill("Maya");
  await picker.getByRole("button", { name: "Message Maya Rao", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Maya Rao", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Maya Rao", exact: true })).toBeEnabled();
  await expect(page.locator('[data-chat-message="maya-79"]')).toBeVisible();
  await expect(transcript(page).getByText("Let’s meet tomorrow. I’ll share the details here 😊", { exact: true })).toBeVisible();
  await expect(page.getByText(/Start the conversation with/)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).directChatFixture.routeRequests.at(-1))).toEqual({ personRef: "person-maya" });
  expect(await page.evaluate(() => (window as any).directChatFixture.sends)).toHaveLength(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("connected-person-existing-chat.png"), animations: "disabled" });
});

test("system Back closes the New chat picker before leaving the inbox", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  await mount(page, false, false, true);
  for (const action of ["New chat", "Compose message"]) {
    await page.getByRole("button", { name: action, exact: true }).first().click();
    await expect(page.getByRole("dialog", { name: "New chat" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).directChatUnwindBack())).toBe(true);
    await expect(page.getByRole("dialog", { name: "New chat" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).directChatUnwindBack())).toBe(false);
  }
});

test("inbox search keyboard keeps a completed command visible and dismissible", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  const errors = await mount(page, false, false, true, "result");
  await page.evaluate(() => {
    document.documentElement.classList.add("kb-open", "native-keyboard-inset");
    document.documentElement.style.setProperty("--kb-height", "300px");
  });
  const result = page.getByRole("region", { name: "Location command" });
  await expect(page.locator('[role="region"][aria-label="Location command"]')).toHaveCount(1);
  await expect(result).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeHidden();
  const dismiss = page.getByRole("button", { name: "Dismiss result" });
  await expect.poll(async () => (await dismiss.boundingBox())!.y + (await dismiss.boundingBox())!.height).toBeLessThanOrEqual(544);
  await dismiss.click();
  await expect(result).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.classList.remove("kb-open", "native-keyboard-inset");
    document.documentElement.style.removeProperty("--kb-height");
  });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeHidden();
  await expect(page.locator("[data-bottom-shell-navigation-slot]")).toBeVisible();
  expect(errors).toEqual([]);
});
for (const [width, height] of [[320, 568], [393, 844], [430, 932], [767, 852], [768, 500], [768, 852], [959, 852], [960, 852], [1024, 499], [1024, 500], [1024, 768], [1100, 500], [1440, 1000], [1920, 1080], [2560, 1440], [844, 390]]) {
  test(`keeps chat navigation and keyboard controls reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const errors = await mount(page, width === 430);
    const mine = page.locator('article[data-message-role="user"] [class*="messageBubble_"]').first();
    await expect(mine).toHaveCSS("font-size", "16px");
    await expect(mine).toHaveCSS("line-height", "22px");
    await expect(mine).toHaveCSS("font-weight", "400");
    await expect(mine).toHaveCSS("border-top-left-radius", "18px");
    const scrollStyle = await transcript(page).evaluate(node => ({ left: getComputedStyle(node).paddingLeft, right: getComputedStyle(node).paddingRight }));
    expect(scrollStyle).toEqual({ left: "16px", right: "16px" });
    // Date tint belongs to the compact label, never the full conversation row.
    const date = page.locator('[class*="messageDateMarker"]').first();
    await expect(date).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const dateRow = (await date.boundingBox())!;
    const datePill = (await date.locator("time").boundingBox())!;
    expect(datePill.width).toBeLessThan(dateRow.width);
    expect(Math.abs(datePill.x + datePill.width / 2 - dateRow.x - dateRow.width / 2)).toBeLessThanOrEqual(1);
    // A reading-position control stays centered within the active conversation.
    await transcript(page).evaluate(node => { node.scrollTop = Math.max(0, node.scrollTop - 300); });
    const latest = page.getByRole("button", { name: "Go to latest messages", exact: true });
    await expect(latest).toBeVisible();
    const latestBox = (await latest.boundingBox())!;
    const threadBox = (await page.locator('[data-direct-message-page] > main').boundingBox())!;
    expect(Math.abs(latestBox.x + latestBox.width / 2 - threadBox.x - threadBox.width / 2)).toBeLessThanOrEqual(1);
    expect(latestBox.x).toBeGreaterThanOrEqual(threadBox.x);
    expect(latestBox.x + latestBox.width).toBeLessThanOrEqual(threadBox.x + threadBox.width);
    expect(latestBox.height).toBeGreaterThanOrEqual(44);
    await latest.click();
    await expect(latest).toBeHidden();
    const layout = await page.evaluate(() => {
      const root = document.querySelector('[data-app-scroll-root="true"]')!;
      const canvas = document.querySelector('[data-direct-message-page]')!;
      const threadHeader = canvas.querySelector('main > header')!;
      const aside = canvas.querySelector('aside[aria-label="Conversations"]');
      const frame = (node: Element) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const style = getComputedStyle(root);
      return { canvas: frame(canvas), threadHeader: frame(threadHeader), aside: aside ? frame(aside) : null,
        top: root.getBoundingClientRect().top + parseFloat(style.paddingTop),
        availableHeight: innerHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) };
    });
    expect(Math.abs(layout.canvas.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.canvas.width - width!)).toBeLessThanOrEqual(2);
    expect(Math.abs(layout.canvas.y - layout.top)).toBeLessThanOrEqual(2);
    expect(layout.canvas.height).toBeGreaterThanOrEqual(layout.availableHeight - 2);
    expect(Math.abs(layout.threadHeader.y - layout.canvas.y)).toBeLessThanOrEqual(1);
    const split = width! >= 768 && (height! >= 500 || width! >= 1024);
    if (split) {
      expect(layout.aside).not.toBeNull();
      expect(Math.abs(layout.aside!.x - layout.canvas.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.aside!.width - width! * 0.3)).toBeLessThanOrEqual(1);
      const inboxHeader = page.getByRole("complementary", { name: "Conversations" }).locator("header");
      const inboxHeaderBox = (await inboxHeader.boundingBox())!;
      expect(Math.abs(inboxHeaderBox.y + inboxHeaderBox.height - layout.threadHeader.y - layout.threadHeader.height)).toBeLessThanOrEqual(1);
      const heading = (await inboxHeader.getByRole("heading", { name: "Messages" }).boundingBox())!;
      const actions = (await inboxHeader.locator('[class*="inboxHeaderActions"]').boundingBox())!;
      if (width! < 1100) expect(heading.y + heading.height + 4).toBeLessThanOrEqual(actions.y);
      else expect(heading.x + heading.width + 4).toBeLessThanOrEqual(actions.x);
      expect(layout.aside!.y + layout.aside!.height).toBeLessThanOrEqual((await page.locator('[data-bottom-shell-motion-stack]').boundingBox())!.y + 1);
      const overflow = await page.locator('[data-app-scroll-root]').evaluate(node => node.scrollHeight - node.clientHeight);
      expect(overflow, "The desktop workspace must not scroll beneath the fixed dock").toBeLessThanOrEqual(1);
      const thread = (await page.locator('[data-direct-message-page] > main').boundingBox())!;
      const header = (await page.locator('[class*="threadHeaderContent"]').boundingBox())!;
      const row = (await page.locator('[data-chat-message]').last().boundingBox())!;
      const dock = (await page.locator('[data-bottom-shell-motion-stack]').boundingBox())!;
      expect(Math.abs(thread.x - layout.aside!.x - layout.aside!.width)).toBeLessThanOrEqual(1);
      expect(header.x).toBe(thread.x);
      expect(header.width).toBe(thread.width);
      expect(Math.abs(row.x - thread.x - 16)).toBeLessThanOrEqual(1);
      await expectSharedDockFrame(page);
      const navigation = (await page.locator('[data-bottom-shell-navigation-slot]').boundingBox())!;
      expect(navigation.x).toBe(dock.x);
      expect(navigation.width).toBe(dock.width);
    }
    if (width! < 768) {
      await fixture(page, "fixture.remoteChange('maya-79', 'A long outgoing message with details. '.repeat(5)); fixture.remoteChange('maya-78', 'A long incoming message with details. '.repeat(5))");
      for (const id of ["maya-79", "maya-78"]) {
        const row = page.locator(`[data-chat-message="${id}"]`);
        await expect(row).toContainText("with details.");
        await row.hover();
        for (const label of ["React to message", "Message options"]) {
          const box = (await row.getByRole("button", { name: label }).boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width!);
        }
      }
    }
    await page.screenshot({ path: test.info().outputPath(`direct-chat-${width}.png`), animations: "disabled" });
    await page.locator("[data-direct-message-composer-input]").fill("A multiline draft\n".repeat(40));
    const inset = height! < 500 ? 140 : 300;
    await page.evaluate((value) => { document.documentElement.classList.add("kb-open", "native-keyboard-inset"); document.documentElement.style.setProperty("--kb-height", `${value}px`); }, inset);
    fs.writeFileSync(test.info().outputPath("keyboard-geometry.json"), JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('[data-app-shell-width],[data-direct-message-page],main,header,textarea,form')).map((node) => ({tag: node.tagName, cls: node.className, box: node.getBoundingClientRect().toJSON(), minHeight: getComputedStyle(node).minHeight, padding: getComputedStyle(node).padding, flex: getComputedStyle(node).flex, height: getComputedStyle(node).height}))), null, 2));
    const editor = page.locator("[data-direct-message-composer-input]");
    const send = page.getByRole("button", { name: "Send message" });
    await expect.poll(async () => (await send.boundingBox())!.y + (await send.boundingBox())!.height).toBeLessThanOrEqual(height! - inset + 1);
    await expect.poll(() => page.evaluate(() => {
      const transcript = document.querySelector('[data-testid="direct-message-list"]')!;
      const dock = document.querySelector('[data-bottom-shell-agent-slot] > [data-agent-bar-shell]')!;
      return transcript.getBoundingClientRect().bottom - dock.getBoundingClientRect().top;
    })).toBeLessThanOrEqual(1);
    const geometry = await editor.boundingBox(); const target = await send.boundingBox();
    expect(geometry!.height).toBeGreaterThanOrEqual(44); expect(target!.width).toBeGreaterThanOrEqual(44); expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width! + 1);
    if (!split) {
      const workspace = (await page.locator('[data-direct-message-page]').boundingBox())!;
      const thread = (await page.locator('[data-direct-message-page] > main').boundingBox())!;
      expect(Math.abs(thread.width - workspace.width)).toBeLessThanOrEqual(1);
    }
    if (split) await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
    else { await page.getByRole("button", { name: "Back to messages" }).click(); await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible(); }
    expect(errors).toEqual([]);
  });
}
test("preserves history during pagination and incoming events, but follows your send", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await mount(page);
  await transcript(page).evaluate((node) => { node.scrollTop = 0; });
  const anchor = page.locator('[data-chat-message="maya-20"]');
  const before = (await anchor.boundingBox())!.y;
  await page.getByRole("button", { name: "Load older messages" }).click();
  await expect(page.locator('[data-chat-message="maya-0"]')).toHaveCount(1);
  expect(Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThan(3);
  const scroll = await transcript(page).evaluate((node) => node.scrollTop);
  await fixture(page, "fixture.incoming()"); await expect(page.getByText("New message 81", { exact: true }).last()).toHaveCount(1);
  expect(Math.abs(await transcript(page).evaluate((node) => node.scrollTop) - scroll)).toBeLessThan(3);
  await page.locator("[data-direct-message-composer-input]").fill("My reply while reading history"); await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("[data-direct-message-composer-input]")).toHaveValue("");
  await expect.poll(() => transcript(page).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(8);
  await expect(page.locator('[data-chat-message="maya-0"]')).toHaveCount(1);
});

test("quoted history navigation preserves live updates while an older page is pending", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 }); const errors = await mount(page);
  await fixture(page, "fixture.quoteOldest()");
  const quote = page.getByRole("button", { name: "Go to original message from Maya Rao" });
  await expect(quote).toBeVisible();
  await fixture(page, "fixture.holdOlder()"); await quote.click();
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.olderPending())).toBe(true);
  await fixture(page, "fixture.incoming(); fixture.remoteChange('maya-79', 'Live edit during quote navigation')");
  await expect(page.locator('[data-chat-message="maya-79"]')).toContainText("Live edit during quote navigation");
  await fixture(page, "fixture.releaseOlder()");
  await expect(page.locator('[data-chat-message="maya-0"]')).toBeFocused();
  await expect(page.locator('[data-chat-message="maya-incoming-80"]')).toHaveCount(1);
  await expect(page.locator('[data-chat-message="maya-79"]')).toContainText("Live edit during quote navigation");
  expect(errors).toEqual([]);
});

for (const width of [320, 768]) test(`file and voice bubbles stay usable with native tap targets at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 852 }); const errors = await mount(page);
  await fixture(page, "fixture.addFiles()");
  const file = page.locator('[data-chat-message="fixture-file"]');
  const voice = page.locator('[data-chat-message="fixture-audio"]');
  await expect(file).toContainText("Chat_Spec_v2.pdf"); await expect(file).toContainText("PDF");
  await expect(voice).toContainText("0:04");
  await expect(voice.getByLabel("Delivered", { exact: true })).toBeVisible();
  for (const button of [file.getByRole("button", { name: "Download Chat_Spec_v2.pdf" }), voice.getByRole("button", { name: "Play voice message" })]) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  await voice.getByRole("button", { name: "Play voice message" }).click();
  await expect(voice.getByRole("button", { name: "Pause voice message" })).toBeVisible();
  await voice.getByRole("button", { name: "Pause voice message" }).click();
  await expect(voice.getByRole("button", { name: "Play voice message" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  await page.screenshot({ path: test.info().outputPath(`file-voice-${width}.png`), animations: "disabled" });
  expect(errors).toEqual([]);
});
for (const scrollAway of [false, true]) test(`a delayed inline photo preserves ${scrollAway ? "the reader’s scrolled position" : "bottom alignment"}`, async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 }); const errors = await mount(page);
  await fixture(page, "fixture.addPhoto()");
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.photoPending())).toBe(true);
  const list = transcript(page);
  if (scrollAway) {
    await list.evaluate(node => { node.scrollTop -= 350; });
    await expect(page.getByRole("button", { name: "Go to latest messages" })).toBeVisible();
  }
  const before = await list.evaluate(node => node.scrollTop);
  await list.evaluate(node => {
    const beforePhotoLoad = (event: Event) => {
      if (!(event.target instanceof HTMLImageElement) || event.target.alt !== "Photo") return;
      // Some browsers deliver an anchoring scroll after layout, before React's
      // image-load callback. Preserve that ordering deterministically.
      node.dispatchEvent(new Event("scroll"));
      node.removeEventListener("load", beforePhotoLoad, true);
    };
    node.addEventListener("load", beforePhotoLoad, true);
  });
  await fixture(page, "fixture.releasePhotos()");
  const image = page.getByRole("img", { name: "Photo", exact: true });
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(400);
  if (scrollAway) await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(before);
  else await expect.poll(() => list.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
test("retries a committed send with the same id and keeps older history available", async ({ page }) => {
  await mount(page); await fixture(page, "fixture.loseNextResponse()");
  await page.locator("[data-direct-message-composer-input]").fill("One message, even after a lost response"); await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.locator("[data-direct-message-composer-input]")).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("[data-direct-message-composer-input]")).toHaveValue("");
  const sends = await page.evaluate(() => (window as any).directChatFixture.sends);
  expect(sends).toHaveLength(2); expect(sends[0].clientMessageId).toBe(sends[1].clientMessageId);
  await expect(page.locator(`[data-chat-message="${sends[0].clientMessageId}"]`)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(1);
});
test("a late send cannot redirect another conversation or erase its draft", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await mount(page); await fixture(page, "fixture.holdSend()");
  await page.locator("[data-direct-message-composer-input]").fill("Message for Maya"); await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: /Arjun Mehta/ }).click();
  await expect(page.getByRole("textbox", { name: /Message Arjun/ })).toBeVisible();
  await page.locator("[data-direct-message-composer-input]").fill("Arjun’s separate draft");
  await fixture(page, "fixture.releaseSend()");
  await expect(page.locator("[data-direct-message-composer-input]")).toHaveValue("Arjun’s separate draft"); expect(page.url()).toBe("http://localhost/one/messages");
  expect(await page.evaluate(() => history.state.directMessageSelection.token)).toBe("dm1.arjun");
  await expect(page.locator('[data-chat-message]').filter({ hasText: "Message for Maya" })).toHaveCount(0);
});
test("hover actions do not shift messages or the centered composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await mount(page);
  const touchActions = await touchMessageActions(page);
  const bubble = page.locator('[data-message-role="user"]').last();
  const before = await bubble.boundingBox();
  await bubble.hover();
  await expect(bubble.getByRole("button", { name: "Message options" })).toBeVisible();
  const other = page.locator('[data-message-role="user"]').first();
  await other.hover();
  await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(touchActions ? 0 : 1);
  if (!touchActions) await expect(other).toHaveAttribute("data-actions-visible", "true");
  await bubble.hover();
  const after = await bubble.boundingBox();
  expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  await expectSharedDockFrame(page);
  for (const role of ["user", "peer"]) {
    const row = page.locator(`[data-message-role="${role}"]`).last();
    await row.hover();
    const emoji = row.getByRole("button", { name: "React to message" });
    const iconBox = (await emoji.boundingBox())!;
    const menuBox = (await row.getByRole("button", { name: "Message options" }).boundingBox())!;
    expect(Math.abs(iconBox.y - menuBox.y)).toBeLessThanOrEqual(1);
    const bubbleBox = (await row.locator('[data-chat-bubble]').boundingBox())!;
    if (touchActions) {
      await expect(emoji.locator("..")).toHaveCSS("opacity", "0");
      for (const button of [emoji, row.getByRole("button", { name: "Message options" })]) {
        await expect(button).toHaveCSS("pointer-events", "none");
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(1440);
      }
    } else {
      expect(menuBox.x).toBeGreaterThanOrEqual(bubbleBox.x);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(bubbleBox.x + bubbleBox.width + 1);
      if (role === "user") expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(bubbleBox.x);
      else expect(iconBox.x).toBeGreaterThanOrEqual(bubbleBox.x + bubbleBox.width);
    }
  }
  await page.getByRole("heading", { name: "Maya Rao", exact: true }).hover();
  await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(0);
  await expect(bubble.getByRole("button", { name: "Message options" }).locator("..")).toHaveCSS("opacity", "0");
  await bubble.getByRole("button", { name: "Message options" }).focus();
  await expect(bubble.getByRole("button", { name: "Message options" }).locator("..")).toHaveCSS("opacity", "1");
  await page.getByRole("heading", { name: "Maya Rao", exact: true }).hover();
  await expect(bubble).toHaveAttribute("data-actions-visible", "true");
  await page.locator("main > header").getByRole("link", { name: "View Maya Rao's profile", exact: true }).focus();
  await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(0);
  const title = page.getByRole("heading", { name: "Messages", exact: true });
  const contact = page.getByRole("heading", { name: "Maya Rao", exact: true });
  const typography = (node: HTMLElement | SVGElement) => {
    const style = getComputedStyle(node);
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
  };
  const screenTitle = await title.evaluate(typography);
  const threadTitle = await contact.evaluate(typography);
  expect(screenTitle.family).toBe(threadTitle.family);
  expect(screenTitle.size).toBe("20px");
  expect(screenTitle.weight).toBe("600");
  expect(threadTitle.size).toBe("16px");
  expect(threadTitle.weight).toBe("600");
});

test.describe("compact message layout", () => {
  test.use({ timezoneId: "UTC", locale: "en-US" });
  for (const width of [320, 393, 768, 1440]) test(`compact message timestamps sit at the lower right at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(page, width === 393);
    if (width === 320) await transcript(page).evaluate(element => {
      // Reproduce CI's 15px classic scrollbar gutter on overlay-scrollbar hosts.
      const gutter = element.getBoundingClientRect().width - element.clientWidth;
      if (gutter < 15) element.style.paddingRight = `${parseFloat(getComputedStyle(element).paddingRight) + 15 - gutter}px`;
    });
    await fixture(page, "fixture.remoteChange('maya-79', 'Hi 🙂'); fixture.remoteChange('maya-78', 'Hi 🙂')");
    for (const id of ["maya-79", "maya-78"]) {
      const row = page.locator(`[data-chat-message="${id}"]`);
      await row.hover();
      const bubble = row.locator('[data-chat-bubble]');
      const before = await bubble.boundingBox();
      await row.getByRole("button", { name: "Message options" }).focus();
      expect(await bubble.boundingBox()).toEqual(before);
      const geometry = await bubble.evaluate(element => {
        const text = element.querySelector(":scope > p")!.getBoundingClientRect();
        const time = element.querySelector("time")!.getBoundingClientRect();
        const bubble = element.getBoundingClientRect();
        const meta = element.querySelector('[class*="messageBubbleMeta"]')!.getBoundingClientRect();
        return { textBottom: text.bottom, timeTop: time.top, timeBottom: time.bottom, bubbleBottom: bubble.bottom, rightInset: bubble.right - meta.right, expectedInset: Math.min(14, parseFloat(getComputedStyle(element).paddingRight)), timeSize: parseFloat(getComputedStyle(element.querySelector("time")!).fontSize) };
      });
      expect(geometry.timeTop, JSON.stringify(geometry)).toBeLessThan(geometry.textBottom);
      expect(geometry.timeBottom, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.textBottom);
      expect(geometry.timeBottom).toBeLessThanOrEqual(geometry.bubbleBottom);
      expect(Math.abs(geometry.rightInset - geometry.expectedInset), JSON.stringify(geometry)).toBeLessThanOrEqual(1);
      expect(geometry.timeSize).toBeLessThanOrEqual(11);
      for (const label of ["React to message", "Message options"]) {
        const button = row.getByRole("button", { name: label });
        const rect = (await button.boundingBox())!;
        expect(rect.width).toBeGreaterThanOrEqual(44);
        expect(rect.height).toBeGreaterThanOrEqual(44);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(width);
        if (!(await touchMessageActions(page))) await button.hover();
        await expect(button).toHaveCSS("background-image", /14px.*15px/);
        await page.keyboard.press("Tab");
        await button.focus();
        await expect(button).toHaveCSS("outline-style", "solid");
        await expect(button).toHaveCSS("outline-width", "2px");
      }
    }
    await page.screenshot({ path: test.info().outputPath(`compact-message-controls-${width}.png`), animations: "disabled" });
  });
});
test("hidden encrypted selections survive browser history and refresh", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await mount(page);
  await expect.poll(() => page.url()).toBe("http://localhost/one/messages");
  await page.getByRole("button", { name: /Arjun Mehta/ }).click();
  await expect(page.getByRole("textbox", { name: /Message Arjun/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "Message Maya Rao" })).toBeVisible();
  expect(page.url()).toBe("http://localhost/one/messages");
  await page.goForward();
  await expect(page.getByRole("textbox", { name: /Message Arjun/ })).toBeVisible();
  expect(page.url()).toBe("http://localhost/one/messages");
  await page.reload(); await page.addScriptTag({ content: script });
  await expect(page.getByRole("textbox", { name: /Message Arjun/ })).toBeVisible();
  expect(page.url()).toBe("http://localhost/one/messages");
});
for (const width of [320, 1440]) {
  test(`whole chat deletion uses the ${width < 768 ? "phone hold" : "web menu"} and confirmation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, false, false, true);
    const chat = page.getByRole("group", { name: "Maya Rao chat" });
    const row = chat.getByRole("button").first();
    const options = chat.getByRole("button", { name: "Chat options" });
    await chat.hover();
    const box = (await options.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await chat.locator("button button").count()).toBe(0);
    if (width < 768) {
      // A moving touch is a scroll, while a stationary hold opens chat actions.
      await row.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, pointerId: 1, button: 0, clientX: 30, clientY: 50 });
      await row.dispatchEvent("pointermove", { pointerType: "touch", clientX: 55, clientY: 50 });
      await page.waitForTimeout(1050);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await row.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, pointerId: 1, button: 0, clientX: 30, clientY: 50 });
      await expect(page.getByRole("menuitem", { name: "Delete chat" })).toBeVisible();
      await row.dispatchEvent("pointerup", { pointerType: "touch", button: 0 });
      await row.dispatchEvent("click", { detail: 1 });
      await expect(page.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
    } else {
      await options.click();
    }
    await page.getByRole("menuitem", { name: "Delete chat" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Deletes this chat for you only.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(chat).toBeVisible();
    if (width < 768) {
      // Native context menus can precede the hold timer and synthesize a click.
      await row.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, pointerId: 2, button: 0, clientX: 30, clientY: 50 });
      await row.dispatchEvent("contextmenu");
      await row.dispatchEvent("pointerup", { pointerType: "touch", button: 0 });
      await row.dispatchEvent("click", { detail: 1 });
      await expect(page.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
    } else {
      await options.click();
    }
    await page.getByRole("menuitem", { name: "Delete chat" }).click();
    await page.getByRole("button", { name: "Delete chat", exact: true }).click();
    await expect(chat).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Arjun Mehta/ })).toBeVisible();
    await fixture(page, "fixture.incoming('maya')");
    await expect(chat).toBeVisible();
    await row.click();
    await expect(transcript(page).locator("[data-chat-message]")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [320, 1440]) {
  test(`name and photos open the profile and Back restores the conversation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page);
    const name = "View Maya Rao's profile";
    const identity = page.locator("main > header").getByRole("link", { name, exact: true });
    const messageLink = transcript(page).getByRole("link", { name }).last();
    await expect(identity).toContainText("Maya Rao");
    await identity.focus();
    await expect(identity).toBeFocused();
    await expect(identity).toHaveCSS("outline-style", "solid");
    expect(Math.abs((await identity.locator(":scope > span").first().boundingBox())!.x - (await identity.boundingBox())!.x)).toBeLessThanOrEqual(1);
    for (const link of [identity, messageLink]) {
      await expect(link).toHaveAttribute("href", "/people/person-maya?from=%2Fone%2Fmessages");
      const box = (await link.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // Avatar gestures never activate the message's long-press menu.
    await messageLink.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, pointerId: 1, button: 0 });
    await page.waitForTimeout(650);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await messageLink.dispatchEvent("pointerup", { pointerType: "touch", button: 0 });
    await page.route("http://localhost/people/**", route => route.fulfill({ contentType: "text/html", body: "<main>Profile route reached</main>" }));
    for (const target of [identity.getByRole("heading", { name: "Maya Rao", exact: true }), identity.locator("img"), messageLink]) {
      await target.click();
      await expect(page).toHaveURL("http://localhost/people/person-maya?from=%2Fone%2Fmessages");
      await expect(page.getByText("Profile route reached")).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL("http://localhost/one/messages");
      if (await page.locator("[data-direct-message-page]").count() === 0) await page.addScriptTag({ content: script });
      await expect(page.getByRole("textbox", { name: "Message Maya Rao", exact: true })).toBeVisible();
    }
  });
}

test("returning to Messages restores the last People thread until Back closes it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mount(page);
  await page.getByRole("button", { name: /Arjun Mehta/ }).click();
  await expect(page.getByRole("textbox", { name: /Message Arjun/ })).toBeVisible();

  // A new document has no conversation token in its URL or history.state.
  // Restoring here requires the user-scoped session selection.
  await page.goto("http://localhost/one/messages");
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("textbox", { name: /Message Arjun/ })).toBeVisible();
  await expect(page.locator("[data-direct-message-page]")).toHaveAttribute("data-chat-open", "true");

  expect(await page.evaluate(() => (window as any).directChatUnwindBack())).toBe(true);
  await expect(page.locator("[data-direct-message-page]")).toHaveAttribute("data-chat-open", "false");
  await page.goto("http://localhost/one/messages");
  await page.addScriptTag({ content: script });
  await expect(page.locator("[data-direct-message-page]")).toHaveAttribute("data-chat-open", "false");
  await expect(page.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
});
test("background refreshes do not read new messages; changing owner clears prior previews immediately", async ({ page }) => {
  await mount(page);
  fs.writeFileSync(test.info().outputPath("read-geometry.json"), JSON.stringify(await page.evaluate(() => {
    const root = document.querySelector('[data-testid="direct-message-list"]')!;
    const bottom = root.lastElementChild!;
    return { focus: document.hasFocus(), visibility: document.visibilityState, root: root.getBoundingClientRect().toJSON(), bottom: bottom.getBoundingClientRect().toJSON(), scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
  })));
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.length)).toBeGreaterThan(0);
  const readCount = await page.evaluate(() => (window as any).directChatFixture.reads.length);
  await fixture(page, "fixture.lifecycle('background'); fixture.incoming()");
  await expect(page.locator('[data-chat-message]').filter({ hasText: "New message 81" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).directChatFixture.reads.length)).toBe(readCount);
  await fixture(page, "fixture.lifecycle('active')"); await expect(page.locator('[data-chat-message]').filter({ hasText: "New message 81" })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.length)).toBeGreaterThan(readCount);
  await fixture(page, "fixture.changeOwner()");
  await expect(page.getByRole("button", { name: /Arjun Mehta/ })).toHaveCount(0);
  await fixture(page, "fixture.releaseInbox()");
});

test("incoming messages covered by a modal or moving composer keep their unread receipt", async ({ page }) => {
  await mount(page, false, false, false, "idle", { modal: true }); await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.length)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Open fixture modal" }).click();
  await expect(page.getByRole("dialog", { name: "Fixture modal" })).toBeVisible();
  const before = await page.evaluate(() => (window as any).directChatFixture.reads.length);
  await fixture(page, "fixture.incoming()");
  await expect(page.locator('[data-chat-message]').filter({ hasText: "New message 81" })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).directChatFixture.reads.length)).toBe(before);
  await page.getByRole("button", { name: "Finish fixture modal" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.length)).toBeGreaterThan(before);
  const afterModal = await page.evaluate(() => (window as any).directChatFixture.reads.length);
  // A moving native dock can occlude an otherwise intersecting bottom marker.
  await page.locator('[data-bottom-shell-agent-slot] > [data-agent-bar-shell]').evaluate((node) => { (node as HTMLElement).style.transform = 'translateY(-120px)'; });
  await fixture(page, "fixture.incoming()");
  await expect(page.locator('[data-chat-message]').filter({ hasText: "New message 82" })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).directChatFixture.reads.length)).toBe(afterModal);
  await page.locator('[data-bottom-shell-agent-slot] > [data-agent-bar-shell]').evaluate((node) => { (node as HTMLElement).style.removeProperty('transform'); });
  // Touch focus restoration can preserve an earlier transcript position.
  // A read requires returning to the actual latest message in that case.
  const latest = page.getByRole('button', { name: 'Go to latest messages' });
  if (await latest.isVisible()) await latest.click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.length)).toBeGreaterThan(afterModal);
});

test("a message arriving during an outstanding read gets its own read boundary", async ({ page }) => {
  await mount(page); await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.length)).toBeGreaterThan(0);
  const before = await page.evaluate(() => (window as any).directChatFixture.reads.length);
  await fixture(page, "fixture.holdRead(); fixture.incoming()");
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.length)).toBe(before + 1);
  await fixture(page, "fixture.incoming()");
  await expect(page.locator('[data-chat-message]').filter({ hasText: "New message 82" })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).directChatFixture.reads.length)).toBe(before + 1);
  await fixture(page, "fixture.releaseRead()");
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.at(-1).throughMessageId)).toBe("maya-incoming-81");
});

test("Enter preserves composition and mobile newlines while desktop Enter sends", async ({ page }) => {
  await mount(page);
  const editor = page.locator("[data-direct-message-composer-input]");
  await editor.fill("Hello from the keyboard");
  await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await editor.press("Shift+Enter");
  expect(await page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(0);
  await editor.fill("Hello from the keyboard");
  await editor.press("Enter");
  if (await page.evaluate(() => matchMedia("(pointer: fine)").matches)) await expect(editor).toHaveValue("");
  else { await expect(editor).toHaveValue("Hello from the keyboard\n"); expect(await page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(0); }
});


for (const width of [320, 393, 1440]) {
  for (const dark of [false, true]) {
    test(`message menu is action-only and full reactions fit at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
      const errors = await mount(page, dark);
      await fixture(page, "fixture.remoteChange('maya-78', 'Choose any reaction')");
      const message = page.locator('[data-chat-message="maya-78"]');
      await expect(message).toContainText("Choose any reaction");
      await holdMessage(page, message);
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
      await expect(menu.getByRole("group", { name: "Quick reactions" })).toHaveCount(0);
      await expect(menu.getByRole("button")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`message-menu-${width}-${dark ? "dark" : "light"}.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      const draft = page.locator("[data-direct-message-composer-input]");
      await draft.fill("Keep this draft");
      const avatarOffset = async () => {
        const avatar = (await message.getByRole("link", { name: "View Maya Rao's profile" }).boundingBox())!;
        const bubble = (await message.locator("[data-chat-bubble]").boundingBox())!;
        return avatar.y + avatar.height - bubble.y - bubble.height;
      };
      const originalAvatarOffset = await avatarOffset();
      const useMenu = await page.evaluate(() => matchMedia("(max-width: 767px), (hover: none)").matches);
      for (const emoji of ["🐱", "👩🏽‍💻", "🇮🇳"]) {
        if (useMenu) {
          await holdMessage(page, message);
          await expect(page.getByRole("menuitem", { name: "React", exact: true })).toHaveCount(0);
          await page.keyboard.press("Escape");
          await message.getByRole("button", { name: "React to message", exact: true }).click();
        } else {
          await message.hover();
          await message.getByRole("button", { name: "React to message", exact: true }).click();
        }
        const picker = page.getByRole("dialog", { name: "Emoji picker", exact: true });
        await expect(picker).toBeVisible();
        await expect(picker.getByRole("tab", { name: "Animals and nature", exact: true })).toBeVisible();
        const box = (await picker.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(width === 320 ? 568 : 900);
        await picker.getByPlaceholder("Search emoji").fill(emoji);
        if (emoji === "🐱") {
          await fixture(page, "fixture.remoteChange('maya-78', 'Choose any reaction')");
          await expect(picker).toBeVisible();
        }
        await picker.getByRole("button", { name: `Use ${emoji}`, exact: true }).click();
        await expect(picker).toHaveCount(0);
        await expect(message.getByRole("button", { name: `${emoji} reaction, 1`, exact: true })).toBeVisible();
        await expect(draft).toHaveValue("Keep this draft");
        expect(Math.abs(await avatarOffset() - originalAvatarOffset)).toBeLessThan(1);
        await message.getByRole("button", { name: `${emoji} reaction, 1`, exact: true }).click();
        await expect(message.getByRole("button", { name: `${emoji} reaction, 1`, exact: true })).toHaveCount(0);
        expect(Math.abs(await avatarOffset() - originalAvatarOffset)).toBeLessThan(1);
      }
      expect(await page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(0);
      await holdMessage(page, message);
      await page.keyboard.press("Escape");
      await message.getByRole("button", { name: "React to message", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Emoji picker", exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`full-reactions-${width}-${dark ? "dark" : "light"}.png`), animations: "disabled" });
      await fixture(page, "fixture.changeOwner()");
      await expect(page.getByRole("dialog", { name: "Emoji picker", exact: true })).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}

test("preserves replies, edits and delete actions with a short phone keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await mount(page);
  const received = page.locator('[data-chat-message="maya-77"]');
  await expect(received.getByRole("button", { name: "Message options" })).toHaveCSS("pointer-events", "none");
  await holdMessage(page, received);
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(page.getByText("Replying to Maya Rao", { exact: true })).toBeVisible();
  await page.locator("[data-direct-message-composer-input]").fill("Reply stays in this chat\nA multiline reply\nwith another line\nand a final line");
  await page.evaluate(() => { document.documentElement.classList.add('kb-open', 'native-keyboard-inset'); document.documentElement.style.setProperty("--kb-height", "300px"); });
  const send = page.getByRole("button", { name: "Send message" });
  await expect.poll(async () => (await send.boundingBox())!.y + (await send.boundingBox())!.height).toBeLessThanOrEqual(269);
  await send.click();
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.sends.at(-1)?.replyToMessageId)).toBe("maya-77");
  await page.evaluate(() => { document.documentElement.classList.remove('kb-open', 'native-keyboard-inset'); document.documentElement.style.removeProperty("--kb-height"); });
  const own = page.locator('[data-chat-message]').filter({ hasText: "Reply stays in this chat" });
  await holdMessage(page, own);
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Edit message", exact: true })).toBeFocused();
  await page.evaluate(() => { document.documentElement.classList.add('kb-open', 'native-keyboard-inset'); document.documentElement.style.setProperty("--kb-height", "300px"); });
  await page.getByRole("textbox", { name: "Edit message", exact: true }).fill("Edited reply");
  await expect.poll(async () => (await page.getByRole("button", { name: "Save", exact: true }).boundingBox())!.y + (await page.getByRole("button", { name: "Save", exact: true }).boundingBox())!.height).toBeLessThanOrEqual(268);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator('[data-chat-message]').filter({ hasText: "Edited reply" })).toHaveCount(1);
  await page.evaluate(() => { document.documentElement.classList.remove('kb-open', 'native-keyboard-inset'); document.documentElement.style.removeProperty("--kb-height"); });
  const edited = page.locator('[data-chat-message]').filter({ hasText: "Edited reply" });
  await holdMessage(page, edited);
  await fixture(page, "fixture.holdReaction()");
  await expect(page.getByRole("group", { name: "Quick reactions" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await edited.getByRole("button", { name: "React to message", exact: true }).click();
  await page.getByPlaceholder("Search emoji").fill("heart");
  await page.getByRole("button", { name: "Use ❤️", exact: true }).click();
  await expect(edited.getByRole("button", { name: "❤️ reaction, 1", exact: true })).toBeVisible();
  await edited.locator("[data-chat-bubble]").click();
  await fixture(page, "fixture.releaseReaction()");
  await holdMessage(page, edited);
  await page.getByRole("menuitem", { name: "Delete for everyone", exact: true }).click();
  await page.getByRole("button", { name: "Yes, delete", exact: true }).click();
  const deleted = page.getByText("This message was deleted.", { exact: true });
  await expect(deleted).toHaveCount(1);
  const deletedBubble = deleted.locator("xpath=..");
  const deletedMeta = deletedBubble.locator('[class*="messageBubbleMeta"]');
  const deletedGeometry = await deletedBubble.evaluate(element => {
    const text = element.querySelector(":scope > p")!;
    const meta = element.querySelector('[class*="messageBubbleMeta"]')!;
    const time = element.querySelector("time")!;
    return {
      textTop: text.getBoundingClientRect().top,
      textBottom: text.getBoundingClientRect().bottom,
      timeTop: time.getBoundingClientRect().top,
      timeBottom: time.getBoundingClientRect().bottom,
      rightInset: element.getBoundingClientRect().right - meta.getBoundingClientRect().right,
      expectedInset: parseFloat(getComputedStyle(element).paddingRight) + parseFloat(getComputedStyle(meta).marginRight),
    };
  });
  expect(deletedGeometry.timeTop, JSON.stringify(deletedGeometry)).toBeLessThan(deletedGeometry.textBottom);
  expect(deletedGeometry.timeBottom, JSON.stringify(deletedGeometry)).toBeGreaterThanOrEqual(deletedGeometry.textBottom);
  expect(Math.abs(deletedGeometry.rightInset - deletedGeometry.expectedInset), JSON.stringify(deletedGeometry)).toBeLessThanOrEqual(1);
  await expect(deletedMeta).toHaveCSS("justify-content", "flex-end");
  // Muted ink on the darker pressed fill fell below the text contrast floor.
  await deleted.hover();
  await page.mouse.down();
  try { await expect(deleted).toHaveCSS("color", "rgb(29, 29, 31)"); }
  finally { await page.mouse.up(); }
});


test("refresh reconciles remote edits and deletions throughout loaded history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await mount(page);
  await page.getByRole("button", { name: "Load older messages" }).click();
  await expect(page.locator('[data-chat-message="maya-0"]')).toHaveCount(1);
  await fixture(page, "fixture.remoteChange('maya-2', 'Edited on another device')");
  await expect(page.locator('[data-chat-message="maya-2"]')).toContainText("Edited on another device");
  await fixture(page, "fixture.remoteChange('maya-3', null)");
  await expect(page.locator('[data-chat-message="maya-3"]')).toHaveCount(0);
  await fixture(page, "fixture.remoteChange('maya-77', null)");
  await expect(page.locator('[data-chat-message="maya-77"]')).toHaveCount(0);
  await expect(page.locator('[data-chat-message="maya-0"]')).toHaveCount(1);
  await fixture(page, "fixture.holdHistory(); fixture.incoming()");
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.historyPending())).toBe(true);
  const own = page.locator('[data-chat-message="maya-79"]');
  if (await touchMessageActions(page)) await holdMessage(page, own);
  else {
    await own.locator("[data-chat-bubble]").click();
    await own.getByRole("button", { name: "Message options" }).click();
  }
  await page.getByRole("menuitem", { name: "Delete for me", exact: true }).click();
  await page.getByRole("button", { name: "Yes, delete", exact: true }).click();
  await expect(own).toHaveCount(0);
  await fixture(page, "fixture.releaseHistory()");
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.historyPending())).toBe(false);
  await expect(own).toHaveCount(0);
});


for (const width of [390, 1440]) test(`visited conversations stay readable during revalidation at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const errors = await mount(page);
  await page.getByRole("button", { name: "Back to messages" }).click();
  await page.getByRole("button", { name: /Arjun Mehta/ }).click();
  await expect(page.getByRole("textbox", { name: /Message Arjun Mehta/ })).toBeEnabled();
  await page.getByRole("button", { name: "Back to messages" }).click();
  await fixture(page, "fixture.holdHistory()");
  await page.getByRole("button", { name: /Maya Rao/ }).click();
  await expect(page.locator('[data-chat-message="maya-79"]')).toBeVisible();
  await expect(page.getByText("Loading messages…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Connecting…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Maya Rao" })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath(`messages-warm-${width}.png`), animations: "disabled" });
  await fixture(page, "fixture.releaseHistory()");
  await expect(page.getByRole("textbox", { name: "Message Maya Rao" })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("cold route resolution completes an already pending inbox request", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await mount(page, false, true);
  await expect(page.getByRole("button", { name: /Arjun Mehta/ })).toHaveCount(0);
  await fixture(page, "fixture.releaseInbox()");
  await expect(page.getByRole("button", { name: /Arjun Mehta/ })).toBeVisible();
});

for (const width of [320, 393, 1440]) {
  test(`selected and sent photos stay image-only at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = await mount(page);
    const photo = fs.readFileSync(path.join(process.cwd(), "public/one-location/onboarding/orbit-office.webp"));
    await page.locator('input[accept="image/jpeg,image/png,image/webp"]').setInputFiles({ name: "private-photo.webp", mimeType: "image/webp", buffer: photo });
    const preview = page.getByRole("img", { name: "Photo ready to send", exact: true });
    await expect(preview).toBeVisible();
    await expect(page.getByText("private-photo.webp", { exact: true })).toHaveCount(0);
    const box = (await preview.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    const inputBox = (await page.locator("[data-direct-message-composer-input]").boundingBox())!;
    const sendBox = (await page.getByRole("button", { name: "Send message", exact: true }).boundingBox())!;
    expect(inputBox.width).toBeGreaterThanOrEqual(80);
    // A long recipient placeholder may use two lines on a narrow phone.
    expect(inputBox.height).toBeLessThanOrEqual(80);
    expect(inputBox.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(Math.abs(inputBox.y + inputBox.height / 2 - sendBox.y - sendBox.height / 2)).toBeLessThan(2);
    await page.screenshot({ path: test.info().outputPath(`selected-photo-${width}.png`), animations: "disabled" });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(preview).toHaveCount(0);
    const sent = page.locator('[data-message-role="user"]').filter({ has: page.getByRole("button", { name: "Open photo", exact: true }) });
    await expect(sent.getByRole("img", { name: "Photo", exact: true })).toBeVisible();
    await expect(sent).not.toContainText("private-photo.webp");
    await expect(sent).not.toContainText("MB");
    await sent.hover();
    const bubble = sent.locator("[data-chat-bubble]");
    await expect(bubble).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(bubble).toHaveCSS("padding", "0px");
    await expect(bubble).toHaveCSS("border-top-width", "0px");
    const bubbleBox = (await bubble.boundingBox())!;
    const imageBox = (await sent.getByRole("img", { name: "Photo", exact: true }).boundingBox())!;
    expect(Math.abs(imageBox.x - bubbleBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(imageBox.y - bubbleBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(imageBox.width - bubbleBox.width)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`sent-photo-${width}.png`), animations: "disabled" });
    await sent.getByRole("button", { name: "Open photo", exact: true }).click();
    await expect(page.getByRole("img", { name: "Shared photo", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("img", { name: "Shared photo", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
