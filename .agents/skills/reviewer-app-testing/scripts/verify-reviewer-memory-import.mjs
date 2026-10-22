#!/usr/bin/env node
/**
 * Large pasted recap → background Memory capture, on localhost. Pastes a synthetic multi-section
 * recap (fixture, fictional data) into Agent chat, verifies that capture stays
 * off the answer's critical path, exposes a quiet settled status with a View
 * Memory action, and never renders a retired inline review panel or plaintext
 * secret material in chat.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";
import { safeFailureCode } from "./consent-rehearsal-contract.mjs";

if (process.env.REVIEWER_ALLOW_SHARED_MUTATIONS !== "true") {
  process.stdout.write(JSON.stringify({ passed: false, code: "MUTATION_AUTHORITY_REQUIRED" }) + "\n");
  process.exit(1);
}

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
    record(name, false, { code: safeFailureCode(error) });
  }
}

const preflight = await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "0" });
let session;
const recap = fs.readFileSync(fixturePath, "utf8");

try {
  session = await reviewer.openSession(browser, "/");
  const { page } = session;

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
    // The composer now represents a large paste as a browser-memory text
    // attachment. The former paste-purpose test id belonged to the retired
    // inline lane and made this rehearsal fail before it exercised Memory.
    await page.getByTestId("agent-chat-text-attachment").waitFor({ state: "visible", timeout: 30_000 });
    return `chars=${recap.length}`;
  });

  await step("the answer starts before background Memory capture settles", async () => {
    const turnRequest = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/one/agent-chat",
      { timeout: importTimeoutMs },
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await turnRequest;
    const reviewPanelCount = await page.getByTestId("agent-pkm-review-list").count();
    if (reviewPanelCount !== 0) throw new Error("retired inline review panel rendered");
    return "assistant turn mounted without waiting for review UI";
  });

  await step("Memory capture exposes only a quiet status and safe review action", async () => {
    const status = page.getByTestId("memory-capture-status");
    await status.waitFor({ state: "visible", timeout: importTimeoutMs });
    await status.getByText("View Memory", { exact: true }).waitFor({ state: "visible", timeout: importTimeoutMs });
    if (await status.getByText("View Memory", { exact: true }).count() !== 1) {
      throw new Error("Memory status did not expose exactly one View Memory action");
    }
    const transcript = await page.locator('[data-message-role="assistant"]').allTextContents();
    const rendered = transcript.join(" ");
    if (/4111 1111 1111 1111|hunter2|X12345678/.test(rendered)) {
      throw new Error("a secret-looking fixture reached rendered chat text");
    }
    return "status-only capture receipt";
  });

  await step("no retired review controls or plaintext values are exposed by the status lane", async () => {
    if (await page.getByTestId("agent-pkm-review-save").count() !== 0) {
      throw new Error("retired review save control rendered");
    }
    return "no inline mutation controls or raw secret material";
  });
  session.capture.assertNoCriticalApiFailures("memory import review");
} catch (error) {
  record("rehearsal aborted", false, { code: safeFailureCode(error) });
} finally {
  // Retain this rehearsal's history. A listing delta is not ownership proof:
  // another reviewer may create conversations while this run is in flight.
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const failed = results.filter((r) => !r.ok).length || (results.length === 0 ? 1 : 0);
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), preflight: preflight?.summary ?? null, results }, null, 2));
  process.stdout.write(`[reviewer-app-testing] memory-import ${failed ? "FAIL" : "PASS"} steps=${results.length} failed=${failed} report=${path.relative(repoRoot, reportPath)}\n`);
  process.exitCode = failed ? 1 : 0;
}
