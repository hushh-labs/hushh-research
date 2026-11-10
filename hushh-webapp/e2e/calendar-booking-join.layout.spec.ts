import { expect, test } from "@playwright/test";
import path from "node:path";
import { calendarBoardDayFixture } from "./fixtures/calendar-board-day";
import { openFixture, qaNow, registerCalendarConnectedFixture, screenshotDirectory } from "./fixtures/calendar-connected-workspace-harness";

registerCalendarConnectedFixture();

test("booking dropdown arrows have a consistent responsive inset", async ({ page }, testInfo) => {
  const { errors, unexpectedRequests } = await openFixture(page, 393, false, "busy", false, true);
  await page.getByRole("button", { name: /^Schedule from shared free time/ }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule meeting" });
  for (const width of [320, 393, 480, 481, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await page.screenshot({ animations: "disabled" });
    for (const label of ["Calendar account and destination", "Duration", "Where"]) {
      const select = dialog.getByRole("combobox", { name: label, exact: true });
      await select.scrollIntoViewIfNeeded();
      const selectBounds = (await select.boundingBox())!;
      const chevron = select.locator("..").locator("svg");
      const chevronBounds = (await chevron.boundingBox())!;
      expect(selectBounds.height).toBeGreaterThanOrEqual(44);
      expect(selectBounds.x + selectBounds.width - chevronBounds.x - chevronBounds.width, `${label} inset at ${width}px`).toBeCloseTo(12, 0);
      expect(Math.abs(selectBounds.y + selectBounds.height / 2 - chevronBounds.y - chevronBounds.height / 2)).toBeLessThanOrEqual(1);
      expect(await select.evaluate(element => parseFloat(getComputedStyle(element).paddingInlineEnd))).toBeGreaterThanOrEqual(40);
      await expect(chevron).toHaveAttribute("aria-hidden", "true");
      await expect(chevron).toHaveCSS("pointer-events", "none");
    }
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await dialog.getByRole("combobox", { name: "Calendar account and destination", exact: true }).selectOption("work");
  await dialog.getByRole("combobox", { name: "Duration", exact: true }).selectOption("30");
  await dialog.getByRole("combobox", { name: "Where", exact: true }).selectOption("in_person");
  await expect(dialog.getByLabel("Location", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Duration")).toHaveValue("30");
  await expect(dialog.locator("p").filter({ hasText: "qa-work@example.com" })).toBeVisible();
  for (const width of [393, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-booking-dropdowns-${testInfo.project.name}-${width}.png`) });
  }
  expect(errors).toEqual([]); expect(unexpectedRequests).toEqual([]);
});

test("Board books account B in one click and refreshes its event and free time", async ({ page }) => {
  const { errors, unexpectedRequests } = await openFixture(page, 393, false, "busy", false, true);
  await page.getByTestId("calendar-fixture-authorize").dispatchEvent("click");

  const work = page.getByRole("group", { name: "Calendar account qa-work@example.com" });
  const joinTrigger = work.getByRole("link", { name: "Join meeting: QA Client Call 1" });
  await joinTrigger.click();
  const join = page.getByRole("dialog", { name: "Check Google account" });
  await expect(join).toContainText("Use qa-work@example.com in Google Meet.");
  await expect(join.getByRole("link", { name: "Open Meet" })).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij?authuser=qa-work%40example.com");
  await expect(join.getByRole("link", { name: "Choose account" })).toHaveAttribute("href", "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij");
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, "calendar-meet-account-mobile-393.png") });
  await join.getByRole("button", { name: "Cancel" }).click();
  await expect(joinTrigger).toBeFocused();

  let created: Record<string, unknown> | null = null;
  let reviewed: Record<string, unknown> | null = null;
  await page.route("**/api/one/calendar/board/day", route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const board = calendarBoardDayFixture({
      day: String(body.date), zone: String(body.time_zone), durationMinutes: Number(body.duration_minutes),
      now: qaNow, busy: true,
      instant: (day, clock) => Date.parse(`${day}T${clock}:00+05:30`),
    });
    if (created) {
      const destination = board.accounts.find(account => account.account_id === "work")!;
      destination.events.push({
        account_id: "work", id: "created-bug-bash", calendar_id: "primary", title: String(created.title),
        etag: "created-etag", start: { dateTime: String(created.start_at) }, end: { dateTime: String(created.end_at) },
        organizer: { email: "qa-work@example.com" }, can_decline: false, attendees: [],
      });
      destination.free_windows = [];
      board.shared_free_windows = [];
    }
    return route.fulfill({ json: board });
  });
  await page.route("**/api/one/calendar/proposals", route => {
    reviewed = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ json: {
      proposal_id: "gcal_browser_review", expires_at: "2030-01-01T00:00:00Z", confirmation_required: true,
      plan: { ...reviewed, board_conflicts: [], board_accounts: [
        { account_id: "default", account_email: "qa-owner@example.com", binding: ["default"], calendar_ids: ["primary"] },
        { account_id: "work", account_email: "qa-work@example.com", binding: ["work"], calendar_ids: ["primary"] },
        { account_id: "projects", account_email: "qa-projects@example.com", binding: ["projects"], calendar_ids: ["primary"] },
      ] },
    } });
  });
  await page.route("**/api/one/calendar/proposals/execute", route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({ proposal_id: "gcal_browser_review", account_id: "work" });
    created = reviewed;
    return route.fulfill({ json: { action: "create", event: { id: "created-bug-bash", title: "Bug Bash", conference_status: "pending" } } });
  });

  await work.getByRole("tab", { name: "Free time" }).click();
  const opening = work.getByRole("button", { name: /Schedule from free time.*qa-work@example.com/ });
  await opening.click();
  const dialog = page.getByRole("dialog", { name: "Schedule meeting" });
  await expect(dialog.getByLabel("Calendar account and destination")).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Time zone" })).toHaveCount(0);
  await expect.poll(() => dialog.locator("[data-photo-source=hussh] img").evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(dialog.getByLabel("Duration")).toHaveValue("60");
  // The full-width date sits above Start on mobile, and both remain inside the dialog.
  const dialogBox = (await dialog.boundingBox())!;
  const dateBox = (await dialog.getByLabel("Date", { exact: true }).boundingBox())!;
  const startBox = (await dialog.getByLabel("Start", { exact: true }).boundingBox())!;
  expect(dateBox.y + dateBox.height).toBeLessThanOrEqual(startBox.y);
  expect(startBox.x + startBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
  await dialog.getByLabel("Title").fill("Bug Bash");
  await dialog.getByLabel("Guests", { exact: true }).fill("guest@example.com");
  await dialog.getByRole("button", { name: "Add" }).click();
  const schedule = dialog.getByRole("button", { name: "Schedule meeting", exact: true });
  const mobileBounds = (await dialog.boundingBox())!;
  expect(mobileBounds.x).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.y).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.x + mobileBounds.width).toBeLessThanOrEqual(393);
  expect(mobileBounds.y + mobileBounds.height).toBeLessThanOrEqual(950);
  expect(await schedule.evaluate(button => button.scrollWidth)).toBeLessThanOrEqual(await schedule.evaluate(button => button.clientWidth));
  await schedule.click();
  await expect(dialog).toHaveCount(0);
  await expect(work.getByRole("button", { name: /Schedule from free time/ })).toHaveCount(0);
  await expect(page.getByText("No shared opening on this day.")).toBeVisible();
  await work.getByRole("tab", { name: /Events/ }).click();
  await expect(work.getByRole("button", { name: /Open Bug Bash/ })).toBeVisible();
  expect(created).toMatchObject({ account_id: "work", checked_account_ids: ["default", "work", "projects"], title: "Bug Bash", meeting_type: "google_meet", attendees: ["guest@example.com"], send_updates: true });
  expect(unexpectedRequests).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [320, 393]) {
  test(`booking fields and guest controls remain reachable in a short viewport at ${width}px`, async ({ page }) => {
    const { errors, unexpectedRequests } = await openFixture(page, width, false, "busy", false, true);
    await page.setViewportSize({ width, height: 620 });
    const work = page.getByRole("group", { name: "Calendar account qa-work@example.com" });
    await work.getByRole("tab", { name: "Free time" }).click();
    await work.getByRole("button", { name: /Schedule from free time.*qa-work@example.com/ }).click();
    const dialog = page.getByRole("dialog", { name: "Schedule meeting" });
    await expect.poll(() => dialog.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
    const guest = `${"calendar-guest-".repeat(4)}@a-long-guest-domain.example.test`;
    await dialog.getByLabel("Guests", { exact: true }).fill(guest);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const body = dialog.locator("[data-calendar-booking-body]");
    const actions = dialog.locator("[data-calendar-booking-actions]");
    const header = dialog.locator('[data-slot="dialog-header"]');
    const assertHitTarget = async (locator: ReturnType<typeof dialog.getByRole>) => {
      await locator.scrollIntoViewIfNeeded();
      expect(await locator.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
    };
    for (const keyboardHeight of [0, 220]) {
      await page.evaluate(height => {
        document.documentElement.classList.toggle("kb-open", height > 0);
        document.documentElement.style.setProperty("--kb-height", `${height}px`);
        document.documentElement.style.setProperty("--app-safe-area-top-effective", "44px");
      }, keyboardHeight);
      await page.screenshot({ animations: "disabled" });
      const frame = (await dialog.boundingBox())!;
      const headerAtOpen = (await header.boundingBox())!;
      expect(headerAtOpen.y - frame.y).toBeLessThan(32);
      expect(frame.y).toBeGreaterThanOrEqual(16);
      expect(frame.y + frame.height).toBeLessThanOrEqual(620 - keyboardHeight);
      await assertHitTarget(dialog.getByRole("button", { name: `Remove ${guest}` }));
      await dialog.getByText("Description (optional)", { exact: true }).click();
      await dialog.locator("textarea").fill("Meeting notes.\n".repeat(12));
      await assertHitTarget(dialog.locator("textarea"));
      const lastField = (await dialog.locator("textarea").boundingBox())!;
      const footer = (await actions.boundingBox())!;
      expect(lastField.y + lastField.height).toBeLessThanOrEqual(footer.y + 1);
      await page.screenshot({ animations: "disabled" });
      const headerBeforeScroll = (await header.boundingBox())!;
      const actionsBeforeScroll = (await actions.boundingBox())!;
      await body.evaluate(element => { element.scrollTop = 0; });
      expect((await header.boundingBox())!.y).toBe(headerBeforeScroll.y);
      expect((await actions.boundingBox())!.y).toBe(actionsBeforeScroll.y);
      for (const field of [dialog.getByLabel("Date", { exact: true }), dialog.getByLabel("Start", { exact: true }), dialog.getByLabel("Duration")]) {
        await assertHitTarget(field);
        const box = (await field.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(frame.x);
        expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
      }
      expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await dialog.getByText("Description (optional)", { exact: true }).click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-booking-short-${width}.png`) });
    expect(unexpectedRequests).toEqual([]); expect(errors).toEqual([]);
  });
}
