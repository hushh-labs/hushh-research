import { installDirectChatFixture, mount, fixture, transcript } from "./fixtures/direct-chat-layout";
import { expect, test } from "@playwright/test";

installDirectChatFixture();

test("tapping the selected inbox row refreshes the last transcript to the latest state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = await mount(page);
  await expect(page.getByRole("textbox", { name: "Message Maya Rao" })).toBeEnabled();
  await fixture(page, "fixture.incoming('maya', false); fixture.holdHistory()");
  await page.getByRole("group", { name: "Maya Rao chat" }).getByRole("button", { name: /Maya Rao/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).directChatFixture.historyPending())).toBe(true);
  await expect(page.locator('[data-chat-message="maya-79"]')).toBeVisible();
  await expect(page.getByText("Loading messages…", { exact: true })).toHaveCount(0);
  await fixture(page, "fixture.releaseHistory()");
  await expect(transcript(page).getByText("New message 81", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) test(`cold selection keeps its identity and shows loading at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const errors = await mount(page, false, false, true);
  await fixture(page, "fixture.holdHistory()");
  await page.getByRole("button", { name: /Maya Rao/ }).click();
  await expect(page.getByRole("heading", { name: "Maya Rao", exact: true })).toBeVisible();
  await expect(page.getByText("Loading messages…", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Maya Rao" })).toBeDisabled();
  await fixture(page, "fixture.releaseHistory()");
  await expect(page.locator('[data-chat-message="maya-79"]')).toBeVisible();
  await expect(page.getByText("Loading messages…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Maya Rao" })).toBeEnabled();
  expect(errors).toEqual([]);
});
