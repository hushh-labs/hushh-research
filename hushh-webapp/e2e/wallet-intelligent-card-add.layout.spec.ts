import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { productFontStyle, stripAppFontFaces, awaitProductFont } from "./fixtures/product-font";
let server: Server, origin: string, card: Buffer, record: Record<string, any> | null = null;
const wire: string[] = [];
let artworkMode: "unknown" | "ambiguous" | "exact" | "outage" | "revoked" = "unknown";
let approvedArt: { bytes: Buffer; variant: Record<string, unknown>; mime?: string }[] = [];
let atlasArt: typeof approvedArt = [], bankMode = false, atlasVersion = "";
const atlasBankKey = "a".repeat(32);
test.beforeAll(async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-full-flow-"));
  const { build } = await import("vite"), { Scanner } = await import("@tailwindcss/oxide"), { compile } = await import("tailwindcss");
  const sharp = (await import("sharp")).default;
  // Requester-authorized, reviewed actual atlas files; card input remains synthetic.
  const atlasRoot = path.join(root, "../consent-protocol/hushh_mcp/resources/wallet-artwork");
  const atlas = JSON.parse(fs.readFileSync(path.join(atlasRoot, "catalog.json"), "utf8"));
  atlasVersion = atlas.version;
  atlasArt = atlas.assets.filter((row: { issuer_id: string; network: string }) => row.issuer_id === "hdfc-bank-in" && row.network === "mastercard").map((row: any) => ({ mime: row.mime, bytes: fs.readFileSync(path.join(atlasRoot, "assets", row.digest + ".webp")), variant: { assetId: row.asset_id, issuerId: row.issuer_id, productId: row.product_id, variantId: row.variant_id, label: row.label, issuerName: row.issuer_name, productName: row.product_name, variantName: row.variant_name, country: row.country, digest: row.digest, allowOverlay: false, image: `/api/one/wallet/card-access/artwork/assets/${row.digest}` } }));
  card = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="756"><rect width="1200" height="756" fill="#dbe8f8"/><g font-family="Arial" font-size="54" fill="#101827"><text x="80" y="135">SYNTHETIC CARD</text><text x="80" y="350">4242 4242 4242 4242</text><text x="80" y="480">VALID THRU 12/30</text><text x="80" y="630">ALEX SAMPLE</text></g></svg>')).png().toBuffer();
  // Owned blank test pixels; no bank branding, sample PAN or issuer coverage.
  approvedArt = await Promise.all([{ name: "Blue", width: 856, height: 540, color: "#223852" }, { name: "Gold", width: 540, height: 856, color: "#9a773e" }].map(async (design, index) => {
    const bytes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${design.width}" height="${design.height}"><rect width="100%" height="100%" rx="24" fill="${design.color}"/><path d="M0 180 Q250 80 900 600" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="70"/><text x="44" y="82" font-family="Arial" font-size="28" fill="white">SYNTHETIC ART</text><text x="44" y="126" font-family="Arial" font-size="20" fill="white">Owned test design · ${design.name}</text></svg>`)).png().toBuffer();
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { bytes, variant: { assetId: `owned-${index}`, issuerId: "owned-test-bank", productId: "owned-test-product", variantId: design.name.toLowerCase(), label: `Test ${design.name}`, issuerName: "Synthetic Test Bank", productName: "Example product", variantName: design.name, country: "US", providerId: "owned-fixtures", artworkVersion: "2026-1", width: design.width, height: design.height, image: `/api/one/wallet/card-access/artwork/assets/${digest}`, digest, allowOverlay: false } };
  }));
  execFileSync(process.execPath, [path.join(root, "scripts/prepare-wallet-ocr.mjs")]);
  const scanner = new Scanner({}), candidates = new Set<string>();
  const boundaries = ["@/lib/services/api-service", "./api-service", "@/lib/services/auth-service", "./auth-service", "@/lib/capacitor", "@/lib/cache/cache-sync-service", "next/navigation"];
  await build({ configFile: false, publicDir: false, logLevel: "error",
    plugins: [{ name: "styles", transform(source, id) { if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate); } }],
    oxc: { jsx: { runtime: "automatic", development: false } },
    resolve: { alias: [...boundaries.map(find => ({ find: new RegExp(`^${find.replaceAll(".", "\\.")}$`), replacement: path.join(root, "e2e/fixtures/wallet-intelligent-boundaries.tsx") })), { find: "@", replacement: root }] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: { outDir: dir, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/wallet-intelligent-card-add.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" } },
  });
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), { base: path.join(root, "app"), loadStylesheet: async (id, base) => {
    const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css") : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
    return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
  } });
  const css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle() + fs.readdirSync(dir).filter(name => name.endsWith(".css")).map(name => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
  const script = fs.readFileSync(path.join(dir, "fixture.js"));
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost").pathname;
    const json = (value: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (url === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(`<html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}#root{height:100vh;overflow:auto}</style><body><div id="root"></div><script src="/fixture.js"></script></body></html>`); return; }
    if (url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(script); return; }
    if (url === "/fixture/encrypted-record") { json(record); return; }
    if (url.includes("/artwork/assets/")) {
      const asset = (bankMode ? atlasArt : approvedArt).find(row => url.endsWith(String(row.variant.digest)));
      if (!asset || artworkMode === "revoked" || req.headers.authorization !== "Bearer synthetic-test-token" || req.headers["x-hushh-consent"] !== "synthetic-owner-token") { res.statusCode = 404; json({ error: "Unavailable" }); return; }
      res.setHeader("Content-Type", asset.mime ?? "image/png"); res.end(asset.bytes); return;
    }
    if (req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      wire.push(body);
      if (url.endsWith("/store-domain")) { const payload = JSON.parse(body); record = { ...payload, revision: (record?.revision ?? 0) + 1 }; json({ success: true, data_version: record.revision }); return; }
      if (url.endsWith("/networks/resolve")) { const network = bankMode ? "mastercard" : "visa"; json({ network, source: "prefix", candidates: [network] }); return; }
      if (url.endsWith("/artwork/banks")) {
        if (req.headers.authorization !== "Bearer synthetic-test-token" || req.headers["x-hushh-consent"] !== "synthetic-owner-token") { res.statusCode = 403; json({ error: "Unavailable" }); return; }
        const input = JSON.parse(body), available = bankMode && input.network === "mastercard";
        json({ catalogVersion: atlasVersion, selectionBasis: "owner_selected_bank", requiresConfirmation: true, bankKey: input.bankKey ?? null, banks: available ? [{ bankKey: atlasBankKey, issuerId: "hdfc-bank-in", name: "HDFC Bank", country: "IN", designCount: atlasArt.length }] : [], variants: available && input.bankKey === atlasBankKey ? atlasArt.map(row => row.variant) : [], nextOffset: null }); return;
      }
      if (url.endsWith("/artwork/resolve")) {
        if (artworkMode === "outage") { res.statusCode = 503; json({ error: "Unavailable" }); return; }
        json({ match: artworkMode === "exact" ? "exact" : artworkMode === "ambiguous" ? "ambiguous" : "unknown", provider: artworkMode === "unknown" ? "unconfigured" : "configured", issuerId: "owned-test-bank", catalogVersion: "owned-1", variants: artworkMode === "exact" ? [approvedArt[0]!.variant] : artworkMode === "ambiguous" ? approvedArt.map(row => row.variant) : [] }); return;
      }
      if (url.endsWith("/artwork/validate")) { json({ selections: JSON.parse(body).selections.map((selection: { assetId: string }) => ({ assetId: selection.assetId, approved: artworkMode !== "revoked", allowOverlay: false })) }); return; }
    }
    if (url.endsWith("/networks")) { json({ networks: ["visa", "mastercard", "amex", "rupay", "discover", "diners", "other"] }); return; }
    const file = url === "/wallet/card-scan-worker.js" ? path.join(root, "public/wallet/card-scan-worker.js") : url.startsWith("/vendor/wallet-ocr/") ? path.join(root, "public/vendor/wallet-ocr", path.basename(url)) : url.startsWith("/wallet/") ? path.join(root, "public/wallet", path.basename(url)) : null;
    if (file && fs.existsSync(file)) { res.setHeader("Content-Type", url.endsWith(".js") ? "text/javascript" : url.endsWith(".wasm") ? "application/wasm" : url.endsWith(".webp") ? "image/webp" : "application/octet-stream"); res.end(fs.readFileSync(file)); return; }
    res.statusCode = 404; json({ error: "Fixture route absent" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
test("Back cancels the crop/read layer and keeps the Add draft in place", async ({ page }) => {
  record = null; wire.length = 0; artworkMode = "unknown"; await page.goto(origin);
  await expect(page.getByRole("region", { name: "Card design", exact: true })).toHaveCount(0);
  await page.getByLabel("Name on card", { exact: true }).fill("Owner correction");
  await page.getByLabel("Choose a card photo", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: card });
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Read card", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("Owner correction");
  await expect(page.getByTestId("secure-card-pan-input")).toHaveValue("");
  await expect.poll(() => page.workers().length).toBe(0); expect(record).toBeNull();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cards" })).toBeVisible();
  expect(record).toBeNull();
});
for (const width of [320, 390, 1440]) test(`real OCR → owner approval → real encrypted write → Cards/reload/lock at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(180000); record = null; wire.length = 0; artworkMode = "unknown";
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 }); await page.goto(origin); await awaitProductFont(page);
  await page.getByLabel("Choose a card photo", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: card });
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Use full photo" }).click(); await page.getByRole("button", { name: "Read card", exact: true }).click();
  await expect(page.getByTestId("secure-card-pan-input")).toHaveValue("4242424242424242", { timeout: 120000 });
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("ALEX SAMPLE"); await expect(page.getByLabel("Expiry (MM/YY)", { exact: true })).toHaveValue("12/30");
  expect(record).toBeNull();
  await page.getByRole("button", { name: "I checked — use photo" }).click();
  const action = page.getByRole("button", { name: "Add to Wallet", exact: true }); await expect(action).toBeEnabled();
  await expect.poll(() => action.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#root").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath(`scan-preview-${width}.png`) });
  await action.click(); await expect(page.getByRole("region", { name: "Cards" })).toBeVisible();
  const id = await page.locator("[data-card-id]").getAttribute("data-card-id"); expect(id).toMatch(/^card_[0-9a-f-]{36}$/);
  expect(record?.encrypted_blob.segments.artwork).toBeTruthy(); expect(record?.manifest.paths.find((row: any) => row.json_path === "artwork").exposure_eligibility).toBe(false);
  for (const value of ["4242424242424242", "ALEX SAMPLE", "data:image", '"cvv"', '"pin"', '"cardholder_name"']) expect(wire.join("\n")).not.toContain(value);
  const digest = await page.locator('[data-card-artwork="photo"]').getAttribute("data-artwork-digest");
  await page.reload(); await expect(page.locator(`[data-card-id="${id}"]`)).toBeVisible(); await expect(page.locator('[data-card-artwork="photo"] img')).toBeVisible();
  expect(await page.locator('[data-card-artwork="photo"]').getAttribute("data-artwork-digest")).toBe(digest);
  await page.locator("#root").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath(`saved-card-${width}.png`) });
  await page.getByRole("button", { name: "Lock Wallet" }).click(); await expect(page.getByText("Wallet locked", { exact: true })).toBeVisible(); expect(await page.locator("[data-card-id]").count()).toBe(0);
  expect(errors).toEqual([]);
});

async function enterOwnedCard(page: import("@playwright/test").Page) {
  await page.getByLabel("Card number", { exact: true }).fill("4242424242424242");
  await page.getByLabel("Name on card", { exact: true }).fill("ALEX SAMPLE");
  await page.getByLabel("Expiry (MM/YY)", { exact: true }).fill("12/30");
}

for (const width of [320, 390, 1440]) test(`approved artwork chooser reference at ${width}px`, async ({ page }, testInfo) => {
  record = null; wire.length = 0; artworkMode = "ambiguous";
  await page.setViewportSize({ width, height: 1000 }); await page.goto(origin); await awaitProductFont(page); await enterOwnedCard(page);
  await expect(page.getByRole("button", { name: "Test Blue", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Test Blue", exact: true }).scrollIntoViewIfNeeded();
  const images = page.getByLabel("Approved card designs").locator("img");
  await expect(images).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath(`artwork-chooser-${width}.png`) });
  const save = page.getByRole("button", { name: "Add to Wallet", exact: true }), cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await save.scrollIntoViewIfNeeded();
  const saveBox = await save.boundingBox(), cancelBox = await cancel.boundingBox();
  expect(saveBox).not.toBeNull(); expect(cancelBox).not.toBeNull();
  expect(saveBox!.x).toBeGreaterThanOrEqual(cancelBox!.x + cancelBox!.width);
  expect(Math.abs(saveBox!.y - cancelBox!.y)).toBeLessThan(1);
  expect(saveBox!.height).toBeGreaterThanOrEqual(44); expect(cancelBox!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: /Use (?:a simple|neutral) design/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath(`add-actions-${width}.png`) });
  await page.locator('[data-ui-role="flow-actions"]').screenshot({ path: testInfo.outputPath(`add-actions-footer-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("approved variant → encrypted save → reload → change design preserves identity → revocation fallback", async ({ page }, testInfo) => {
  test.setTimeout(180000);
  record = null; wire.length = 0; artworkMode = "ambiguous";
  await page.setViewportSize({ width: 390, height: 1000 }); await page.goto(origin);
  await page.getByLabel("Choose a card photo", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: card });
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Use full photo" }).click();
  await page.getByRole("button", { name: "Read card", exact: true }).click();
  await expect(page.getByLabel("Card number", { exact: true })).toHaveValue("4242424242424242", { timeout: 120000 });
  await page.getByRole("button", { name: "Test Gold", exact: true }).click();
  await expect(page.getByRole("button", { name: "Test Gold", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Add to Wallet", exact: true }).click();
  await expect(page.locator('[data-card-artwork="catalog"] img')).toBeVisible();
  const id = await page.locator("[data-card-id]").getAttribute("data-card-id");
  const digest = await page.locator('[data-card-artwork="catalog"]').getAttribute("data-artwork-digest");
  await page.reload();
  await expect(page.locator(`[data-card-id="${id}"]`)).toBeVisible();
  await expect(page.locator('[data-card-artwork="catalog"]')).toHaveAttribute("data-artwork-digest", digest!);
  await page.getByRole("button", { name: "Change card design", exact: true }).click();
  await page.getByRole("button", { name: "Test Blue", exact: true }).click();
  await page.getByRole("button", { name: "Save design", exact: true }).click();
  await expect(page.locator(`[data-card-id="${id}"] [data-card-artwork="catalog"]`).first()).toHaveAttribute("data-artwork-digest", String(approvedArt[0]!.variant.digest));
  await page.reload(); await expect(page.locator(`[data-card-id="${id}"]`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("approved-saved-card-390.png") });
  for (const value of ["4242424242424242", "ALEX SAMPLE", "data:image", '"cvv"', '"pin"']) expect(wire.join("\n")).not.toContain(value);
  expect(record?.manifest.paths.find((row: any) => row.json_path === "artwork").exposure_eligibility).toBe(false);
  artworkMode = "revoked"; await page.reload();
  await expect(page.locator(`[data-card-id="${id}"]`)).toBeVisible();
  await expect(page.locator('[data-card-artwork="catalog"]')).toHaveCount(0);
});

test("exact artwork selects automatically; an unavailable provider keeps saving available", async ({ page }) => {
  record = null; wire.length = 0; artworkMode = "exact"; await page.goto(origin); await enterOwnedCard(page);
  await expect(page.getByRole("button", { name: "Test Blue", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Use a simple design" })).toHaveCount(0);
  artworkMode = "outage"; await page.reload();
  const unavailable = page.waitForResponse(response => response.url().endsWith("/artwork/resolve") && response.status() === 503);
  await enterOwnedCard(page); await unavailable;
  await expect(page.getByRole("region", { name: "Card design", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to Wallet", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Add to Wallet", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cards" })).toBeVisible();
  await expect(page.locator('[data-card-artwork="catalog"]')).toHaveCount(0);
});

for (const width of [390, 1440]) test(`atlas bank designs rotate privately and persist for two cards at ${width}px`, async ({ page }, testInfo) => {
  record = null; wire.length = 0; artworkMode = "unknown"; bankMode = true;
  try {
    await page.setViewportSize({ width, height: width > 800 ? 1300 : 1000 }); await page.goto(origin); await awaitProductFont(page);
    const add = async (pan: string) => {
      await page.getByLabel("Card number", { exact: true }).fill(pan);
      await page.getByLabel("Name on card", { exact: true }).fill("SYNTHETIC OWNER");
      await page.getByLabel("Expiry (MM/YY)", { exact: true }).fill("12/30");
      await page.getByLabel("Bank (optional)").click(); await page.getByRole("option", { name: "HDFC Bank · IN" }).click();
      await expect(page.getByTestId("wallet-card-face")).toHaveAttribute("data-card-artwork", "catalog");
      const digest = await page.getByTestId("wallet-card-face").getAttribute("data-artwork-digest");
      await expect(page.getByTestId("secure-card-save")).toBeEnabled(); await page.getByTestId("secure-card-save").click();
      await expect(page.getByRole("region", { name: "Cards", exact: true })).toBeVisible();
      return digest;
    };
    const first = await add("5555555555554444");
    await page.getByRole("button", { name: "Add another card", exact: true }).click();
    const second = await add("5105105105105100"); expect(second).not.toBe(first);
    const ids = await page.locator("[data-card-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-card-id")));
    expect(ids).toHaveLength(2);
    await page.reload(); await awaitProductFont(page);
    await expect(page.getByTestId("wallet-card-face")).toHaveCount(2);
    const digests = await page.getByTestId("wallet-card-face").evaluateAll(elements => elements.map(element => element.getAttribute("data-artwork-digest")));
    expect(digests).toEqual(expect.arrayContaining([first, second]));
    expect(await page.locator("[data-card-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-card-id")))).toEqual(ids);
    expect(wire.every(body => !body.includes("5555555555554444") && !body.includes("5105105105105100"))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`atlas-two-cards-${width}.png`), fullPage: true });
  } finally { bankMode = false; }
});
