#!/usr/bin/env node
/**
 * Large pasted recap → Memory review, on localhost. Pastes a synthetic multi-section
 * recap (fixture, fictional data) into Agent chat, takes the "Review for Memory"
 * lane, and asserts the review is grouped by destination with per-item keep/skip,
 * that the secret-looking lines were excluded with a pointer to the secure form,
 * and that nothing is written: the review is skipped, never saved, so the shared
 * reviewer vault is left untouched.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(process.env.REVIEWER_APP_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);
const importTimeoutMs = Number(process.env.REVIEWER_IMPORT_TIMEOUT_MS || 420_000);
const reportPath = path.join(repoRoot, "tmp", "reviewer-memory-import-report.json");
const fixturePath = path.join(repoRoot, "hushh-webapp/__tests__/fixtures/pkm/synthetic-life-recap.v1.md");

const results = [];
function record(name, ok, detail = {}) {
  results.push({ name, ok, ...detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail.note ? ` - ${detail.note}` : ""}\n`);
}
async function step(name, fn) {
  try {
    const note = await fn();
    record(name, true, note ? { note: String(note) } : {});
  } catch (error) {
    record(name, false, { note: String(error?.message || error).slice(0, 400) });
  }
}

const preflight = await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "0" });
let session;
let ownerToken = "";
let baselineConversationIds = new Set();
const recap = fs.readFileSync(fixturePath, "utf8");

try {
  session = await reviewer.openSession(browser, "/agent");
  const { page } = session;
  ownerToken = await session.capture.ownerToken();
  const conversationIds = async () => {
    const response = await fetch(`${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`, {
      headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
    });
    if (!response.ok) return new Set();
    const payload = await response.json();
    return new Set((payload.conversations || []).map((item) => String(item.id)));
  };
  baselineConversationIds = await conversationIds();

  await step("a long paste switches the composer to the Memory lane", async () => {
    const composer = page.getByTestId("agent-chat-composer-textarea");
    await composer.waitFor({ state: "visible", timeout: 60_000 });
    await composer.focus();
    await page.evaluate((text) => {
      const target = document.querySelector('[data-testid="agent-chat-composer-textarea"]');
      const data = new DataTransfer();
      data.setData("text/plain", text);
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, recap);
    await composer.fill(recap);
    await page.getByTestId("agent-chat-paste-purpose").waitFor({ state: "visible", timeout: 30_000 });
    return `chars=${recap.length}`;
  });

  await step("Review for Memory organizes the recap into grouped, selectable items", async () => {
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByTestId("agent-pkm-review-list").waitFor({ state: "visible", timeout: importTimeoutMs });
    const groups = await page.getByTestId("agent-pkm-review-group").count();
    const cards = await page.getByTestId("agent-pkm-review-card").count();
    const boxes = await page.locator('[data-testid="agent-pkm-review-list"] input[type="checkbox"]').count();
    if (groups < 2) throw new Error(`expected several destination groups, got ${groups}`);
    if (boxes !== cards) throw new Error(`every item must be selectable: ${boxes} boxes for ${cards} items`);
    return `groups=${groups} items=${cards}`;
  });

  await step("secret-looking lines were excluded and the secure form is pointed to", async () => {
    // The import's assistant turn streams activity first; wait for the settled
    // summary sentence before reading it.
    await page.waitForFunction(
      () => {
        const turns = [...document.querySelectorAll('[data-message-role="assistant"]')];
        return turns.some((turn) => (turn.textContent || "").includes("Keep or skip each item"));
      },
      undefined,
      { timeout: 120_000 },
    );
    const text = await page.evaluate(() => {
      const turns = [...document.querySelectorAll('[data-message-role="assistant"]')];
      return turns.map((turn) => turn.textContent || "").find((value) => value.includes("Keep or skip each item")) || "";
    });
    if (!/excluded/i.test(text) || !/Wallet form/i.test(text)) throw new Error(`summary lacks the exclusion note: ${text.slice(0, 240)}`);
    const list = await page.getByTestId("agent-pkm-review-list").innerText();
    if (/4111 1111 1111 1111|hunter2|X12345678/.test(list)) throw new Error("a secret reached the review list");
  });

  await step("skip a group and one item, then discard the review without writing", async () => {
    const groupToggle = page.getByRole("button", { name: /Skip group/ }).first();
    if (await groupToggle.isVisible().catch(() => false)) await groupToggle.click();
    const box = page.locator('[data-testid="agent-pkm-review-list"] input[type="checkbox"]:checked').first();
    if (await box.isVisible().catch(() => false)) await box.click();
    const save = page.getByTestId("agent-pkm-review-save");
    const label = await save.innerText();
    if (!/Save \d+ of \d+/.test(label)) throw new Error(`expected a partial save label, got: ${label}`);
    const storeCalls = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/pkm/store-domain")) storeCalls.push(request.url());
    });
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByTestId("agent-pkm-review-list").waitFor({ state: "detached", timeout: 30_000 });
    if (storeCalls.length) throw new Error("a store-domain write happened on Skip");
    return label;
  });
  session.capture.assertNoCriticalApiFailures("memory import review");
} catch (error) {
  record("rehearsal aborted", false, { note: String(error?.stack || error?.message || error).slice(0, 600) });
} finally {
  if (ownerToken) {
    const response = await fetch(`${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`, {
      headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" },
    }).catch(() => null);
    if (response?.ok) {
      const payload = await response.json().catch(() => ({ conversations: [] }));
      const ids = (payload.conversations || []).map((item) => String(item.id)).filter((id) => !baselineConversationIds.has(id));
      await Promise.all(ids.map((id) => fetch(`${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" } }).catch(() => undefined)));
    }
  }
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const failed = results.filter((r) => !r.ok).length || (results.length === 0 ? 1 : 0);
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), preflight: preflight?.summary ?? null, results }, null, 2));
  process.stdout.write(`[reviewer-app-testing] memory-import ${failed ? "FAIL" : "PASS"} steps=${results.length} failed=${failed} report=${path.relative(repoRoot, reportPath)}\n`);
  process.exitCode = failed ? 1 : 0;
}
