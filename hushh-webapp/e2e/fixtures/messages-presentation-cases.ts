import { expect, test, type Page } from "@playwright/test";
import { registerMessagesHeaderBreakpointCases } from "./messages-header-breakpoints";

export type MountMessages = (
  page: Page,
  dark?: boolean,
  delayInbox?: boolean,
  inbox?: boolean,
  command?: string,
  options?: { modal?: boolean; preview?: boolean; overflowInbox?: boolean; origin?: string; systemTheme?: boolean },
) => Promise<string[]>;

export function registerMessagesPresentationCases({ mount, touchMessageActions, expectSharedDockFrame }: {
  mount: MountMessages;
  touchMessageActions: (page: Page) => Promise<boolean>;
  expectSharedDockFrame: (page: Page) => Promise<void>;
}): void {
  const geometry = (node: HTMLElement | SVGElement) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return { width: box.width, height: box.height, top: box.top, bottom: box.bottom,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      font: [style.fontFamily, style.fontSize, style.lineHeight, style.fontWeight],
      radius: style.borderTopLeftRadius, background: style.backgroundColor,
      border: style.borderTopWidth, shadow: style.boxShadow };
  };
  for (const width of [390, 768, 1280]) for (const dark of [false, true]) {
    test(`Messages shares People and Circle geometry at ${width}px ${dark ? "dark" : "light"}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const sample = async (kind: "people" | "circles") => {
        const errors = await mount(page, dark, false, true);
        if (kind === "circles") await page.getByRole("tab", { name: "Circles 3" }).click();
        const pane = kind === "people" ? page.locator('[data-direct-message-page]') : page.locator('[data-circle-messages-pane]');
        const row = pane.locator(kind === "people" ? '[class*="conversationRow"]' : '[class*="rowText"]').first();
        const rowSurface = kind === "people" ? row : row.locator("..");
        await rowSurface.hover();
        const list = {
          row: await rowSurface.evaluate(geometry),
          avatar: await pane.locator(kind === "people" ? '[class*="conversationAvatar"]' : '[class*="groupAvatarFront"]').first().evaluate(geometry),
          header: await pane.locator(kind === "people" ? '[class*="inboxHeader"]' : 'aside > header').first().evaluate(geometry),
        };
        if (kind === "people") await page.getByRole("button", { name: /^Maya Rao/ }).click();
        else await pane.getByRole("button", { name: /Weekend friends/ }).click();
        const editor = page.getByRole("textbox", { name: kind === "people" ? "Message Maya Rao" : "Message", exact: true });
        await expect(editor).toBeVisible();
        const selected = await rowSurface.evaluate(node => getComputedStyle(node).backgroundColor);
        await editor.fill("Keep this draft");
        const send = page.getByRole("button", { name: "Send message", exact: true });
        const attach = page.getByRole("button", { name: kind === "people" ? "Add attachment" : "Attach photo, video, or document", exact: true });
        const emoji = page.getByRole("button", { name: "Choose emoji", exact: true });
        await page.mouse.move(0, 0);
        const composer = { editor: await editor.evaluate(geometry), send: await send.evaluate(geometry),
          material: await send.locator("..").evaluate(geometry),
          attach: await attach.evaluate(geometry), attachIcon: await attach.locator("svg").evaluate(geometry),
          emoji: await emoji.evaluate(geometry), emojiIcon: await emoji.locator("svg").evaluate(geometry) };
        await page.keyboard.press("Tab");
        await attach.focus();
        await expect(attach).toHaveCSS("outline-width", "2px");
        await expect(attach).toHaveCSS("outline-offset", "2px");
        const message = page.locator(kind === "people" ? '[data-chat-message="maya-78"]' : '[data-circle-chat-lane] [data-chat-message="message-42"]');
        const bubble = message.locator('[data-chat-bubble]');
        const metadata = message.locator(kind === "people" ? '[class*="messageBubbleMeta"]' : '[class*="_meta_"]');
        const avatar = message.locator(kind === "people" ? '[class*="messagePeerAvatar"]' : '[class*="avatar"] [data-slot="avatar"]');
        const transcript = { bubble: await bubble.evaluate(geometry), metadata: await metadata.evaluate(geometry),
          avatar: await avatar.evaluate(geometry),
          inset: await page.locator(kind === "people" ? '[class*="messageList"]' : '[aria-label="Circle messages"]').evaluate(node => getComputedStyle(node).paddingLeft) };
        const addReaction = message.getByRole("button", { name: "React to message", exact: true });
        await expect(addReaction.locator("svg")).toHaveCSS("width", "20px");
        await expect(addReaction.locator("svg")).toHaveCSS("height", "20px");
        await page.keyboard.press("Tab");
        await addReaction.focus();
        await expect(addReaction).toHaveCSS("outline-width", "2px");
        await expect(addReaction).toHaveCSS("background-image", /14px.*15px/);
        // Compact actions live above the bubble for keyboard focus. Their touch
        // entry is the separately covered long-press menu, not a pointer click.
        if (await touchMessageActions(page)) await addReaction.press("Enter");
        else await addReaction.click();
        const picker = page.getByRole("dialog", { name: "Emoji picker", exact: true });
        await picker.getByPlaceholder("Search emoji").fill("👍");
        await picker.getByRole("button", { name: "Use 👍", exact: true }).click();
        const reaction = message.getByRole("button", { name: /👍.*1/ });
        await expect(reaction).toBeVisible();
        const badge = reaction.locator(":scope > span").first();
        const reactions = { target: await reaction.evaluate(geometry), badge: await badge.evaluate(geometry) };
        const avatarTarget = kind === "people" ? await message.getByRole("link", { name: /View .* profile/ }).evaluate(geometry) : null;
        const reactionGap = (await reaction.locator("..").boundingBox())!.y - (await bubble.boundingBox())!.y - (await bubble.boundingBox())!.height;
        await expect(editor).toHaveValue("Keep this draft");
        await editor.fill(Array.from({ length: 20 }, (_, index) => `Line ${index}`).join("\n"));
        await expect.poll(async () => (await editor.boundingBox())!.height).toBeLessThanOrEqual(128);
        const grown = (await editor.boundingBox())!.height;
        await editor.fill("Keep this draft");
        await page.screenshot({ path: testInfo.outputPath(`${kind}-${width}-${dark ? "dark" : "light"}.png`), animations: "disabled" });
        expect(errors).toEqual([]);
        // Leave the real route in its inbox state before mounting the other lane;
        // a phone visit otherwise correctly restores the last open conversation.
        if (kind === "people") await page.getByRole("button", { name: "Back to messages", exact: true }).click();
        return { list, selected, composer, transcript, reactions, avatarTarget, reactionGap, grown };
      };
      const people = await sample("people");
      const circles = await sample("circles");
      console.log("MESSAGES_GEOMETRY " + JSON.stringify({ width, dark, people, circles }));
      for (const result of [people, circles]) {
        expect(result.list.row.height).toBeGreaterThanOrEqual(70);
        expect(result.list.avatar.width).toBe(44);
        expect(result.list.avatar.height).toBe(44);
        expect(result.composer.send.width).toBe(44);
        expect(result.composer.send.height).toBe(44);
        expect(result.composer.material.width).toBe(44);
        expect(result.composer.material.height).toBe(44);
        expect(result.composer.material.padding).toEqual(["0px", "0px", "0px", "0px"]);
        expect(result.composer.material.border).toBe("0px");
        expect(result.composer.editor.height).toBe(44);
        for (const control of [result.composer.attach, result.composer.emoji]) {
          expect(control.width).toBe(44);
          expect(control.height).toBe(44);
        }
        for (const icon of [result.composer.attachIcon, result.composer.emojiIcon]) {
          expect(icon.width).toBe(20);
          expect(icon.height).toBe(20);
        }
        expect(result.composer.attach.border).toBe("0px");
        expect(result.composer.attach.background).toBe("rgba(0, 0, 0, 0)");
        expect(result.composer.attach.shadow).toBe("none");
        expect(result.transcript.avatar.width).toBe(32);
        expect(result.transcript.avatar.height).toBe(32);
        expect(result.transcript.inset).toBe("16px");
        expect(result.transcript.bubble.padding).toEqual(["10px", width < 768 ? "14px" : "44px", "10px", "14px"]);
        expect(result.transcript.metadata.font.slice(1, 3)).toEqual(["10px", "12px"]);
        expect(Math.abs(result.transcript.avatar.bottom - result.transcript.bubble.bottom)).toBeLessThanOrEqual(1);
        expect(result.reactions.target.width).toBeGreaterThanOrEqual(44);
        expect(result.reactions.target.height).toBe(44);
        expect(result.reactions.badge.height).toBe(26);
        if (result.avatarTarget) {
          expect(result.avatarTarget.width).toBeGreaterThanOrEqual(44);
          expect(result.avatarTarget.height).toBeGreaterThanOrEqual(44);
        }
        expect(Math.abs(result.reactionGap)).toBeLessThanOrEqual(1);
        expect(result.transcript.metadata.top).toBeGreaterThanOrEqual(result.transcript.bubble.top);
        expect(result.transcript.metadata.bottom).toBeLessThanOrEqual(result.transcript.bubble.bottom);
        expect(result.grown).toBe(128);
      }
      expect(Math.abs(people.list.row.width - circles.list.row.width)).toBeLessThanOrEqual(1);
      expect(people.list.header.padding).toEqual(circles.list.header.padding);
      expect(people.list.row.background).toBe(circles.list.row.background);
      expect(people.selected).toBe(circles.selected);
      expect(people.transcript.bubble.padding).toEqual(circles.transcript.bubble.padding);
      expect(people.transcript.bubble.font).toEqual(circles.transcript.bubble.font);
      expect(people.transcript.bubble.radius).toBe(circles.transcript.bubble.radius);
      expect(people.transcript.metadata.font).toEqual(circles.transcript.metadata.font);
      expect(people.composer.editor.padding).toEqual(circles.composer.editor.padding);
      expect(people.composer.editor.font).toEqual(circles.composer.editor.font);
    });
  }
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
    await page.getByRole("heading", { name: /^Maya Rao/ }).hover();
    await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(0);
    await expect(bubble.getByRole("button", { name: "Message options" }).locator("..")).toHaveCSS("opacity", "0");
    await bubble.getByRole("button", { name: "Message options" }).focus();
    await expect(bubble.getByRole("button", { name: "Message options" }).locator("..")).toHaveCSS("opacity", "1");
    await page.getByRole("heading", { name: /^Maya Rao/ }).hover();
    await expect(bubble).toHaveAttribute("data-actions-visible", "true");
    await page.locator("main > header").getByRole("link", { name: "View Maya Rao's profile", exact: true }).focus();
    await expect(page.locator('article[data-actions-visible="true"]')).toHaveCount(0);
    const title = page.getByRole("heading", { name: "Messages", exact: true });
    const contact = page.getByRole("heading", { name: /^Maya Rao/ });
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
    const threadTitle = await page.getByRole("heading", { name: /^Maya Rao/ }).evaluate(measure);
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
