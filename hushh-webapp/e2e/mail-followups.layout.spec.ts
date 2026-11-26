import { expect, test, type Page } from "@playwright/test";
import { buildMailWorkspaceFixture } from "./fixtures/build-mail-workspace";

let fixture: Awaited<ReturnType<typeof buildMailWorkspaceFixture>>;
test.beforeAll(async () => {
  fixture = await buildMailWorkspaceFixture(true);
});
test.afterAll(() => fixture?.dispose());
async function open(page: Page, width: number, journey: string) {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install({ time: new Date("2026-11-22T08:00:00Z") });
  await page.route("http://localhost/followups", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html data-journey="${journey}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fixture.css}</style></head><body><main id="root"></main><script src="/fixture.js"></script></body></html>`,
    }),
  );
  await page.route("http://localhost/fixture.js", (route) =>
    route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: fixture.script,
    }),
  );
  await page.goto("http://localhost/followups");
}
for (const width of [393, 1280]) {
  test(`Document watch and review at ${width}px`, async ({ page }, info) => {
    await open(page, width, "document");
    const button = (name: string) =>
      page.getByRole("button", { name, exact: true });
    await button("Track a conversation").click();
    await page.getByLabel("Person or topic").fill("agreement");
    await button("Find conversation").click();
    await page.getByRole("radio").check();
    await page.getByLabel("What are you waiting for?").fill("Signed agreement");
    await button("Check with Mail AI").click();
    await button("Track in Tasks").click();
    await button("Plan follow-up").click();
    await button("Watch for a reply").click();
    await expect(
      page.getByText("1 conversation", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("board.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.clock.fastForward(61000);
    await expect(
      page.getByRole("region", { name: "In Progress" }).getByRole("article"),
    ).toHaveCount(1);
    await page.evaluate(() => {
      document.documentElement.dataset.reply = "signed";
    });
    await page.clock.fastForward(61000);
    await expect(
      page.getByRole("region", { name: "Done" }).getByRole("article"),
    ).toHaveCount(1);
    const checks = await page.locator("html").getAttribute("data-checks");
    await page.clock.fastForward(121000);
    await expect(page.locator("html")).toHaveAttribute("data-checks", checks!);
    await button("Review outcome").click();
    await expect(button("Prepare for my review")).toBeDisabled();
    await button("Open signed.pdf").click();
    await button("I reviewed the document").click();
    await button("Prepare for my review").click();
    await expect(page.getByLabel("Message")).toHaveValue(
      "Draft for a@example.test",
    );
  });
  test(`Independent mailbox evidence and draft at ${width}px`, async ({
    page,
  }) => {
    await open(page, width, "accounts");
    const button = (name: string) =>
      page.getByRole("button", { name, exact: true });
    async function choose(id: string) {
      await page
        .getByRole("combobox", { name: "Choose mailbox" })
        .selectOption({ label: id + "@example.test" });
    }
    await choose("b");
    await expect(page.getByRole("combobox")).toHaveValue("b");
    await choose("c");
    await page.clock.fastForward(5100);
    await expect(
      page.getByRole("heading", { name: "Get the signed document for c" }),
    ).toBeVisible();
    await button("Why this?").click();
    await expect(
      page.getByRole("heading", { name: "Evidence for c@example.test" }),
    ).toBeVisible();
    await button("Back to Follow-ups").click();
    await button("Plan follow-up").click();
    await button("Prepare for my review").click();
    await expect(page.getByLabel("Message")).toHaveValue(
      "Draft for c@example.test",
    );
    await expect(page.getByText("To lab-c@example.test")).toBeVisible();
    await choose("b");
    await button("Disconnect mailbox").click();
    await button("Confirm disconnect").click();
    await expect(
      page.getByRole("heading", { name: "Get the signed document for a" }),
    ).toBeVisible();
    await choose("c");
    await expect(
      page.getByRole("heading", { name: "Get the signed document for c" }),
    ).toBeVisible();
  });
}

for (const width of [393, 1280]) {
  test(`All Mail board fixture at ${width}px`, async ({ page }, info) => {
    await open(page, width, "board");
    await page.getByRole("combobox").selectOption({ label: "All Mail" });
    await expect(
      page.getByText("7 conversations", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("4 need you · 2 waiting")).toBeVisible();
    await page.screenshot({
      path: info.outputPath("followups.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

test("a matching document cancels only its Task reminder after leaving Mail", async ({ page }) => {
  await open(page, 393, "reminders");
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const choose = (id: string) => page.getByRole("combobox", { name: "Choose mailbox" })
    .selectOption({ label: id + "@example.test" });
  const schedule = async (time: string) => {
    await button("Remind me in One").click();
    const localInput = await page.evaluate((time) => {
      const due = new Date("2026-11-22T" + time + ":00Z");
      return new Date(due.getTime() - due.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }, time);
    await page.getByLabel("Reminder time").fill(localInput);
    await button("Save reminder").click();
    await expect(button("Cancel reminder")).toBeVisible();
  };
  const storedState = () => page.locator("html").evaluate((root) => {
    const saved = JSON.parse(root.getAttribute("data-saved-tasks") ?? '{"tasks":[]}') as {
      tasks: { id: string; status: string; personalReminder?: { state: string } }[];
    };
    return Object.fromEntries(saved.tasks.map(task => [
      task.id[0], [task.status, task.personalReminder?.state],
    ]));
  });

  await choose("b");
  await button("Plan follow-up").click();
  await schedule("08:09");
  await button("Cancel reminder").click();
  await expect.poll(storedState).toMatchObject({ b: ["pending", "cancelled"] });
  await schedule("08:08");

  await choose("a");
  await button("Plan follow-up").click();
  await schedule("08:06");
  await button("Leave Mail").click();
  await expect(page.getByRole("combobox", { name: "Choose mailbox" })).toHaveCount(0);
  await page.evaluate(() => { document.documentElement.dataset.reply = "thanks"; });
  await page.clock.fastForward(61000);
  await expect.poll(storedState).toEqual({ a: ["pending", "pending"], b: ["pending", "pending"] });

  await page.evaluate(() => { document.documentElement.dataset.reply = "signed"; });
  await page.clock.fastForward(61000);
  await expect.poll(storedState).toEqual({ a: ["done", "cancelled"], b: ["pending", "pending"] });
  await page.clock.fastForward(4 * 60000);
  await expect(page.getByText("Task reminder", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(2 * 60000);
  const reminder = page.locator("[data-sonner-toast]").filter({ hasText: "Task reminder" });
  await expect.poll(storedState).toEqual({ a: ["done", "cancelled"], b: ["pending", "delivered"] });
  await page.clock.runFor(100);
  await expect(reminder).toHaveCount(1);
  await expect(reminder).toContainText("Get the signed document for b");
  await expect(reminder.getByRole("button", { name: "Open Tasks" })).toBeVisible();
});
