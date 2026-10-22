import { expect, test, type Locator, type Page } from "@playwright/test";

type MountMessages = (page: Page, dark?: boolean, delayInbox?: boolean, inbox?: boolean) => Promise<unknown>;

export async function proveMessagesInboxBack(page: Page, mount: MountMessages, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await mount(page, false, false, true);
  const back = page.getByRole("button", { name: "Go back", exact: true });
  await expect(back).toBeVisible();
  const heading = (await page.getByRole("heading", { name: "Messages", exact: true }).boundingBox())!;
  const firstAction = (await page.getByRole("button", { name: /Switch to .* mode/ }).boundingBox())!;
  expect(heading.x + heading.width).toBeLessThanOrEqual(firstAction.x);
  await page.screenshot({ path: test.info().outputPath(`messages-back-${width}.png`), animations: "disabled" });
  await back.click();
  await expect(page).toHaveURL("http://localhost/one");
}

export async function proveMessagesBackLayers(page: Page, mount: MountMessages, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await mount(page);
  const chat = page.locator("[data-direct-message-page]");
  await page.getByRole("button", { name: "Search messages", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search messages" })).toBeVisible();
  const back = width < 768
    ? () => page.evaluate(() => (window as unknown as { directChatUnwindBack: () => boolean }).directChatUnwindBack())
    : async () => { await page.getByRole("button", { name: "Go back", exact: true }).click(); return true; };
  expect(await back()).toBe(true);
  await expect(page.getByRole("searchbox", { name: "Search messages" })).toHaveCount(0);
  await expect(chat).toHaveAttribute("data-chat-open", "true");
  expect(await back()).toBe(true);
  await expect(chat).toHaveAttribute("data-chat-open", "false");
  if (width < 768) expect(await back()).toBe(false);
  else {
    await back();
    await expect(page).toHaveURL("http://localhost/one");
  }
}

export function readCircleInboxGeometry(heading: Locator) {
  return heading.evaluate(el => {
    const style = getComputedStyle(el);
    const headerElement = el.closest("header")!;
    const header = headerElement.getBoundingClientRect();
    const title = el.getBoundingClientRect();
    const action = headerElement.querySelector("a")!.getBoundingClientRect();
    const aside = el.closest("aside")!;
    const pane = el.closest("[data-circle-messages-pane]")!;
    return {
      fontSize: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight,
      headerHeight: header.height, titleLeft: title.left - header.left,
      titleRight: title.right, actionLeft: action.left, actionRight: action.right,
      titleBottom: title.bottom, actionTop: action.top,
      viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
      listHeight: aside.getBoundingClientRect().height,
      paneHeight: pane.getBoundingClientRect().height,
      threadHeight: pane.querySelector(":scope > section")!.getBoundingClientRect().height,
    };
  });
}
