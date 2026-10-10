import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Production components/styles with synthetic auth/navigation/service ports.
// Device keyboards, signed-in routes and push delivery have separate proofs.
let script: string;
let css: string;
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
        { find: "@/lib/services/connections-service", replacement: path.join(root, "e2e/fixtures/direct-chat-connections.ts") },
        { find: "@/lib/firebase/config", replacement: path.join(root, "e2e/fixtures/direct-chat-auth.ts") },
        { find: "@/components/connect/circles/circle-messages-pane", replacement: path.join(root, "e2e/fixtures/bottom-shell-boundaries.tsx") },
        { find: "next/navigation", replacement: path.join(root, "e2e/fixtures/direct-chat-navigation.tsx") },
        { find: "next/link", replacement: path.join(root, "e2e/fixtures/direct-chat-navigation.tsx") },
        ...["@/lib/vault/vault-context", "@/lib/consent/use-consent-pending-summary-count", "@/lib/feed/use-feed-unread-count", "@/lib/one-voice/readiness", "@/components/one-voice/voice-session-provider", "@/components/one-voice/tool-result-card", "@/components/one-location/onboarding/location-onboarding-interaction-surface"].map((find) => ({ find, replacement: path.join(root, "e2e/fixtures/bottom-shell-boundaries.tsx") })),
        { find: /^(\.\/|@\/components\/agent\/)location-command-provider$/, replacement: path.join(root, "e2e/fixtures/bottom-shell-boundaries.tsx") },
        { find: /^(\.\/|@\/components\/one-voice\/)tool-result-card$/, replacement: path.join(root, "e2e/fixtures/bottom-shell-boundaries.tsx") },
        { find: "@", replacement: root },
      ] }, define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
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
async function mount(page: Page, dark = false, delayInbox = false, inbox = false, command = "idle") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://localhost/fixture-person-*.webp", (route) => route.fulfill({ contentType: "image/webp", body: fs.readFileSync(path.join(process.cwd(), `public/one-location/onboarding/orbit-person-${Number(route.request().url().match(/person-(\d+)/)![1]) + 1}.webp`)) }));
  await page.route("http://localhost/one/messages*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-command="${command}" data-path="/one/messages" class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
  await page.goto(`http://localhost/one/messages${inbox ? "" : `?conversation=maya${delayInbox ? "&delayInbox=1" : ""}`}`);
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
  const activeNav = navigation.getByRole("radio", { name: "Chat", exact: true });
  await expect(activeNav).toHaveAttribute("aria-checked", "true");
  await expect(navigation.getByRole("radio", { name: "One", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(activeNav).toHaveCSS("color", "rgb(10, 132, 255)");
  const navLabels = await navigation.innerText();
  expect(navLabels).toContain("Chat");
  expect(navLabels).toContain("One");
  expect(navLabels).toContain("Connect");
  expect(navLabels).toContain("Feed");
  expect(navLabels).toContain("Search");

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(chat).toHaveAttribute("data-theme", "light");
  await expect(activeNav).toHaveCSS("color", "rgb(0, 122, 255)");
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
});

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

test("system Back closes the New chat picker before leaving the inbox", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  await mount(page, false, false, true);
  await page.getByRole("button", { name: "New chat" }).first().click();
  await expect(page.getByRole("dialog", { name: "New chat" })).toBeVisible();

  expect(await page.evaluate(() => (window as any).directChatUnwindBack())).toBe(true);
  await expect(page.getByRole("dialog", { name: "New chat" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).directChatUnwindBack())).toBe(false);
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
for (const [width, height] of [[320, 568], [393, 844], [430, 932], [768, 852], [1440, 1000], [844, 390]]) {
  test(`keeps chat navigation and keyboard controls reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    const errors = await mount(page, width === 430);
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
    if (width! >= 960) {
      expect(layout.aside).not.toBeNull();
      expect(Math.abs(layout.aside!.x - layout.canvas.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.aside!.width - 370)).toBeLessThanOrEqual(2);
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
      const dock = document.querySelector('[data-agent-bar-shell]')!;
      return transcript.getBoundingClientRect().bottom - dock.getBoundingClientRect().top;
    })).toBeLessThanOrEqual(1);
    const geometry = await editor.boundingBox(); const target = await send.boundingBox();
    expect(geometry!.height).toBeGreaterThanOrEqual(44); expect(target!.width).toBeGreaterThanOrEqual(44); expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width! + 1);
    if (width! < 960) {
      const workspace = (await page.locator('[data-direct-message-page]').boundingBox())!;
      const thread = (await page.locator('[data-direct-message-page] > main').boundingBox())!;
      expect(Math.abs(thread.width - workspace.width)).toBeLessThanOrEqual(1);
    }
    if (width! >= 960) await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
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
  const bubble = page.locator('[data-message-role="user"]').last();
  const before = await bubble.boundingBox();
  await bubble.hover();
  await expect(bubble.getByRole("button", { name: "Message options" })).toBeVisible();
  const other = page.locator('[data-message-role="user"]').first();
  await other.hover();
  await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(1);
  await expect(other).toHaveAttribute("data-actions-visible", "true");
  await bubble.hover();
  const after = await bubble.boundingBox();
  expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  const dock = await page.locator('[data-bottom-shell-motion-stack]').boundingBox();
  expect(Math.abs(dock!.x + dock!.width / 2 - 720)).toBeLessThanOrEqual(1);
  for (const role of ["user", "peer"]) {
    const row = page.locator(`[data-message-role="${role}"]`).last();
    await row.hover();
    const emoji = row.getByRole("button", { name: "React to message" });
    const iconBox = (await emoji.boundingBox())!;
    const menuBox = (await row.getByRole("button", { name: "Message options" }).boundingBox())!;
    expect(Math.abs(iconBox.y - menuBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(menuBox.x - iconBox.x - iconBox.width)).toBeLessThanOrEqual(3);
    const bubbleBox = (await emoji.locator("../..").boundingBox())!;
    if (role === "user") expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(bubbleBox.x);
    else expect(iconBox.x).toBeGreaterThanOrEqual(bubbleBox.x + bubbleBox.width);
  }
  await page.getByRole("heading", { name: "Maya Rao", exact: true }).hover();
  await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(0);
  const touchPointer = await page.evaluate(() => matchMedia("(hover: none)").matches);
  await expect(bubble.getByRole("button", { name: "Message options" }).locator("..")).toHaveCSS(
    "opacity",
    touchPointer ? "1" : "0",
  );
  await bubble.getByRole("button", { name: "Message options" }).focus();
  await page.getByRole("heading", { name: "Maya Rao", exact: true }).hover();
  await expect(bubble).toHaveAttribute("data-actions-visible", "true");
  await page.getByRole("button", { name: "Search messages", exact: true }).focus();
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
  expect(screenTitle.weight).toBe("700");
  expect(threadTitle.size).toBe("16px");
  expect(threadTitle.weight).toBe("700");
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
  await mount(page); await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.reads.length)).toBeGreaterThan(0);
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
  await page.locator('[data-agent-bar-shell]').evaluate((node) => { (node as HTMLElement).style.transform = 'translateY(-120px)'; });
  await fixture(page, "fixture.incoming()");
  await expect(page.locator('[data-chat-message]').filter({ hasText: "New message 82" })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).directChatFixture.reads.length)).toBe(afterModal);
  await page.locator('[data-agent-bar-shell]').evaluate((node) => { (node as HTMLElement).style.removeProperty('transform'); });
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


test("preserves replies, edits and delete actions with a short phone keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await mount(page);
  const received = page.locator('[data-chat-message="maya-77"]');
  await received.locator("[data-chat-bubble]").click(); await received.getByRole("button", { name: "Message options" }).click();
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
  await own.locator("[data-chat-bubble]").click(); await own.getByRole("button", { name: "Message options" }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page.evaluate(() => { document.documentElement.classList.add('kb-open', 'native-keyboard-inset'); document.documentElement.style.setProperty("--kb-height", "300px"); });
  await page.getByRole("textbox", { name: "Edit message", exact: true }).fill("Edited reply");
  await expect.poll(async () => (await page.getByRole("button", { name: "Save", exact: true }).boundingBox())!.y + (await page.getByRole("button", { name: "Save", exact: true }).boundingBox())!.height).toBeLessThanOrEqual(268);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator('[data-chat-message]').filter({ hasText: "Edited reply" })).toHaveCount(1);
  await page.evaluate(() => { document.documentElement.classList.remove('kb-open', 'native-keyboard-inset'); document.documentElement.style.removeProperty("--kb-height"); });
  const edited = page.locator('[data-chat-message]').filter({ hasText: "Edited reply" });
  await edited.locator("[data-chat-bubble]").click(); await edited.getByRole("button", { name: "React to message" }).click();
  await page.getByRole("button", { name: "React ❤️", exact: true }).click();
  await expect(edited.getByRole("button", { name: "❤️ reaction, 1", exact: true })).toBeVisible();
  await edited.locator("[data-chat-bubble]").click(); await edited.getByRole("button", { name: "Message options" }).click();
  await page.getByRole("menuitem", { name: "Delete for everyone", exact: true }).click();
  await page.getByRole("button", { name: "Yes, delete", exact: true }).click();
  await expect(page.getByText("This message was deleted.", { exact: true })).toHaveCount(1);
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
  await own.locator("[data-chat-bubble]").click(); await own.getByRole("button", { name: "Message options" }).click();
  await page.getByRole("menuitem", { name: "Delete for me", exact: true }).click();
  await page.getByRole("button", { name: "Yes, delete", exact: true }).click();
  await expect(own).toHaveCount(0);
  await fixture(page, "fixture.releaseHistory()");
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.historyPending())).toBe(false);
  await expect(own).toHaveCount(0);
});


test("cold route resolution completes an already pending inbox request", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await mount(page, false, true);
  await expect(page.getByRole("button", { name: /Arjun Mehta/ })).toHaveCount(0);
  await fixture(page, "fixture.releaseInbox()");
  await expect(page.getByRole("button", { name: /Arjun Mehta/ })).toBeVisible();
});
