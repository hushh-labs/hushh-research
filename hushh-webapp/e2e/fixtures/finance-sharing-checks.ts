import { expect, test, type Page } from "@playwright/test";

export function registerFinanceSharingChecks(mount: (page: Page, width: number) => Promise<void>) {
for (const width of [393, 1440]) for (const theme of ["light", "dark"]) {
  test(`Finance sharing approval and ended access ${width}px ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mount(page, width);
    await page.evaluate(mode => document.documentElement.classList.toggle("dark", mode === "dark"), theme);
    await page.getByRole("button", { name: "Open sample Finance sharing", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Share Finance", exact: true });
    await expect(edit).toBeVisible();
    const dollars = edit.getByRole("checkbox", { name: /Show dollar amounts/ });
    const model = edit.getByRole("checkbox", { name: /Allow their private agent to review/ });
    await expect(dollars).not.toBeChecked();
    await expect(model).not.toBeChecked();
    await expect(page.locator("body")).not.toHaveAttribute("data-finance-publishes");
    await edit.getByRole("checkbox", { name: /Sample connection/ }).check();
    const first = await edit.getByRole("heading", { name: "Who can see it?" }).boundingBox();
    const second = await edit.getByRole("heading", { name: "How should access work?" }).boundingBox();
    if (width >= 1024) expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
    else expect(second!.y).toBeGreaterThan(first!.y);
    await edit.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Review before sharing", exact: true });
    await expect(preview.getByRole("region", { name: "Shared allocation" })).toBeVisible();
    await expect(preview.getByText("Hidden", { exact: true })).toBeVisible();
    await expect(preview.getByText("Not allowed", { exact: true })).toBeVisible();
    await expect(preview.locator("path.recharts-area-curve")).toHaveAttribute("d", /^M/);
    await expect(preview).not.toContainText("$10,000");
    expect(await preview.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const confirm = preview.getByRole("button", { name: "Share with 1 person", exact: true });
    expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: test.info().outputPath(`finance-sharing-${width}-${theme}.png`) });
    await confirm.click();
    await expect(page.locator("body")).toHaveAttribute("data-finance-publishes", "1");
    const sent = page.getByRole("dialog", { name: "Finance shared", exact: true });
    await sent.getByRole("button", { name: "Done", exact: true }).click();
    await expect(sent).toHaveCount(0);
    await page.getByRole("button", { name: "Open sample received Finance", exact: true }).click();
    const received = page.getByRole("dialog", { name: "Sample sender · Finance", exact: true });
    await expect(received.getByRole("region", { name: "Shared allocation" })).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute("data-finance-reviews");
    await received.getByRole("button", { name: "Review with my private agent", exact: true }).click();
    await expect(received.getByText(/^Synthetic review:/)).toBeVisible();
    await page.evaluate(() => { document.body.dataset.financeEnded = "true"; window.dispatchEvent(new Event("finance-sharing-changed")); });
    await expect(page.getByRole("dialog", { name: "Shared Finance", exact: true }).getByText("The owner stopped sharing this information.", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Synthetic review:/)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Shared allocation" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

}
