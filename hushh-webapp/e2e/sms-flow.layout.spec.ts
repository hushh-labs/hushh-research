import { chromium, expect, test } from "@playwright/test";
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
let soundScript: string;
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
  await build({
    configFile: false, publicDir: false, logLevel: "error",
    build: {
      outDir, emptyOutDir: false,
      lib: {
        entry: path.join(root, "lib/one-location/notification-sound.ts"),
        name: "SmsSound", formats: ["iife"], fileName: () => "sound.js",
      },
    },
  });
  soundScript = fs.readFileSync(path.join(outDir, "sound.js"), "utf8");
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

test("Chrome autoplay blocking uses the system fallback, then a gesture primes later push audio", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Chromium autoplay policy and CDP without synthetic user activation");
  const browser = await chromium.launch({ args: ["--autoplay-policy=document-user-activation-required"] });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<button>Open One</button>");
    const cdp = await page.context().newCDPSession(page);
    // page.evaluate grants transient user activation and would hide this bug.
    const evaluateWithoutGesture = async (expression: string) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: false });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await evaluateWithoutGesture(`
      window.createdContexts = [];
      window.toneConnections = 0;
      window.vibrationCalls = 0;
      window.vibrationStopped = false;
      Object.defineProperty(navigator, "vibrate", { configurable: true, value: (pattern) => { window.vibrationCalls++; window.vibrationStopped = pattern === 0; return true; } });
      const NativeAudio = window.AudioContext;
      window.AudioContext = class extends NativeAudio {
        constructor() { super(); window.createdContexts.push(this); }
        createOscillator() {
          const tone = super.createOscillator();
          const connect = tone.connect.bind(tone), disconnect = tone.disconnect.bind(tone);
          let connected = false;
          tone.connect = (...args) => { if (!connected) window.toneConnections++; connected = true; return connect(...args); };
          tone.disconnect = () => { if (connected) window.toneConnections--; connected = false; disconnect(); };
          return tone;
        }
      };
      ${soundScript}
      window.releaseSound = SmsSound.installOneLocationNotificationSound();
    `);
    expect(await evaluateWithoutGesture(`SmsSound.playOneLocationNotificationSound("sos")`)).toBe(false);
    expect(await evaluateWithoutGesture("window.toneConnections")).toBe(0);
    expect(await evaluateWithoutGesture("window.vibrationCalls")).toBe(1);
    await evaluateWithoutGesture("SmsSound.stopOneLocationNotificationSound()");
    expect(await evaluateWithoutGesture("window.vibrationStopped")).toBe(true);
    await page.getByRole("button", { name: "Open One" }).click();
    await expect.poll(() => evaluateWithoutGesture("window.createdContexts[0].state")).toBe("running");
    expect(await evaluateWithoutGesture(`SmsSound.playOneLocationNotificationSound("sos", "active")`)).toBe(true);
    expect(await evaluateWithoutGesture("window.toneConnections")).toBe(1);
    await evaluateWithoutGesture(`SmsSound.stopOneLocationNotificationSound("unrelated")`);
    expect(await evaluateWithoutGesture("window.toneConnections")).toBe(1);
    await evaluateWithoutGesture(`SmsSound.stopOneLocationNotificationSound("active")`);
    expect(await evaluateWithoutGesture("window.toneConnections")).toBe(0);
    expect(await evaluateWithoutGesture(`SmsSound.playOneLocationNotificationSound("sos", "next")`)).toBe(true);
    // Hiding the app must disconnect synchronously, even if both native audio
    // time and JS timers freeze before the tone's scheduled end.
    await evaluateWithoutGesture(`window.dispatchEvent(new Event("pagehide"))`);
    expect(await evaluateWithoutGesture("window.toneConnections")).toBe(0);
    await evaluateWithoutGesture("window.releaseSound()");
    await expect.poll(() => evaluateWithoutGesture("window.createdContexts[0].state")).toBe("closed");
  } finally {
    await browser.close();
  }
});

test("mixed readiness groups warnings, wraps names and keeps ready contacts sendable on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.setContent(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body data-readiness="mixed"><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByText("5 of 8 contacts ready.")).toBeVisible();
  const disclosure = page.locator("details");
  const summary = disclosure.locator("summary");
  await expect(summary).toHaveText("3 contacts need attention");
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(disclosure.getByText("Location receiving unavailable", { exact: true })).toHaveCount(1);
  await expect(disclosure.getByText(/Roopmann Varadharaj/)).toBeVisible();
  await expect(disclosure.getByText(/1 contact could not be checked/)).toBeVisible();
  await expect(page.getByText(/account verification|verify their phone/i)).toHaveCount(0);
  expect((await disclosure.boundingBox())!.height).toBeLessThan(330);
  const refresh = page.getByRole("button", { name: "Refresh circle" });
  expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await refresh.click();
  await expect(page.locator("body")).toHaveAttribute("data-refreshed", "true");
  const send = page.getByTestId("sos-send-custom-message");
  await page.getByRole("button", { name: "Come get me" }).click();
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeVisible();
  await expect(send).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("sms-mixed-readiness.png"), fullPage: true });
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
