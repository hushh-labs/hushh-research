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
    await page.getByLabel("Message").fill("My unsent text for C");
    await choose("b");
    await button("Disconnect mailbox").click();
    await button("Confirm disconnect").click();
    await expect(page.getByText("Choose a mailbox to continue.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Get the signed document for a" })).toHaveCount(0);
    await choose("a");
    await expect(
      page.getByRole("heading", { name: "Get the signed document for a" }),
    ).toBeVisible();
    await choose("c");
    await expect(
      page.getByRole("heading", { name: "Get the signed document for c" }),
    ).toBeVisible();
    await button("Plan follow-up").click();
    await button("Prepare for my review").click();
    await expect(page.getByLabel("Message")).toHaveValue("My unsent text for C");
    await expect(page.getByText("From c@example.test")).toBeVisible();
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
