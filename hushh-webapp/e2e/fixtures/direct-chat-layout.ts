import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./product-font";
export let script: string;
let css: string;
export function installDirectChatFixture() {
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
}
export async function mount(page: Page, dark = false, delayInbox = false, inbox = false, command = "idle", options: { modal?: boolean; preview?: boolean; overflowInbox?: boolean } = {}) {
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
export const fixture = (page: Page, code: string) => page.evaluate((value) => { Function("fixture", value)((window as any).directChatFixture); }, code);
export const transcript = (page: Page) => page.getByTestId("direct-message-list");
