import { expect, test, type Page } from "@playwright/test";

export function registerFinanceSharingChecks(mount: (page: Page, width: number) => Promise<void>) {
test("Finance motion keeps sharing immediate with reduced motion", async ({ page }) => {
  await mount(page, 393);
  await page.getByRole("button", { name: "Open sample Finance sharing", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Share Finance", exact: true });
  await edit.getByRole("checkbox", { name: /Sample connection/ }).check();
  await edit.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(edit.getByRole("heading", { name: "What do you want to share?" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(edit.getByRole("checkbox", { name: /^Allocation/ })).toBeFocused();
  const options = edit.getByTestId("finance-share-options");
  const motion = await options.evaluate(el => {
    const style = getComputedStyle(el);
    return { name: style.animationName, duration: parseFloat(style.animationDuration) };
  });
  expect(motion.name).toBe("app-step-enter");
  expect(motion.duration).toBeGreaterThan(0);
  expect(motion.duration).toBeLessThanOrEqual(.15);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => options.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  await edit.getByRole("button", { name: "Ongoing access", exact: false }).click();
  const ongoing = edit.getByRole("button", { name: "Ongoing access", exact: false });
  await expect(ongoing).toHaveAttribute("aria-pressed", "true");
  expect(await ongoing.evaluate(el => getComputedStyle(el, "::before").opacity)).toBe("1");
  expect(await ongoing.evaluate(el => getComputedStyle(el, "::before").transitionDuration)).toBe("0s");
  await edit.getByRole("button", { name: "Back", exact: true }).click();
  await expect(edit.getByRole("heading", { name: "Who can see it?" })).toBeFocused();
  await expect(edit.getByRole("checkbox", { name: /Sample connection/ })).toBeChecked();
  await expect(edit.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await expect(page.locator("body")).not.toHaveAttribute("data-finance-publishes");
});

for (const width of [393, 1440]) for (const theme of ["light", "dark"]) {
  test(`Finance sharing approval and ended access ${width}px ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mount(page, width);
    await page.evaluate(mode => document.documentElement.classList.toggle("dark", mode === "dark"), theme);
    await page.getByRole("button", { name: "Open sample Finance sharing", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Share Finance", exact: true });
    await expect(edit).toBeVisible();
    const people = edit.getByTestId("finance-share-people");
    await edit.getByRole("checkbox", { name: /Sample connection/ }).check();
    if (width < 768) {
      await expect(edit.getByRole("heading", { name: "How should access work?" })).toBeHidden();
      await page.screenshot({ path: test.info().outputPath(`finance-sharing-people-${width}-${theme}.png`), animations: "disabled" });
      await edit.getByRole("button", { name: "Continue", exact: true }).click();
      await edit.getByRole("button", { name: "Back", exact: true }).click();
      await expect(edit.getByRole("checkbox", { name: /Sample connection/ })).toBeChecked();
      await edit.getByRole("button", { name: "Continue", exact: true }).click();
    } else {
      const left = (await people.boundingBox())!;
      const right = (await edit.getByTestId("finance-share-options").boundingBox())!;
      expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(left.height - right.height)).toBeLessThanOrEqual(1);
      expect(left.x + left.width).toBeLessThan(right.x);
      expect(await people.getByRole("group", { name: "Connections" }).evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    }
    expect(await edit.getByRole("heading", { name: "What do you want to share?" }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(16);
    const dollars = edit.getByRole("checkbox", { name: /Show dollar amounts/ });
    const model = edit.getByRole("checkbox", { name: /Allow their private agent to review/ });
    await expect(dollars).not.toBeChecked();
    await expect(model).not.toBeChecked();
    await expect(page.locator("body")).not.toHaveAttribute("data-finance-publishes");
    const forward = edit.getByRole("button", { name: "Preview", exact: true });
    const manage = edit.getByRole("button", { name: width < 768 ? "Back" : "Manage sharing", exact: true });
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
