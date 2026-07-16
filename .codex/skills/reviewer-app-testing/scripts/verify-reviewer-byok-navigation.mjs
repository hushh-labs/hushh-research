#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(
  process.env.REVIEWER_APP_ORIGIN || "https://uat.one.hushh.ai"
).replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);
const routes = String(process.env.REVIEWER_APP_ROUTES || "/agent,/one/kai/portfolio")
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);

if (process.argv.includes("--help")) {
  process.stdout.write(
    [
      "Read-only reviewer BYOK and Next-navigation rehearsal.",
      "",
      "Optional:",
      "  REVIEWER_APP_ORIGIN=https://uat.one.hushh.ai",
      "  REVIEWER_APP_ROUTES=/agent,/one/kai/portfolio",
      "  PLAYWRIGHT_HEADLESS=0",
      "",
    ].join("\n")
  );
  process.exit(0);
}

const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
});
let firstSession;
let freshSession;
let firstKeyCommitment;
let freshKeyCommitment;
try {
  firstSession = await reviewer.openSession(browser, routes[0] || "/agent");
  firstKeyCommitment = reviewer.vaultKeyCommitment(await firstSession.capture.vaultState());
  for (const route of routes.slice(1)) {
    await reviewer.navigateInApp(firstSession.page, route);
  }
  await firstSession.page.waitForTimeout(1_000);
  await reviewer.assertVaultContinuity(firstSession.page, "same-session route chain");
  firstSession.capture.assertNoCriticalApiFailures("same-session route chain");
  await firstSession.context.close();
  firstSession = null;

  freshSession = await reviewer.openSession(browser, routes.at(-1) || "/agent");
  freshKeyCommitment = reviewer.vaultKeyCommitment(await freshSession.capture.vaultState());
  await freshSession.page.waitForTimeout(1_000);
  freshSession.capture.assertNoCriticalApiFailures("fresh-session re-unlock");
  if (firstKeyCommitment !== freshKeyCommitment) {
    throw new Error("Fresh-session reviewer unlock resolved a different vault key commitment.");
  }
  process.stdout.write(
    `[reviewer-app-testing] PASS same_session_routes=${routes.length} cold_session_reunlock=1\n`
  );
} finally {
  await firstSession?.context.close().catch(() => undefined);
  await freshSession?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
