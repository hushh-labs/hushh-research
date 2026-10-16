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
let approvedArt: { bytes: Buffer; variant: Record<string, unknown>; mime?: string; network?: string; selectable?: boolean; replacementId?: string; historical?: boolean }[] = [];
let atlasArt: typeof approvedArt = [], bankMode = false, atlasVersion = "";
let atlasRevision: "previous" | "current" = "current";
let focusedArtworkId: string | null = null;
test.beforeAll(async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-full-flow-"));
  const { build } = await import("vite"), { Scanner } = await import("@tailwindcss/oxide"), { compile } = await import("tailwindcss");
  const sharp = (await import("sharp")).default;
  // Requester-authorized, reviewed actual atlas files; card input remains synthetic.
  const atlasRoot = path.join(root, "../consent-protocol/hushh_mcp/resources/wallet-artwork");
  const atlas = JSON.parse(fs.readFileSync(path.join(atlasRoot, "catalog.json"), "utf8"));
  atlasVersion = atlas.version;
  atlasArt = atlas.assets.map((row: any) => ({ network: row.network, mime: row.mime, selectable: row.selectable !== false, historical: !row.asset_id.endsWith("-clean-v2"), replacementId: row.replacement_asset_id, bytes: fs.readFileSync(path.join(atlasRoot, "assets", row.digest + ".webp")), variant: { assetId: row.asset_id, issuerId: row.issuer_id, productId: row.product_id, variantId: row.variant_id, label: row.label, issuerName: row.issuer_name, productName: row.product_name, variantName: row.variant_name, country: row.country, digest: row.digest, allowOverlay: row.allow_overlay, image: `/api/one/wallet/card-access/artwork/assets/${row.digest}`, replaces: atlas.assets.filter((old: any) => old.replacement_asset_id === row.asset_id).map((old: any) => ({ assetId: old.asset_id, digest: old.digest })) } }));
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
      if (url.endsWith("/networks/resolve")) { const network = JSON.parse(body).selectedNetwork || "visa"; json({ network, source: "prefix", candidates: [network] }); return; }
      if (url.endsWith("/artwork/banks")) {
        if (req.headers.authorization !== "Bearer synthetic-test-token" || req.headers["x-hushh-consent"] !== "synthetic-owner-token") { res.statusCode = 403; json({ error: "Unavailable" }); return; }
        const input = JSON.parse(body);
        if (artworkMode === "outage") { res.statusCode = 503; json({ error: "Unavailable" }); return; }
        const variants = bankMode ? atlasArt.filter(row => row.network === input.network && (!focusedArtworkId || row.variant.assetId === focusedArtworkId) && (atlasRevision === "previous" ? row.historical : row.selectable)).map(row => atlasRevision === "previous" ? { ...row.variant, allowOverlay: false, replaces: [] } : row.variant) : artworkMode === "ambiguous" || artworkMode === "exact" ? approvedArt.map(row => row.variant) : [];
        json({ catalogVersion: bankMode ? atlasRevision === "previous" ? "atlas-adapted-20261015-v1" : atlasVersion : "owned-1", network: input.network, selectionBasis: "network_illustration", requiresConfirmation: false, bankKey: null, banks: [], variants: variants.slice(input.offset, input.offset + 24), nextOffset: variants.length > input.offset + 24 ? input.offset + 24 : null }); return;
      }

      if (url.endsWith("/artwork/resolve")) {
        if (artworkMode === "outage") { res.statusCode = 503; json({ error: "Unavailable" }); return; }
        json({ match: artworkMode === "exact" ? "exact" : artworkMode === "ambiguous" ? "ambiguous" : "unknown", provider: artworkMode === "unknown" ? "unconfigured" : "configured", issuerId: "owned-test-bank", catalogVersion: "owned-1", variants: artworkMode === "exact" ? [approvedArt[0]!.variant] : artworkMode === "ambiguous" ? approvedArt.map(row => row.variant) : [] }); return;
      }
      if (url.endsWith("/artwork/validate")) {
        const input = JSON.parse(body);
        json({ selections: input.selections.map((selection: Record<string, string>) => {
          const asset = (bankMode ? atlasArt : approvedArt).find(row => row.variant.assetId === selection.assetId);
          const target = bankMode && atlasRevision === "current" && input.purpose === "saved" ? atlasArt.find(row => row.variant.assetId === asset?.replacementId) : undefined;
          const approved = Boolean(asset && artworkMode !== "revoked" && ["digest", "issuerId", "productId", "variantId"].every(key => asset.variant[key] === selection[key]) && (input.purpose === "saved" || !bankMode || (atlasRevision === "previous" ? asset.historical : asset.selectable)));
          return { assetId: selection.assetId, approved, allowOverlay: approved && (atlasRevision !== "previous" || !bankMode) && asset!.variant.allowOverlay === true, ...(approved && target ? { replacement: { catalogVersion: atlasVersion, variant: target.variant } } : {}) };
        }) }); return;
      }
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
test("manual CVV stays masked, encrypts, reloads and reveals only to the owner", async ({ page }, testInfo) => {
  record = null; wire.length = 0; artworkMode = "unknown";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/?cvv-proof=1`); await awaitProductFont(page);
  await page.getByLabel("Card number", { exact: true }).fill("4242424242424242");
  await page.getByLabel("Name on card", { exact: true }).fill("SYNTHETIC OWNER");
  await page.getByLabel("Expiry (MM/YY)", { exact: true }).fill("1230");
  const code = page.getByLabel("CVV", { exact: true });
  await expect(code).toHaveAttribute("type", "password");
  await code.fill("0931");
  await expect(page.getByTestId("secure-card-save")).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await code.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("wallet-cvv-entry.png") });
  await page.getByTestId("secure-card-save").click();
  await expect(page.getByRole("region", { name: "Cards" })).toBeVisible();
  expect(record).not.toBeNull();
  expect(wire.join("\n")).not.toMatch(/"(?:manual_cvv|securityCode|0931)"/);
  await expect(page.getByTestId("wallet-owner-cvv")).toHaveText("•••");
  await page.reload();
  await expect(page.getByTestId("wallet-owner-cvv")).toHaveText("•••");
  await page.getByRole("button", { name: "Show CVV" }).click();
  await expect(page.getByTestId("wallet-owner-cvv")).toHaveText("0931");
  await page.getByRole("button", { name: "Hide CVV" }).click();
  await expect(page.getByTestId("wallet-owner-cvv")).toHaveText("•••");
  await page.getByRole("button", { name: "Lock Wallet" }).click();
  await expect(page.getByText("Wallet locked", { exact: true })).toBeVisible();
  await expect(page.getByTestId("wallet-owner-cvv")).toHaveCount(0);
});
test("Back cancels the crop/read layer and keeps the Add draft in place", async ({ page }) => {
  record = null; wire.length = 0; artworkMode = "unknown"; await page.goto(origin);
  await expect(page.getByRole("region", { name: "Card design", exact: true })).toHaveCount(0);
  await page.getByLabel("Name on card", { exact: true }).fill("Owner correction");
  await page.getByLabel("Choose a card photo", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: card });
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toBeEnabled();
  const corner = page.getByRole("button", { name: "Top left crop corner", exact: true });
  const handleBox = await corner.boundingBox();
  expect(handleBox!.width).toBeCloseTo(44, 1); expect(handleBox!.height).toBeCloseTo(44, 1);
  await corner.focus(); await corner.press("ArrowRight");
  await expect(corner).toHaveCSS("left", /.+px/);
  await page.getByRole("button", { name: "Read card", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("OWNER CORRECTION");
  await expect(page.getByTestId("secure-card-pan-input")).toHaveValue("");
  await expect.poll(() => page.workers().length).toBe(0); expect(record).toBeNull();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cards" })).toBeVisible();
  expect(record).toBeNull();
});
for (const width of [320, 390, 1440]) test(`real OCR → owner approval → real encrypted write → Cards/reload/lock at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(180000); record = null; wire.length = 0; artworkMode = "ambiguous";
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  if (width < 640) await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException("Synthetic permission rejection", "NotAllowedError")) } });
  });
  await page.setViewportSize({ width, height: 900 }); await page.goto(origin); await awaitProductFont(page);
  if (width < 640) {
    await page.getByRole("button", { name: "Scan card", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Camera unavailable" })).toBeVisible();
    const capture = page.getByRole("region", { name: "Photograph your card", exact: true });
    for (const name of ["Take photo", "Choose from photos", "Cancel"]) {
      const box = await capture.getByRole("button", { name, exact: true }).boundingBox();
      expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: testInfo.outputPath(`camera-photo-fallback-${width}.png`) });
  }
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose from photos", exact: true }).click();
  await (await chooser).setFiles({ name: "synthetic.png", mimeType: "image/png", buffer: card });
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toBeEnabled();
  const handle = page.getByRole("button", { name: "Top left crop corner", exact: true });
  const box = await handle.boundingBox();
  expect(box!.width).toBeCloseTo(44, 1); expect(box!.height).toBeCloseTo(44, 1);
  await page.mouse.move(box!.x + 22, box!.y + 22); await page.mouse.down();
  await page.mouse.move(box!.x + 32, box!.y + 32, { steps: 5 }); await page.mouse.up();
  expect(await handle.evaluate(el => parseFloat((el as HTMLElement).style.left))).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath(`card-crop-handles-${width}.png`) });
  await page.getByRole("button", { name: "Use full photo" }).click(); await page.getByRole("button", { name: "Read card", exact: true }).click();
  await expect(page.getByTestId("secure-card-pan-input")).toHaveValue("4242 4242 4242 4242", { timeout: 120000 });
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("ALEX SAMPLE"); await expect(page.getByLabel("Expiry (MM/YY)", { exact: true })).toHaveValue("12/30");
  expect(record).toBeNull();
  const action = page.getByRole("button", { name: "Add to Wallet", exact: true }); await expect(action).toBeEnabled();
  await expect.poll(() => action.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#root").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath(`scan-preview-${width}.png`) });
  await action.click(); await expect(page.getByRole("region", { name: "Cards" })).toBeVisible();
  const id = await page.locator("[data-card-id]").getAttribute("data-card-id"); expect(id).toMatch(/^card_[0-9a-f-]{36}$/);
  expect(record?.encrypted_blob.segments.artwork).toBeTruthy(); expect(record?.manifest.paths.find((row: any) => row.json_path === "artwork").exposure_eligibility).toBe(false);
  for (const value of ["4242424242424242", "ALEX SAMPLE", "data:image", '"cvv"', '"pin"', '"cardholder_name"']) expect(wire.join("\n")).not.toContain(value);
  const digest = await page.locator('[data-card-artwork="catalog"]').getAttribute("data-artwork-digest");
  await page.reload(); await expect(page.locator(`[data-card-id="${id}"]`)).toBeVisible(); await expect(page.locator('[data-card-artwork="catalog"] img')).toBeVisible();
  expect(await page.locator('[data-card-artwork="catalog"]').getAttribute("data-artwork-digest")).toBe(digest);
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

for (const width of [320, 390, 1440]) test(`automatic artwork form at ${width}px`, async ({ page }, testInfo) => {
  record = null; wire.length = 0; artworkMode = "ambiguous";
  await page.setViewportSize({ width, height: 1000 }); await page.goto(origin); await awaitProductFont(page); await enterOwnedCard(page);
  await expect(page.getByLabel("Bank (optional)")).toHaveCount(0);
  await expect(page.getByLabel("Approved card designs")).toHaveCount(0);
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

test("automatic network artwork survives encrypted reload and falls back after revocation", async ({ page }) => {
  record = null; wire.length = 0; artworkMode = "ambiguous";
  await page.goto(origin); await enterOwnedCard(page);
  await page.getByRole("button", { name: "Add to Wallet", exact: true }).click();
  await expect(page.locator('[data-card-artwork="catalog"] img')).toBeVisible();
  const id = await page.locator("[data-card-id]").getAttribute("data-card-id");
  const digest = await page.locator('[data-card-artwork="catalog"]').getAttribute("data-artwork-digest");
  await page.reload();
  await expect(page.locator(`[data-card-id="${id}"] [data-card-artwork="catalog"]`)).toHaveAttribute("data-artwork-digest", digest!);
  artworkMode = "revoked"; await page.reload();
  await expect(page.locator(`[data-card-id="${id}"]`)).toBeVisible();
  await expect(page.locator('[data-card-artwork="catalog"]')).toHaveCount(0);
});

test("an unavailable artwork catalog keeps saving available without a chooser", async ({ page }) => {
  record = null; wire.length = 0; artworkMode = "outage"; await page.goto(origin); await enterOwnedCard(page);
  await expect(page.getByLabel("Bank (optional)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to Wallet", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Add to Wallet", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cards" })).toBeVisible();
  await expect(page.locator('[data-card-artwork="catalog"]')).toHaveCount(0);
});

const networkPans: Record<string, [string, string]> = {
  Visa: ["4242424242424242", "4111111111111111"],
  Mastercard: ["5555555555554444", "5105105105105100"],
  "American Express": ["378282246310005", "371449635398431"],
  Discover: ["6011111111111117", "6011000990139424"],
  RuPay: ["6080018765432101", "6080010000000009"],
};
async function addNetworkCard(page: import("@playwright/test").Page, network: string, pan: string, holder = "SYNTHETIC OWNER") {
  await page.getByLabel("Card number", { exact: true }).fill(pan);
  await page.getByLabel("Name on card", { exact: true }).fill(holder);
  await page.getByLabel("Expiry (MM/YY)", { exact: true }).fill("12/30");
  await page.getByTestId("secure-card-network-select").click();
  await page.getByRole("option", { name: network, exact: true }).click();
  await expect(page.getByLabel("Bank (optional)")).toHaveCount(0);
  await expect(page.getByLabel("Approved card designs")).toHaveCount(0);
  await expect(page.getByTestId("secure-card-save")).toBeEnabled(); await page.getByTestId("secure-card-save").click();
  await expect(page.getByRole("region", { name: "Cards", exact: true })).toBeVisible();
}

async function expectEmbeddedDetails(page: import("@playwright/test").Page) {
  for (const face of await page.locator('[data-card-artwork="catalog"]').all()) {
    await expect(face).toHaveAttribute("data-artwork-ready", "true");
    await expect(face.locator("img")).toBeVisible();
    const geometry = await face.evaluate(el => {
      const bounds = el.getBoundingClientRect(), plane = el.querySelector('[data-slot="wallet-card-artwork-plane"]')!.getBoundingClientRect();
      const fields = [...el.querySelectorAll('[data-slot="wallet-card-number"] > [aria-hidden], [data-slot="wallet-card-holder"], [data-slot="wallet-card-expiry"]')].map(field => field.getBoundingClientRect());
      const holder = el.querySelector('[data-slot="wallet-card-holder"]')!.getBoundingClientRect(), expiry = el.querySelector('[data-slot="wallet-card-expiry"]')!.getBoundingClientRect();
      const details = el.querySelector('[data-slot="wallet-card-embedded-details"]')!.getBoundingClientRect();
      return { ratio: bounds.width / bounds.height, planeWidth: plane.width, width: bounds.width, contained: fields.every(field => field.left >= plane.left - 1 && field.right <= plane.right + 1 && field.top >= plane.top - 1 && field.bottom <= plane.bottom + 1), separated: holder.right < expiry.left, brandingReserved: details.right <= bounds.left + bounds.width * 0.71 };
    });
    expect(geometry.ratio).toBeCloseTo(85.6 / 53.98, 2);
    expect(Math.abs(geometry.planeWidth - geometry.width)).toBeLessThan(3);
    expect(geometry.contained).toBe(true); expect(geometry.separated).toBe(true); expect(geometry.brandingReserved).toBe(true);
    await expect(face.locator('[data-slot="wallet-card-holder"]')).toContainText("SYNTHETIC OWNER");
    await expect(face.locator('[data-slot="wallet-card-expiry"]')).toContainText("12/30");
  }
}

for (const width of [320, 390, 1440]) for (const [network, pans] of Object.entries(networkPans)) test(`atlas ${network} designs rotate automatically and persist at ${width}px`, async ({ page }, testInfo) => {
  record = null; wire.length = 0; artworkMode = "unknown"; bankMode = true;
  try {
    await page.setViewportSize({ width, height: width > 800 ? 1300 : 1000 }); await page.goto(origin); await awaitProductFont(page);
    const add = async (pan: string) => {
      await addNetworkCard(page, network, pan, width === 320 ? "SYNTHETIC OWNER WITH A VERY LONG FULL NAME" : "SYNTHETIC OWNER");
      const faces = page.locator('[data-card-artwork="catalog"]');
      const digests = await faces.evaluateAll(elements => elements.map(el => el.getAttribute("data-artwork-digest")));
      for (const image of await faces.locator("img").all()) await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expectEmbeddedDetails(page);
      for (const pan of pans) expect(await page.getByRole("region", { name: "Cards", exact: true }).innerText()).not.toContain(pan);
      return digests.at(-1)!;
    };
    const first = await add(pans[0]);
    await page.getByRole("button", { name: "Add another card", exact: true }).click();
    const second = await add(pans[1]); expect(second).not.toBe(first);
    const ids = await page.locator("[data-card-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-card-id")));
    expect(ids).toHaveLength(2);
    await page.reload(); await awaitProductFont(page);
    await expect(page.getByTestId("wallet-card-face")).toHaveCount(2);
    const digests = await page.getByTestId("wallet-card-face").evaluateAll(elements => elements.map(element => element.getAttribute("data-artwork-digest")));
    expect(digests).toEqual(expect.arrayContaining([first, second]));
    expect(await page.locator("[data-card-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-card-id")))).toEqual(ids);
    expect(wire.every(body => pans.every(pan => !body.includes(pan)))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`atlas-${network}-two-cards-${width}.png`), fullPage: true });
  } finally { bankMode = false; }
});

for (const width of [320, 390]) test(`embedded details reserve fixed card branding at ${width}px`, async ({ page }) => {
  record = null; artworkMode = "unknown"; bankMode = true;
  try {
    await page.setViewportSize({ width, height: 1000 }); await page.goto(origin);
    for (const [index, id] of ["atlas-085", "atlas-056", "atlas-057"].entries()) {
      if (index) await page.getByRole("button", { name: "Add another card", exact: true }).click();
      focusedArtworkId = id;
      await addNetworkCard(page, index ? "RuPay" : "Discover", index ? networkPans.RuPay![index === 1 ? 0 : 1] : networkPans.Discover![0]);
      await expectEmbeddedDetails(page);
      const geometry = await page.getByTestId("wallet-card-face").last().evaluate(el => {
        const face = el.getBoundingClientRect(), details = el.querySelector('[data-slot="wallet-card-embedded-details"]')!.getBoundingClientRect();
        return { bottom: (details.bottom - face.top) / face.height, right: (details.right - face.left) / face.width };
      });
      expect(geometry.bottom).toBeLessThan(index ? 0.86 : 0.73);
      if (!index) expect(geometry.right).toBeLessThan(0.51);
    }
  } finally { focusedArtworkId = null; bankMode = false; }
});

for (const network of ["American Express", "RuPay"]) test(`saved ${network} blurred or portrait artwork adopts the clean landscape revision without rewriting the vault`, async ({ page }) => {
  record = null; wire.length = 0; artworkMode = "unknown"; bankMode = true; atlasRevision = "previous";
  try {
    await page.setViewportSize({ width: 390, height: 1000 }); await page.goto(origin);
    for (const [index, pan] of networkPans[network]!.entries()) {
      if (index) await page.getByRole("button", { name: "Add another card", exact: true }).click();
      await addNetworkCard(page, network, pan);
    }
    const old = await page.getByTestId("wallet-card-face").evaluateAll(elements => elements.map(el => el.getAttribute("data-artwork-digest")));
    const saved = JSON.stringify(record);
    atlasRevision = "current"; await page.reload(); await awaitProductFont(page);
    await expect(page.locator('[data-card-artwork="catalog"]')).toHaveCount(2);
    await expectEmbeddedDetails(page);
    const current = await page.getByTestId("wallet-card-face").evaluateAll(elements => elements.map(el => el.getAttribute("data-artwork-digest")));
    expect(old.some(digest => atlasArt.find(row => row.variant.digest === digest)?.replacementId)).toBe(true);
    for (const [index, digest] of old.entries()) {
      const replacement = atlasArt.find(row => row.variant.digest === digest)!.replacementId;
      expect(current[index]).toBe(replacement ? atlasArt.find(row => row.variant.assetId === replacement)!.variant.digest : digest);
    }
    expect(JSON.stringify(record)).toBe(saved);
    await page.getByRole("button", { name: "Add another card", exact: true }).click();
    await addNetworkCard(page, network, networkPans[network]![0]);
    const repeated = await page.getByTestId("wallet-card-face").evaluateAll(elements => elements.map(el => el.getAttribute("data-artwork-digest")));
    expect(repeated.at(-1)).toBe(current[0]);
  } finally { bankMode = false; atlasRevision = "current"; }
});

for (const network of ["American Express", "Discover", "RuPay"]) test(`legacy ${network} blue cards recover original atlas images without rewriting the vault`, async ({ page }, testInfo) => {
  record = null; wire.length = 0; artworkMode = "outage"; bankMode = true;
  try {
    await page.setViewportSize({ width: 390, height: 1000 }); await page.goto(origin);
    for (const [index, pan] of networkPans[network]!.entries()) {
      if (index) await page.getByRole("button", { name: "Add another card", exact: true }).click();
      await addNetworkCard(page, network, pan);
    }
    await expect(page.locator('[data-card-artwork="catalog"]')).toHaveCount(0);
    const saved = JSON.stringify(record);
    const ids = await page.locator("[data-card-id]").evaluateAll(elements => elements.map(el => el.getAttribute("data-card-id")));
    artworkMode = "unknown"; await page.reload(); await awaitProductFont(page);
    const faces = page.locator('[data-card-artwork="catalog"]'); await expect(faces).toHaveCount(2);
    const digests = await faces.evaluateAll(elements => elements.map(el => el.getAttribute("data-artwork-digest")));
    expect(new Set(digests).size).toBe(2);
    const networkId = network === "American Express" ? "amex" : network.toLowerCase();
    for (const digest of digests) expect(atlasArt.some(row => row.network === networkId && row.variant.digest === digest)).toBe(true);
    for (const image of await faces.locator("img").all()) await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(JSON.stringify(record)).toBe(saved);
    await page.reload(); await expect(page.locator('[data-card-artwork="catalog"]')).toHaveCount(2);
    expect(await page.locator('[data-card-artwork="catalog"]').evaluateAll(elements => elements.map(el => el.getAttribute("data-artwork-digest")))).toEqual(digests);
    expect(await page.locator("[data-card-id]").evaluateAll(elements => elements.map(el => el.getAttribute("data-card-id")))).toEqual(ids);
    expect(JSON.stringify(record)).toBe(saved);
    for (const pan of networkPans[network]!) expect(wire.join("\n")).not.toContain(pan);
    await page.screenshot({ path: testInfo.outputPath(`recovered-${network}-390.png`), fullPage: true });
  } finally { bankMode = false; }
});
