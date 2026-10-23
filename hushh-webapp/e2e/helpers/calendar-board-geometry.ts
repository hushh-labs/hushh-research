import { expect, type Locator, type Page } from "@playwright/test";

export async function assertCalendarBoardGeometry(page: Page, width: number) {
  const board = page.locator("[data-calendar-account-board]");
  await expect(board).toBeVisible();
  const shell = page.locator('[data-app-shell-width="agent"]').filter({ has: board });
  await expect(shell).toBeVisible();
  const box = await shell.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(880);
  if (width >= 901) expect(Math.abs(box!.x - (width - box!.width) / 2)).toBeLessThanOrEqual(1);
}

export async function assertCalendarAccountLabel(label: Locator, width: number) {
  const name = label.locator("div").first();
  const domain = label.locator("span").first();
  await expect(name).toHaveCSS("font-size", "14px");
  await expect(domain).toHaveCSS("font-size", "12px");
  expect(`${await name.textContent()}${await domain.textContent()}`).toBe(await label.getAttribute("title"));
  if (width < 901) return;
  expect(await label.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
}
