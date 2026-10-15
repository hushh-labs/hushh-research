import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { productFontStyle, stripAppFontFaces, awaitProductFont } from "./fixtures/product-font";
let server: Server, origin: string, card: Buffer, record: Record<string, any> | null = null;
const wire: string[] = [];
test.beforeAll(async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-full-flow-"));
  const { build } = await import("vite"), { Scanner } = await import("@tailwindcss/oxide"), { compile } = await import("tailwindcss");
  const sharp = (await import("sharp")).default;
  card = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="756"><rect width="1200" height="756" fill="#dbe8f8"/><g font-family="Arial" font-size="54" fill="#101827"><text x="80" y="135">SYNTHETIC CARD</text><text x="80" y="350">4242 4242 4242 4242</text><text x="80" y="480">VALID THRU 12/30</text><text x="80" y="630">ALEX SAMPLE</text></g></svg>')).png().toBuffer();
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
    if (req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      wire.push(body);
      if (url.endsWith("/store-domain")) { const payload = JSON.parse(body); record = { ...payload, revision: (record?.revision ?? 0) + 1 }; json({ success: true, data_version: record.revision }); return; }
      if (url.endsWith("/networks/resolve")) { json({ network: "visa", source: "prefix", candidates: ["visa"] }); return; }
      if (url.endsWith("/artwork/resolve")) { json({ match: "unknown", network: "visa", catalogVersion: "empty-1", variants: [] }); return; }
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
  record = null; wire.length = 0; await page.goto(origin);
  await page.getByLabel("Name on card", { exact: true }).fill("Owner correction");
  await page.getByLabel("Choose a card photo", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: card });
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Read card", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Read card", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Name on card", { exact: true })).toHaveValue("Owner correction");
  await expect(page.getByTestId("secure-card-pan-input")).toHaveValue("");
  await expect.poll(() => page.workers().length).toBe(0); expect(record).toBeNull();
});
for (const width of [320, 390, 1440]) test(`real OCR → owner approval → real encrypted write → Cards/reload/lock at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(180000); record = null; wire.length = 0;
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
