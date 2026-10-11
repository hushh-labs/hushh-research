import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  awaitProductFont,
  productFontStyle,
  stripAppFontFaces,
} from "./fixtures/product-font";

// The shipped SMS panel and product CSS, with local action callbacks. Fan-out,
// identity readiness and notification delivery contracts have separate tests.
let css: string;
let script: string;
let fixtureOutputDirectory: string | null = null;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sms-flow-"));
  fixtureOutputDirectory = outDir;
  await build({
    configFile: false,
    publicDir: false,
    logLevel: "error",
    plugins: [
      {
        name: "fixture-css-candidates",
        transform(source, id) {
          if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) {
            for (const candidate of scanner.scanFiles([
              { content: source, extension: "tsx" },
            ]))
              candidates.add(candidate);
          }
        },
      },
    ],
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": root } },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": "{}",
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, "e2e/fixtures/sms-flow.tsx"),
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
              ? path.join(
                  root,
                  "node_modules/tw-animate-css/dist/tw-animate.css",
                )
              : path.resolve(base, id);
        return {
          path: file,
          base: path.dirname(file),
          content: fs.readFileSync(file, "utf8"),
        };
      },
    },
  );
  css =
    stripAppFontFaces(compiler.build([...candidates])) +
    productFontStyle() +
    fs
      .readdirSync(outDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(outDir, name), "utf8"))
      .join("\n");
});

test.afterAll(() => {
  if (!fixtureOutputDirectory) return;
  const target = path.resolve(fixtureOutputDirectory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !/^sms-flow-[a-zA-Z0-9]+$/.test(path.basename(target))) {
    throw new Error("Unexpected SMS fixture output directory");
  }
  fs.rmSync(target, { recursive: true, force: true });
});

test("preset, edit, cancel, hold, live receipt and Stop work through real browser events", async ({ page, isMobile, browserName }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.setContent(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  const message = page.getByRole("textbox", { name: "Or write your own" });
  const send = page.getByTestId("sos-send-custom-message");
  await page.getByRole("button", { name: "I'm not safe" }).click();
  await expect(message).toHaveValue("I'm not safe");
  await expect(send).toBeEnabled();
  await message.fill("Please come to the entrance");
  await send.click();
  await expect(send).toHaveText("Cancel");
  await send.click();
  await expect(send).toHaveText("Send");
  await page.waitForTimeout(2100);
  await expect(page.locator("body")).not.toHaveAttribute("data-sent-count");
  await page.getByRole("button", { name: "Come get me" }).click();
  const rect = await send.boundingBox();
  if (!rect) throw new Error("Send is not visible");
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  // Exercise the browser's touch pipeline on mobile Chrome; WebKit/desktop
  // exercise real pointer capture and release through the mouse driver.
  const touch = isMobile && browserName === "chromium"
    ? await page.context().newCDPSession(page)
    : null;
  const press = async () => {
    if (touch) await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x, y }],
    });
    else {
      await page.mouse.move(x, y);
      await page.mouse.down();
    }
  };
  const release = async () => {
    if (touch) await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd", touchPoints: [],
    });
    else await page.mouse.up();
  };
  await press();
  await page.waitForTimeout(1000);
  await release();
  await page.waitForTimeout(2100);
  await expect(page.locator("body")).not.toHaveAttribute("data-sent-count");
  await press();
  await page.waitForTimeout(2100);
  await release();
  await expect(page.getByTestId("sos-status-label")).toHaveText("Alert active");
  await expect(page.locator("body")).toHaveAttribute("data-sent-count", "1");
  await expect(page.locator("body")).toHaveAttribute("data-sent-note", "Come get me");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop Save My Soul alert" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Stop alert", exact: true }).click();
  await expect(message).toBeVisible();
  await expect(page.getByText("Pick a quick message.")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
