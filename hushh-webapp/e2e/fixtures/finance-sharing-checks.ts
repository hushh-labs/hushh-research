import { expect, test, type Page } from "@playwright/test";

export function registerFinanceSharingChecks(mount: (page: Page, width: number) => Promise<void>) {
for (const width of [393, 1024]) {
  test(`Finance received-only management ${width}px`, async ({ page }) => {
    await mount(page, width);
    const sharing = page.getByTestId("finance-received-only-fixture");
    await expect(sharing.getByRole("button", { name: "Ask an advisor", exact: true })).toBeDisabled();
    await expect(sharing.getByRole("button", { name: "Share portfolio", exact: true })).toBeDisabled();
    await sharing.getByRole("button", { name: "Manage sharing", exact: true }).click();
    const manager = page.getByRole("dialog", { name: "Finance sharing", exact: true });
    await expect(manager.getByRole("button", { name: "Shared by you", exact: true })).toBeDisabled();
    await expect(manager.getByRole("heading", { name: "Sample sender", exact: true })).toBeVisible();
    const view = manager.getByRole("button", { name: "View", exact: true });
    await expect(view).toBeVisible();
    expect(await manager.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (width >= 768) {
      const inset = await view.evaluate(button => button.closest("article")!.getBoundingClientRect().right - button.getBoundingClientRect().right);
      expect(Math.abs(inset)).toBeLessThanOrEqual(1);
    }
    await manager.screenshot({ path: test.info().outputPath(`finance-manager-${width}.png`) });
    await view.click();
    await expect(page.getByRole("dialog", { name: "Sample sender · Finance", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute("data-finance-publishes");
  });
}
test("Finance sharing swipes retain one fixed frame across resize and reduced motion", async ({ page }) => {
  await mount(page, 393);
  await page.getByRole("button", { name: "Open sample Finance sharing", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Share Finance", exact: true });
  const initialHeight = (await edit.boundingBox())!.height;
  await edit.getByRole("checkbox", { name: /Sample connection/ }).check();
  const pager = edit.locator('[data-swipe-views-root="true"]');
  const swipe = async (forward: boolean) => {
    const box = (await pager.boundingBox())!;
    await page.mouse.move(box.x + box.width * (forward ? .8 : .2), box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (forward ? .2 : .8), box.y + 12, { steps: 15 });
    await page.mouse.up();
  };
  await swipe(true);
  await expect(edit.getByRole("heading", { name: "What do you want to share?" })).toBeFocused();
  expect((await edit.boundingBox())!.height).toBeCloseTo(initialHeight, 0);
  await swipe(false);
  await expect(edit.getByRole("heading", { name: "Who can see it?" })).toBeFocused();
  await expect(edit.getByRole("checkbox", { name: /Sample connection/ })).toBeChecked();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-task-surface="sheet"]')).toHaveCount(1);
  await expect(edit.getByRole("checkbox", { name: /Sample connection/ })).toBeChecked();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await edit.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(edit.getByRole("heading", { name: "What do you want to share?" })).toBeFocused();
  await edit.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(edit.getByRole("heading", { name: "How should access work?" })).toBeFocused();
  const active = edit.getByRole("tabpanel", { name: "How should access work?" });
  await expect.poll(async () => Math.abs((await active.boundingBox())!.x - (await pager.boundingBox())!.x)).toBeLessThanOrEqual(1);
  await edit.getByRole("button", { name: "Ongoing access", exact: false }).click();
  await expect(edit.getByRole("button", { name: "Ongoing access", exact: false })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).not.toHaveAttribute("data-finance-publishes");
});

for (const width of [393, 1440]) for (const theme of ["light", "dark"]) {
  test(`Finance sharing layout and preview ${width}px ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mount(page, width);
    await page.evaluate(mode => document.documentElement.classList.toggle("dark", mode === "dark"), theme);
    await page.getByRole("button", { name: "Open sample Finance sharing", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Share Finance", exact: true });
    await expect(edit).toBeVisible();
    const people = edit.getByTestId("finance-share-people");
    await edit.getByRole("checkbox", { name: /Sample connection/ }).check();
    const frameHeight = (await edit.boundingBox())!.height;
    await expect(page.locator('[data-task-surface="sheet"]')).toHaveCount(1);
    await expect(edit.getByRole("heading", { name: "How should access work?" })).toBeHidden();
    expect(await people.getByRole("group", { name: "Connections" }).evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await edit.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(edit.getByRole("heading", { name: "What do you want to share?" })).toBeFocused();
    expect((await edit.boundingBox())!.height).toBeCloseTo(frameHeight, 0);
    expect(await edit.getByRole("heading", { name: "What do you want to share?" }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(16);
    await edit.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(edit.getByRole("heading", { name: "How should access work?" })).toBeFocused();
    expect((await edit.boundingBox())!.height).toBeCloseTo(frameHeight, 0);
    const dollars = edit.getByRole("checkbox", { name: /Show dollar amounts/ });
    const model = edit.getByRole("checkbox", { name: /Allow their Agent One to review/ });
    await expect(dollars).not.toBeChecked();
    await expect(model).not.toBeChecked();
    await expect(page.locator("body")).not.toHaveAttribute("data-finance-publishes");
    const forward = edit.getByRole("button", { name: "Preview", exact: true });
    const manage = edit.getByRole("button", { name: "Back", exact: true });
    expect((await forward.boundingBox())!.x).toBeGreaterThan((await manage.boundingBox())!.x);
    const forwardBox = (await forward.boundingBox())!;
    const dialogBox = (await edit.boundingBox())!;
    expect(dialogBox.x + dialogBox.width - forwardBox.x - forwardBox.width).toBeLessThanOrEqual(32);
    const accents = await forward.evaluate(el => ["--app-accent", "--app-accent-hover"].map(token => {
      const probe = document.createElement("span"); probe.style.backgroundColor = `var(${token})`; el.append(probe);
      const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color;
    }));
    await expect.poll(async () => accents.includes(await forward.evaluate(el => getComputedStyle(el).backgroundColor))).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`finance-sharing-edit-${width}-${theme}.png`), animations: "disabled" });
    await edit.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Review before sharing", exact: true });
    await expect(preview.getByRole("region", { name: "Shared allocation" })).toBeVisible();
    expect((await preview.boundingBox())!.height).toBeCloseTo(frameHeight, 0);
    await expect(preview.getByText("Hidden", { exact: true })).toBeVisible();
    await expect(preview.getByText("Not allowed", { exact: true })).toBeVisible();
    await expect(preview.locator("path.recharts-area-curve")).toHaveAttribute("d", /^M/);
    await expect(preview).not.toContainText("$10,000");
    expect(await preview.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const confirm = preview.getByRole("button", { name: "Share with 1 person", exact: true });
    expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: test.info().outputPath(`finance-sharing-${width}-${theme}.png`) });
    await expect(page.locator("body")).not.toHaveAttribute("data-finance-publishes");
    expect(errors).toEqual([]);
  });
  test(`Finance sharing approval ${width}px ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mount(page, width);
    await page.evaluate(mode => document.documentElement.classList.toggle("dark", mode === "dark"), theme);
    await page.getByRole("button", { name: "Open sample Finance sharing", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Share Finance", exact: true });
    await edit.getByRole("checkbox", { name: /Sample connection/ }).check();
    await edit.getByRole("button", { name: "Continue", exact: true }).click();
    await edit.getByRole("button", { name: "Continue", exact: true }).click();
    await edit.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Review before sharing", exact: true });
    await expect(page.locator("body")).not.toHaveAttribute("data-finance-publishes");
    const confirm = preview.getByRole("button", { name: "Share with 1 person", exact: true });
    await confirm.click();
    await expect(page.locator("body")).toHaveAttribute("data-finance-publishes", "1");
    const sent = page.getByRole("dialog", { name: "Finance shared", exact: true });
    await sent.getByRole("button", { name: "Done", exact: true }).click();
    await expect(sent).toHaveCount(0);
    expect(errors).toEqual([]);
  });
  test(`Finance received review clears after access ends ${width}px ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mount(page, width);
    await page.evaluate(mode => document.documentElement.classList.toggle("dark", mode === "dark"), theme);
    await page.getByRole("button", { name: "Open sample received Finance", exact: true }).click();
    const received = page.getByRole("dialog", { name: "Sample sender · Finance", exact: true });
    await expect(received.getByRole("region", { name: "Shared allocation" })).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute("data-finance-reviews");
    await received.getByRole("button", { name: "Review with Agent One", exact: true }).click();
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
