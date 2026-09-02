#!/usr/bin/env node
/**
 * Reviewer rehearsal for the Wallet plane: /one/wallet surface + Agent
 * One chat permutations. Composes the shared harness; adds only domain
 * assertions. Mutation-authorized (adds and removes audit cards on the shared
 * reviewer fixture, then cleans up), so it requires
 * REVIEWER_ALLOW_SHARED_MUTATIONS=true. Never screenshots or logs a revealed
 * card; assertions on secrets happen in-page and report booleans only.
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
const turnTimeoutMs = Number(process.env.REVIEWER_TURN_TIMEOUT_MS || 180_000);
const runTag = `Audit ${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
const reportPath = path.join(repoRoot, "tmp", "reviewer-wallet-report.json");

// Public test numbers only (Luhn-valid, non-chargeable).
const VISA = { nickname: `${runTag} Visa`, pan: "4111111111111111", last4: "1111", cvv: "123", pin: "1234", expiry: "04/30", region: "US" };
const MC = { nickname: `${runTag} MC`, pan: "5555555555554444", last4: "4444", cvv: "321", pin: "", expiry: "05/31", region: "IN" };
const RUPAY = "6521111111111114";
const FORBIDDEN_LEAKS = ["one_adk_sessions", "DB operation failed", "[SQL:", "psycopg2", "payload_ciphertext"];

if (process.env.REVIEWER_ALLOW_SHARED_MUTATIONS !== "true") {
  throw new Error("Payment cards rehearsal adds and removes cards on the shared reviewer fixture. Set REVIEWER_ALLOW_SHARED_MUTATIONS=true only with explicit mutation authority.");
}

const results = [];
function record(name, ok, detail = {}) {
  results.push({ name, ok, ...detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail.note ? ` - ${detail.note}` : ""}\n`);
}
async function step(name, fn) {
  try {
    const detail = (await fn()) || {};
    record(name, true, detail);
    return true;
  } catch (error) {
    record(name, false, { note: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function luhnFix(base) {
  const luhn = (s) => { let sum = 0, dbl = false; for (let i = s.length - 1; i >= 0; i -= 1) { let v = s.charCodeAt(i) - 48; if (dbl) { v *= 2; if (v > 9) v -= 9; } sum += v; dbl = !dbl; } return sum % 10 === 0; };
  for (let d = 0; d <= 9; d += 1) { const c = base.slice(0, -1) + d; if (luhn(c)) return c; }
  throw new Error("unreachable");
}

function attachNetworkLog(page) {
  const log = [];
  const chatTools = [];
  page.on("request", (request) => {
    // Evidence for chat parity: which client tools the app offered the model.
    if (new URL(request.url()).pathname !== "/api/one/agent-chat" || request.method() !== "POST") return;
    try {
      const body = JSON.parse(request.postData() || "{}");
      const names = (body.tools || []).map((tool) => tool?.name).filter(Boolean);
      chatTools.push({ at: Date.now(), tools: names, available: body?.screenContext?.screen_metadata?.available_action_ids || body?.screen_context?.available_action_ids || null });
    } catch { /* not JSON */ }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const entry = { method: response.request().method(), path: url.pathname, status: response.status(), at: Date.now(), body: null };
    log.push(entry);
    // Keep the machine-readable failure detail (code/reason) for non-2xx
    // first-party responses; these are validator codes, never card data.
    if (response.status() >= 400 && response.status() !== 404) {
      response.text().then((text) => { entry.body = text.slice(0, 600); }).catch(() => undefined);
    }
  });
  return {
    since(ts, pathPrefix) { return log.filter((e) => e.at >= ts && e.path.startsWith(pathPrefix)); },
    all() { return log; },
    lastChatTools() { return chatTools.at(-1) || null; },
  };
}

async function fillAddForm(scope, card) {
  const form = scope.getByTestId("secure-card-add-form");
  await form.waitFor({ state: "visible", timeout: 30_000 });
  await form.locator("#card-nickname").fill(card.nickname);
  await form.locator("#card-holder").fill("Reviewer Fixture");
  await form.locator("#card-number").fill(card.pan);
  await form.locator("#card-expiry").fill(card.expiry);
  await form.locator("#card-cvv").fill(card.cvv);
  if (card.pin) await form.locator("#card-pin").fill(card.pin);
  await form.locator("#card-region").selectOption(card.region);
}

async function cardRows(page) {
  return page.locator('[data-testid="one-wallet-list"] li').allInnerTexts().catch(() => []);
}

/** Chat steps must run on /agent; a navigation action in an earlier turn may have moved the page. */
async function ensureOnAgent(page) {
  const pathname = await page.evaluate(() => window.location.pathname);
  if (pathname === "/agent") return;
  await reviewer.navigateInApp(page, "/agent");
}

async function sendPrompt(page, text) {
  await ensureOnAgent(page);
  const composer = page.getByTestId("agent-chat-composer-textarea");
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  const baselineAssistant = await page.locator('[data-message-role="assistant"]').count();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  return baselineAssistant;
}

/** Confirm any pending directive cards (Authorize, then the action label) until none remain or the deadline passes. */
/**
 * Confirm any staged directive cards (Authorize, then the action label). A parked
 * action that owes no confirmation runs on its own, so once the assistant has
 * settled and no card has appeared for a short quiet window, return.
 */
async function confirmDirectives(page, { expectDirective, deadlineMs }) {
  const deadline = Date.now() + deadlineMs;
  let clicks = 0;
  let quietTicks = 0;
  while (Date.now() < deadline) {
    const confirm = page.getByTestId("specialist-directive-confirm").first();
    if (await confirm.isVisible().catch(() => false)) {
      quietTicks = 0;
      const label = (await confirm.innerText().catch(() => "")).trim();
      if (label !== "Working…") {
        await confirm.click({ noWaitAfter: true }).catch(() => undefined);
        clicks += 1;
      }
      await page.waitForTimeout(600);
      continue;
    }
    const streaming = await page.locator('[data-message-status="streaming"]').count();
    if (streaming === 0) {
      quietTicks += 1;
      if (quietTicks >= (expectDirective ? 8 : 3)) return clicks;
    } else {
      quietTicks = 0;
    }
    await page.waitForTimeout(400);
  }
  return clicks;
}

/**
 * Reveal is confirm_required: One first asks in words, then the browser stages a
 * confirmation card. Answer yes once if no widget appeared, then confirm the card.
 */
async function revealFlow(page, prompt, pan) {
  const grouped = pan.replace(/(.{4})/g, "$1 ").trim();
  const widgetShowing = () => page.evaluate((g) => [...document.querySelectorAll('[data-testid="secure-card-reveal"]')].some((el) => (el.textContent || "").includes(g)), grouped);
  let baseline = await sendPrompt(page, prompt);
  await confirmDirectives(page, { expectDirective: true, deadlineMs: turnTimeoutMs });
  await waitForAssistantSettled(page, baseline);
  if (await widgetShowing()) return;
  baseline = await sendPrompt(page, "Yes, reveal it.");
  await confirmDirectives(page, { expectDirective: true, deadlineMs: turnTimeoutMs });
  const waitForWidget = (timeout) => page.waitForFunction((g) => [...document.querySelectorAll('[data-testid="secure-card-reveal"]')].some((el) => (el.textContent || "").includes(g)), grouped, { timeout });
  try {
    await waitForWidget(60_000);
  } catch {
    // The model occasionally answers in words without offering the reveal
    // action. A person would ask once more; do the same, bounded to one retry,
    // and let the second attempt carry the full turn deadline.
    baseline = await sendPrompt(page, prompt);
    await confirmDirectives(page, { expectDirective: true, deadlineMs: turnTimeoutMs });
    await waitForWidget(turnTimeoutMs);
  }
  await waitForAssistantSettled(page, baseline).catch(() => undefined);
}

async function waitForAssistantSettled(page, baselineAssistant, extraMs = 0) {
  await page.waitForFunction(
    ({ baselineCount }) => {
      const turns = [...document.querySelectorAll('[data-message-role="assistant"]')];
      const latest = turns.at(-1);
      return turns.length > baselineCount && latest?.getAttribute("data-message-status") !== "streaming" && Boolean(latest?.textContent?.trim());
    },
    { baselineCount: baselineAssistant },
    { timeout: turnTimeoutMs + extraMs },
  );
  return page.locator('[data-message-role="assistant"]').last().innerText();
}

async function bodyHas(page, needle) {
  return page.evaluate((n) => document.body.innerText.includes(n), needle);
}

const preflight = await prepareReviewerRehearsal({ repoRoot, appOrigin });
const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const browser = await reviewer.chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "0" });
let session;
let ownerToken = "";
let baselineConversationIds = new Set();

async function conversationIds(token) {
  const response = await fetch(`${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(reviewer.reviewerUid)}?limit=20`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!response.ok) return new Set();
  const payload = await response.json();
  return new Set((payload.conversations || []).map((item) => String(item.id)));
}

/** Remove every leftover "Audit " card; each delete is a slow encrypted commit, so wait for the row count to drop. */
async function removeAuditCards(page) {
  const auditRows = () => page.locator('[data-testid="one-wallet-list"] li').filter({ hasText: "Audit " });
  for (let i = 0; i < 12; i += 1) {
    const before = await auditRows().count();
    if (before === 0) return;
    const remove = auditRows().first().getByRole("button", { name: "Remove" });
    await remove.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => {
      const li = [...document.querySelectorAll('[data-testid="one-wallet-list"] li')].find((el) => (el.textContent || "").includes("Audit "));
      const button = [...(li?.querySelectorAll("button") || [])].find((b) => (b.textContent || "").trim() === "Remove");
      return button instanceof HTMLButtonElement && !button.disabled;
    }, {}, { timeout: 30_000 });
    await remove.click({ noWaitAfter: true });
    await page.waitForFunction((expected) => {
      const rows = [...document.querySelectorAll('[data-testid="one-wallet-list"] li')].filter((el) => (el.textContent || "").includes("Audit "));
      return rows.length < expected;
    }, before, { timeout: 90_000 });
  }
  throw new Error("could not remove every audit card");
}

try {
  // ── Boundary 1: cold entry visibly hard-gates on the vault ──────────────
  await step("cold entry to /one/wallet shows the vault challenge first", async () => {
    await reviewer.assertVisibleVaultChallenge(browser, "/one/wallet");
  });

  // ── Surface: /one/wallet ────────────────────────────────────────────────
  session = await reviewer.openSession(browser, "/one/wallet");
  const { page } = session;
  const net = attachNetworkLog(page);
  ownerToken = await session.capture.ownerToken().catch(() => "");
  if (ownerToken) baselineConversationIds = await conversationIds(ownerToken);

  await step("/one/wallet renders its native beacon in a valid data state", async () => {
    // The beacon is an aria-hidden, zero-size marker: wait for it to be
    // attached (never "visible") and read its settled data state.
    await page.getByTestId("native-route-one-wallet").waitFor({ state: "attached", timeout: 60_000 });
    await page.getByTestId("one-wallet-workspace").waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="native-route-one-wallet"]');
      const state = el?.getAttribute("data-native-data-state");
      return state && !["booting", "loading"].includes(state);
    }, {}, { timeout: 60_000 });
    const state = await page.evaluate(() => document.querySelector('[data-testid="native-route-one-wallet"]')?.getAttribute("data-native-data-state"));
    if (!["loaded", "empty-valid"].includes(state)) throw new Error(`unexpected data state ${state}`);
    return { note: `data_state=${state}` };
  });

  await step("leftover audit cards from earlier runs are removed", async () => {
    await removeAuditCards(page);
  });

  await step("form rejects a region-locked brand outside its market without any network call", async () => {
    const addButton = page.getByTestId("one-wallet-add");
    if (await addButton.isVisible().catch(() => false)) await addButton.click();
    else await page.getByRole("button", { name: /add a card/i }).click();
    const before = Date.now();
    await fillAddForm(page, { ...VISA, pan: luhnFix(RUPAY), region: "US", nickname: `${runTag} bad` });
    await page.getByTestId("secure-card-save").click();
    await page.getByTestId("secure-card-errors").waitFor({ state: "visible", timeout: 10_000 });
    const errors = await page.getByTestId("secure-card-errors").innerText();
    if (!/not issued in the selected region/i.test(errors)) throw new Error(`unexpected error copy: ${errors}`);
    if (net.since(before, "/api/pkm/store-domain").length) throw new Error("store-domain was called for an invalid card");
    return { note: "brand_region_mismatch surfaced client-side" };
  });

  await step("form rejects a checksum failure client-side", async () => {
    await page.locator("#card-number").fill("4111111111111112");
    await page.locator("#card-region").selectOption("US");
    await page.getByTestId("secure-card-save").click();
    const errors = await page.getByTestId("secure-card-errors").innerText();
    if (!/checksum/i.test(errors)) throw new Error(`unexpected error copy: ${errors}`);
  });

  let visaSaved = false;
  visaSaved = await step("adding a valid Visa persists through /api/pkm/store-domain with HTTP 200", async () => {
    const before = Date.now();
    await fillAddForm(page, VISA);
    await page.getByTestId("secure-card-save").click();
    await page.waitForFunction((nickname) => document.body.innerText.includes(nickname) && !document.querySelector('[data-testid="secure-card-add-form"]'), VISA.nickname, { timeout: 90_000 });
    await page.waitForTimeout(500);
    const stores = net.since(before, "/api/pkm/store-domain");
    const statuses = stores.map((s) => s.status);
    if (!statuses.includes(200)) throw new Error(`store-domain statuses: ${JSON.stringify(stores.map(({ status, body }) => ({ status, body })))}`);
    const rows = await cardRows(page);
    if (!rows.some((r) => r.includes("····1111") && r.includes(VISA.nickname))) throw new Error(`card row missing: ${JSON.stringify(rows)}`);
    return { note: `store-domain ${statuses.join(",")}` };
  });

  await step("reveal decrypts on-device, shows PAN/CVV/PIN, and hides again", async () => {
    await page.getByTestId("one-wallet-reveal-1111").click();
    const reveal = page.getByTestId("secure-card-reveal");
    await reveal.waitFor({ state: "visible", timeout: 30_000 });
    const ok = await page.evaluate(({ pan, cvv, pin }) => {
      const text = document.querySelector('[data-testid="secure-card-reveal"]')?.textContent || "";
      const grouped = pan.replace(/(.{4})/g, "$1 ").trim();
      return text.includes(grouped) && text.includes(`CVV ${cvv}`) && text.includes(`PIN ${pin}`);
    }, { pan: VISA.pan, cvv: VISA.cvv, pin: VISA.pin });
    if (!ok) throw new Error("reveal widget did not show the expected values");
    await page.getByTestId("secure-card-hide").click();
    // On the page, Hide returns straight to the list (no interstitial).
    await page.getByTestId("secure-card-reveal").waitFor({ state: "detached", timeout: 10_000 });
    await page.getByTestId("one-wallet-list").waitFor({ state: "visible", timeout: 10_000 });
    const stillVisible = await page.evaluate((pan) => document.body.innerText.includes(pan.replace(/(.{4})/g, "$1 ").trim()), VISA.pan);
    if (stillVisible) throw new Error("PAN still visible after hide");
  });

  await step("owner token never reads plaintext: server domain read returns ciphertext only", async () => {
    const payload = await reviewer.fetchOwnerJson(`/api/pkm/domain-data/${encodeURIComponent(reviewer.reviewerUid)}/wallet`, ownerToken, { allow404: true });
    const raw = JSON.stringify(payload || {});
    if (raw.includes(VISA.pan) || raw.includes(VISA.cvv + "\"") || raw.includes("\"pan\"")) throw new Error("server payload exposes plaintext card data");
    if (!raw.includes("ciphertext")) throw new Error("server payload has no ciphertext envelope");
  });

  // ── Chat permutations (same session, Next client navigation) ───────────
  await reviewer.navigateInApp(page, "/agent");
  await step("same-session navigation to /agent keeps the vault unlocked", async () => {
    await reviewer.assertVaultContinuity(page, "/agent");
  });

  await step("chat: 'what cards do I have' returns metadata (last4) and never the PAN", async () => {
    const baseline = await sendPrompt(page, "What cards do I have saved?");
    const clicks = await confirmDirectives(page, { expectDirective: true, deadlineMs: turnTimeoutMs });
    const reply = await waitForAssistantSettled(page, baseline);
    const offered = net.lastChatTools();
    const evidence = `directive_clicks=${clicks} client_tools=${JSON.stringify(offered?.tools || [])} available=${JSON.stringify(offered?.available || null)}`;
    const leaked = await bodyHas(page, VISA.pan);
    if (leaked) throw new Error("full PAN appeared in the chat surface");
    if (!/1111/.test(reply) && !(await bodyHas(page, "1111"))) throw new Error(`reply lacks last4 (${evidence}): ${reply.slice(0, 160)}`);
    return { note: evidence };
  });

  await step("chat: 'add a card' opens the secure form and saves through store-domain 200", async () => {
    const before = Date.now();
    const baseline = await sendPrompt(page, "Add a new card to my vault");
    await confirmDirectives(page, { expectDirective: true, deadlineMs: turnTimeoutMs });
    await page.getByTestId("secure-card-add-form").waitFor({ state: "visible", timeout: turnTimeoutMs });
    await fillAddForm(page, MC);
    await page.getByTestId("secure-card-save").click();
    await page.waitForFunction((nickname) => document.body.innerText.includes(`Saved card "${nickname}"`), MC.nickname, { timeout: 90_000 });
    const statuses = net.since(before, "/api/pkm/store-domain").map((s) => s.status);
    if (!statuses.includes(200)) throw new Error(`store-domain statuses: ${statuses.join(",")}`);
    void baseline;
    return { note: `store-domain ${statuses.join(",")}` };
  });

  await step("chat: reveal by last4 renders the secure widget; the model never speaks the PAN", async () => {
    await revealFlow(page, `Show me the full details of my card ending ${MC.last4}`, MC.pan);
    const assistantTexts = await page.locator('[data-message-role="assistant"]').allInnerTexts();
    if (assistantTexts.some((t) => t.includes(MC.pan) || t.includes(MC.cvv))) throw new Error("assistant text contained card secrets");
  });

  await step("chat: reveal by nickname resolves the right card", async () => {
    await revealFlow(page, `Reveal my "${VISA.nickname}" card`, VISA.pan);
  });

  await step("chat: reveal of an unknown card fails closed without a widget", async () => {
    const widgetsBefore = await page.locator('[data-testid="secure-card-reveal"]').count();
    const baseline = await sendPrompt(page, "Show me my card ending 9999");
    await confirmDirectives(page, { expectDirective: false, deadlineMs: turnTimeoutMs });
    const reply = await waitForAssistantSettled(page, baseline);
    const widgetsAfter = await page.locator('[data-testid="secure-card-reveal"]').count();
    if (widgetsAfter > widgetsBefore) throw new Error("a reveal widget opened for a nonexistent card");
    return { note: reply.slice(0, 120).replace(/\s+/g, " ") };
  });

  await step("paste guard (prompt path): a pasted PAN never reaches /api/one/agent-chat", async () => {
    const before = Date.now();
    await sendPrompt(page, `save this card please 4111 1111 1111 1111 exp 04/30`);
    await page.waitForFunction(() => document.body.innerText.includes("blocked on this device"), {}, { timeout: 30_000 });
    await page.waitForTimeout(1_500);
    // Only a model turn counts (POST to the chat endpoint itself); history refreshes are GETs.
    const chatCalls = net.since(before, "/api/one/agent-chat").filter((e) => e.method === "POST" && e.path === "/api/one/agent-chat");
    if (chatCalls.length) throw new Error(`agent-chat was called: ${JSON.stringify(chatCalls)}`);
    const formVisible = await page.getByTestId("secure-card-add-form").last().isVisible().catch(() => false);
    if (!formVisible) throw new Error("secure add form was not offered after the block");
  });

  await step("no internal runtime error text leaked into the chat surface", async () => {
    for (const needle of FORBIDDEN_LEAKS) if (await bodyHas(page, needle)) throw new Error(`leaked: ${needle}`);
  });

  session.capture.assertNoCriticalApiFailures("wallet cards rehearsal");

  // ── Cold session: re-authenticate, re-unlock, read back ────────────────
  await session.context.close();
  session = null;
  await step("cold session re-unlock reads the cards back from ciphertext", async () => {
    session = await reviewer.openSession(browser, "/one/wallet");
    await session.page.waitForFunction((nick) => document.body.innerText.includes(nick), VISA.nickname, { timeout: 90_000 });
    const rows = await cardRows(session.page);
    const have = rows.filter((r) => r.includes(runTag)).length;
    if (have < 2) throw new Error(`expected 2 audit cards after cold re-unlock, saw ${have}: ${JSON.stringify(rows)}`);
    return { note: `cards_after_cold_reunlock=${have}` };
  });

  await step("list search filters by network and reports no-match, then clears", async () => {
    const search = session.page.getByTestId("one-wallet-search");
    await search.fill("mastercard");
    await session.page.waitForFunction(() => document.querySelectorAll('[data-testid="one-wallet-list"] li').length === 1, {}, { timeout: 15_000 });
    await search.fill("zzzz-no-such-card");
    await session.page.getByTestId("one-wallet-no-match").waitFor({ state: "visible", timeout: 15_000 });
    await search.fill("");
    await session.page.waitForFunction(() => document.querySelectorAll('[data-testid="one-wallet-list"] li').length >= 2, {}, { timeout: 15_000 });
  });

  await step("Memory shows the wallet domain without a manual refresh, and Recently learned opens its own route", async () => {
    // The cards were written on /one/wallet while /one/pkm was unmounted: the
    // epoch-seeded revision must force a fresh metadata read on mount.
    // In-app navigation only: a document load would drop the memory-only vault
    // key and reset the epoch, proving nothing about same-session freshness.
    await reviewer.navigateInApp(session.page, "/one/pkm");
    await session.page.getByTestId("memory-category-wallet").waitFor({ state: "visible", timeout: 30_000 });
    await session.page.getByTestId("memory-recently-learned-row").click();
    await session.page.waitForURL("**/one/pkm/recent", { timeout: 15_000 });
    await session.page.getByTestId("memory-recent-list").waitFor({ state: "visible", timeout: 30_000 });
    const pageText = await session.page.locator("body").innerText();
    if (/\b4111\s?1111\s?1111\s?1111\b/.test(pageText)) throw new Error("PAN rendered in Memory");
    await reviewer.navigateInApp(session.page, "/one/wallet");
    await session.page.getByTestId("one-wallet-list").waitFor({ state: "visible", timeout: 30_000 });
  });

  await step("remove cleans up every audit card", async () => {
    await removeAuditCards(session.page);
    const rows = await cardRows(session.page);
    if (rows.some((r) => r.includes(runTag))) throw new Error("audit cards remain");
  });
} finally {
  if (ownerToken) {
    const currentIds = await conversationIds(ownerToken).catch(() => new Set());
    await Promise.all([...currentIds].filter((id) => !baselineConversationIds.has(id)).map((id) => fetch(`${appOrigin}/api/one/agent-chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}`, Accept: "application/json" } }).catch(() => undefined)));
  }
  await session?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ origin: appOrigin, mutation_policy: preflight.mutationPolicy, run_tag: runTag, results }, null, 2), { mode: 0o600 });
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`[reviewer-app-testing] wallet ${failed.length === 0 ? "PASS" : "FAIL"} steps=${results.length} failed=${failed.length} report=${path.relative(repoRoot, reportPath)}\n`);
  if (failed.length) process.exitCode = 1;
}
