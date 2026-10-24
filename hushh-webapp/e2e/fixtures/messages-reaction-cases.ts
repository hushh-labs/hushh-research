import { expect, test, type Page, type Locator } from "@playwright/test";
import type { MountMessages } from "./messages-presentation-cases";

// Each round trip returns to the same draft/reaction state. Give each Unicode
// case its own unchanged deadline instead of accumulating three UI journeys.
export function registerMessagesReactionCases({ mount, fixture, holdMessage }: {
  mount: MountMessages;
  fixture: (page: Page, code: string) => Promise<void>;
  holdMessage: (page: Page, row: Locator) => Promise<void>;
}): void {
  for (const width of [320, 393, 1440]) {
    for (const dark of [false, true]) {
      for (const emoji of ["🐱", "👩🏽‍💻", "🇮🇳"]) {
        test(`message menu is action-only and full reactions fit at ${width}px ${dark ? "dark" : "light"} using ${emoji}`, async ({ page }) => {
          await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
          const errors = await mount(page, dark);
          await fixture(page, "fixture.remoteChange('maya-78', 'Choose any reaction')");
          const message = page.locator('[data-chat-message="maya-78"]');
          await expect(message).toContainText("Choose any reaction");
          await holdMessage(page, message);
          const menu = page.getByRole("menu");
          await expect(menu.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
          await expect(menu.getByRole("group", { name: "Quick reactions" })).toHaveCount(0);
          await expect(menu.getByRole("button")).toHaveCount(0);
          await page.screenshot({ path: test.info().outputPath(`message-menu-${width}-${dark ? "dark" : "light"}.png`), animations: "disabled" });
          await page.keyboard.press("Escape");
          const draft = page.locator("[data-direct-message-composer-input]");
          await draft.fill("Keep this draft");
          const avatarOffset = async () => {
            const avatar = (await message.getByRole("link", { name: "View Maya Rao's profile" }).boundingBox())!;
            const bubble = (await message.locator("[data-chat-bubble]").boundingBox())!;
            return avatar.y + avatar.height - bubble.y - bubble.height;
          };
          const originalAvatarOffset = await avatarOffset();
          const useMenu = await page.evaluate(() => matchMedia("(max-width: 767px), (hover: none)").matches);
          if (useMenu) {
            await holdMessage(page, message);
            await expect(page.getByRole("menuitem", { name: "React", exact: true })).toHaveCount(0);
            await page.keyboard.press("Escape");
            await message.getByRole("button", { name: "React to message", exact: true }).click();
          } else {
            await message.hover();
            await message.getByRole("button", { name: "React to message", exact: true }).click();
          }
          const picker = page.getByRole("dialog", { name: "Emoji picker", exact: true });
          await expect(picker).toBeVisible();
          await expect(picker.getByRole("tab", { name: "Animals and nature", exact: true })).toBeVisible();
          const box = (await picker.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(width === 320 ? 568 : 900);
          await picker.getByPlaceholder("Search emoji").fill(emoji);
          if (emoji === "🐱") {
            await fixture(page, "fixture.remoteChange('maya-78', 'Choose any reaction')");
            await expect(picker).toBeVisible();
          }
          await picker.getByRole("button", { name: `Use ${emoji}`, exact: true }).click();
          await expect(picker).toHaveCount(0);
          await expect(message.getByRole("button", { name: `${emoji} reaction, 1`, exact: true })).toBeVisible();
          await expect(draft).toHaveValue("Keep this draft");
          expect(Math.abs(await avatarOffset() - originalAvatarOffset)).toBeLessThan(1);
          await message.getByRole("button", { name: `${emoji} reaction, 1`, exact: true }).click();
          await expect(message.getByRole("button", { name: `${emoji} reaction, 1`, exact: true })).toHaveCount(0);
          expect(Math.abs(await avatarOffset() - originalAvatarOffset)).toBeLessThan(1);
          expect(await page.evaluate(() => (window as any).directChatFixture.sends.length)).toBe(0);
          await holdMessage(page, message);
          await page.keyboard.press("Escape");
          await message.getByRole("button", { name: "React to message", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Emoji picker", exact: true })).toBeVisible();
          await page.screenshot({ path: test.info().outputPath(`full-reactions-${width}-${dark ? "dark" : "light"}.png`), animations: "disabled" });
          await fixture(page, "fixture.changeOwner()");
          await expect(page.getByRole("dialog", { name: "Emoji picker", exact: true })).toHaveCount(0);
          expect(errors).toEqual([]);
        });
      }
    }
  }
}
