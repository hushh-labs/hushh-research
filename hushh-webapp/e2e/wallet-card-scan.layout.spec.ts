import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
let server: Server;
let origin: string;
let failLanguage = false;
let syntheticCard: Buffer;
const photos = new Map<string, Buffer>();
const numbers = { visa13: "4222222222222", diners14: "30569309025904", amex15: "378282246310005", mastercard16: "5555555555554444", discover16: "6011111111111117", rupay16: "6080018765432101", visa19: "4000000000000000006" };
test.beforeAll(async () => {
  const { build } = await import("vite");
  const root = process.cwd();
  const sharp = (await import("sharp")).default;
  syntheticCard = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="white"/><g font-family="Arial" font-size="56" fill="black"><text x="80" y="140">DEMO CARD</text><text x="80" y="350">4242 4242 4242 4242</text><text x="80" y="480">VALID THRU 12/30</text><text x="80" y="620">ALEX SAMPLE</text></g></svg>')).png().toBuffer();
  photos.set("dim", await sharp(syntheticCard).linear(.12, 5).png().toBuffer());
  photos.set("low-contrast", await sharp(syntheticCard).linear(.04, 30).png().toBuffer());
  photos.set("shadow", await sharp(syntheticCard).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><defs><linearGradient id="s"><stop stop-color="black" stop-opacity=".94"/><stop offset="1" stop-color="black" stop-opacity=".2"/></linearGradient></defs><rect width="1200" height="750" fill="url(#s)"/></svg>'), blend: "over" }]).png().toBuffer());
  photos.set("dark", await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="#111827"/><g font-family="Arial" font-size="56" fill="#fafafa"><text x="80" y="140">SYNTHETIC CARD</text><text x="80" y="350">4242 4242 4242 4242</text><text x="80" y="480">VALID THRU 12/30</text><text x="80" y="620">ALEX SAMPLE</text></g></svg>')).png().toBuffer());
  photos.set("embossed-style", await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><defs><linearGradient id="metal"><stop stop-color="#e4d5a5"/><stop offset=".5" stop-color="#b8ad83"/><stop offset="1" stop-color="#e6d7a6"/></linearGradient><filter id="raised"><feDropShadow dx="-1" dy="-1" stdDeviation=".3" flood-color="white" flood-opacity=".9"/><feDropShadow dx="2" dy="2" stdDeviation=".6" flood-color="black" flood-opacity=".6"/></filter></defs><rect width="1200" height="750" fill="url(#metal)"/><g font-family="Arial" font-size="56" fill="#41423e" filter="url(#raised)"><text x="80" y="140">SYNTHETIC CARD</text><text x="80" y="350">4242 4242 4242 4242</text><text x="80" y="480">VALID THRU 12/30</text><text x="80" y="620">ALEX SAMPLE</text></g></svg>')).png().toBuffer());
  photos.set("blank", await sharp({ create: { width:1200,height:750,channels:3,background:"#080808" } }).png().toBuffer());
  for (const [name, pan] of Object.entries(numbers)) photos.set(name, await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="756"><rect width="1200" height="756" fill="white"/><g font-family="Arial" font-size="50" fill="black"><text x="80" y="140">SYNTHETIC CARD</text><text x="80" y="350">${pan.match(/.{1,4}/g)!.join(" ")}</text><text x="80" y="480">VALID THRU 12/30</text><text x="80" y="630">ALEX SAMPLE</text></g></svg>`)).png().toBuffer());
  for (const angle of [90, 180, 270]) photos.set(`rotated${angle}`, await sharp(syntheticCard).rotate(angle).png().toBuffer());
  photos.set("perspective", await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="950"><rect width="1400" height="950" fill="#334155"/><image href="data:image/png;base64,${syntheticCard.toString("base64")}" width="1200" height="750" transform="matrix(1 .08 .1 1 60 30)"/></svg>`)).png().toBuffer());
  photos.set("glare", await sharp(syntheticCard).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect x="520" width="170" height="750" fill="white" opacity=".28"/></svg>') }]).png().toBuffer());
  photos.set("full-photo", await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#bbb7b1" } }).composite([{ input: await sharp(syntheticCard).resize(1000).toBuffer(), left: 300, top: 280 }]).png().toBuffer());
  photos.set("partial", await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="white"/><g font-family="Arial" font-size="56"><text x="80" y="480">EXPIRY 12/30</text><text x="80" y="620">ALEX SAMPLE</text></g></svg>')).png().toBuffer());
  photos.set("ambiguous", await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="white"/><g font-family="Arial" font-size="52"><text x="80" y="180">4242 4242 4242 4242</text><text x="80" y="330">5555 5555 5555 4444</text><text x="80" y="480">EXPIRY 12/30</text><text x="80" y="620">ALEX SAMPLE</text></g></svg>')).png().toBuffer());
  execFileSync(process.execPath, [path.join(root, "scripts/prepare-wallet-ocr.mjs")]);
  const dir = mkdtempSync(path.join(tmpdir(), "wallet-ocr-proof-"));
  const entry = path.join(dir, "entry.ts");
  writeFileSync(entry, `import { scanWalletCard, scanWalletCardForReview } from ${JSON.stringify(path.join(root, "lib/services/wallet-card-scan.ts").replaceAll("\\", "/"))}; window.scanWalletCard = scanWalletCard; window.scanWalletCardForReview = scanWalletCardForReview;`);
  await build({ configFile: false, publicDir: false, logLevel: "error", resolve: { alias: { "@": root } }, build: { outDir: dir, emptyOutDir: false, lib: { entry, name: "Scan", formats: ["iife"], fileName: () => "scan.js" } } });
  server = createServer((req, res) => {
    const name = new URL(req.url!, "http://localhost").pathname;
    if (name === "/synthetic-card.png") { res.setHeader("Content-Type", "image/png"); res.end(syntheticCard); return; }
    const variant = photos.get(name.slice(1).replace(/\.png$/, ""));
    if (variant) { res.setHeader("Content-Type", "image/png"); res.end(variant); return; }
    if (failLanguage && name.endsWith("eng.traineddata.gz")) { res.statusCode = 404; res.end(); return; }
    if (name === "/") { res.setHeader("Content-Type", "text/html"); res.end('<script src="/scan.js"></script>'); return; }
    const filename = name === "/scan.js" ? path.join(dir, "scan.js") : name === "/wallet/card-scan-worker.js" ? path.join(root, "public/wallet/card-scan-worker.js") : path.join(root, "public/vendor/wallet-ocr", path.basename(name));
    try { res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream"); res.end(readFileSync(filename)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });
test("reads a synthetic card with bundled OCR and no off-device requests", async ({ page }) => {
  test.setTimeout(120000);
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const photo = await (await fetch("/synthetic-card.png")).blob();
    return await (window as unknown as { scanWalletCard: (file: Blob, signal: AbortSignal) => Promise<{ pan: string }> }).scanWalletCard(photo, new AbortController().signal);
  });
  expect(result).toEqual({ pan: "4242424242424242", expiry: "12/30", cardholderName: "ALEX SAMPLE" });
  const unexpected = requests.filter(({ url, method, body }) => !(method === "GET" && body === null && (url.startsWith("blob:" + origin + "/") || url === origin + "/" || url === origin + "/scan.js" || url === origin + "/synthetic-card.png" || url === origin + "/wallet/card-scan-worker.js" || url.startsWith(origin + "/vendor/wallet-ocr/"))));
  expect(unexpected.map(({ url, method, body }) => ({ url: url.slice(0, 100), method, hasBody: body !== null }))).toEqual([]);
});

test("reads an uncropped 4:3 camera photo without forcing it into card proportions", async ({ page }) => {
  test.setTimeout(120000); await page.goto(origin);
  const result = await page.evaluate(async () => (window as any).scanWalletCardForReview(await (await fetch("/full-photo.png")).blob(), new AbortController().signal, { corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }));
  expect(result.fields).toEqual({ pan: "4242424242424242", expiry: "12/30", cardholderName: "ALEX SAMPLE" });
  await expect.poll(() => page.workers().length).toBe(0);
});

for (const condition of ["dim", "low-contrast", "shadow", "dark", "embossed-style", "rotated90", "rotated180", "rotated270", "glare"]) {
  test(`reads a ${condition} card photo`, async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(origin);
    const result = await page.evaluate(async (condition) => {
      const file = await (await fetch(`/${condition}.png`)).blob();
      return (window as unknown as { scanWalletCard: (file: Blob, signal: AbortSignal) => Promise<unknown> }).scanWalletCard(file, new AbortController().signal);
    }, condition);
    expect(result).toEqual({ pan: "4242424242424242", expiry: "12/30", cardholderName: "ALEX SAMPLE" });
    await expect.poll(() => page.workers().length).toBe(0);
  });
}

test("rejects a completely dark photo without inventing card details", async ({ page }) => {
  await page.goto(origin);
  const message = await page.evaluate(async () => {
    const file = await (await fetch("/blank.png")).blob();
    try {
      await (window as unknown as { scanWalletCard: (file: Blob, signal: AbortSignal) => Promise<unknown> }).scanWalletCard(file, new AbortController().signal);
      return "unexpected success";
    } catch (error) { return (error as Error).message; }
  });
  expect(message).toContain("No readable card details");
  await expect.poll(() => page.workers().length).toBe(0);
});

for (const [condition, pan] of Object.entries(numbers)) test(`recognizes synthetic ${condition} without manufacturing digits`, async ({ page }) => {
  await page.goto(origin);
  const result = await page.evaluate(async condition => (window as any).scanWalletCard(await (await fetch(`/${condition}.png`)).blob(), new AbortController().signal), condition);
  expect(result).toMatchObject({ pan, expiry: "12/30", cardholderName: "ALEX SAMPLE" }); await expect.poll(() => page.workers().length).toBe(0);
});
test("rectifies an owner-confirmed skewed quadrilateral", async ({ page }) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => (window as any).scanWalletCardForReview(await (await fetch("/perspective.png")).blob(), new AbortController().signal, { corners: [{ x:60/1400,y:30/950 }, { x:1260/1400,y:126/950 }, { x:1335/1400,y:876/950 }, { x:135/1400,y:780/950 }] }));
  expect(result.fields).toMatchObject({ pan: "4242424242424242", expiry: "12/30", cardholderName: "ALEX SAMPLE" });
});
test("preserves partial fields and refuses competing valid PANs", async ({ page }) => {
  await page.goto(origin);
  for (const condition of ["partial", "ambiguous"]) {
    const result = await page.evaluate(async condition => (window as any).scanWalletCardForReview(await (await fetch(`/${condition}.png`)).blob(), new AbortController().signal), condition);
    expect(result.fields.pan).toBeUndefined(); expect(result.fields).toMatchObject({ expiry: "12/30", cardholderName: "ALEX SAMPLE" });
    expect(result.states.pan).toBe(condition === "partial" ? "missing" : "needs_review");
  }
});
test("cancels actual OCR and terminates the owned worker", async ({ page }) => {
  await page.goto(origin);
  const error = await page.evaluate(async () => { const controller = new AbortController(), file = await (await fetch("/synthetic-card.png")).blob(); const result = (window as any).scanWalletCard(file, controller.signal); setTimeout(() => controller.abort(), 25); try { await result; return "success"; } catch (error) { return (error as Error).name; } });
  expect(error).toBe("AbortError"); await expect.poll(() => page.workers().length).toBe(0);
});

test("failed language initialization settles and releases its workers", async ({ page }) => {
  failLanguage = true;
  try {
    await page.goto(origin);
    const failed = await page.evaluate(async () => {
      try {
        const photo = await (await fetch("/synthetic-card.png")).blob();
        await (window as unknown as { scanWalletCard: (file: Blob, signal: AbortSignal) => Promise<unknown> }).scanWalletCard(photo, new AbortController().signal);
        return false;
      } catch { return true; }
    });
    expect(failed).toBe(true);
    await expect.poll(() => page.workers().length).toBe(0);
  } finally { failLanguage = false; }
});
