import { expect, test, type Page } from "@playwright/test";

type Mount = (page: Page, options: { at: string; width?: number }) => Promise<string[]>;
const pane = (page: Page) => page.getByTestId("profile-pane");
const title = (page: Page) => pane(page).locator("h2").first();
const query = (page: Page) => new URL(page.url()).searchParams;

/** The Profile and History controls must share one destination and origin. */
export function registerProfileConnectorNavigation(mount: Mount) {
  for (const [entry, act, detail] of [
    ["the Profile row", async (page: Page) => {
      await page.getByTestId("open-profile").click();
      await pane(page).getByTestId("profile-connectors-row").getByRole("button").click();
    }, null],
    ["a Drive card's reconnect link", async (page: Page) => {
      await page.getByTestId("drive-card-reconnect").click();
    }, "connector:google_drive"],
    ["chat's Open connectors", async (page: Page) => {
      await page.getByTestId("chat-open-connectors").click();
    }, null],
    ["chat's History footer", async (page: Page) => {
      await page.getByTestId("chat-history-opener").click();
      await page.getByRole("button", { name: "Open Connectors", exact: true }).click();
    }, null],
  ] as const) {
    test(`Connectors from ${entry} lands in the Profile pane`, async ({ page }) => {
      const errors = await mount(page, { at: "/" });
      await act(page);
      await expect(pane(page)).toBeVisible();
      await expect(title(page)).toHaveText(detail ? "Google Drive" : "Connectors");
      await expect(pane(page).locator("[data-surface='profile']")).toBeVisible();
      await expect(page.getByRole("heading", { name: "One access", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "What One knows", exact: true })).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/");
      expect(query(page).get("profile_pane")).toBe("1");
      expect(query(page).get("profile_panel")).toBe("connectors");
      expect(query(page).get("profile_detail")).toBe(detail);
      expect(errors).toEqual([]);
    });
  }
  for (const width of [390, 1440]) {
    for (const dismiss of ["Back", "Close", "Escape"]) {
      test(`History Connectors returns to the same chat with ${dismiss} at ${width}px`, async ({ page }) => {
        const consoleErrors: string[] = [];
        page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
        const errors = await mount(page, { at: "/", width });
        const draft = page.getByRole("textbox", { name: "Chat draft" });
        await draft.fill("Keep my unsent conversation");
        const original = await draft.elementHandle();
        const opener = page.getByTestId("chat-history-opener");
        await opener.click();
        await page.getByRole("button", { name: "Open Connectors", exact: true }).click();
        await expect(title(page)).toHaveText("Connectors");
        if (dismiss === "Back") await pane(page).screenshot({ path: test.info().outputPath(`chat-connectors-${width}.png`) });
        await expect(page.getByRole("dialog", { name: "Agent chat history", exact: true })).not.toBeVisible();
        if (dismiss === "Escape") await page.keyboard.press("Escape");
        else await pane(page).getByRole("button", { name: dismiss === "Back" ? "Back in Profile" : "Close Profile" }).click();
        await expect(pane(page)).toHaveCount(0);
        await expect(draft).toHaveValue("Keep my unsent conversation");
        expect(await original!.evaluate(element => element.isConnected)).toBe(true);
        await expect(page.getByTestId("stream")).toHaveText("Streaming turn 1");
        await expect(opener).toBeFocused();
        expect(query(page).get("profile_pane")).toBeNull();
        await opener.click();
        await expect(page.getByRole("dialog", { name: "Agent chat history", exact: true })).toBeVisible();
        expect([...errors, ...consoleErrors]).toEqual([]);
      });
    }
  }
}
