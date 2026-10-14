import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    const pixels = async (png: Buffer) => page.evaluate(async encoded => {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const digest = await crypto.subtle.digest("SHA-256", context.getImageData(0, 0, canvas.width, canvas.height).data);
      bitmap.close();
      return { width: canvas.width, height: canvas.height, hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
    }, png.toString("base64"));
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
    // PNG compression bytes are not a visual contract: compare decoded pixels.
    const afterPixels = await pixels(after);
    if (JSON.stringify(afterPixels) !== JSON.stringify(beforePixels)) {
      await testInfo.attach("live-list", { body: before, contentType: "image/png" });
      await testInfo.attach("restored-list", { body: after, contentType: "image/png" });
    }
    expect(afterPixels).toEqual(beforePixels);
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
