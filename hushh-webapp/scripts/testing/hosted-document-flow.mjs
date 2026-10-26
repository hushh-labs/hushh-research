/** Browser -> production client -> HTTP router -> SQL -> signed payment ->
 * local PDF -> real download. Only provider/auth/PKM transports are synthetic. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = "";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const boundary = path.join(root, "e2e/fixtures/hosted-document-boundaries.tsx");
const alias = ["@/lib/services/api-service", "./api-service", "@/lib/services/one-kyc-client-zk-service", "@/hooks/use-auth", "@/lib/vault/vault-context", "@/lib/services/auth-service", "./auth-service", "@/lib/cache/cache-sync-service", "@/lib/connections/custom-connector-configuration", "next/navigation"]
  .map(find => ({ find, replacement: boundary }));
const fixture = "/e2e/fixtures/hosted-document-flow.tsx";
let server, browser, page;
const events = [];
const failures = [];
const errors = [];
let directGoogleReads = 0; let oneUploads = 0;
let legacyQuoteReads = 0;
const record = (name, details = {}) => events.push({ name, ...details });
try {
  assert.ok(typeof config.viteCacheDir === "string" && path.isAbsolute(config.viteCacheDir));
  server = await createServer({
    root, cacheDir: config.viteCacheDir, configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic" } },
    // Middleware supplies the HTML, so the optimizer needs its actual TSX entry.
    // Python owns this run's cache even if it must terminate the Node process.
    optimizeDeps: { entries: [fixture.slice(1)], holdUntilCrawlEnd: true },
    define: { "process.env": JSON.stringify({ NEXT_PUBLIC_APP_URL: "https://one.invalid" }) },
    resolve: { alias: [...alias, { find: "@", replacement: root }] },
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": config.backend, "/__document_fixture/settle": config.backend, "/__document_fixture/replace-key": config.backend, "/__document_fixture/pause-intake": config.backend } },
    plugins: [{ name: "isolated-document-loop", configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url === "/__document_fixture/config") {
          res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(config.client)); return;
        }
        if (req.url?.startsWith("/one/documents/open")) {
          res.setHeader("Content-Type", "text/html");
          res.end(`<html><body><div id="root"></div><script type="module" src="${fixture}"></script></body></html>`); return;
        }
        next();
      });
    } }],
  });
  await server.listen();
  assert.ok(await server.transformRequest(fixture), "Hosted browser entry did not transform");
  await server.waitForRequestsIdle();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  assert.ok(["chromium", "webkit"].includes(config.engine));
  browser = await ({ chromium, webkit }[config.engine]).launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 820 } });
  page = await context.newPage();
  const switchActor = async actor => {
    await page.getByRole("button", { name: `Use ${actor} session`, exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('[data-testid="document-fixture"]')?.getAttribute("data-actor") === expected, actor);
  };
  const control = id => page.locator(`[data-voice-control-id="${id}"]`);
  page.on("pageerror", error => errors.push(error.message));
  page.on("requestfailed", request => {
    const url = new URL(request.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const failure = request.failure()?.errorText ?? "";
    failures.push({ path: url.pathname.replace(/[a-f0-9-]{36}/g, ":id").slice(0, 200),
      transport: /abort|cancel/i.test(failure) ? "cancelled" : /timeout|timed out/i.test(failure) ? "timeout" : "failed" });
  });
  page.on("response", async response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/")) {
      const error = await response.json().catch(() => null);
      failures.push({ status: response.status(), code: error?.detail?.code ?? "unavailable", path: url.pathname.replace(/[a-f0-9-]{36}/g, ":id") });
    } else failures.push({ status: response.status(), path: url.pathname.replace(/[a-f0-9-]{36}/g, ":id") });
  });
  page.on("console", message => { if (message.type() === "error" || message.text().includes("worker")) failures.push({ browser: message.text().slice(0, 300) }); });
  const sourceBytes = Buffer.from(config.source.pdf, "base64");
  const sourceHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  await page.route("https://www.googleapis.com/drive/v3/files/**", async route => {
    directGoogleReads++;
    assert.equal(route.request().headers().authorization, "Bearer synthetic-direct-google");
    const media = new URL(route.request().url()).searchParams.get("alt") === "media";
    await route.fulfill({ contentType: media ? "application/pdf" : "application/json", body: media ? sourceBytes : JSON.stringify({
      id: "private-pdf-source", name: "Private statement.pdf", mimeType: "application/pdf", size: String(sourceBytes.length),
      version: "1", sha256Checksum: sourceHash, capabilities: { canDownload: true }, trashed: false,
    }) });
  });
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/sharing/quote")) legacyQuoteReads++;
    if (request.method() === "PUT" && new URL(request.url()).pathname.includes("/delivery/uploads/")) {
      oneUploads++;
      const body = request.postDataBuffer();
      assert.ok(body && !body.includes(sourceBytes) && !body.includes(Buffer.from("%PDF-")));
      assert.equal(request.headers()["content-type"], "application/octet-stream");
    }
  });
  let requestId;
  await page.route("https://checkout.stripe.com/**", async route => {
    // External Stripe alone is synthetic; the callback is HMAC signed and
    // handled by the actual webhook route and production settlement service.
    // eslint-disable-next-line no-restricted-syntax -- Test-only external Stripe transport, followed by the real signed HTTP webhook.
    const response = await fetch(`${config.backend}/__document_fixture/settle/${requestId}`, { method: "POST" });
    assert.equal(response.status, 200);
    record("signed_payment_settled");
    // WebKit cannot fulfill an intercepted navigation with a redirect status.
    // Model Stripe's browser return with its own HTML navigation instead.
    await route.fulfill({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(`${origin}/one/documents/open?ref=${requestId}`)})</script>` });
  });
  const start = performance.now();
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`${origin}/one/documents/open`);
  await page.getByRole("button", { name: "Request files", exact: true }).click();
  await control("document-hosting-receive-through").selectOption("one");
  await page.getByLabel("Which files do you need?", { exact: true }).fill("Statements");
  await page.getByLabel("Start date", { exact: true }).fill("2026-10-01");
  await page.getByLabel("End date", { exact: true }).fill("2026-10-25");
  await page.locator("#document-activity-accepted").check();
  assert.equal(await page.locator("#document-activity-accepted").isChecked(), true);
  const creation = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/sharing/delivery-requests"));
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  const created = await creation;
  assert.equal(created.status(), 202);
  assert.equal(created.request().headers().authorization, "Bearer recipient");
  assert.equal(created.request().headers()["x-hushh-consent"], "recipient");
  assert.equal(created.request().postDataJSON().receiveThrough, "one");
  assert.equal(created.request().postDataJSON().activityAccepted, true);
  requestId = (await created.json()).requestId;
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  await page.getByText("Request sent.", { exact: true }).waitFor();
  assert.equal(legacyQuoteReads, 0, "One requests must not depend on legacy Drive quotes");
  assert.equal(await page.evaluate(async () => (await import("/e2e/fixtures/hosted-document-boundaries.tsx")).getFixtureKeySetupCount()), 1);
  record("request_committed");
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto(`${origin}/one/documents/open?ref=${requestId}&actor=owner`);
  await page.getByRole("checkbox", { name: "Private statement.pdf · PDF" }).check();
  await page.getByLabel("Price (USD)").fill("25.00");
  const accessDeadline = page.getByLabel("Access until (your time)", { exact: true });
  assert.equal(await accessDeadline.getAttribute("type"), "datetime-local");
  // Enter the browser's local date format, rounded down within the requested
  // deadline. The client must send this same instant as a canonical UTC value.
  await accessDeadline.fill((await accessDeadline.inputValue()).slice(0, 16));
  const expectedDeadline = await accessDeadline.evaluate(node => new Date(node.value).toISOString());
  const copyPermission = page.getByTestId("hosted-document-panel").locator('[data-consent-role="disclosure"]').getByRole("checkbox");
  assert.equal(await copyPermission.isChecked(), false);
  assert.equal(await control("document-hosting-prepare").isEnabled(), false);
  await copyPermission.check();
  const preparation = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/delivery/approve") && response.request().postDataJSON()?.phase === "prepare");
  await control("document-hosting-prepare").click();
  const prepared = await preparation;
  assert.equal(prepared.status(), 200);
  assert.equal(prepared.request().postDataJSON().copyAccepted, true);
  assert.equal(prepared.request().postDataJSON().accessExpiresAt, expectedDeadline);
  await control("document-hosting-final-approve").waitFor({ timeout: 30000 });
  const selectedFile = page.getByLabel("Approved files", { exact: true }).getByText("Private statement.pdf · PDF", { exact: true });
  await selectedFile.waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "Private statement.pdf · PDF" }).count(), 0);
  await page.reload();
  await selectedFile.waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "Private statement.pdf · PDF" }).count(), 0);
  record("encrypted_package_staged", { directGoogleReads, oneUploads });
  assert.equal(directGoogleReads, 3); assert.equal(oneUploads, 3);
  await control("document-hosting-final-approve").click();
  await page.getByText("Waiting for recipient acceptance", { exact: true }).waitFor();
  await switchActor("recipient");
  await page.getByRole("checkbox", { name: /I accept this approved document version/ }).check();
  assert.equal(await control("document-hosting-pay").textContent(), "Accept and pay $25.00");
  await control("document-hosting-pay").click();
  await page.waitForURL(`${origin}/one/documents/open?ref=${requestId}`);
  await page.getByRole("region", { name: "Protected documents", exact: true }).waitFor({ timeout: 15000 });
  const reported = kind => page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/delivery/activity") && response.request().postDataJSON()?.kind === kind);
  const renderedEvent = reported("preview_rendered");
  await control("document-hosting-preview").click();
  const canvas = page.getByLabel("Document preview, page 1", { exact: true });
  await canvas.waitFor();
  await page.waitForFunction(() => { const node = document.querySelector('canvas[aria-label="Document preview, page 1"]'); return node && node.width > 0 && node.height > 0; });
  assert.ok(await canvas.evaluate(node => node.getContext("2d").getImageData(0, 0, node.width, node.height).data.some((value, index) => index % 4 !== 3 && value < 240)));
  assert.equal((await renderedEvent).status(), 200);
  record("local_preview_rendered");
  await control("document-hosting-close-preview").click();
  const originalPromise = page.waitForEvent("download");
  const originalHandoff = reported("handoff_reported");
  await control("document-hosting-download-original").click();
  const original = await originalPromise;
  const originalBytes = await fs.readFile(await original.path());
  assert.equal(original.suggestedFilename(), "Private statement.pdf");
  assert.equal(crypto.createHash("sha256").update(originalBytes).digest("hex"), sourceHash);
  assert.equal((await originalHandoff).status(), 200);
  const markedPromise = page.waitForEvent("download");
  const markedHandoff = reported("handoff_reported");
  await control("document-hosting-download-copy").click();
  const marked = await markedPromise;
  const markedBytes = await fs.readFile(await marked.path());
  assert.ok(markedBytes.subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.notEqual(crypto.createHash("sha256").update(markedBytes).digest("hex"), sourceHash);
  assert.equal((await markedHandoff).status(), 200);
  const watermarkText = await page.evaluate(async bytes => {
    const { loadHostedPdf } = await import("/lib/consent/document-hosting-pdf.ts");
    const pdf = await loadHostedPdf(new Uint8Array(bytes), new AbortController().signal);
    try {
      const content = await (await pdf.getPage(1)).getTextContent();
      return content.items.filter(item => "str" in item).map(item => item.str).join(" ");
    } finally { await pdf.loadingTask.destroy(); }
  }, [...markedBytes]);
  assert.ok(watermarkText.includes("One copy") && watermarkText.includes("recipient reci***"));
  const panel = page.getByTestId("hosted-document-panel");
  assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  record("both_downloads_verified");
  assert.equal(directGoogleReads, 3, "Recipient must read the approved copy while owner/source is offline");
  assert.equal(await page.evaluate(async () => (await import("/e2e/fixtures/hosted-document-boundaries.tsx")).getFixtureKeySetupCount()), 0, "Paid reads must never create replacement keys");
  // eslint-disable-next-line no-restricted-globals -- Negative storage proof, never a credential/content write.
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  // Model the operational intake kill switch, then continue the issued paid
  // copy's real recovery/read/revoke flow with both legacy switches still off.
  // eslint-disable-next-line no-restricted-syntax -- Test-only runtime policy boundary.
  const paused = await fetch(`${config.backend}/__document_fixture/pause-intake`, { method: "POST" });
  assert.equal(paused.status, 200); assert.equal((await paused.json()).enabled, false);
  const retiredSession = await page.evaluateHandle(async () =>
    (await import("/e2e/fixtures/hosted-document-boundaries.tsx")).fixtureSession("recipient").isCurrent);
  await page.evaluate(async () => (await import("/e2e/fixtures/hosted-document-boundaries.tsx")).loseFixtureRecipientKey());
  await switchActor("owner");
  await switchActor("recipient");
  assert.equal(await retiredSession.evaluate(isCurrent => isCurrent()), false, "Restoring an actor must not revive its retired session");
  await retiredSession.dispose();
  await control("document-hosting-recovery-request").waitFor();
  page.once("dialog", dialog => dialog.accept());
  await control("document-hosting-recovery-request").click();
  await page.getByText("Recovery requested. The owner must authorize repairing this copy. Nothing was charged.", { exact: true }).waitFor();
  await switchActor("owner");
  await control("document-hosting-repair").waitFor();
  const amendment = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/delivery/recovery-amendment"));
  await control("document-hosting-repair").click();
  await page.getByRole("alertdialog", { name: "Repair recipient access?" }).getByRole("button", { name: "Repair access", exact: true }).click();
  const repaired = await amendment;
  assert.equal(repaired.status(), 200);
  await repaired.finished();
  assert.equal((await repaired.json()).recoveryRequested, false);
  await control("document-hosting-repair").waitFor({ state: "hidden" });
  await switchActor("recipient");
  const recoveredDownload = page.waitForEvent("download");
  const recoveredHandoff = reported("handoff_reported");
  await control("document-hosting-download-original").click();
  assert.equal(crypto.createHash("sha256").update(await fs.readFile(await (await recoveredDownload).path())).digest("hex"), sourceHash);
  assert.equal((await recoveredHandoff).status(), 200);
  assert.equal(directGoogleReads, 3); assert.equal(oneUploads, 3);
  record("paid_key_recovery_verified");
  await switchActor("owner");
  await control("document-hosting-revoke").click();
  await page.getByRole("alertdialog", { name: "Stop One access?" }).getByRole("button", { name: "Stop access", exact: true }).click();
  await page.getByText("Access revoked", { exact: true }).waitFor();
  record("revoke_committed");
  await switchActor("recipient");
  assert.equal(await control("document-hosting-download-original").count(), 0);
  assert.deepEqual(errors, []);
  const elapsedMs = Math.round(performance.now() - start);
  assert.ok(elapsedMs < 45000, `Production loop exceeded 45s: ${elapsedMs}ms`);
  console.log(JSON.stringify({ feature: "protected_document_delivery", engine: config.engine, trace_loop: events, elapsedMs, requestId }));
  await context.close();
} catch (error) {
  const alerts = await page?.getByRole("alert").allTextContents().catch(() => []);
  const keySetups = await page?.evaluate(async () => (await import("/e2e/fixtures/hosted-document-boundaries.tsx")).getFixtureKeySetupCount()).catch(() => null);
  console.error(JSON.stringify({ stage: events.at(-1)?.name ?? "starting", directGoogleReads, oneUploads, keySetups, failures, alerts, errors }));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
