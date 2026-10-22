import { expect, test, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Production React component and CSS; fixture replaces only the service port.
// Protocol/crypto proofs are separate and do not claim this adapter is a backend.
let script: string;
let css: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  let moduleCss = "";
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "circle-chat-layout-"));
  try {
    await build({ configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic", development: false } },
      plugins: [{ name: "fixture-css", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      } }],
      resolve: { alias: [
        ...["@/hooks/use-auth", "@/lib/vault/vault-context", "@/lib/one-location/service"].map(find => ({ find, replacement: path.join(root, "e2e/fixtures/circle-chat-boundary.ts") })),
        { find: "next/navigation", replacement: path.join(root, "e2e/fixtures/direct-chat-navigation.tsx") },
        { find: "@/components/consent/notification-provider", replacement: path.join(root, "e2e/fixtures/circle-chat-notification-boundary.ts") },
        { find: "@/lib/services/circle-chat-service", replacement: path.join(root, "e2e/fixtures/circle-chat-boundary.ts") },
        { find: "@/lib/services/api-service", replacement: path.join(root, "e2e/fixtures/circle-chat-http-boundary.ts") },
        { find: "@/lib/cache/cache-sync-service", replacement: path.join(root, "e2e/fixtures/circle-chat-cache-boundary.ts") },
        { find: "@", replacement: root },
      ] }, define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}",
        __CIRCLE_CHAT_FIXTURE_MEDIA__: JSON.stringify(fs.readFileSync(path.join(root, "public/one-location/onboarding/orbit-office.webp")).toString("base64")) },
      build: { outDir, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/circle-chat.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" } },
    });
    script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
    moduleCss = fs.readdirSync(outDir).filter(file => file.endsWith(".css")).map(file => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n");
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
async function mount(page: Page, dark = false, workspace = false) {
  await page.route("http://localhost/fixture-person-*.webp", (route) => {
    const index = Number(route.request().url().match(/person-(\d+)/)![1]);
    return route.fulfill({ contentType: "image/webp", body: fs.readFileSync(path.join(process.cwd(), `public/one-location/onboarding/orbit-person-${index + 1}.webp`)) });
  });
  await page.route("http://localhost/circle-chat-fixture*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
  await page.goto(`http://localhost/circle-chat-fixture${workspace ? "?workspace=1" : ""}`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.bringToFront();
}

async function touchMessageActions(page: Page) {
  return page.evaluate(() => matchMedia("(max-width: 767px), (hover: none)").matches);
}

async function openMessageOptions(page: Page, message: Locator) {
  await expect(page.getByRole("menu")).toHaveCount(0);
  if (await touchMessageActions(page)) {
    const bubble = message.locator("[data-chat-bubble]");
    await bubble.click({ trial: true });
    const box = await bubble.boundingBox();
    const pointer = { pointerType: "touch", isPrimary: true, pointerId: 1, button: 0,
      clientX: box!.x + box!.width / 2, clientY: box!.y + box!.height / 2 };
    await bubble.dispatchEvent("pointerdown", pointer);
    await expect(page.getByRole("menu")).toHaveAttribute("data-state", "open");
    await bubble.dispatchEvent("pointerup", pointer);
  } else {
    await message.getByRole("button", { name: "Message options" }).click();
  }
}

test("phone Circle actions open on hold and the keyboard adds no gap before members", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  await mount(page, false, true);
  await expect(page.getByText("Only circle members can read these messages.", { exact: true })).toHaveCount(0);
  const message = page.locator('[data-chat-message="hello"]');
  const options = message.getByRole("button", { name: "Message options" });
  await expect(options.locator("..")).toHaveCSS("opacity", "0");
  await openMessageOptions(page, message);
  await page.getByRole("menuitem", { name: "React ❤️", exact: true }).click();
  await expect(message.getByRole("button", { name: "❤️, 1 reactions, you reacted" })).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await openMessageOptions(page, message);
  await page.getByRole("menuitem", { name: "More reactions…", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Emoji picker" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Emoji picker" })).not.toBeVisible();
  for (const inset of [0, 300]) {
    await page.evaluate((inset) => { document.documentElement.style.setProperty("--kb-height", `${inset}px`); document.documentElement.classList.toggle("kb-open", inset > 0); }, inset);
    const gap = await page.getByRole("button", { name: "View circle members" }).evaluate((node) => node.getBoundingClientRect().top - document.querySelector("[data-one-chat-surface]")!.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(16);
  }
});

for (const width of [320, 393, 768, 1440]) test(`short circle messages keep timestamps inline at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await mount(page, width === 393, true);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hi 🙂");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const row = page.locator("[data-chat-message]").filter({ hasText: "Hi 🙂" });
  await expect(row).toBeVisible();
  const geometry = await row.evaluate(element => {
    const text = [...element.querySelectorAll("p")].find(node => node.textContent === "Hi 🙂")!.getBoundingClientRect();
    const time = [...element.querySelectorAll("time")].at(-1)!.getBoundingClientRect();
    return { textBottom: text.bottom, timeTop: time.top, timeSize: parseFloat(getComputedStyle([...element.querySelectorAll("time")].at(-1)!).fontSize) };
  });
  expect(geometry.timeTop).toBeLessThan(geometry.textBottom);
  expect(geometry.timeSize).toBeLessThanOrEqual(11);
  await page.screenshot({ path: test.info().outputPath(`inline-circle-time-${width}.png`), animations: "disabled" });
});

test("Circle message menu offers only actions authorized for that sender", async ({ page }) => {
  await mount(page, false, true);
  const own = page.locator('[data-chat-message="reply"]');
  await openMessageOptions(page, own);
  for (const name of ["Reply", "Edit", "Delete for me", "Delete for everyone"]) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: test.info().outputPath("circle-message-options.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await openMessageOptions(page, page.locator('[data-chat-message="hello"]'));
  await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete for me", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete for everyone", exact: true })).toHaveCount(0);
});

test("Circle reply, edit and both deletion scopes complete without disturbing adjacent messages", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mount(page, false, true);
  const peer = page.locator('[data-chat-message="hello"]');
  const own = page.locator('[data-chat-message="reply"]');
  await openMessageOptions(page, peer);
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  await expect(page.getByLabel("Replying to message")).toContainText("Kushal Trivedi");
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("Thanks! 👩🏽‍💻 مرحبا");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Replying to message")).toHaveCount(0);
  const quote = page.getByRole("button", { name: "View original message from Kushal Trivedi" });
  await expect(quote).toContainText("Hey everyone!");
  await quote.click();
  await expect(peer).toBeFocused();
  await openMessageOptions(page, own);
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit message text" }).fill("Updated meetup plan");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(own).toContainText("Updated meetup plan");
  await expect(own).toContainText("Edited");
  await openMessageOptions(page, peer);
  await page.getByRole("menuitem", { name: "Delete for me", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(peer).toBeVisible();
  await openMessageOptions(page, peer);
  await page.getByRole("menuitem", { name: "Delete for me", exact: true }).click();
  await page.getByRole("button", { name: "Delete message", exact: true }).click();
  await expect(peer).toHaveCount(0);
  await expect(quote).toHaveCount(0);
  await expect(page.getByText("Original message unavailable", { exact: true })).toBeVisible();
  await openMessageOptions(page, own);
  await page.getByRole("menuitem", { name: "Delete for everyone", exact: true }).click();
  await page.getByRole("button", { name: "Delete message", exact: true }).click();
  await expect(own).toContainText("This message was deleted.");
  await expect(own.getByRole("button", { name: "React to message" })).toHaveCount(0);
  await expect(page.getByText("Our next meetup spot 📍", { exact: true })).toBeVisible();
  await expect(editor).toBeEnabled();
  expect(errors).toEqual([]);
});

test("Circle edit failure keeps the draft and retries the identical sealed change", async ({ page }) => {
  await mount(page, false, true);
  await page.evaluate(() => { (window as unknown as { chatFixture: { failNextMutation: boolean } }).chatFixture.failNextMutation = true; });
  const own = page.locator('[data-chat-message="reply"]');
  await openMessageOptions(page, own);
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Edit message text" });
  await input.fill("   ");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await input.fill("Keep this draft 👋");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Check your connection and try again.");
  await expect(input).toHaveValue("Keep this draft 👋");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(input).toHaveCount(0);
  await expect(own).toContainText("Keep this draft 👋");
  const attempts = await page.evaluate(() => (window as unknown as { chatFixture: { mutations: unknown[] } }).chatFixture.mutations);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
});

for (const width of [320, 393, 1440]) {
  test(`Circle creation offers contacts and deferral in the same layer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.route("http://localhost/circle-create-fixture*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
    await page.goto("http://localhost/circle-create-fixture?workspace=1&create=1");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const dialog = page.getByRole("dialog", { name: "Create a Circle" });
    await dialog.getByRole("textbox", { name: "Circle name" }).fill("Weekend friends");
    await dialog.getByRole("button", { name: "Next", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Add people" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add people later" })).toBeInViewport();
    const add = dialog.getByRole("button", { name: "Add Kushal Trivedi", exact: true });
    await expect(add).toBeVisible();
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`circle-create-contacts-${width}.png`), animations: "disabled" });
    if (width === 320) {
      await dialog.getByRole("button", { name: "Add people later" }).click();
      await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeEnabled();
    } else {
      await add.click();
      await dialog.getByRole("button", { name: "Add 1 person", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeEnabled();
    }
    await expect(dialog).not.toBeVisible();
  });
}

for (const width of [320, 1440]) {
  for (const dark of [false, true]) {
    test(`Circle Messages uses the shared dock without a second field surface at ${width}px ${dark ? "dark" : "light"}`, async ({ page }) => {
      page.on("pageerror", error => console.error("Circle lane runtime", error.message));
      await page.setViewportSize({ width, height: 844 });
      await page.route("http://localhost/circle-lane-fixture*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
      await page.goto("http://localhost/circle-lane-fixture?lane=1");
      await page.addScriptTag({ content: script });
      await awaitProductFont(page);
      const editor = page.getByRole("textbox", { name: "Message" });
      await expect(editor).toBeVisible();
      const header = page.getByRole("heading", { name: "Weekend friends" });
      await expect(header).toBeVisible();
      const identityGap = await header.evaluate(el => {
        const identity = el.parentElement!.parentElement!;
        const avatar = identity.firstElementChild!.getBoundingClientRect();
        return el.getBoundingClientRect().left - avatar.right;
      });
      expect(identityGap).toBeGreaterThanOrEqual(0);
      expect(identityGap).toBeLessThanOrEqual(16);
      await editor.fill("Hello circle");
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
      const geometry = await editor.evaluate(el => {
        const field = el.closest('[data-slot="input-group"]')!;
        const composer = el.closest('[data-circle-chat-composer]')!;
        return { width: document.documentElement.scrollWidth, viewport: innerWidth,
          fieldBorder: getComputedStyle(field).borderTopWidth,
          composerShadow: getComputedStyle(composer).boxShadow,
          editorHeight: el.getBoundingClientRect().height };
      });
      expect(geometry.width).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.fieldBorder).toBe("0px");
      expect(geometry.composerShadow).toBe("none");
      expect(geometry.editorHeight).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: test.info().outputPath(`circle-lane-${width}-${dark ? "dark" : "light"}.png`) });
    });
  }
}

for (const width of [320, 393, 1440]) {
  test(`full Circle reactions fit the viewport and attach to the selected message at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await mount(page, false, true);
    const touchActions = await touchMessageActions(page);
    for (const id of ["hello", "reply", "photo"]) {
      const message = page.locator(`[data-chat-message="${id}"]`);
      const trigger = message.getByRole("button", { name: "React to message" });
      await expect(trigger).toHaveText("☺");
      const hitArea = await trigger.boundingBox();
      expect(hitArea!.width).toBeGreaterThanOrEqual(44);
      expect(hitArea!.height).toBeGreaterThanOrEqual(44);
      const alignment = await trigger.evaluate(el => {
        const action = el.getBoundingClientRect();
        const bubble = el.parentElement!.firstElementChild!.getBoundingClientRect();
        return { topGap: Math.abs(action.top - bubble.top), beside: action.right <= bubble.left || action.left >= bubble.right,
          left: action.left, right: action.right };
      });
      if (!touchActions) {
        expect(alignment.topGap).toBeLessThanOrEqual(1);
        expect(alignment.beside).toBe(true);
      } else {
        await expect(trigger).toHaveCSS("opacity", "0");
        await expect(trigger).toHaveCSS("pointer-events", "none");
      }
      expect(alignment.left).toBeGreaterThanOrEqual(0);
      expect(alignment.right).toBeLessThanOrEqual(width);
      const menu = message.getByRole("button", { name: "Message options" });
      if (touchActions) {
        await expect(menu.locator("..")).toHaveCSS("opacity", "0");
        await expect(menu).toHaveCSS("pointer-events", "none");
      }
      const menuBox = await menu.boundingBox();
      expect(menuBox!.width).toBeGreaterThanOrEqual(44);
      expect(menuBox!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(menuBox!.y - hitArea!.y)).toBeLessThanOrEqual(1);
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
      await trigger.focus(); await page.keyboard.press("Enter");
      const picker = page.getByRole("dialog", { name: "Emoji picker" });
      await expect(picker).toBeVisible();
      await picker.getByRole("tab", { name: "Flags", exact: true }).click();
      await picker.getByPlaceholder("Search emoji").fill("India");
      const choice = picker.getByRole("button", { name: "Use 🇮🇳", exact: true });
      await expect(choice).toBeVisible();
      const box = await picker.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(845);
      const target = await choice.boundingBox();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
      await choice.click();
      await expect(picker).not.toBeVisible();
      const badge = message.getByRole("button", { name: "🇮🇳, 1 reactions, you reacted" });
      await expect(badge).toBeVisible();
      if (id === "reply") await page.screenshot({ path: test.info().outputPath(`circle-reactions-${width}.png`) });
      await badge.click();
      await expect(badge).toHaveCount(0);
      await trigger.focus(); await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await expect(picker).not.toBeVisible();
      await trigger.focus(); await page.keyboard.press("Enter");
      await expect(picker).toBeVisible();
      // The picker can cover either header or composer; its collision gutter is outside it.
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await expect(picker).not.toBeVisible();
    }
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  });
}

for (const width of [320, 768, 1440]) {
  test(`Circle Alerts uses an iOS switch with save recovery at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(page, width === 768, true);
    const toggle = page.getByRole("switch", { name: "Chat alerts" });
    await expect(toggle).toBeChecked();
    const bounds = await toggle.evaluate(el => {
      const label = el.closest("label")!.getBoundingClientRect();
      const track = el.getBoundingClientRect();
      return { width: label.width, height: label.height, trackWidth: track.width, trackHeight: track.height,
        transition: getComputedStyle(el).transitionProperty, thumbTransition: getComputedStyle(el.firstElementChild!).transitionProperty };
    });
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.trackWidth).toBe(51);
    expect(bounds.trackHeight).toBe(31);
    expect(bounds.transition).toBe("none");
    expect(bounds.thumbTransition).toBe("none");
    await page.getByText("Alerts", { exact: true }).click();
    await expect(toggle).not.toBeChecked();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await page.evaluate(() => { (window as unknown as { chatFixture: { failNextMute: boolean } }).chatFixture.failNextMute = true; });
    await toggle.click();
    await expect(page.getByRole("alert")).toContainText("Chat alerts could not be updated.");
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    // The existing online listener refreshes state and clears a transient save error.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("switch", { name: "Chat alerts" }).click();
    await expect(page.getByRole("switch", { name: "Chat alerts" })).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`circle-alerts-${width}.png`) });
  });
}

test("Circle smiley supports keyboard selection and reaction failure recovery", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 393, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mount(page, true, true);
  const message = page.locator('[data-chat-message="reply"]');
  const trigger = message.getByRole("button", { name: "React to message" });
  await expect(trigger).toHaveText("☺");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Emoji picker" });
  const search = picker.getByPlaceholder("Search emoji");
  await search.fill("no-matching-emoji-12345");
  await expect(picker.getByText(/No emojis match/)).toBeVisible();
  await search.fill("🇮🇳");
  await page.evaluate(() => { (window as unknown as { chatFixture: { failNextReaction: boolean } }).chatFixture.failNextReaction = true; });
  await picker.getByRole("button", { name: "Use 🇮🇳", exact: true }).click();
  const badge = message.getByRole("button", { name: "🇮🇳, 1 reactions, you reacted" });
  await expect(badge).toHaveCount(0);
  await expect(message.getByRole("alert")).toContainText("Reaction could not be saved. Try again.");
  await trigger.focus(); await page.keyboard.press("Enter");
  await picker.getByPlaceholder("Search emoji").fill("🇮🇳");
  await picker.getByRole("button", { name: "Use 🇮🇳", exact: true }).click();
  await expect(badge).toBeVisible();
  await expect(message.getByRole("alert")).toHaveCount(0);
  await trigger.focus(); await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});

for (const width of [320, 393, 430, 768, 1440]) {
  test(`fits long messages and a bounded keyboard composer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page, width === 430);
    await page.getByRole("textbox", { name: "Message" }).fill("A long draft\n".repeat(120));
    await page.evaluate(() => document.documentElement.style.setProperty("--kb-height", "300px"));
    const geometry = await page.evaluate(() => {
      const editor = document.querySelector("textarea")!;
      return { pageWidth: document.documentElement.scrollWidth, width: innerWidth, editorHeight: editor.getBoundingClientRect().height,
        targets: [...document.querySelectorAll('button[aria-label="Choose image"],button[aria-label="Send message"]')].map((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })) };
    });
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.editorHeight).toBeLessThanOrEqual(129);
    for (const target of geometry.targets) { expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44); }
    await page.screenshot({ path: test.info().outputPath(`circle-chat-${width}.png`), fullPage: true });
  });
}

test("preserves a timed-out send across collapse and opens images inside the app", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  await mount(page);
  await page.evaluate(() => { (window as unknown as { chatFixture: { failNext: boolean } }).chatFixture.failNext = true; });
  await page.getByRole("textbox", { name: "Message" }).fill("Hello friends");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Delivery is unconfirmed/)).toBeVisible();
  await page.getByRole("button", { name: /Circle chat/ }).click();
  await page.getByRole("button", { name: /Circle chat/ }).click();
  await page.getByRole("button", { name: "Retry message" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  const sends = await page.evaluate(() => (window as unknown as { chatFixture: { sends: unknown[] } }).chatFixture.sends);
  expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]);
  await expect(page.getByRole("button", { name: "View image", exact: true })).toHaveCount(0);
  await page.locator("[data-circle-chat-image]").scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Open shared image" })).toBeVisible();
  await page.getByRole("button", { name: "Open shared image" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const closeButton = page.getByRole("button", { name: "Close", exact: true });
  // Measure the final hit area after the dialog's opening scale animation.
  await expect.poll(async () => (await closeButton.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  await expect.poll(async () => (await closeButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(393);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

for (const width of [320, 393, 1440]) {
  test(`circle workspace preserves drafts across members and blocks reads in the viewer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 852 });
    await mount(page, false, true);
    await expect(page.getByRole("button", { name: "Open shared image" })).toBeVisible();
    await expect(page.getByLabel("Seen by everyone")).toBeVisible();
    fs.writeFileSync(test.info().outputPath(`circle-geometry-${width}.json`), JSON.stringify(await page.evaluate(() => {
      const tab = document.querySelector('[role="tab"][data-state="active"]')!;
      const style = getComputedStyle(tab);
      return { tab: { className: tab.className, background: style.background, color: style.color, border: style.border, width: tab.getBoundingClientRect().width },
        heading: getComputedStyle(document.querySelector("h1")!).fontSize,
        pageWidth: document.documentElement.scrollWidth, viewport: innerWidth };
    }), null, 2));
    await page.getByRole("textbox", { name: "Message" }).fill("Draft survives members navigation");
    await page.getByRole("tab", { name: "Members", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.getByRole("heading", { name: "Business Circle", exact: true }).click();
    await page.mouse.move(0, 0);
    await page.getByRole("tab", { name: "Members", exact: true }).evaluate((tab) => (tab as HTMLElement).blur());
    await page.screenshot({ path: test.info().outputPath(`circle-members-${width}.png`), animations: "disabled" });
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Draft survives members navigation");
    await page.getByRole("textbox", { name: "Message" }).fill("");
    await expect(page.getByRole("button", { name: "Open shared image" })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: "meetup.webp", mimeType: "image/webp", buffer: fs.readFileSync(path.join(process.cwd(), "public/one-location/onboarding/orbit-office.webp")) });
    await expect(page.getByRole("img", { name: "Image ready to send" })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.getByRole("heading", { name: "Business Circle", exact: true }).click();
    await page.getByRole("tab", { name: "Chat", exact: true }).evaluate((tab) => (tab as HTMLElement).blur());
    await page.locator("[data-app-scroll-root]").evaluate((root) => { root.scrollTop = 0; });
    await expect(page.getByRole("button", { name: "Open shared image" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`circle-workspace-${width}.png`), animations: "disabled" });
    await page.getByRole("button", { name: "View circle members" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`circle-workspace-composer-${width}.png`), animations: "disabled" });
    await page.getByRole("button", { name: "Remove attached image" }).click();
    await expect(page.getByRole("img", { name: "Image ready to send" })).toHaveCount(0);
    await page.getByRole("button", { name: "Change circle photo" }).click();
    await expect(page.getByRole("dialog", { name: "Circle photo" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Circle photo" })).not.toBeVisible();
    await page.locator("[data-circle-chat-image]").scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Open shared image" })).toBeVisible();
    await page.getByRole("button", { name: "Open shared image" }).click();
    await expect(page.getByRole("dialog", { name: "Shared image" })).toBeVisible();
    const before = await page.evaluate(() => (window as any).chatFixture.read.length);
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
    expect(await page.evaluate(() => (window as any).chatFixture.read.length)).toBe(before);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.getByRole("button", { name: "Change circle photo" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose photo", exact: true }).click();
    await (await chooser).setFiles(path.join(process.cwd(), "public/one-location/onboarding/orbit-office.webp"));
    await expect(page.getByRole("button", { name: "Save photo", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Save photo", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Circle photo" })).not.toBeVisible();
    await page.getByRole("button", { name: "Change circle photo" }).click();
    await page.getByRole("button", { name: "Remove photo", exact: true }).click();
    await page.getByRole("button", { name: "Save photo", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Circle photo" })).not.toBeVisible();
  });
}

test("shows a sent photo immediately through slow preparation and upload without downloading it again", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await mount(page, false, true);
  await expect(page.getByRole("button", { name: "Open shared image" })).toBeVisible();
  await page.evaluate(() => Object.assign((window as any).chatFixture, { prepareDelayMs: 1500, sendDelayMs: 1500 }));
  await page.locator('input[type="file"]').setInputFiles({ name: "meetup.webp", mimeType: "image/webp", buffer: fs.readFileSync(path.join(process.cwd(), "public/one-location/onboarding/orbit-office.webp")) });
  await expect(page.getByRole("img", { name: "Image ready to send" })).toBeVisible();
  const started = Date.now();
  await page.getByRole("button", { name: "Send message" }).click();
  const pending = page.locator('[data-chat-message]').filter({ has: page.getByText("Sending…", { exact: true }) });
  await expect(pending.getByRole("img", { name: "Image shared in circle" })).toBeVisible({ timeout: 1000 });
  expect(Date.now() - started).toBeLessThan(1500);
  const source = await pending.getByRole("img").getAttribute("src");
  expect(source).toMatch(/^blob:/);
  const ready = await page.evaluate(() => (window as any).chatFixture.sends.length);
  expect(ready).toBe(0);
  await pending.getByRole("button", { name: "Open shared image" }).click();
  await expect(page.getByRole("dialog", { name: "Shared image" })).toBeVisible();
  await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0, { timeout: 6000 });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const sentId = await page.locator('[data-chat-message]').last().getAttribute("data-chat-message");
  expect(await page.evaluate(() => (window as any).chatFixture.imageMessageIds)).not.toContain(sentId);
  expect(await page.getByRole("img", { name: "Image shared in circle" }).last().getAttribute("src")).toBe(source);
});

test("incoming messages preserve reading position and your reply returns to the latest message", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 }); await mount(page);
  const list = page.getByLabel("Circle messages", { exact: true });
  // The initial history load pins the transcript on a frame. Wait until its
  // readable-bottom receipt confirms that setup before simulating a scroll.
  await expect.poll(() => page.evaluate(() => (window as any).chatFixture.read.includes(45))).toBe(true);
  await list.evaluate((node) => { node.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Go to latest messages" })).toBeVisible();
  const jump = await page.getByRole("button", { name: "Go to latest messages" }).boundingBox();
  const pane = await list.boundingBox();
  expect(Math.abs((jump!.x + jump!.width / 2) - (pane!.x + pane!.width / 2))).toBeLessThanOrEqual(1);

  const before = await list.evaluate((node) => node.scrollTop);
  await page.evaluate(() => (window as any).chatFixture.incoming());
  await expect(page.getByText("Incoming while reading history", { exact: true })).toHaveCount(1);
  expect(Math.abs(await list.evaluate((node) => node.scrollTop) - before)).toBeLessThan(3);
  await page.getByRole("textbox", { name: "Message" }).fill("My reply from history");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await expect.poll(() => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(8);
});

test("the native keyboard reveal keeps an image caption and send control above the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await mount(page, false, true);
  await page.locator('input[type="file"]').setInputFiles({ name: "caption.webp", mimeType: "image/webp", buffer: fs.readFileSync(path.join(process.cwd(), "public/one-location/onboarding/orbit-office.webp")) });
  const editor = page.getByRole("textbox", { name: "Message" });
  await editor.fill("A multiline image caption\n".repeat(20));
  await page.evaluate(() => { document.documentElement.classList.add("kb-open", "native-keyboard-inset"); document.documentElement.style.setProperty("--kb-height", "300px"); });
  // The shared KeyboardInsetManager calls this after publishing its inset.
  await editor.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
  const send = page.getByRole("button", { name: "Send message" });
  await expect.poll(async () => { const box = (await send.boundingBox())!; return box.y + box.height; }).toBeLessThanOrEqual(269);
  await expect(send).toBeEnabled();
  await expect(page.getByRole("img", { name: "Image ready to send" })).toHaveCount(1);
  expect((await page.getByRole("img", { name: "Image ready to send" }).boundingBox())!.y).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
  await page.screenshot({ path: test.info().outputPath("circle-caption-keyboard.png"), animations: "disabled" });
});

for (const width of [320, 393, 1440]) {
  test(`Circle Messages list heading matches People sizing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("http://localhost/circle-list-fixture*", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.goto("http://localhost/circle-list-fixture?lane=1&list=1");
    await page.addScriptTag({ content: script });
    await awaitProductFont(page);
    const heading = page.getByRole("heading", { name: "Messages", exact: true });
    await expect(heading).toBeVisible();
    const geometry = await heading.evaluate(el => {
      const style = getComputedStyle(el);
      const headerElement = el.closest("header")!;
      const header = headerElement.getBoundingClientRect();
      const title = el.getBoundingClientRect();
      const action = headerElement.querySelector("a")!.getBoundingClientRect();
      return { fontSize: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight,
        headerHeight: header.height, titleLeft: title.left - header.left,
        titleRight: title.right, actionLeft: action.left, actionRight: action.right,
        titleBottom: title.bottom, actionTop: action.top,
        viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
        listHeight: el.closest("aside")!.getBoundingClientRect().height,
        paneHeight: el.closest("[data-circle-messages-pane]")!.getBoundingClientRect().height,
        threadHeight: el.closest("[data-circle-messages-pane]")!.querySelector(":scope > section")!.getBoundingClientRect().height };
    });
    expect(geometry.fontSize).toBe("20px");
    expect(geometry.lineHeight).toBe("24px");
    expect(geometry.weight).toBe("600");
    expect(geometry.headerHeight).toBe(width < 380 ? 120 : 68);
    if (width >= 768) {
      // Both split panes reserve the centered dock; phone lists fill their pane.
      expect(Math.abs(geometry.listHeight - geometry.threadHeight)).toBeLessThanOrEqual(1);
      expect(geometry.listHeight).toBeGreaterThan(0);
      expect(geometry.listHeight).toBeLessThan(geometry.paneHeight);
    } else {
      expect(Math.abs(geometry.listHeight - geometry.paneHeight)).toBeLessThanOrEqual(1);
    }
    expect(geometry.titleLeft).toBeGreaterThanOrEqual(18 + 44);
    if (width < 380) expect(geometry.actionTop).toBeGreaterThanOrEqual(geometry.titleBottom);
    else expect(geometry.titleRight).toBeLessThanOrEqual(geometry.actionLeft);
    expect(geometry.actionRight).toBeLessThanOrEqual(width);
    expect(geometry.pageWidth).toBeLessThanOrEqual(width + 1);
    const search = page.getByRole("searchbox", { name: "Search circles" });
    await expect(search).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh circles" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch theme" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit circles" })).toHaveAttribute("href", "/one/connect?tab=circles");
    await expect(page.getByRole("link", { name: "Create circle" })).toHaveAttribute("href", "/one/connect?tab=circles&action=create-circle");
    await expect(search).toHaveAttribute("placeholder", "Search circles");
    const band = await search.evaluate(el => {
      const field = el.closest("label")!.getBoundingClientRect();
      const list = el.closest("aside")!.getBoundingClientRect();
      const header = el.closest("aside")!.querySelector("header")!.getBoundingClientRect();
      return { left: field.left - list.left, right: list.right - field.right,
        height: field.height, gap: field.top - header.bottom, fontWeight: getComputedStyle(el).fontWeight };
    });
    expect(band.left).toBe(16);
    expect(band.right).toBeGreaterThanOrEqual(16);
    expect(band.right).toBeLessThanOrEqual(17);
    expect(band.height).toBe(42);
    expect(band.gap).toBe(4);
    expect(band.fontWeight).toBe("400");
    await expect(page.getByRole("button", { name: "Weekend friends 2 members" })).toBeVisible();
    await search.fill("unmatched");
    await expect(page.getByText("No matching circles")).toBeVisible();
    await expect(page.getByRole("button", { name: "Weekend friends 2 members" })).toHaveCount(0);
    await search.fill("weekend");
    await expect(page.getByRole("button", { name: "Weekend friends 2 members" })).toBeVisible();
    await search.fill("");
    await search.blur();
    await heading.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`circle-list-heading-${width}.png`) });
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(page).toHaveURL("http://localhost/one");
  });
}
