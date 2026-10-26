import { expect, test, type Page } from "@playwright/test";
import { registerMessagesHeaderBreakpointCases } from "./messages-header-breakpoints";

export type MountMessages = (
  page: Page,
  dark?: boolean,
  delayInbox?: boolean,
  inbox?: boolean,
  command?: string,
  options?: { modal?: boolean; preview?: boolean; overflowInbox?: boolean; origin?: string },
) => Promise<string[]>;

export function registerMessagesPresentationCases({ mount, touchMessageActions, expectSharedDockFrame }: {
  mount: MountMessages;
  touchMessageActions: (page: Page) => Promise<boolean>;
  expectSharedDockFrame: (page: Page) => Promise<void>;
}): void {
  test("hover actions do not shift messages or the centered composer", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await mount(page);
    const touchActions = await touchMessageActions(page);
    const bubble = page.locator('[data-message-role="user"]').last();
    const before = await bubble.boundingBox();
    await bubble.hover();
    await expect(bubble.getByRole("button", { name: "Message options" })).toBeVisible();
    const other = page.locator('[data-message-role="user"]').first();
    await other.hover();
    await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(touchActions ? 0 : 1);
    if (!touchActions) await expect(other).toHaveAttribute("data-actions-visible", "true");
    await bubble.hover();
    const after = await bubble.boundingBox();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    await expectSharedDockFrame(page);
    for (const role of ["user", "peer"]) {
      const row = page.locator(`[data-message-role="${role}"]`).last();
      await row.hover();
      const emoji = row.getByRole("button", { name: "React to message" });
      const iconBox = (await emoji.boundingBox())!;
      const menuBox = (await row.getByRole("button", { name: "Message options" }).boundingBox())!;
      await expect(row.getByRole("button", { name: "Message options" })).toHaveCSS("background-image", /12px,.*12\.5px/);
      expect(menuBox.width).toBeGreaterThanOrEqual(44);
      expect(menuBox.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(iconBox.y - menuBox.y)).toBeLessThanOrEqual(1);
      const bubbleBox = (await row.locator('[data-chat-bubble]').boundingBox())!;
      if (touchActions) {
        await expect(emoji.locator("..")).toHaveCSS("opacity", "0");
        for (const button of [emoji, row.getByRole("button", { name: "Message options" })]) {
          await expect(button).toHaveCSS("pointer-events", "none");
          const box = (await button.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(1440);
        }
      } else {
        expect(menuBox.x).toBeGreaterThanOrEqual(bubbleBox.x);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(bubbleBox.x + bubbleBox.width + 1);
        if (role === "user") expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(bubbleBox.x);
        else expect(iconBox.x).toBeGreaterThanOrEqual(bubbleBox.x + bubbleBox.width);
      }
    }
    await page.getByRole("heading", { name: "Maya Rao", exact: true }).hover();
    await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(0);
    await expect(bubble.getByRole("button", { name: "Message options" }).locator("..")).toHaveCSS("opacity", "0");
    await bubble.getByRole("button", { name: "Message options" }).focus();
    await expect(bubble.getByRole("button", { name: "Message options" }).locator("..")).toHaveCSS("opacity", "1");
    await page.getByRole("heading", { name: "Maya Rao", exact: true }).hover();
    await expect(bubble).toHaveAttribute("data-actions-visible", "true");
    await page.locator("main > header").getByRole("link", { name: "View Maya Rao's profile", exact: true }).focus();
    await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(0);
    const title = page.getByRole("heading", { name: "Messages", exact: true });
    const contact = page.getByRole("heading", { name: "Maya Rao", exact: true });
    const typography = (node: HTMLElement | SVGElement) => {
      const style = getComputedStyle(node);
      return { family: style.fontFamily, size: style.fontSize, line: style.lineHeight, weight: style.fontWeight };
    };
    const screenTitle = await title.evaluate(typography);
    const threadTitle = await contact.evaluate(typography);
    expect(screenTitle.family).toBe(threadTitle.family);
    expect(screenTitle.size).toBe("17px");
    expect(screenTitle.line).toBe("22px");
    expect(screenTitle.weight).toBe("600");
    expect(threadTitle.size).toBe("17px");
    expect(threadTitle.line).toBe("22px");
    expect(threadTitle.weight).toBe("600");
  });

  test("Messages navigation, picker, thread and quiet action compute the Connect scale", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(page, false, false, true);
    const measure = (node: HTMLElement | SVGElement) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight, width: box.width, height: box.height };
    };
    const listTitle = await page.getByRole("heading", { name: "Messages", exact: true }).evaluate(measure);
    const laneTab = await page.getByRole("tab", { name: /People 2/ }).evaluate(measure);
    const rowName = await page.locator('[class*="conversationName"]').first().evaluate(measure);
    const rowPreview = await page.locator('[class*="conversationPreview"]').first().evaluate(measure);
    const profile = page.getByRole("button", { name: "Open Profile" }).first();
    const profileBox = (await profile.boundingBox())!;
    await page.evaluate(() => window.addEventListener("hushh:profile-pane-open", (event) => {
      const detail = (event as CustomEvent<{ source: string; returnFocus?: HTMLElement }>).detail;
      (window as unknown as { messagesProfileProof?: unknown }).messagesProfileProof = {
        source: detail.source, trigger: detail.returnFocus?.getAttribute("aria-label"),
      };
    }, { once: true }));
    await profile.click();
    expect(await page.evaluate(() => (window as unknown as { messagesProfileProof?: unknown }).messagesProfileProof)).toEqual({ source: "tap", trigger: "Open Profile" });

    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const picker = page.getByRole("dialog", { name: "New chat" });
    const pickerTitle = await picker.getByRole("heading", { name: "New chat" }).evaluate(measure);
    const pickerSearch = await picker.getByRole("searchbox", { name: "Search connections" }).evaluate(measure);
    await picker.getByRole("searchbox", { name: "Search connections" }).fill("Maya");
    await picker.getByRole("button", { name: "Message Maya Rao", exact: true }).click();
    const threadTitle = await page.getByRole("heading", { name: "Maya Rao", exact: true }).evaluate(measure);
    const bubble = await page.locator('[data-chat-bubble]').first().evaluate(measure);
    const composer = await page.getByRole("textbox", { name: "Message Maya Rao" }).evaluate(measure);
    const older = page.getByRole("button", { name: "Load older messages" });
    const quiet = await older.evaluate((node) => {
      const outer = getComputedStyle(node);
      const pill = getComputedStyle(node, "::before");
      const box = node.getBoundingClientRect();
      return { size: outer.fontSize, line: outer.lineHeight, weight: outer.fontWeight,
        outerBackground: outer.backgroundColor, pillBackground: pill.backgroundColor,
        borderWidth: pill.borderTopWidth, height: box.height, width: box.width };
    });
    expect(listTitle).toMatchObject({ size: "17px", line: "22px", weight: "600" });
    expect(laneTab).toMatchObject({ size: "15px", line: "20px", weight: "550", height: 44 });
    expect(rowName).toMatchObject({ size: "14px", line: "21px", weight: "550" });
    expect(rowPreview).toMatchObject({ size: "12px", line: "18px", weight: "400" });
    expect(profileBox.width).toBeGreaterThanOrEqual(44);
    expect(profileBox.height).toBeGreaterThanOrEqual(44);
    expect(pickerTitle).toMatchObject({ size: "20px", line: "28px", weight: "600" });
    expect(pickerSearch).toMatchObject({ size: "16px", line: "22px", weight: "400" });
    expect(threadTitle).toMatchObject({ size: "17px", line: "22px", weight: "600" });
    expect(bubble).toMatchObject({ size: "16px", line: "22px", weight: "400" });
    expect(composer.size).toBe("16px");
    expect(quiet).toMatchObject({ size: "12px", line: "18px", weight: "550", outerBackground: "rgba(0, 0, 0, 0)", borderWidth: "1px" });
    expect(quiet.height).toBeGreaterThanOrEqual(44);
    expect(quiet.pillBackground).not.toBe("rgba(0, 0, 0, 0)");
    console.log("MESSAGES_COMPUTED " + JSON.stringify({ listTitle, laneTab, rowName, rowPreview, profile: { width: profileBox.width, height: profileBox.height }, pickerTitle, pickerSearch, threadTitle, bubble, composer, quiet }));
  });

  test("Circle Messages keeps readable bubbles and scopes its action portal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mount(page, false, false, true);
    await page.getByRole("tab", { name: "Circles 3" }).click();
    const rowName = await page.locator('[data-circle-messages-pane] [class*="rowText"] strong').first().evaluate(node => {
      const style = getComputedStyle(node); return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight };
    });
    await page.getByRole("button", { name: /Weekend friends/ }).click();
    const title = await page.getByRole("heading", { name: "Weekend friends" }).evaluate(node => {
      const style = getComputedStyle(node); return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight };
    });
    const bubble = page.locator('[data-circle-chat-lane] [data-chat-bubble]').first();
    await expect(bubble).toBeVisible();
    const bubbleType = await bubble.evaluate(node => {
      const style = getComputedStyle(node); return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight };
    });
    const profile = page.getByRole("region", { name: "Weekend friends messages" }).getByRole("button", { name: "Open Profile" });
    const profileBox = (await profile.boundingBox())!;
    expect(rowName).toEqual({ size: "14px", line: "21px", weight: "550" });
    expect(title).toEqual({ size: "17px", line: "22px", weight: "600" });
    expect(bubbleType).toEqual({ size: "16px", line: "22px", weight: "400" });
    expect(profileBox.width).toBeGreaterThanOrEqual(44);
    expect(profileBox.height).toBeGreaterThanOrEqual(44);
    await bubble.scrollIntoViewIfNeeded();
    await bubble.dispatchEvent("contextmenu");
    const menu = page.getByRole("menu");
    await expect(menu).toHaveAttribute("data-messages-type-scale", "true");
    const replyType = await menu.getByRole("menuitem", { name: "Reply" }).evaluate(node => {
      const style = getComputedStyle(node); return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight };
    });
    expect(replyType).toEqual({ size: "13px", line: "21px", weight: "550" });
    await menu.getByRole("menuitem", { name: "Delete for me" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete for you?" });
    await expect(dialog).toHaveAttribute("data-messages-type-scale", "true");
    const dialogTitle = await dialog.getByRole("heading", { name: "Delete for you?" }).evaluate(node => {
      const style = getComputedStyle(node); return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight };
    });
    expect(dialogTitle).toEqual({ size: "20px", line: "28px", weight: "600" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    console.log("CIRCLE_MESSAGES_COMPUTED " + JSON.stringify({ rowName, title, bubbleType, replyType, dialogTitle, profile: { width: profileBox.width, height: profileBox.height } }));
  });

  registerMessagesHeaderBreakpointCases(mount);
}
