import { expect, type Page } from "@playwright/test";

/** Confirm that a roster option opens one accessible, legible removal choice. */
export async function assertConnectionRemoveDialog(page: Page, name: string, viewportWidth: number) {
  await page.getByRole("button", { name: `Options for ${name}`, exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-slot="alert-dialog-overlay"]')).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Remove connection" })).toBeVisible();
  await expect(dialog).toContainText(`Remove ${name} from your connections?`);
  await expect(dialog.locator('[data-slot="alert-dialog-footer"] button')).toHaveCount(2);

  const removeAction = dialog.getByRole("button", { name: "Remove", exact: true });
  await expect(removeAction).toBeVisible();
  await expect(removeAction.locator("svg")).toHaveCount(0);
  const appearance = await removeAction.evaluate((button) => {
    const label = button.querySelector(":scope > span");
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--app-destructive)";
    document.body.append(probe);
    const buttonBounds = button.getBoundingClientRect();
    const labelBounds = label?.getBoundingClientRect();
    const result = {
      labelOffset: labelBounds
        ? Math.abs(labelBounds.left + labelBounds.width / 2 - (buttonBounds.left + buttonBounds.width / 2))
        : null,
      buttonColor: getComputedStyle(button).backgroundColor,
      systemRed: getComputedStyle(probe).backgroundColor,
    };
    probe.remove();
    return result;
  });
  expect(appearance.labelOffset).not.toBeNull();
  expect(appearance.labelOffset!).toBeLessThan(2);
  expect(appearance.buttonColor).toBe(appearance.systemRed);

  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(Math.abs(bounds!.x + bounds!.width / 2 - viewportWidth / 2)).toBeLessThan(2);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
}
