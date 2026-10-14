import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Browser-only proof: production paid card + native WebCrypto/IndexedDB +
// Radix Avatar's untouched Image loader and native HTMLImageElement.decode().
// Auth, vault controls and server/provider results are synthetic. No Stripe
// session, Gemini call, outside photo or production account is involved.
let script: string;
let css: string;
const URL = "http://localhost/answer-profile-photo";
const REQUEST_ID = "01234567-89ab-4cde-8fab-0123456789ab";

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-profile-photo-"));
  await build({
    configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic" } },
    plugins: [{ name: "fixture-css-candidates", transform(source, id) {
      if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
        for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
    } }],
    resolve: { alias: [
      ...["@/hooks/use-auth", "@/lib/vault/vault-context", "@/lib/services/api-service", "@/lib/services/auth-service",
        "@/lib/cache/cache-sync-service", "@/components/consent/answer-request-review",
        "@/components/vault/vault-unlock-dialog", "@/lib/answers/answer-delivery-sweep"].map(find => ({
        find, replacement: path.join(root, "e2e/fixtures/answer-profile-photo-boundaries.tsx"),
      })),
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: { outDir, emptyOutDir: false,
      lib: { entry: path.join(root, "e2e/fixtures/answer-profile-photo.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" } },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"), loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});

async function mount(page: Page, paid: boolean, prepared = true) {
  let isPrepared = prepared;
  const errors: string[] = [];
  const outsideRequests: string[] = [];
  let answerReads = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.route("**/*", async route => {
    const request = route.request();
    if (request.url() === URL) return route.fulfill({ contentType: "text/html",
      body: `<!doctype html><html><head><title>Paid answer profile photo fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` });
    const pathname = new globalThis.URL(request.url()).pathname;
    let body: unknown;
    if (pathname === "/api/one/answer-requests/availability") body = { requests: true, payments: true, payouts: true };
    else if (pathname === "/api/one/answer-requests/inbox") body = { requests: [] };
    else if (pathname === `/api/one/answer-requests/${REQUEST_ID}/state`) body = {
      role: "requester", requestStatus: paid ? "answered" : "approved", question: "What is your profile photo?",
      coverage: { included: [
        { scope: "attr.identity.identity_profile.full_name", label: "Full name" },
        { scope: "attr.identity.identity_profile.profile_photo_url", label: "Profile photo" },
      ], notIncluded: [] },
    };
    else if (pathname === `/api/one/answer-requests/${REQUEST_ID}/payment`) body = {
      requestStatus: paid ? "answered" : "approved", orderStatus: paid ? "paid" : "checkout_open",
      amountCents: 1000, currency: "usd", checkoutUrl: null, paidAt: paid ? "2026-10-13T12:00:00Z" : null,
      refundedAt: null, refundReason: null, preparationStatus: isPrepared ? "ready" : "preparing", reconciliationRequired: false,
      fulfilment: "owner_device", answerDeadlineAt: null, answerDeadlineHours: 72,
    };
    else if (pathname === `/api/one/answer-requests/${REQUEST_ID}/answer`) {
      answerReads++;
      // Deliberately return the old envelope even after account switch: the
      // real recipient-key mismatch must prevent opening it as the new user.
      body = await page.evaluate(async () => await (window as unknown as { answerPhotoEnvelope: Promise<unknown> }).answerPhotoEnvelope);
    } else {
      outsideRequests.push(request.url());
      return route.abort();
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(URL);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page).toHaveTitle("Paid answer profile photo fixture");
  await expect(page.getByRole("heading", { name: "Paid answer profile photo" })).toBeVisible();
  return { errors, outsideRequests, answerReads: () => answerReads, stage: () => { isPrepared = true; } };
}

test("paid approved photo decodes natively, then lock and account switch isolate it", async ({ page }) => {
  const evidence = await mount(page, true);
  const card = page.getByRole("region", { name: "Paid answer" });
  await card.getByRole("button", { name: "Open answer", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Fixture unlock" })).toBeVisible();
  expect(evidence.answerReads()).toBe(0);
  await expect(card.locator("img")).toHaveCount(0);
  await page.getByRole("button", { name: "Unlock fixture vault", exact: true }).click();
  const image = card.getByRole("img", { name: "Avery's profile photo", exact: true });
  await expect(image).toBeVisible();
  expect(await image.evaluate(async node => {
    const image = node as HTMLImageElement;
    await image.decode();
    return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, fit: getComputedStyle(image).objectFit };
  })).toEqual({ complete: true, width: 3, height: 2, fit: "cover" });
  await expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(card.locator("img")).toHaveCount(1);
  await expect(card).toContainText("The approved profile photo belongs to Avery.");
  expect(evidence.answerReads()).toBe(1);
  expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const shotDir = process.env.ANSWER_PHOTO_SHOT_DIR;
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    await card.screenshot({ path: path.join(shotDir, "paid-answer-profile-photo-webkit.png"), animations: "disabled" });
  }
  await page.getByRole("button", { name: "Lock fixture vault", exact: true }).click();
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card).not.toContainText("The approved profile photo belongs to Avery.");
  await expect(card.getByRole("button", { name: "Open answer", exact: true })).toBeVisible();
  expect(evidence.answerReads()).toBe(1);
  // Reopen before changing accounts so account isolation has its own
  // currently displayed plaintext/image to remove, independently of lock.
  await card.getByRole("button", { name: "Open answer", exact: true }).click();
  await page.getByRole("button", { name: "Unlock fixture vault", exact: true }).click();
  await expect(image).toBeVisible();
  expect(evidence.answerReads()).toBe(2);
  await page.getByRole("button", { name: "Switch fixture account", exact: true }).click();
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card).not.toContainText("The approved profile photo belongs to Avery.");
  await card.getByRole("button", { name: "Open answer", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("Recipient key unavailable");
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card).not.toContainText("The approved profile photo belongs to Avery.");
  expect(evidence.answerReads()).toBe(3);
  expect(evidence.outsideRequests).toEqual([]);
  expect(evidence.errors).toEqual([]);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("unpaid prepared answer never fetches or renders the approved photo", async ({ page }) => {
  const evidence = await mount(page, false);
  const card = page.getByRole("region", { name: "Paid answer" });
  await expect(card.getByText("Included in this answer: Full name, Profile photo.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Pay $10", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Open answer", exact: true })).toHaveCount(0);
  await expect(card.locator("img")).toHaveCount(0);
  await card.getByRole("button", { name: "Refresh question", exact: true }).click();
  await expect(card.getByRole("button", { name: "Pay $10", exact: true })).toBeVisible();
  expect(evidence.answerReads()).toBe(0);
  expect(evidence.outsideRequests).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test("staging becomes payable through bounded card polling without an event stream", async ({ page }) => {
  await page.clock.install();
  const evidence = await mount(page, false, false);
  const card = page.getByRole("region", { name: "Paid answer" });
  await expect(card.getByRole("button", { name: "Pay $10", exact: true })).toHaveCount(0);
  await expect(card.getByText(/Their answer is being prepared/)).toBeVisible();
  evidence.stage();
  await page.clock.runFor(3100);
  await expect(card.getByRole("button", { name: "Pay $10", exact: true })).toBeVisible();
  expect(evidence.answerReads()).toBe(0);
  expect(evidence.errors).toEqual([]);
  expect(evidence.outsideRequests).toEqual([]);
});
