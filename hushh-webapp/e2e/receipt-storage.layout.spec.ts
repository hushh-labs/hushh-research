import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";


let script: string;
let css: string;

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-storage-"));
  await build({
    configFile: false,
    logLevel: "error",
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        // Candidates are derived from every transformed module, so a class the
        // card renders cannot be missing from the CSS. A hand-maintained list
        // would let an unregistered class emit no style and still pass.
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
        },
      },
    ],
    resolve: {
      alias: [
        { find: "@", replacement: root },
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/receipt-storage.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(
    fs
      .readFileSync(path.join(root, "app/globals.css"), "utf8")
      .replace(/^@source\s+[^;]+;\s*$/gm, ""),
    {
      base: path.join(root, "app"),
      loadStylesheet: async (id, base) => {
        const file =
          id === "tailwindcss"
            ? path.join(root, "node_modules/tailwindcss/index.css")
            : id === "tw-animate-css"
              ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css")
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
  css += fs.readdirSync(outDir).filter(file => file.endsWith(".css"))
    .map(file => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n");
});

for (const width of [390, 1000]) {
  test(`encrypted receipts restore unchanged after full reload at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const officialAssets = [
      ["trainings.internshala.com", process.env.RECEIPT_QA_INTERNSHALA_LOGO_PATH],
      ["udemy.com", process.env.RECEIPT_QA_UDEMY_LOGO_PATH],
    ] as const;
    for (const [domain, file] of officialAssets) {
      if (file) await page.route(`https://icons.duckduckgo.com/ip3/${domain}.ico`, route => route.fulfill({ contentType: "image/png", body: fs.readFileSync(file) }));
    }
    await page.route("http://localhost/brand/email-domains/*.png", route => route.fulfill({ contentType: "image/png", body: fs.readFileSync(path.join(process.cwd(), "public", new URL(route.request().url()).pathname)) }));
    await page.route("http://localhost/receipt-storage.js", route => route.fulfill({ contentType: "application/javascript", body: script }));
    await page.route("http://localhost/receipt-storage-fixture", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="/receipt-storage.js"></script></body></html>` }));
    await page.goto("http://localhost/receipt-storage-fixture");
    await awaitProductFont(page);
    await expect(page.getByRole("status")).toHaveText("live");
    const list = page.getByTestId("saved-receipt-list");
    const awaitLogos = async () => {
      await list.locator("img").evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
      await expect(list.locator('[data-slot="receipt-merchant-logo"][data-logo-kind="brand"]')).toHaveCount(10);
    };
    await awaitLogos();
    const awaitPaint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await list.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await awaitPaint();
    const originalText = await list.innerText();
    const originalBox = await list.boundingBox();
    const before = await list.screenshot({ animations: "disabled", path: testInfo.outputPath("live-list.png") });
    const pixels = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const beforePixels = await pixels(before);
    await page.getByRole("button", { name: "Persist synthetic receipts" }).click();
    await expect(page.getByRole("status")).toHaveText("persisted");
    await page.reload();
    await awaitProductFont(page);
    await expect(page.getByRole("status")).toHaveText("restored");
    await awaitLogos();
    expect(await list.innerText()).toBe(originalText);
    await list.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await awaitPaint();
    expect(await list.boundingBox()).toEqual(originalBox);
    const after = await list.screenshot({ animations: "disabled", path: testInfo.outputPath("restored-list.png") });
    // Chromium can repaint a few rounded-edge pixels with 1–19 channel levels of
    // antialiasing drift after reload. Keep a tight decoded-pixel contract while
    // allowing that raster noise; text, bounds and logos are asserted above.
    const afterPixels = await pixels(after);
    expect(afterPixels.info.width).toBe(beforePixels.info.width);
    expect(afterPixels.info.height).toBe(beforePixels.info.height);
    let changedPixels = 0;
    let maxChannelDelta = 0;
    for (let offset = 0; offset < beforePixels.data.length; offset += 4) {
      let pixelDelta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        pixelDelta = Math.max(pixelDelta, Math.abs(beforePixels.data[offset + channel] - afterPixels.data[offset + channel]));
      }
      if (pixelDelta) changedPixels += 1;
      maxChannelDelta = Math.max(maxChannelDelta, pixelDelta);
    }
    const allowedPixels = Math.ceil(beforePixels.info.width * beforePixels.info.height * 0.0005);
    if (changedPixels > allowedPixels || maxChannelDelta > 24) {
      await testInfo.attach("live-list", { body: before, contentType: "image/png" });
      await testInfo.attach("restored-list", { body: after, contentType: "image/png" });
    }
    expect(changedPixels, "Only subpixel repaint differences may survive reload").toBeLessThanOrEqual(allowedPixels);
    expect(maxChannelDelta, "Reload must not change any visible color or glyph").toBeLessThanOrEqual(24);
    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("hushh-secure-resource-cache", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const records = await new Promise(resolve => { const request = db.transaction("durable_resources").objectStore("durable_resources").getAll(); request.onsuccess = () => resolve(request.result); });
      db.close(); return JSON.stringify(records);
    });
    expect(stored).not.toMatch(/RAW_|raw@example.com|ORDER-|Apple|Amazon|Udemy|Internshala|12\.00/);
    await page.getByRole("button", { name: "Fail synthetic refresh" }).click();
    await expect(page.getByTestId("storage-feedback")).toHaveText("failed-refresh-kept-previous");
    expect(await list.innerText()).toBe(originalText);
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("restored");
    expect(await list.innerText()).toBe(originalText);
    await page.getByRole("navigation", { name: "Receipt pagination" }).getByRole("button", { name: "Next", exact: true }).click();
    await expect(list).toContainText("2 / 2");
    await list.getByRole("button", { name: /Apple|Amazon/ }).first().click();
    await expect(page.getByRole("status").filter({ hasText: "Reconnect Mail or sync again to load the original email and source evidence." })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start delayed synthetic scan" }).click();
    await expect(page.getByTestId("storage-feedback")).toHaveText("scan-pending");
    await page.getByRole("button", { name: "Reset synthetic receipts" }).click();
    await expect(page.getByRole("status")).toHaveText("reset");
    await expect(list).toHaveCount(0);
    await page.getByRole("button", { name: "Finish delayed synthetic scan" }).click();
    await expect(page.getByTestId("storage-feedback")).toHaveText("stale-scan-rejected");
    await expect(list).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("live");
  });
}

for (const width of [390, 1000]) {
  test(`reviewed training logos and row geometry survive reload at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const assets = [
      ["Internshala Trainings", "trainings.internshala.com", process.env.RECEIPT_QA_INTERNSHALA_LOGO_PATH],
      ["Udemy", "udemy.com", process.env.RECEIPT_QA_UDEMY_LOGO_PATH],
    ] as const;
    // Local evidence uses downloaded official assets; CI proves decoding and the
    // reviewed domain contract with a synthetic image, without external requests.
    const synthetic = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfT8AAAAASUVORK5CYII=", "base64");
    for (const [, domain, file] of assets) await page.route(`https://icons.duckduckgo.com/ip3/${domain}.ico`, route => route.fulfill({ contentType: "image/png", body: file ? fs.readFileSync(file) : synthetic }));
    await page.route("http://localhost/receipt-storage.js", route => route.fulfill({ contentType: "application/javascript", body: script }));
    await page.route("http://localhost/receipt-storage-fixture?brands=true", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><title>Reviewed training receipt logos</title><style>${css}</style></head><body><div id="root"></div><script src="/receipt-storage.js"></script></body></html>` }));
    await page.goto("http://localhost/receipt-storage-fixture?brands=true");
    await awaitProductFont(page);
    await expect(page.getByRole("status")).toHaveText("live");
    const list = page.getByTestId("saved-receipt-list");
    const beforeText = await list.innerText();
    const dimensions: Record<string, { width: number; height: number }> = {};
    for (const [merchant, domain] of assets) {
      const row = list.getByRole("button", { name: new RegExp(merchant) });
      await expect(row.locator('[data-logo-kind="brand"] img')).toHaveAttribute("src", `https://icons.duckduckgo.com/ip3/${domain}.ico`);
      const box = (await row.boundingBox())!; dimensions[merchant] = { width: box.width, height: box.height };
    }
    await page.getByRole("button", { name: "Persist synthetic receipts" }).click();
    await expect(page.getByRole("status")).toHaveText("persisted");
    await page.reload(); await awaitProductFont(page);
    await expect(page.getByRole("status")).toHaveText("restored");
    expect(await list.innerText()).toBe(beforeText);
    for (const [merchant, domain] of assets) {
      const row = list.getByRole("button", { name: new RegExp(merchant) });
      await expect(row.locator('[data-logo-kind="brand"] img')).toHaveAttribute("src", `https://icons.duckduckgo.com/ip3/${domain}.ico`);
      const box = (await row.boundingBox())!;
      expect({ width: box.width, height: box.height }).toEqual(dimensions[merchant]);
      await row.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(merchant);
      await expect(dialog.locator('[data-logo-kind="brand"] img')).toHaveAttribute("src", `https://icons.duckduckgo.com/ip3/${domain}.ico`);
      await page.keyboard.press("Escape");
    }
    await list.screenshot({ animations: "disabled", path: testInfo.outputPath(`reviewed-training-logos-${width}.png`) });
  });
}
