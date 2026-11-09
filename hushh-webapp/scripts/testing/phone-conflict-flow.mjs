/** Local fixture only. Production UI/services/policies/SQL; recorded providers.
 * One context at a time; no screenshots, traces, credential or content output. */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = "";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = "/e2e/fixtures/phone-conflict-flow.tsx";
const boundary = path.join(root, "e2e/fixtures/phone-conflict-boundaries.tsx");
const events = [];
let server, browser, context, stage = "start", activeScenario = "start";
const diagnostics = { errors: [], api: [], transfer: {
  get_requests: 0, get_responses: 0, get_failures: 0, confirm_requests: 0, erase_requests: 0,
  click_started: false, click_completed: false,
} };
const transferDebug = diagnostics.transfer_debug = {};
const elapsed = () => Math.round(performance.now());
function clickFailure(error) {
  const message = String(error?.message || "");
  const reasons = [
    ["not_enabled", /element is not enabled|element is disabled/i],
    ["not_visible", /element is not visible/i],
    ["not_stable", /element is not stable/i],
    ["pointer_intercepted", /intercepts pointer events/i],
    ["outside_viewport", /outside of the viewport/i],
    ["target_closed", /page.*closed|context.*closed|target.*closed/i],
  ].filter(([, pattern]) => pattern.test(message)).map(([reason]) => reason);
  const kind = error?.name === "TimeoutError" ? "timeout" : error?.code === "ERR_ASSERTION" ? "assertion" : "other";
  return { kind, reasons };
}
async function buttonState(button) {
  const values = await Promise.allSettled([
    button.count(), button.isVisible(), button.isEnabled({ timeout: 1000 }),
    button.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const tags = ["HTML", "BODY", "DIV", "BUTTON", "SPAN", "OL", "LI", "SECTION", "DIALOG", "IFRAME", "VITE-ERROR-OVERLAY"];
      const roles = ["dialog", "alertdialog", "presentation", "none"];
      const slots = ["dialog-overlay", "dialog-content", "alert-dialog-overlay", "alert-dialog-content", "sheet-overlay", "sheet-content", "toast", "toaster"];
      const role = hit?.getAttribute("role");
      const slot = hit?.getAttribute("data-slot");
      // Only geometry, booleans and fixed enums; never DOM text, classes or URLs.
      return {
        target_receives_pointer: hit === element || element.contains(hit),
        target_pointer_events: getComputedStyle(element).pointerEvents === "none" ? "none" : "other",
        target_box: { x: box.x, y: box.y, width: box.width, height: box.height },
        hit_tag: tags.includes(hit?.tagName) ? hit.tagName : "other",
        hit_role: roles.includes(role) ? role : "other",
        hit_slot: slots.includes(slot) ? slot : "other",
        hit_is_toast: Boolean(hit?.closest("[data-sonner-toaster]")),
        hit_is_dialog: Boolean(hit?.closest('[role="dialog"], [role="alertdialog"]')),
      };
    }, undefined, { timeout: 1000 }),
  ]);
  return Object.fromEntries(["count", "visible", "enabled", "hit_test"].map((key, index) =>
    [key, values[index].status === "fulfilled" ? values[index].value : null]));
}
const isTransferReadback = pathname => /^\/api\/account\/phone\/transfer\/[a-f0-9-]{36}$/.test(pathname);
function safeError(error) {
  return String(error?.message || "unclassified").replace(/fixture\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[fixture-token]")
    .replace(/\+[1-9][0-9]{7,14}/g, "[phone]").slice(0, 700);
}
const record = name => events.push(name);
function requireHandoff(raw, origin) {
  const login = new URL(raw, origin);
  const destination = new URL(login.searchParams.get("redirect") || "/", origin);
  if (login.pathname !== "/login" || destination.pathname !== "/register-phone" ||
      !/^[a-f0-9-]{36}$/.test(destination.searchParams.get("recovery") || "")) {
    throw Object.assign(new Error("Recovery intent absent"), { code: "PHONE_HANDOFF_INTENT_MISSING" });
  }
  assert.equal(raw.includes("6505550101"), false);
  assert.equal(raw.includes("123456"), false);
  return destination.searchParams.get("recovery");
}
assert.throws(() => requireHandoff("/login?redirect=%2Fprofile", "http://127.0.0.1"),
  { code: "PHONE_HANDOFF_INTENT_MISSING" });
record("legacy_257_handoff_rejected");
async function fixtureRequest(operation, scenario) {
  // eslint-disable-next-line no-restricted-syntax -- Test-owned disposable fixture/scheduler transport; never an application API replacement.
  const response = await fetch(`${config.backend}/__phone_fixture/${operation}/${scenario}`, { method: "POST" });
  assert.equal(response.status, 200, `fixture_${operation}_refused`);
  return response.json();
}
async function conflict(page) {
  stage = "phone_entry";
  await page.getByRole("textbox", { name: "Phone number", exact: true }).fill("6505550101");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  stage = "phone_code_enter_invalid";
  const code = page.getByRole("textbox", { name: "One-time code", exact: true });
  await code.fill("111111");
  stage = "phone_code_confirm_invalid";
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  stage = "phone_code_invalid_error";
  await page.getByRole("alert").first().waitFor();
  stage = "phone_code_enter_valid";
  await code.fill("123456");
  stage = "phone_code_confirm_valid";
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("heading", { name: "Number already linked", exact: true }).waitFor();
  stage = "phone_conflict";
}
async function handoff(page, action, origin) {
  const created = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/account/phone/recovery/continuations")
    .then(async response => ({ status: response.status(), body: await response.json(), action: response.request().postDataJSON().action }));
  await page.getByRole("button", { name: "Delete my previous account", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/login");
  const id = requireHandoff(page.url(), origin);
  const receipt = await created;
  assert.equal(receipt.status, 200);
  assert.equal(receipt.action, action);
  assert.equal(receipt.body.continuation_id, id);
  await page.getByRole("button", { name: "Use unrelated account", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in to your previous account", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Review deletion", exact: true }).count(), 0);
  await page.reload();
  await page.getByRole("heading", { name: "Sign in to your previous account", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("recovery"), id);
  await page.getByRole("button", { name: "Choose account", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/login");
  assert.equal(requireHandoff(page.url(), origin), id);
  await page.getByRole("button", { name: "Use previous account", exact: true }).click();
  await page.getByRole("heading", { name: action === "delete" ? "Delete old account" : "Account recovered", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: action === "delete" ? "Delete old account" : "Account recovered", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("recovery"), id);
  record(`${action}_continuation_survived_wrong_owner_and_refresh`);
}
try {
  assert.ok(path.isAbsolute(config.viteCacheDir));
  assert.ok(["chromium", "webkit"].includes(config.engine));
  server = await createServer({ root, envDir: false, cacheDir: config.viteCacheDir, configFile: false,
    logLevel: "silent", oxc: { jsx: { runtime: "automatic" } },
    optimizeDeps: { entries: [fixture.slice(1)], holdUntilCrawlEnd: true },
    define: { "process.env": JSON.stringify({ NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "development",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "synthetic-auth", NEXT_PUBLIC_FIREBASE_API_KEY: "synthetic-only" }) },
    resolve: { alias: [...["firebase/app", "firebase/auth", "firebase/analytics", "firebase/messaging", "next/navigation", "next/link", "next/image"]
      .map(find => ({ find, replacement: boundary })), { find: "@", replacement: root }] },
    server: { host: "127.0.0.1", port: 0, proxy: {
      "/api/vault": { target: config.backend, rewrite: value => value.replace(/^\/api\/vault/, "/db/vault") },
      "/api": config.backend, "/__phone_fixture": config.backend } },
    plugins: [{ name: "phone-acceptance-entry", configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url && ["/register-phone", "/login", "/one/setup", "/fixture/devices", "/"].includes(req.url.split("?")[0])) {
          res.setHeader("Content-Type", "text/html"); res.setHeader("Cache-Control", "no-store");
          res.end(`<html><body><div id="root"></div><script>globalThis.process={env:{NODE_ENV:"development"},browser:true}</script><script type="module" src="${fixture}"></script></body></html>`); return;
        }
        next();
      });
    } }],
  });
  await server.listen();
  assert.ok(await server.transformRequest(fixture));
  // The fixture uses the app stylesheet; compile it before timing browser actions.
  assert.ok(await server.transformRequest("/app/globals.css"));
  await server.waitForRequestsIdle();
  // Static-import idleness can precede dependency bundling on a cold runner.
  // Complete fixture preparation before starting the unchanged browser deadline.
  const optimizer = server.environments.client.depsOptimizer;
  await optimizer?.scanProcessing;
  await Promise.all(Object.values(optimizer?.metadata.discovered || {}).map(dep => dep.processing));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await ({ chromium, webkit }[config.engine]).launch({ headless: true });
  for (const scenario of ["recover", "occupied", "delete_linked", "devices"]) {
    activeScenario = scenario;
    stage = scenario;
    await fixtureRequest("reset", scenario);
    context = await browser.newContext({ viewport: { width: 393, height: 852 }, locale: "en-US", timezoneId: "America/Los_Angeles" });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    let transferClick;
    let erasures = 0, transfers = 0, revocations = 0, linkedConfirms = 0, claimsAfterConfirm = 0;
    const pageErrors = [];
    page.on("pageerror", error => { pageErrors.push("page_error"); if (diagnostics.errors.length < 5) diagnostics.errors.push(safeError(error)); });
    page.on("response", response => {
      const pathname = new URL(response.url()).pathname;
      if (response.request().method() === "GET" && isTransferReadback(pathname)) diagnostics.transfer.get_responses++;
      const endpoint = pathname.replace(/[a-f0-9-]{36}/g, ":id");
      if (response.status() >= 400 && endpoint.startsWith("/api/") && diagnostics.api.length < 12)
        diagnostics.api.push({ endpoint, status: response.status() });
    });
    page.on("request", request => {
      const endpoint = new URL(request.url()).pathname;
      if (request.method() === "GET" && isTransferReadback(endpoint)) {
        diagnostics.transfer.get_requests++;
        transferDebug.status_request_ms = elapsed();
      }
      if (request.method() === "POST" && endpoint === "/api/account/delete-lost-vault") {
        erasures++; if (scenario === "transfer") diagnostics.transfer.erase_requests++;
      }
      if (request.method() === "POST" && endpoint === "/api/account/phone/transfer/confirm") {
        transfers++; diagnostics.transfer.confirm_requests++;
      }
      if (request.method() === "DELETE" && endpoint.startsWith("/api/account/trusted-devices/")) revocations++;
      if (request.method() === "POST" && endpoint === "/api/account/phone/linked-account/deletions/confirm") linkedConfirms++;
      // After admission only a new verification may claim; the spent proof never does.
      if (request.method() === "POST" && endpoint === "/api/account/phone/claim" && linkedConfirms) claimsAfterConfirm++;
    });
    page.on("requestfailed", request => {
      if (request.method() === "GET" && isTransferReadback(new URL(request.url()).pathname)) diagnostics.transfer.get_failures++;
    });
    try {
      await page.goto(`${origin}${scenario === "devices" ? "/fixture/devices" : "/register-phone"}`);
      if (scenario !== "devices") await conflict(page);
      if (scenario === "recover") {
        await handoff(page, "delete", origin);
        stage = "owner_verified_deletion_review";
        await page.getByRole("button", { name: "Review deletion", exact: true }).click();
        await page.getByRole("button", { name: /^Continue with (Google|Apple)$/ }).first().waitFor();
        assert.equal(await page.getByRole("button", { name: "Permanently delete account", exact: true }).count(), 0);
        assert.equal(erasures, 0); assert.equal(transfers, 0);
        record("previous_owner_deletion_review_requires_fresh_confirmation");
      } else if (scenario === "occupied") {
        stage = "occupied_account_boundaries";
        await page.getByRole("button", { name: "Delete my previous account", exact: true }).waitFor();
        assert.equal(await page.locator("[data-phone-conflict]").getByRole("button").count(), 2);
        for (const name of ["Use this number on this account", "Send a real SMS code", "Recover my previous account", "Sign in to existing account", "Review previous device access", "Account options"]) {
          assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
        }
        assert.equal(erasures, 0); assert.equal(transfers, 0);
        await page.getByRole("button", { name: "Use a different number", exact: true }).click();
        await page.getByRole("textbox", { name: "Phone number", exact: true }).waitFor();
        record("occupied_phone_keeps_original_email_and_information");
      } else if (scenario === "delete_linked") {
        stage = "delete_linked_review";
        await page.getByRole("button", { name: "Delete my previous account", exact: true }).click();
        await page.getByRole("heading", { name: "Delete the account linked to ••01?", exact: true }).waitFor();
        const remove = page.getByRole("button", { name: "Delete that account", exact: true });
        assert.equal(await remove.isDisabled(), true);
        await page.getByRole("checkbox", { name: "I understand this can’t be undone.", exact: true }).check();
        assert.equal(await remove.isEnabled(), true);
        const confirmed = page.waitForResponse(response => response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/account/phone/linked-account/deletions/confirm")
          .then(async response => ({ status: response.status(), body: await response.json() }));
        stage = "delete_linked_confirm";
        // Both taps land in one task, before React commits `busy`; only the
        // synchronous in-flight guard can refuse the second.
        await remove.evaluate(button => { button.click(); button.click(); });
        const receipt = await confirmed;
        assert.equal(receipt.status, 200); assert.equal(receipt.body.state, "admitted");
        stage = "delete_linked_requested";
        await page.getByRole("heading", { name: "Deletion requested", exact: true }).waitFor();
        await page.getByRole("status").filter({ hasText: /^Deletion requested\. This number is not linked to your current account\. Verify again, or use a different number\.$/ }).waitFor();
        assert.equal(await page.locator("[data-phone-linked-deletion]").getByRole("button").count(), 1);
        assert.equal(new URL(page.url()).pathname, "/register-phone");
        assert.equal(await page.getByTestId("phone-fixture-destination").count(), 0);
        assert.equal(linkedConfirms, 1); assert.equal(claimsAfterConfirm, 0);
        stage = "delete_linked_worker";
        assert.equal((await fixtureRequest("drain", scenario)).settled, 1);
        assert.equal(claimsAfterConfirm, 0);
        stage = "delete_linked_verify_again";
        await page.getByRole("button", { name: "Verify this number again", exact: true }).click();
        await page.getByRole("textbox", { name: "Phone number", exact: true }).fill("6505550101");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("textbox", { name: "One-time code", exact: true }).fill("123456");
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
        await page.getByTestId("phone-fixture-destination").filter({ hasText: /^\/one\/setup$/ }).waitFor();
        assert.equal(linkedConfirms, 1); assert.equal(claimsAfterConfirm, 1);
        assert.equal(erasures, 0); assert.equal(transfers, 0);
        record("delete_linked_requested_erased_then_number_verified_again");
      } else {
        await page.getByRole("button", { name: "Unlink Fixture computer", exact: true }).click();
        await page.getByRole("button", { name: "Send code", exact: true }).click();
        await page.getByRole("textbox", { name: "Device verification code", exact: true }).fill("111111");
        await page.getByRole("button", { name: "Unlink device", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: /code did not work/ }).waitFor();
        assert.equal(revocations, 0);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.getByRole("button", { name: "Unlink Fixture computer", exact: true }).click();
        await page.getByRole("button", { name: "Send code", exact: true }).click();
        await page.getByRole("textbox", { name: "Device verification code", exact: true }).fill("123456");
        await page.getByRole("button", { name: "Unlink device", exact: true }).click();
        await page.getByText("Revoked · awaiting device seal confirmation", { exact: true }).waitFor();
        await page.reload();
        await page.getByText("Revoked · awaiting device seal confirmation", { exact: true }).waitFor();
        assert.equal(revocations, 1);
        record("device_fresh_proof_confirmation_and_readback");
      }
      assert.deepEqual(pageErrors, []);
      await fixtureRequest("assert", scenario);
    } catch (error) {
      if (stage === "transfer_readback") {
        transferDebug.wait_failed_ms = elapsed();
        transferDebug.wait_error = clickFailure(error);
        transferDebug.after_failure = await buttonState(page.getByRole("button", { name: "Check transfer progress", exact: true }));
      }
      throw error;
    } finally {
      try { await context.close(); }
      finally {
        context = null;
        // Settle the existing action even if close fails; only fixed codes escape.
        if (transferClick) await transferClick.catch(() => {});
      }
    }
  }
  process.stdout.write(JSON.stringify({ feature: "phone_conflict", engine: config.engine, provider: config.provider, trace_loop: events }) + "\n");
} catch (error) {
  const summary = stage === "transfer_readback" ? "PHONE_TRANSFER_READBACK_FAILED" : safeError(error);
  process.stderr.write(JSON.stringify({ code: "PHONE_BROWSER_LOOP_FAILED", scenario: activeScenario, stage, completedSteps: events.slice(-8), error: summary, diagnostics }) + "\n");
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (server) await server.close();
}
