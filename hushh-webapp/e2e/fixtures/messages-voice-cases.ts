import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { MountMessages } from "./messages-presentation-cases";

export function registerMessagesVoiceCases({ mount, fixture }: {
  mount: MountMessages;
  fixture: (page: Page, code: string) => Promise<unknown>;
}) {
  test.describe("browser microphone permission and capture", () => {
    // Exercise Chromium's permission gate, MediaStream and shipped AudioWorklet.
    // The synthetic input makes this repeatable without accessing a person's mic.
    const microphoneTest = test.extend<{ microphoneOrigin: string }>({
      microphoneOrigin: async ({}, provideOrigin) => {
        // AudioWorklet fetches need a real HTTP response; page routing cannot
        // reliably intercept the worklet's separate execution context.
        const server = createServer((request, response) => {
          if (request.url !== "/audio/one-command-capture.worklet.js") { response.writeHead(404).end(); return; }
          response.writeHead(200, { "Content-Type": "application/javascript" });
          response.end(fs.readFileSync(path.join(process.cwd(), "public/audio/one-command-capture.worklet.js")));
        });
        try {
          await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Microphone fixture did not bind a port.");
          await provideOrigin(`http://127.0.0.1:${address.port}`);
        } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      },
    });
    microphoneTest("recovers from denied microphone access and sends a captured WAV only on Send", async ({ playwright, microphoneOrigin }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium", "Chromium's synthetic microphone is the permission/capture test port.");
      const browser = await playwright.chromium.launch({ channel: "chromium", args: ["--use-fake-device-for-media-stream"] });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await context.grantPermissions([], { origin: microphoneOrigin });
        const errors = await mount(page, false, false, false, "idle", { origin: microphoneOrigin });
        await expect(page).toHaveURL(`${microphoneOrigin}/one/messages`);
        const mic = page.getByRole("button", { name: "Record voice message" });
        await mic.click();
        await expect(mic).toBeEnabled();
        await expect(page.getByRole("group", { name: "Voice recording" })).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(0);

        await context.grantPermissions(["microphone"], { origin: microphoneOrigin });
        await mic.click();
        const send = page.getByRole("button", { name: "Send voice message" });
        await expect(send).toBeEnabled();
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(0);
        await send.click();
        await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(1);
        const recording = await page.evaluate(async () => {
          const file = (window as any).directChatFixture.sends[0].attachment as File;
          const bytes = new Uint8Array(await file.arrayBuffer());
          return { mime: file.type, size: file.size, riff: String.fromCharCode(...bytes.subarray(0, 4)) };
        });
        expect(recording.mime).toBe("audio/wav");
        expect(recording.size).toBeGreaterThan(44);
        expect(recording.riff).toBe("RIFF");
        await expect(mic).toBeEnabled();
        await expect(page.locator("nextjs-portal")).toHaveCount(0);
        expect(errors).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath("microphone-deny-grant-send.png"), animations: "disabled" });
      } finally { await browser.close(); }
    });

    microphoneTest("cancels a live microphone on background without sending partial audio", async ({ playwright, microphoneOrigin }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium", "Chromium's synthetic microphone is the permission/capture test port.");
      const browser = await playwright.chromium.launch({ channel: "chromium", args: ["--use-fake-device-for-media-stream"] });
      try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        await context.grantPermissions(["microphone"], { origin: microphoneOrigin });
        const errors = await mount(page, false, false, false, "idle", { origin: microphoneOrigin });
        await page.getByRole("button", { name: "Record voice message" }).click();
        await expect(page.getByRole("button", { name: "Send voice message" })).toBeEnabled();
        await fixture(page, "fixture.lifecycle('background')");
        await expect(page.getByRole("button", { name: "Record voice message" })).toBeEnabled();
        expect(await page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(0);
        await fixture(page, "fixture.lifecycle('active')");
        await page.getByRole("button", { name: "Record voice message" }).click();
        await expect(page.getByRole("button", { name: "Send voice message" })).toBeEnabled();
        await page.getByRole("button", { name: "Cancel recording" }).click();
        await expect(page.getByRole("button", { name: "Record voice message" })).toBeEnabled();
        expect(await page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(0);
        expect(errors).toEqual([]);
      } finally { await browser.close(); }
    });
  });
}
