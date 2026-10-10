#!/usr/bin/env node
/** Focused headless proof of the actual PNG export. No app server, accounts, or external services. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { chromium, webkit } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundler = await rolldown({
  cwd: root,
  input: "virtual:wallet-image-proof",
  resolve: { alias: { "@": root } },
  plugins: [{
    name: "wallet-image-proof",
    resolveId(id) { if (id === "virtual:wallet-image-proof") return id; },
    load(id) {
      if (id === "virtual:wallet-image-proof") return `export * from ${JSON.stringify(path.join(root, "lib/wallet/wallet-card-image.ts"))}; export { decodePayload } from ${JSON.stringify(path.join(root, "components/wallet-card/__tests__/qr-code-test-decoder.ts"))};`;
    },
  }],
});
const bundle = await bundler.generate({ format: "iife", name: "WalletCardImages" });
await bundler.close();
for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  const unexpected = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "blob:" && url.origin === "http://wallet-image.test") {
      await route.continue();
    } else if (url.origin === "http://wallet-image.test" && /^\/wallet\/artwork\/(profile|referral|nws)-v1\.svg$/.test(url.pathname)) {
      await route.fulfill({ contentType: "image/svg+xml", body: await readFile(path.join(root, "public", url.pathname)) });
    } else if (url.href === "http://wallet-image.test/") {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Wallet image export verification</title>" });
    } else {
      unexpected.push(url.origin);
      await route.abort();
    }
  });
  await page.goto("http://wallet-image.test/");
  await page.addScriptTag({ content: bundle.output[0].code });
  for (const kind of ["profile", "referral", "nws"]) {
    const result = await page.evaluate(async (kind) => {
      const api = window.WalletCardImages;
      const profile = { ownerId: "qa-owner", displayName: "Ankit Kumar Singh", cardPayload: { username: "ankit.kumar.singh" }, memberSince: "2021-04-14T00:00:00Z", walletId: "wallet-1234abcd", shareUrl: "https://one.hushh.ai/c/profile-test-token", referralUrl: "https://one.hushh.ai/r/referral-test-slug" };
      const svg = await api.buildWalletCardSvg({ kind, profile });
      const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
      const file = await api.createWalletCardImageFile({ kind, profile });
      const pngUrl = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = pngUrl;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const qr = svgDocument.querySelector("[data-wallet-qr]");
        let decoded = null;
        if (qr) {
          const extent = Number(qr.getAttribute("viewBox").split(" ")[2]);
          const size = extent - 8;
          const modules = new Uint8Array(size * size);
          const left = Number(qr.getAttribute("x"));
          const top = Number(qr.getAttribute("y")) * canvas.height / 650;
          const qrWidth = Number(qr.getAttribute("width"));
          for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
            const px = Math.floor(left + (x + 4.5) * qrWidth / extent);
            const py = Math.floor(top + (y + 4.5) * qrWidth / extent);
            const offset = (py * canvas.width + px) * 4;
            modules[y * size + x] = pixels[offset] < 128 ? 1 : 0;
          }
          decoded = api.decodePayload({ size, modules });
        }
        // The exported face contains rendered art, rather than only text/QR on transparency.
        const artPixel = (Math.floor(canvas.height * .2) * canvas.width + Math.floor(canvas.width * .7)) * 4;
        return { type: file.type, name: file.name, size: file.size, width: image.naturalWidth, height: image.naturalHeight, decodedCorrect: decoded === (kind === "profile" ? profile.shareUrl : kind === "referral" ? profile.referralUrl : null), artworkOpaque: pixels[artPixel + 3] === 255, identityPresent: svgDocument.querySelector("[data-wallet-identity]").textContent.includes(profile.cardPayload.username), sample: svgDocument.querySelector("text.score")?.textContent ?? null };
      } finally { URL.revokeObjectURL(pngUrl); }
    }, kind);
    assert.equal(result.type, "image/png");
    assert.equal(result.name, `agent-one-${kind}.png`);
    assert.equal(result.width, 1080); assert.equal(result.height, 681);
    assert.ok(result.size > 20000); assert.ok(result.decodedCorrect); assert.ok(result.artworkOpaque); assert.ok(result.identityPresent);
    if (kind === "nws") assert.equal(result.sample, "900");
    console.log(`${engine}/${kind}: complete PNG ${result.width}×${result.height}, artwork and identity present, ${kind === "nws" ? "sample 900 and no QR" : "actual PNG QR decoded correctly"}`);
  }
  assert.deepEqual(unexpected, [], "Self-contained artwork must not request external images or fonts");
} finally { await browser.close(); }

}
