#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(process.env.REVIEWER_APP_ORIGIN || "http://127.0.0.1:3000").replace(/\/$/, "");
const outputDir = path.resolve(
  process.env.REVIEWER_SCREENSHOT_DIR || path.join(repoRoot, "tmp/agent-one-verification"),
);
const syntheticImport = Array.from(
  { length: 14 },
  (_, index) => `${index + 1}. Example domain ${index + 1}\n- Synthetic fact ${index + 1} for memory review only.`,
).join("\n\n");

await prepareReviewerRehearsal({ repoRoot, appOrigin });
fs.mkdirSync(outputDir, { recursive: true });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin });
const browser = await reviewer.chromium.launch({ headless: true });
let session;

try {
  session = await reviewer.openSession(browser, "/agent");
  const { page } = session;
  const newChat = page.getByRole("button", { name: /New chat/i }).first();
  if (await newChat.isVisible().catch(() => false)) await newChat.click();
  const composer = page.getByTestId("agent-chat-composer-textarea");
  await composer.fill(syntheticImport);
  await composer.evaluate((element, text) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  }, syntheticImport);
  await page.getByTestId("agent-chat-paste-purpose").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: path.join(outputDir, "agent-chat-memory-import-desktop.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(outputDir, "agent-chat-memory-import-mobile.png"),
    fullPage: false,
  });
  process.stdout.write(
    `[reviewer-app-testing] PASS sanitized_screenshots=2 output_dir=${path.relative(repoRoot, outputDir)}\n`,
  );
} finally {
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
