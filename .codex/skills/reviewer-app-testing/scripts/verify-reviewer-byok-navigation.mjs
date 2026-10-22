#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReviewerSessionHarness } from "./reviewer-session-harness.mjs";
import { prepareReviewerRehearsal } from "./reviewer-rehearsal-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const appOrigin = String(
  process.env.REVIEWER_APP_ORIGIN || "https://uat.one.hushh.ai"
).replace(/\/$/, "");
const timeoutMs = Number(process.env.REVIEWER_APP_TIMEOUT_MS || 360_000);
const routes = String(process.env.REVIEWER_APP_ROUTES || "/,/one/kai?tab=portfolio")
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);
const vaultNavigationScenario = process.env.REVIEWER_VAULT_NAVIGATION_SCENARIO === "true";
const feedConnectOnly = process.env.REVIEWER_VAULT_NAVIGATION_SCOPE === "feed_connect";
const diagnostics = [];

if (process.argv.includes("--help")) {
  process.stdout.write(
    [
      "Read-only reviewer BYOK and Next-navigation rehearsal.",
      "",
      "Optional:",
      "  REVIEWER_APP_ORIGIN=https://uat.one.hushh.ai",
      "  REVIEWER_APP_ROUTES=/,/one/kai?tab=portfolio",
      "  REVIEWER_VAULT_NAVIGATION_SCENARIO=true (agent roster, Feed and Connect controls)",
      "  REVIEWER_VAULT_NAVIGATION_SCOPE=feed_connect (separate narrower rehearsal)",
      "  PLAYWRIGHT_HEADLESS=0",
      "",
    ].join("\n")
  );
  process.exit(0);
}

const preflight = await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs,
  configurePage: async (page) => {
    // The binding survives document replacement; retain only explicitly closed
    // metadata fields, never the event object, raw routes, bridge or credentials.
    await page.exposeBinding("__captureVaultDiagnostic", (_source, entry) => {
      const kinds = ["provider_mounted", "provider_disposed", "unlocked", "locked", "state", "prompt_visible"];
      const reasons = ["explicit_or_unspecified", "provider_disposed", "identity_changed", "terminal_auth", "owner_invalid", "lock_requested", "api_validation", "vault_rekeyed"];
      const authority = ["locked", "valid", "renewing", "unavailable", "unknown"];
      if (!entry || !kinds.includes(entry.kind)) return;
      diagnostics.push({
        kind: entry.kind,
        runtime: typeof entry.runtime === "string" && /^[a-f0-9-]{36}$/i.test(entry.runtime) ? entry.runtime : "unknown",
        sequence: Number.isSafeInteger(entry.sequence) ? entry.sequence : 0,
        elapsedMs: Number.isSafeInteger(entry.elapsedMs) ? entry.elapsedMs : 0,
        reason: reasons.includes(entry.reason) ? entry.reason : undefined,
        authority: authority.includes(entry.authority) ? entry.authority : undefined,
        unlocked: typeof entry.unlocked === "boolean" ? entry.unlocked : undefined,
        hadKey: typeof entry.hadKey === "boolean" ? entry.hadKey : undefined,
        surface: ["standard", "hard_gate"].includes(entry.surface) ? entry.surface : undefined,
        navigation: ["navigate", "reload", "back_forward"].includes(entry.navigation) ? entry.navigation : "unknown",
        discarded: entry.discarded === true,
      });
      if (diagnostics.length > 200) diagnostics.shift();
    });
    await page.addInitScript(() => {
      window.addEventListener("hushh-vault-diagnostic", (event) => {
        void window.__captureVaultDiagnostic(event.detail).catch(() => undefined);
      });
    });
  },
});
const browser = await reviewer.chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
});
let firstSession;
let freshSession;
let firstKeyCommitment;
let freshKeyCommitment;
try {
  await reviewer.assertVisibleVaultChallenge(browser, routes[0] || "/");
  firstSession = await reviewer.openSession(browser, routes[0] || "/");
  firstKeyCommitment = reviewer.vaultKeyCommitment(await firstSession.capture.vaultState());
  if (vaultNavigationScenario) {
    const page = firstSession.page;
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const checkTransition = async (label) => {
      await reviewer.assertVaultContinuity(page, label);
      if (await page.evaluate(() => performance.timeOrigin) !== timeOrigin) {
        throw new Error("Vault navigation replaced the browser document.");
      }
      firstSession.readOnlyGuard.assertNoBlockedMutation();
      firstSession.capture.assertNoCriticalApiFailures(label);
      process.stdout.write(`[vault-navigation] PASS step=${label}\n`);
    };
    for (const section of feedConnectOnly ? [] : ["finance", "gmail", "calendar", "wallet", "pkm"]) {
      await reviewer.navigateInApp(page, "/one");
      // The current shell uses the roster. AgentSectionDropdown remains in
      // source for compatibility tests but is not mounted by the application.
      const agent = page.getByTestId(`one-agent-tile-${section}`)
        .or(page.getByTestId(`one-agent-list-row-${section}`)).first();
      const href = await agent.getAttribute("href");
      if (!href?.startsWith("/one/")) throw new Error("Agent roster destination is not an internal One route.");
      const target = new URL(href, appOrigin);
      await agent.click();
      await page.waitForURL((url) => url.pathname === target.pathname && url.search === target.search);
      await checkTransition(section);
    }
    await reviewer.navigateInApp(page, "/one");
    for (const tab of ["Feed", "Connect"]) {
      // Feed's accessible name can include its unread/activity badge.
      // Use the authored navigation identity rather than assuming label-only text.
      const controlId = tab === "Feed" ? "nav-one-feed" : "nav-connect";
      await page.locator(`[data-app-bottom-nav] [data-tour-id="${controlId}"]`).click();
      await page.waitForURL((url) => url.pathname === `/one/${tab.toLowerCase()}`);
      await checkTransition(tab.toLowerCase());
    }
    await reviewer.navigateInApp(page, "/one");
    await checkTransition("return_to_agent");
  }
  for (const route of routes.slice(1)) {
    await reviewer.navigateInApp(firstSession.page, route);
  }
  await firstSession.page.waitForTimeout(1_000);
  await reviewer.assertVaultContinuity(firstSession.page, "same-session route chain");
  firstSession.readOnlyGuard.assertNoBlockedMutation();
  firstSession.capture.assertNoCriticalApiFailures("same-session route chain");
  await firstSession.context.close();
  firstSession = null;

  freshSession = await reviewer.openSession(browser, routes.at(-1) || "/");
  freshKeyCommitment = reviewer.vaultKeyCommitment(await freshSession.capture.vaultState());
  await freshSession.page.waitForTimeout(1_000);
  freshSession.readOnlyGuard.assertNoBlockedMutation();
  freshSession.capture.assertNoCriticalApiFailures("fresh-session re-unlock");
  if (firstKeyCommitment !== freshKeyCommitment) {
    throw new Error("Fresh-session reviewer unlock resolved a different vault key commitment.");
  }
  process.stdout.write(
    `[reviewer-app-testing] PASS visible_vault_challenge=1 same_session_routes=${routes.length} cold_session_reunlock=1 mutation_policy=${preflight.mutationPolicy}\n`
  );
} finally {
  if (firstSession && !firstSession.page.isClosed()) {
    const structure = await firstSession.page.evaluate(() => ({
      bottomNav: Boolean(document.querySelector("[data-app-bottom-nav]")),
      feedControl: Boolean(document.querySelector('[data-tour-id="nav-one-feed"]')),
      connectControl: Boolean(document.querySelector('[data-tour-id="nav-connect"]')),
      vaultSurface: document.documentElement.hasAttribute("data-vault-unlock-active"),
    })).catch(() => ({ unavailable: true }));
    process.stdout.write(`[vault-navigation] final_structure=${JSON.stringify(structure)}\n`);
  }
  process.stdout.write(`[vault-navigation] diagnostics=${JSON.stringify(diagnostics)}\n`);
  await firstSession?.context.close().catch(() => undefined);
  await freshSession?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
