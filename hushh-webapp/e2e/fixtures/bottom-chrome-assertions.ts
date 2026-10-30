import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/** Resting geometry and paint of the production shell's compact Chat seat. */
export async function assertCompactChatChrome(page: Page, width: number, dark: boolean) {
  const input = page.getByRole("textbox", { name: "Message One" });
  await expect(input).toHaveAttribute("placeholder", "Message One");
  const dock = await page.locator("[data-agent-dock-surface]").boundingBox();
  const navigation = await page.locator(".kai-bottom-nav-pill").boundingBox();
  expect(dock!.height).toBeGreaterThanOrEqual(60);
  expect(navigation!.height).toBeLessThan(dock!.height);
  const voice = page.getByRole("button", { name: "Start voice mode" });
  await expect(voice).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  expect(await voice.evaluate(node => getComputedStyle(node, "::before").backgroundColor)).toBe("rgb(0, 122, 255)");
  const shotDir = process.env.BOTTOM_CHROME_SHOT_DIR;
  if (shotDir && width === 393) {
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, `message-one-${dark ? "dark" : "light"}.png`),
      clip: { x: 0, y: dock!.y - 12, width, height: 844 - dock!.y + 12 }, animations: "disabled" });
  }
}

/** A draft replaces the idle waveform without shrinking its touch target. */
export async function assertComposerSendTarget(page: Page) {
  await expect(page.getByRole("button", { name: "Start voice mode" })).toHaveCount(0);
  const action = page.getByRole("button", { name: "Send message" });
  const target = await action.boundingBox();
  const icon = await action.locator("svg").boundingBox();
  expect(target!.width).toBeGreaterThanOrEqual(44);
  expect(target!.height).toBeGreaterThanOrEqual(44);
  expect(icon!.width).toBeLessThanOrEqual(16);
  expect(icon!.height).toBeLessThanOrEqual(16);
}
