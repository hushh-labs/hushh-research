import { expect, type Page } from "@playwright/test";
import path from "node:path";

export async function assertMutualListLayout(page: Page, width: number) {
  await expect(
    page.getByRole("heading", { level: 1, name: "25 mutual connections" }),
  ).toBeVisible();
  await expect(page.getByText("Showing 20 of 25")).toBeVisible();

  const listBox = await page.getByTestId("mutual-connections-list").boundingBox();
  if (!listBox) throw new Error("Mutual connections list should have a rendered box.");
  expect(listBox.width).toBeGreaterThan(width === 393 ? 300 : 900);
  expect(listBox.width).toBeLessThanOrEqual(width === 393 ? 393 : 1120);
  const header = page.getByTestId("mutual-connections-list").locator("header");
  expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  const firstAction = page.getByRole("button", {
    name: "Open Mutual Person 01's profile",
  });
  const actionBox = await firstAction.boundingBox();
  if (!actionBox) throw new Error("Mutual profile action should have a rendered box.");
  expect(actionBox.height).toBeGreaterThanOrEqual(76);
  await expect(firstAction.getByText("View profile", { exact: true })).toBeVisible({
    visible: width !== 393,
  });

  if (process.env.MUTUAL_EVIDENCE_DIR) {
    await page.screenshot({
      path: path.join(process.env.MUTUAL_EVIDENCE_DIR, `mutual-list-top-${width}.png`),
    });
  }
}
