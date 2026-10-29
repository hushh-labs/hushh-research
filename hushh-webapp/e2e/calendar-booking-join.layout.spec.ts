import { expect, test } from "@playwright/test";
import path from "node:path";
import { calendarBoardDayFixture } from "./fixtures/calendar-board-day";
import { openFixture, qaNow, registerCalendarConnectedFixture, screenshotDirectory } from "./fixtures/calendar-connected-workspace-harness";

registerCalendarConnectedFixture();

test("Board booking reviews account B and refreshes its event and free time after confirmation", async ({ page }) => {
  const { errors, unexpectedRequests } = await openFixture(page, 393, false, "busy", false, true);
  await page.getByTestId("calendar-fixture-authorize").dispatchEvent("click");

  const work = page.getByRole("group", { name: "Calendar account qa-work@example.com" });
  await work.getByRole("link", { name: "Join meeting: QA Client Call 1" }).click();
  const join = page.getByRole("dialog", { name: "Check Google account" });
  await expect(join).toContainText("Use qa-work@example.com in Google Meet. Tap Switch on the pre-join screen.");
  await expect(join.getByRole("link", { name: "Open Meet" })).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, "calendar-meet-account-mobile-393.png") });
  await join.getByRole("button", { name: "Cancel" }).click();

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
  await expect(dialog.getByLabel("Calendar account and destination")).toHaveValue("work");
  await expect(dialog.getByLabel("Duration")).toHaveValue("60");
  await dialog.getByLabel("Title").fill("Bug Bash");
  await dialog.getByLabel("Guests (optional)").fill("guest@example.com");
  await dialog.getByRole("button", { name: "Add" }).click();
  await dialog.getByRole("button", { name: "Review meeting" }).click();
  await expect(dialog.getByRole("region", { name: "Meeting review" })).toContainText("guest@example.com");
  await expect(dialog.getByRole("region", { name: "Meeting review" })).toContainText("UTC+05:30");
  await expect(dialog).not.toContainText("Asia/Kolkata");
  const mobileBounds = (await dialog.boundingBox())!;
  expect(mobileBounds.x).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.y).toBeGreaterThanOrEqual(0);
  expect(mobileBounds.x + mobileBounds.width).toBeLessThanOrEqual(393);
  expect(mobileBounds.y + mobileBounds.height).toBeLessThanOrEqual(950);
  expect(reviewed).toMatchObject({ account_id: "work", checked_account_ids: ["default", "work", "projects"], title: "Bug Bash", meeting_type: "google_meet", attendees: ["guest@example.com"] });
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, "calendar-booking-review-mobile-393.png") });
  await page.setViewportSize({ width: 1024, height: 900 });
  const desktopBounds = (await dialog.boundingBox())!;
  expect(desktopBounds.x).toBeGreaterThanOrEqual(0);
  expect(desktopBounds.x + desktopBounds.width).toBeLessThanOrEqual(1024);
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, "calendar-booking-review-desktop-1024.png") });
  const confirm = dialog.getByRole("button", { name: "Schedule meeting", exact: true });
  expect(await confirm.evaluate(button => button.scrollWidth)).toBeLessThanOrEqual(await confirm.evaluate(button => button.clientWidth));
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(work.getByRole("button", { name: /Schedule from free time/ })).toHaveCount(0);
  await expect(page.getByText("No shared opening on this day.")).toBeVisible();
  await work.getByRole("tab", { name: /Events/ }).click();
  await expect(work.getByRole("button", { name: /Open Bug Bash/ })).toBeVisible();
  expect(created).not.toBeNull();
  expect(unexpectedRequests).toEqual([]);
  expect(errors).toEqual([]);
});
