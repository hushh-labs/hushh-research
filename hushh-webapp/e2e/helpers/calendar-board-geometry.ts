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
  // Profile row label.
  await expect(name).toHaveCSS("font-size", "13px");
  await expect(domain).toHaveCSS("font-size", "12px");
  expect(`${await name.textContent()}${await domain.textContent()}`).toBe(await label.getAttribute("title"));
  if (width < 901) return;
  expect(await label.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
}

/** Verify the three-row cap across meeting and imported-event groups. */
export async function assertCalendarAccountScroll(page: Page, width: number, screenshotPath: string) {
  await page.setViewportSize({ width, height: 700 });
  const owner = page.getByRole("group", { name: "Calendar account qa-owner@example.com" });
  const card = page.getByRole("group", { name: "Calendar account qa-work@example.com" });
  const ownerEvents = owner.getByRole("region", { name: "Calendar events for qa-owner@example.com" });
  const events = card.getByRole("region", { name: "Calendar events for qa-work@example.com" });
  await expect(ownerEvents.getByRole("listitem")).toHaveCount(3);
  await expect(ownerEvents).not.toHaveAttribute("data-scrollable");
  await expect(events.getByRole("listitem")).toHaveCount(4);
  await expect(events).toHaveAttribute("data-scrollable", "true");
  await expect(card.getByText("3 meetings", { exact: true })).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toHaveCount(3);
  await expect(page.getByText(/Awaiting your response/i)).toHaveCount(0);
  const geometry = await events.evaluate(node => ({
    height: node.clientHeight, contentHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY,
    titleInsets: Array.from(node.querySelectorAll("li")).map(row => row.querySelector("strong")!.getBoundingClientRect().top - row.getBoundingClientRect().top),
  }));
  expect(geometry.contentHeight).toBeGreaterThan(geometry.height);
  expect(geometry.overflow).toBe("auto");
  expect(geometry.height).toBeCloseTo((await ownerEvents.boundingBox())!.height, 0);
  expect(geometry.height).toBeCloseTo(3 * 108, 0);
  expect(Math.max(...geometry.titleInsets) - Math.min(...geometry.titleInsets)).toBeLessThanOrEqual(1);
  const root = page.getByTestId("calendar-scroll-root");
  await ownerEvents.getByRole("listitem").first().hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => root.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await events.scrollIntoViewIfNeeded();
  await events.getByRole("listitem").first().hover();
  const parentTop = await root.evaluate(node => node.scrollTop);
  await page.mouse.wheel(0, 80);
  await expect.poll(() => events.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  expect(await root.evaluate(node => node.scrollTop)).toBe(parentTop);
  const last = events.getByRole("button", { name: /^Open QA Client Call 4 / });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const crowded = page.getByRole("region", { name: "Calendar events for qa-projects@example.com" });
  await expect(crowded.getByRole("listitem")).toHaveCount(12);
  await expect(crowded).toHaveCSS("max-height", "324px");
  await page.screenshot({ animations: "disabled", path: screenshotPath });
  const footer = page.getByRole("button", { name: "Try Calendar Agent with One" });
  await footer.scrollIntoViewIfNeeded();
  await expect(footer).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
