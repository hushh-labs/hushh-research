/** Local fixture only. Production UI/services/policies/SQL; recorded providers.
 * One context at a time; no screenshots, traces, credential or content output. */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  await page.getByRole("heading", { name: "This number is linked to another account", exact: true }).waitFor();
  stage = "phone_conflict";
}
async function handoff(page, action, origin) {
  const created = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/account/phone/recovery/continuations")
    .then(async response => ({ status: response.status(), body: await response.json() }));
  await page.getByRole("button", { name: action === "delete" ? "Delete my previous account" : "Recover my previous account", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/login");
  const id = requireHandoff(page.url(), origin);
  const receipt = await created;
  assert.equal(receipt.status, 200);
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
  await server.waitForRequestsIdle();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await ({ chromium, webkit }[config.engine]).launch({ headless: true });
  for (const scenario of ["recover", "delete", "transfer", "devices"]) {
    activeScenario = scenario;
    stage = scenario;
    await fixtureRequest("reset", scenario);
    context = await browser.newContext({ viewport: { width: 393, height: 852 }, locale: "en-US", timezoneId: "America/Los_Angeles" });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    let erasures = 0, transfers = 0, revocations = 0;
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
      if (request.method() === "GET" && isTransferReadback(endpoint)) diagnostics.transfer.get_requests++;
      if (request.method() === "POST" && endpoint === "/api/account/delete-lost-vault") {
        erasures++; if (scenario === "transfer") diagnostics.transfer.erase_requests++;
      }
      if (request.method() === "POST" && endpoint === "/api/account/phone/transfer/confirm") {
        transfers++; diagnostics.transfer.confirm_requests++;
      }
      if (request.method() === "DELETE" && endpoint.startsWith("/api/account/trusted-devices/")) revocations++;
    });
    page.on("requestfailed", request => {
      if (request.method() === "GET" && isTransferReadback(new URL(request.url()).pathname)) diagnostics.transfer.get_failures++;
    });
    try {
      await page.goto(`${origin}${scenario === "devices" ? "/fixture/devices" : "/register-phone"}`);
      if (scenario !== "devices") await conflict(page);
      if (scenario === "recover" || scenario === "delete") {
        await handoff(page, scenario, origin);
        if (scenario === "recover") {
          stage = "recover_continue";
          await page.getByRole("button", { name: "Continue to your account", exact: true }).click();
          await page.getByTestId("phone-fixture-destination").filter({ hasText: /^\/$/ }).waitFor();
          assert.equal(erasures, 0);
        } else {
          await page.getByRole("button", { name: "Review deletion", exact: true }).click();
          await page.getByRole("button", { name: `Continue with ${config.provider === "apple.com" ? "Apple" : "Google"}`, exact: true }).click();
          await page.getByRole("textbox", { name: "Mobile number", exact: true }).fill("6505550101");
          await page.getByRole("button", { name: "Send code", exact: true }).click();
          await page.getByRole("textbox", { name: "Verification code", exact: true }).fill("123456");
          await page.getByRole("button", { name: "Verify code", exact: true }).click();
          await page.getByRole("checkbox", { name: "I understand this can’t be undone.", exact: true }).check();
          const mutation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/account/delete-lost-vault" && response.request().method() === "POST");
          await page.getByRole("button", { name: "Permanently delete account", exact: true }).click();
          assert.equal((await mutation).status(), 202);
          await page.getByRole("heading", { name: /Deleting your account|Checking your account deletion/ }).waitFor();
          await page.reload();
          await page.getByRole("heading", { name: /Deleting your account|Checking your account deletion/ }).waitFor();
          assert.equal(erasures, 1);
          await fixtureRequest("drain", scenario);
          const refresh = page.getByRole("button", { name: /^(Refresh status|Check status)$/ });
          if (await refresh.count()) await refresh.click();
          await page.waitForURL(url => url.pathname === "/login" && url.searchParams.has("auth_notice"));
          assert.equal(new URL(page.url()).searchParams.get("auth_notice"), "account_deleted",
            "Authoritative cleanup completion must confirm erasure without inventing identity disposition or signup readiness");
          await page.getByRole("status").filter({ hasText: /^This account’s information was deleted\./ }).first().waitFor();
          assert.equal(await page.getByText("Your old account is deleted. Continue below to start fresh.", { exact: true }).count(), 0);
          assert.equal(erasures, 1);
          record("delete_real_sql_worker_and_terminal_ui");
        }
      } else if (scenario === "transfer") {
        await page.getByRole("button", { name: "Use this number on this account", exact: true }).click();
        await page.getByRole("heading", { name: "Use this number on this account?", exact: true }).waitFor();
        const confirm = page.getByRole("button", { name: "Confirm phone transfer", exact: true });
        let committedResponseLost = false;
        stage = "transfer_response_drop";
        await page.route("**/api/account/phone/transfer/confirm", async route => {
          // Drop only the browser response AFTER the real API has committed.
          // The actual confirm/provider effect is forwarded exactly once.
          const receipt = await route.fetch();
          assert.equal(receipt.status(), 200);
          await route.abort("failed");
          committedResponseLost = true;
        });
        await confirm.click();
        const checkProgress = page.getByRole("button", { name: "Check transfer progress", exact: true });
        await checkProgress.waitFor();
        // Finish the owned network fault before the next browser action.
        await page.unrouteAll({ behavior: "wait" });
        assert.equal(committedResponseLost, true);
        assert.equal(transfers, 1);
        stage = "transfer_readback";
        if (config.transferReadbackFailure) {
          await page.route("**/api/account/phone/transfer/*", route => route.abort("failed"));
        }
        diagnostics.transfer.click_started = true;
        // Observe both promises immediately so a timeout reaches the sanitized
        // outer diagnostic catch instead of terminating Node as unhandled.
        const [receipt] = await Promise.all([
          page.waitForResponse(response => response.request().method() === "GET" &&
            isTransferReadback(new URL(response.url()).pathname))
            .then(async response => ({ status: response.status(), body: await response.json() })),
          checkProgress.click().then(async () => {
            diagnostics.transfer.click_completed = true;
            // Negative control only: delay this test's acknowledgment beyond
            // the unchanged 15s waiter. The actual click still happens once.
            if (config.transferReadbackFailure) await new Promise(resolve => setTimeout(resolve, 16_000));
          }),
        ]);
        assert.equal(receipt.status, 200); assert.equal(receipt.body.transfer_status, "completed");
        await page.getByTestId("phone-fixture-destination").filter({ hasText: "/one/setup" }).waitFor();
        assert.equal(transfers, 1); assert.equal(erasures, 0);
        record("transfer_lost_response_status_only_completion_preserved_information");
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
    } finally { await context.close(); context = null; }
  }
  process.stdout.write(JSON.stringify({ feature: "phone_conflict", engine: config.engine, provider: config.provider, trace_loop: events }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ code: "PHONE_BROWSER_LOOP_FAILED", scenario: activeScenario, stage, completedSteps: events.slice(-8), error: safeError(error), diagnostics }) + "\n");
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (server) await server.close();
}
