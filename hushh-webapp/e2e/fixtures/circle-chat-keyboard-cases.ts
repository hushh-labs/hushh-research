import { expect, test, type Page, type Locator } from "@playwright/test";

export function registerCircleChatKeyboardCases({ mount, openMessageOptions }: {
  mount: (page: Page, dark?: boolean, workspace?: boolean) => Promise<void>;
  openMessageOptions: (page: Page, message: Locator) => Promise<void>;
}) {
  test("phone Circle actions open on hold and the composer follows the keyboard without a blank gap", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 393, height: 844 });
    await mount(page, false, true);
    await expect(page.getByText("Only circle members can read these messages.", { exact: true })).toHaveCount(0);
    const message = page.locator('[data-chat-message="hello"]');
    const options = message.getByRole("button", { name: "Message options" });
    await expect(options.locator("..")).toHaveCSS("opacity", "0");
    await openMessageOptions(page, message);
    await page.getByRole("menuitem", { name: "React ❤️", exact: true }).click();
    await expect(message.getByRole("button", { name: "❤️, 1 reactions, you reacted" })).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await openMessageOptions(page, message);
    await page.getByRole("menuitem", { name: "More reactions…", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Emoji picker" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Emoji picker" })).not.toBeVisible();
    const members = page.getByRole("button", { name: "View circle members" });
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(members).toBeVisible();
    await editor.fill("A draft that survives the keyboard opening");
    for (const mode of ["native", "mobile-web", "resized"] as const) {
      await page.setViewportSize({ width: 393, height: mode === "resized" ? 544 : 844 });
      await page.evaluate(mode => {
        const root = document.documentElement;
        root.classList.add("kb-open");
        root.classList.toggle("native-keyboard-inset", mode !== "mobile-web");
        root.classList.toggle("kb-resizes", mode === "resized");
        root.style.setProperty("--kb-height", mode === "resized" ? "0px" : "300px");
        if (mode === "mobile-web") root.style.setProperty("--kb-visible-height", "544px");
        else root.style.removeProperty("--kb-visible-height");
      }, mode);
      await expect(members).toBeHidden();
      await expect(page.getByRole("tab", { name: "Members", exact: true })).toBeVisible();
      await expect.poll(() => page.locator("[data-circle-chat-composer]").evaluate(node => 544 - node.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
      await expect.poll(() => page.locator("[data-circle-chat-composer]").evaluate(node => 544 - node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(10);
      await expect(editor).toHaveValue("A draft that survives the keyboard opening");
      expect((await page.getByLabel("Circle messages", { exact: true }).boundingBox())!.height).toBeGreaterThan(40);
      if (mode === "native") await page.screenshot({ path: test.info().outputPath("circle-keyboard-gap-fixed.png"), animations: "disabled", clip: { x: 0, y: 0, width: 393, height: 544 } });
    }
    await page.evaluate(() => {
      document.documentElement.classList.remove("kb-open", "native-keyboard-inset", "kb-resizes");
      document.documentElement.style.removeProperty("--kb-height");
    });
    await page.setViewportSize({ width: 393, height: 844 });
    await expect(members).toBeVisible();
    const gap = await members.evaluate(node => node.getBoundingClientRect().top - document.querySelector("[data-one-chat-surface]")!.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(16);
    expect(errors).toEqual([]);
  });

}
