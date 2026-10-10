import { expect, test, type Page } from "@playwright/test";
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
