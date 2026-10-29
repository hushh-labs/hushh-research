import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  registerCalendarConnectedFixture,
  openFixture,
  screenshotDirectory,
  qaNow,
  dayEvents,
  privateLongTitle,
  privateLongLocation,
  assertActionsClearChrome,
} from "./fixtures/calendar-connected-workspace-harness";
import { assertCalendarAccountLabel, assertCalendarBoardGeometry, assertCalendarAccountScroll } from "./helpers/calendar-board-geometry";

registerCalendarConnectedFixture();

test("Calendar product font and real action targets survive responsive boundaries", async ({ page }) => {
  test.setTimeout(60_000);
  const { errors, unexpectedRequests } = await openFixture(page, 393);
  for (const width of [350, 351, 360, 393, 430, 520, 521, 620, 621, 639, 640, 759, 760, 767, 768, 900, 901, 1024, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.locator("[data-calendar-workspace]").evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/Plus Jakarta Sans/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}px`).toBe(true);
    const row = page.locator('[data-calendar-event="primary:shared-id"]');
    const join = (await row.getByRole("link", { name: "Join meeting: QA Product Sync" }).boundingBox())!;
    const more = (await row.getByRole("button", { name: /^More options:/ }).boundingBox())!;
    expect(join.height, `Join target at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(more.height, `more target at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(join.x + join.width, `adjacent targets at ${width}px`).toBeLessThanOrEqual(more.x);
  }
  await page.setViewportSize({ width: 393, height: 950 });
  await page.getByRole("tab", { name: "Invitations", exact: true }).click();
  await page.getByRole("button", { name: /Open invitation: QA Product Sync/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect.poll(() => dialog.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
  const title = dialog.getByRole("heading", { name: "QA Product Sync" });
  expect(await title.evaluate(element => ({ family: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize, line: getComputedStyle(element).lineHeight }))).toMatchObject({ size: "20px", line: "28px" });
  await expect(title).toHaveCSS("font-family", /Plus Jakarta Sans/);
  const invitationBack = dialog.getByRole("button", { name: "Invitations", exact: true });
  await expect(invitationBack).toHaveCSS("font-size", "12px");
  expect((await invitationBack.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const invitationJoin = dialog.getByRole("link", { name: "Join meeting" });
  expect((await invitationJoin.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(invitationJoin).toHaveCSS("background-color", /rgb/);
  for (const name of ["Accept", "Decline", "Decline & offer another time"]) {
    const button = dialog.getByRole("button", { name, exact: true });
    await page.mouse.move(0, 0);
    await expect.poll(() => button.evaluate(element => getComputedStyle(element).backgroundColor)).toBeTruthy();
    const restingBackground = await button.evaluate(element => getComputedStyle(element).backgroundColor);
    const normal = (await button.boundingBox())!;
    expect(normal.height, `${name} target`).toBeGreaterThanOrEqual(44);
    await button.hover();
    const hovered = (await button.boundingBox())!;
    expect(hovered.width, `${name} hover width`).toBe(normal.width);
    expect(hovered.height, `${name} hover height`).toBe(normal.height);
    expect(hovered.x, `${name} hover alignment`).toBe(normal.x);
    await expect.poll(() => button.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(restingBackground);
    expect(await button.evaluate(element => getComputedStyle(element).borderRadius)).toBe("999px");
  }
  const accept = dialog.getByRole("button", { name: "Accept", exact: true });
  await accept.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(accept).toBeFocused();
  expect(await accept.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, "calendar-invitation-keyboard-focus-393.png") });
  await accept.evaluate(element => element.blur());
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  const darkRestingBackground = await accept.evaluate(element => getComputedStyle(element).backgroundColor);
  await accept.hover();
  await expect.poll(() => accept.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(darkRestingBackground);
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, "calendar-invitation-dark-hover-393.png") });
  expect(unexpectedRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("three-account Board keeps its measure, heading roles and account actions across breakpoints", async ({ page }) => {
  const { errors, unexpectedRequests } = await openFixture(page, 360, false, "standard", false, true);
  for (const width of [360, 393, 430, 768, 900, 901, 1024, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Board overflow at ${width}px`).toBe(true);
    await expect(page.locator("[data-calendar-account-board]")).toHaveCSS("font-family", /Plus Jakarta Sans/);
    const add = (await page.getByRole("button", { name: "Add account" }).boundingBox())!;
    expect(add.height, `Add account target at ${width}px`).toBeGreaterThanOrEqual(44);
    const overlap = (await page.getByRole("button", { name: /^Review 1 overlapping meeting for QA Design Review/ }).boundingBox())!;
    expect(overlap.height, `overlap target at ${width}px`).toBeGreaterThanOrEqual(44);
  }
  const addPill = page.getByRole("button", { name: "Add account" });
  const lightPill = await addPill.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(addPill).not.toHaveCSS("background-color", lightPill);
  expect((await addPill.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, "calendar-board-dark-1440.png") });
  await page.getByRole("button", { name: /^Open QA Design Review/ }).click();
  const dialog = page.getByRole("dialog");
  await expect.poll(() => dialog.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
  const title = dialog.getByRole("heading", { name: "QA Design Review" });
  await expect(title).toHaveCSS("font-size", "20px");
  await expect(title).toHaveCSS("line-height", "28px");
  expect(unexpectedRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("a broken HUSSH portrait keeps the Calendar account initial and size", async ({ page }) => {
  const { errors, unexpectedRequests } = await openFixture(page, 390, false, "standard", false, true, true);
  const account = page.getByRole("group", { name: "Calendar account qa-work@example.com" });
  const avatar = account.locator("[data-photo-source=hussh]");
  await expect(avatar.locator("[data-slot=avatar-fallback]")).toBeVisible();
  await expect(avatar.locator("img")).toHaveCount(0);
  const bounds = await avatar.boundingBox();
  expect(bounds?.width).toBeGreaterThan(30);
  expect(bounds?.height).toBeGreaterThan(30);
  expect(unexpectedRequests).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`Calendar caps each account at three events and scrolls the rest inside at ${width}px`, async ({ page }) => {
    const { errors, unexpectedRequests } = await openFixture(page, width, false, "busy", false, true);
    await assertCalendarAccountScroll(page, width, path.join(screenshotDirectory, `calendar-three-event-scroll-${width}.png`));
    expect(unexpectedRequests).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`three-account board and inline conflict review at ${width}px`, async ({ page }) => {
    const { errors, unexpectedRequests, calls } = await openFixture(page, width, false, "standard", false, true);
    await assertCalendarBoardGeometry(page, width);
    for (const email of ["qa-owner@example.com", "qa-work@example.com", "qa-projects@example.com"]) {
      const label = page.getByRole("group", { name: `Calendar account ${email}` }).getByText(email, { exact: true });
      await expect(label).toBeVisible();
      await assertCalendarAccountLabel(label, width);
    }
    await expect(page.getByRole("group", { name: "Calendar account qa-owner@example.com" }).locator("[data-photo-source=hussh]")).toHaveCount(1);
    await expect(page.getByRole("group", { name: "Calendar account qa-work@example.com" }).locator("[data-photo-source=hussh]")).toHaveCount(1);
    await expect(page.getByRole("group", { name: "Calendar account qa-projects@example.com" }).locator("[data-photo-url]")).toHaveCount(0);
    for (const email of ["qa-owner@example.com", "qa-work@example.com"]) {
      await expect.poll(() => page.getByRole("group", { name: `Calendar account ${email}` }).locator("[data-photo-source=hussh] img").evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
    }
    for (const event of ["QA Design Review", "QA Client Call", "QA Project Focus"]) await expect(page.getByRole("button", { name: new RegExp(`^Open ${event}`) })).toBeVisible();
    await expect(page.getByText("1 cross-account overlap")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Free across all accounts" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-three-account-board-${width}.png`) });
    await page.getByRole("button", { name: /^Review 1 overlapping meeting for QA Design Review/ }).click();
    await page.getByRole("button", { name: "Resolve these overlaps" }).click();
    await page.getByRole("button", { name: "Keep this instead" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox").check();
    await dialog.getByPlaceholder("Explain why you cannot attend").fill("I need to join the client call.");
    await dialog.getByRole("button", { name: "Review Calendar and Mail" }).click();
    await expect(dialog.getByText("To: organizer-design@example.test")).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm selected changes" }).click();
    await expect(dialog.getByText("Calendar: declined · Mail: sent")).toBeVisible();
    expect(page.url()).toContain("/calendar-connected-fixture?board=1");
    expect(calls.some(call => call.path.endsWith("/conflicts/workspace/review"))).toBe(true);
    expect(calls.some(call => call.path.endsWith("/conflicts/workspace/confirm"))).toBe(true);
    expect(unexpectedRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
for (const width of [320, 390, 1440]) {
  test(`connected Calendar geometry, timeline, windows and shared session recovery at ${width}px`, async ({ page }) => {
    const { errors, unexpectedRequests, calls, failAvailability } = await openFixture(page, width);
    const tabs = page.getByRole("tablist", { name: "Calendar navigation" });
    const tabBounds = (await tabs.boundingBox())!;
    expect(tabBounds.height).toBe(36);
    expect(Math.abs((await page.locator("[data-calendar-workspace]").boundingBox())!.width - tabBounds.width)).toBeLessThanOrEqual(1);
    if (width > 1000) expect(tabBounds.width).toBe(824);
    const segments = await tabs.getByRole("tab").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    expect(Math.max(...segments) - Math.min(...segments)).toBeLessThanOrEqual(1);
    expect(await tabs.locator("[data-ui-role=agent-tab-label]").evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth))).toBe(true);
    expect(await tabs.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe("10px");
    expect((await page.getByRole("tablist", { name: "Schedule views" }).boundingBox())!.height).toBeLessThan(tabBounds.height);
    expect(await page.locator("[data-calendar-workspace]").evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/Plus Jakarta Sans/);
    await expect(page.getByText("qa-owner@example.com", { exact: true })).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "All-day events" })).toBeVisible();
    const countdown = page.getByText("In 25 min", { exact: true });
    await expect(countdown).toBeVisible();
    await expect(countdown).toHaveCSS("white-space", "nowrap");
    const countdownGeometry = await countdown.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(countdownGeometry.height).toBeLessThanOrEqual(countdownGeometry.lineHeight + 1);
    const selectedSurface = await page.locator("[data-highlighted]").evaluate(element => getComputedStyle(element).backgroundColor);
    const inactiveSurface = await page.getByRole("tab", { name: "Free time", exact: true }).evaluate(element => getComputedStyle(element).backgroundColor);
    await expect(page.getByRole("tab", { name: "Today", exact: true })).toHaveCSS("background-color", selectedSurface);
    await expect(page.getByRole("link", { name: "Join meeting: QA Product Sync", exact: true })).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    await expect(page.getByRole("link", { name: "Join meeting: QA Design Review", exact: true })).toHaveAttribute("href", "https://zoom.us/j/123456789");
    await expect(page.getByRole("link", { name: "Join meeting: QA Client Call – Acme", exact: true })).toHaveAttribute("href", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_qa/0");
    await expect(page.locator('[data-calendar-event="primary:shared-id"] img[src="/one-calendar/providers/google-meet-reference.png"]')).toBeVisible();
    await expect(page.locator('[data-calendar-event="qa-work@example.com:design"] svg circle[fill="#0784ff"]')).toBeAttached();
    await expect(page.locator('[data-calendar-event="qa-work@example.com:design"] svg rect[fill="white"]')).toBeAttached();
    await expect(page.locator('[data-calendar-event="qa-work@example.com:client"] img[src="/one-calendar/providers/microsoft-teams-reference.png"]')).toBeVisible();
    await expect.poll(() => page.locator('[data-calendar-event] img').evaluateAll(elements => elements.every(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0))).toBe(true);
    await expect(page.locator('[data-calendar-event="primary:shared-id"]')).toHaveCount(1);
    await expect(page.locator('[data-calendar-event="qa-work@example.com:shared-id"]')).toHaveCount(1);
    const activeEvent = page.locator('[data-calendar-event="primary:shared-id"]');
    const regularEvent = page.locator('[data-calendar-event="qa-work@example.com:design"]');
    const timelineCorners = await regularEvent.evaluate(element => ({
      group: getComputedStyle(element.parentElement!).borderTopLeftRadius,
      expected: getComputedStyle(document.documentElement).getPropertyValue("--app-card-radius-standard").trim(),
      containsHighlight: Boolean(element.parentElement!.querySelector("[data-highlighted]")),
    }));
    expect(timelineCorners.group).toBe(timelineCorners.expected);
    expect(timelineCorners.containsHighlight).toBe(false);
    await expect(activeEvent).toHaveCSS("border-top-left-radius", timelineCorners.expected);
    for (const row of [activeEvent, regularEvent]) {
      const join = (await row.getByRole("link", { name: /^Join meeting:/ }).boundingBox())!;
      const overflow = (await row.getByRole("button", { name: /^More options:/ }).boundingBox())!;
      expect(join.x + join.width).toBeLessThanOrEqual(overflow.x);
      expect(Math.abs(join.y + join.height / 2 - overflow.y - overflow.height / 2)).toBeLessThanOrEqual(1);
    }
    expect(await page.locator('[data-calendar-event="primary:lunch"] [aria-hidden="true"][style]').evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(246, 191, 38)");
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-today-${width}.png`) });
    await assertActionsClearChrome(page, width, "today");
    await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = 0; });
    await page.getByRole("button", { name: /^QA Product Sync/ }).click();
    const eventDialog = page.getByRole("dialog");
    await expect(eventDialog).toContainText("Synthetic event details for rendered QA.");
    for (let index = 0; index < 5; index++) { await page.keyboard.press("Tab"); expect(await eventDialog.evaluate(element => element.contains(document.activeElement))).toBe(true); }
    const readsBeforeVaultLock = calls.filter(call => call.path.endsWith("/schedule/today")).length;
    await page.getByTestId("calendar-fixture-lock").dispatchEvent("click");
    await expect(eventDialog).toContainText("Synthetic event details for rendered QA.");
    expect(calls.filter(call => call.path.endsWith("/schedule/today"))).toHaveLength(readsBeforeVaultLock);
    await expect(page.getByText("Calendar session unavailable.", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /unlock/i })).toHaveCount(0);
    await page.getByTestId("calendar-fixture-authorize").dispatchEvent("click");
    await expect(eventDialog).toContainText("Synthetic event details for rendered QA.");
    await page.keyboard.press("Escape");
    await expect(eventDialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^QA Product Sync/ })).toBeVisible();
    const menu = page.getByRole("button", { name: "Calendar settings and actions", exact: true });
    await menu.focus(); await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Time zone and calendars for this session. Free time checks the whole selected day.");
    for (let index = 0; index < 6; index++) { await page.keyboard.press("Tab"); expect(await page.getByRole("dialog").evaluate(element => element.contains(document.activeElement))).toBe(true); }
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await tabs.getByRole("tab", { name: "Schedule", exact: true }).focus();
    await page.keyboard.press("ArrowRight"); await expect(tabs.getByRole("tab", { name: "Invitations", exact: true })).toBeFocused();
    await expect(page.getByRole("tablist", { name: "Invitation filters" })).toBeVisible();
    await page.keyboard.press("ArrowRight"); await expect(tabs.getByRole("tab", { name: "Insights", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await page.getByRole("tab", { name: "Free time", exact: true }).click();
    await expect(page.getByRole("heading", { name: "7 available slots today", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Free time", exact: true })).toHaveCSS("background-color", selectedSurface);
    await expect(page.getByRole("tab", { name: "Today", exact: true })).toHaveCSS("background-color", inactiveSurface);
    const availabilityCall = calls.find(call => call.path.endsWith("/schedule/availability"))!;
    expect(availabilityCall.body.duration_minutes).toBe(15);
    expect(availabilityCall.authorization).toBe("Bearer synthetic-firebase-owner-token");
    expect(availabilityCall.response?.windows).toHaveLength(3);
    await expect(page.getByRole("button", { name: /^Ask One about/ })).toHaveCount(3);
    await expect(page.getByText("Showing 3 of 7 available windows.")).toBeVisible();
    for (const window of availabilityCall.response!.windows) expect(Math.floor((Date.parse(window.end_at) - Date.parse(window.start_at)) / 60_000)).toBe(window.duration_minutes);
    await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-free-time-${width}.png`) });
    await assertActionsClearChrome(page, width, "free");
    const add = page.getByRole("button", { name: /^Ask One about/ }).last();
    const rowBox = (await add.boundingBox())!;
    expect(rowBox.height).toBeGreaterThanOrEqual(44);
    expect(rowBox.width).toBeGreaterThan(width < 500 ? 250 : 500);
    await add.focus();
    await page.keyboard.press("Enter"); await expect(page.getByTestId("calendar-action")).toContainText('"durationMinutes":15');
    await expect(page.getByTestId("calendar-action")).toContainText("2026-10-14");
    await page.getByRole("button", { name: /Need a different time/ }).click();
    await expect(page.getByTestId("calendar-action")).toContainText("Check the full selected local day");
    await page.getByRole("tab", { name: "30 min", exact: true }).click();
    await expect(page.getByRole("heading", { name: "6 available slots today", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await expect(page.getByLabel("Selected date")).toHaveValue("2026-10-15");
    await expect(page.getByRole("link", { name: "Open Google Calendar" })).toHaveAttribute("href", "https://calendar.google.com/calendar/u/0/r/day/2026/10/15?authuser=qa-owner%40example.com");
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    failAvailability();
    await menu.click(); await page.getByRole("menuitem", { name: "Refresh Calendar", exact: true }).click();
    await expect(page.getByText("Availability could not be checked.", { exact: true })).toBeVisible();
    await expect(page.getByText("No free slots in this window.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByText("Checking again automatically when connected.", { exact: true })).toHaveCount(0);
    await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-free-error-${width}.png`) });
    failAvailability(false);
    await page.getByRole("button", { name: "Retry", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: /available slots on this day/ })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Try Calendar Agent with One", exact: true }).click(); await expect(page.getByTestId("calendar-action")).toHaveText("calendar-chat");
    await page.getByRole("button", { name: "Disconnect Calendar", exact: true }).click(); await expect(page.getByTestId("calendar-action")).toHaveText("disconnect-calendar");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors.every(error => /Failed to load resource.*(?:502|Bad Gateway)/i.test(error))).toBe(true);
    // A connected Firebase owner can read Schedule without a vault token;
    // Google consent remains enforced by the backend provider boundary.
    const locked = await openFixture(page, width, true);
    await page.getByRole("tab", { name: "Free time", exact: true }).click();
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    expect(locked.calls.some(call => call.path.endsWith("/schedule/today"))).toBe(true);
    await expect(page.getByText("Calendar session unavailable.", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /unlock/i })).toHaveCount(0);
    await page.getByTestId("calendar-fixture-authorize").dispatchEvent("click");
    await expect(page.getByRole("heading", { name: "7 available slots on this day", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Free time", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(locked.calls.filter(call => call.path.endsWith("/schedule/availability")).at(-1)?.body.date).toBe("2026-10-15");
    expect(locked.errors).toEqual([]);
    expect(locked.unexpectedRequests).toEqual([]);

    const long = await openFixture(page, width, false, "long");
    const longTitle = page.getByText(privateLongTitle, { exact: true });
    await expect(longTitle).toHaveCSS("white-space", "nowrap");
    await expect(longTitle).toHaveCSS("text-overflow", "ellipsis");
    await expect(page.getByText(privateLongLocation, { exact: true })).toHaveCSS("text-overflow", "ellipsis");
    await expect(page.getByRole("button", { name: new RegExp(`^${privateLongTitle}`) })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: new RegExp(`^${privateLongTitle}`) }).click();
    await expect(page.getByRole("dialog")).toContainText(privateLongTitle);
    await expect(page.getByRole("dialog")).toContainText(privateLongLocation);
    const previousReads = long.calls.filter(call => call.path.endsWith("/schedule/today")).length;
    const releaseSchedule = long.holdSchedule();
    try {
      await page.getByTestId("calendar-fixture-switch-owner").dispatchEvent("click");
      await expect.poll(() => long.calls.filter(call => call.path.endsWith("/schedule/today")).length).toBeGreaterThan(previousReads);
      expect(long.calls.filter(call => call.path.endsWith("/schedule/today")).at(-1)?.authorization).toBe("Bearer synthetic-firebase-other-owner-token");
      // A new owner never sees the prior owner's details while their read is held.
      await expect.poll(() => page.evaluate(({ title, location }) => document.body.textContent?.includes(title) || document.body.textContent?.includes(location), { title: privateLongTitle, location: privateLongLocation })).toBe(false);
    } finally {
      releaseSchedule("standard");
    }
    await expect(page.getByText("other-owner@example.com", { exact: true })).toBeVisible();
    await expect(page.getByText("No events today.", { exact: true })).toBeVisible();
    expect(await page.evaluate(({ title, location }) => document.body.textContent?.includes(title) || document.body.textContent?.includes(location), { title: privateLongTitle, location: privateLongLocation })).toBe(false);
    expect(long.errors).toEqual([]);
    expect(long.unexpectedRequests).toEqual([]);

    const empty = await openFixture(page, width, false, "empty");
    await expect(page.getByText("No events today.", { exact: true })).toBeVisible();
    await expect(page.locator("[data-calendar-event]")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open Google Calendar" })).toHaveAttribute("href", "https://calendar.google.com/calendar/u/0/r/day/2026/10/14?authuser=qa-owner%40example.com");
    await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = element.scrollHeight; });
    const emptyChrome = (await page.getByTestId("reserved-bottom-chrome").boundingBox())!;
    const emptyDisconnect = (await page.getByRole("button", { name: "Disconnect Calendar", exact: true }).boundingBox())!;
    expect(emptyDisconnect.y + emptyDisconnect.height).toBeLessThanOrEqual(emptyChrome.y);
    expect(empty.errors).toEqual([]);
    expect(empty.unexpectedRequests).toEqual([]);
  });
}

if (process.env.CALENDAR_PROVIDER_REPLAY_PATH) {
  for (const width of [390, 1440]) test(`Explorer-backed actual calculation renders at ${width}px`, async ({ page }) => {
    const { errors, unexpectedRequests } = await openFixture(page, width, false, "empty", "future");
    await page.getByRole("button", { name: "Calendar settings and actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Time zone", exact: true }).selectOption("Asia/Kolkata");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await page.getByRole("tab", { name: "Free time", exact: true }).click();
    for (const duration of [15, 30, 60]) {
      await page.getByRole("tab", { name: `${duration} min`, exact: true }).click();
      await expect(page.getByText("23 hr", { exact: true })).toBeVisible();
      await expect(page.getByText("12:00 AM – 11:00 PM", { exact: true })).toBeVisible();
      await expect(page.getByText(/Midnight \(next day\)/)).toHaveCount(duration === 60 ? 0 : 1);
      await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `explorer-local-${width}-${duration}.png`) });
    }
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await expect(page.getByText("23 hr", { exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `explorer-local-next-day-${width}.png`) });
    expect(errors).toEqual([]); expect(unexpectedRequests).toEqual([]);
    const today = await openFixture(page, width, false, "empty", "today");
    await page.getByRole("button", { name: "Calendar settings and actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Time zone", exact: true }).selectOption("Asia/Kolkata");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByRole("tab", { name: "Free time", exact: true }).click();
    await expect(page.getByText(/^2:13.*11:00 PM$/)).toBeVisible();
    await expect(page.getByText(/Midnight \(next day\)/)).toBeVisible();
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `explorer-local-today-${width}.png`) });
    expect(today.errors).toEqual([]); expect(today.unexpectedRequests).toEqual([]);
  });
}


for (const width of [320, 390, 1440]) {
  test(`slot chat proposal and Change time remain accessible at ${width}px`, async ({ page }) => {
    await openFixture(page, width);
    await page.getByTestId("calendar-fixture-proposal").evaluate((element: HTMLButtonElement) => element.click());
    const card = page.getByTestId("agent-calendar-proposal-card");
    const confirm = page.getByRole("button", { name: "Schedule meeting" });
    await confirm.scrollIntoViewIfNeeded();
    const bounds = (await confirm.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual((await page.getByTestId("reserved-bottom-chrome").boundingBox())!.y);
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(screenshotDirectory, `calendar-chat-proposal-${width}.png`) });
    await page.getByRole("button", { name: "Change time" }).click();
    await expect(confirm).toBeDisabled();
    await page.getByRole("combobox", { name: "Choose a start inside your free window" }).click();
    await page.getByRole("option").nth(1).click();
    await expect(page.getByTestId("calendar-action")).toHaveText("change-time:2030-01-17T08:45:00Z");
    await expect(card).toContainText("long-calendar-attendee-for-responsive-verification@example.test");
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByTestId("calendar-action")).toHaveText("cancelled-without-event");
    await confirm.click();
    await expect(page.getByTestId("agent-calendar-proposal-confirm")).toBeDisabled();
    await expect(page.getByTestId("agent-calendar-proposal-confirm")).toHaveText("Working…");
    await expect(page.getByRole("button", { name: "Change time" })).toBeDisabled();
  });
}


for (const width of [320, 390, 1440]) {
  test(`Invitations list, detail, conflict confirmation and RSVP at ${width}px`, async ({ page }, testInfo) => {
    const { errors, unexpectedRequests, calls } = await openFixture(page, width);
    const cta = page.getByRole("button", { name: "Try Calendar Agent with One", exact: true });
    const scheduleBounds = (await cta.boundingBox())!;
    expect(scheduleBounds.height).toBe(50);
    expect(scheduleBounds.width).toBeLessThanOrEqual(420);
    await expect(page.getByText("See your full day in Google Calendar")).toHaveCount(0);
    await page.getByRole("tab", { name: "Invitations", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Pending (2)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open invitation: QA Product Sync" }).locator("[data-photo-source=hussh]")).toHaveCount(1);
    await expect.poll(() => page.getByRole("button", { name: "Open invitation: QA Product Sync" }).locator("[data-photo-source=hussh] img").evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.getByRole("button", { name: "Show Google contact photos" })).toHaveCount(0);
    const invitationBounds = (await cta.boundingBox())!;
    expect(invitationBounds.width).toBe(scheduleBounds.width);
    expect(invitationBounds.height).toBe(scheduleBounds.height);
    const disconnect = page.getByRole("button", { name: "Disconnect Calendar", exact: true });
    expect((await disconnect.boundingBox())!.width).toBe(invitationBounds.width);
    await expect(page.getByText("See more in Google Calendar")).toHaveCount(0);
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `invitations-list-${testInfo.project.name}-${width}.png`) });
    await page.getByRole("button", { name: "Open invitation: QA Product Sync" }).click();
    await expect(page.getByRole("link", { name: "Join meeting", exact: true })).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    const dialog = page.getByRole("dialog", { name: "Invitation details", exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
    const bounds = (await dialog.boundingBox())!;
    expect(Math.abs(bounds.x + bounds.width / 2 - width / 2)).toBeLessThanOrEqual(2);
    const guests = dialog.getByRole("list", { name: "Guests" }).getByRole("listitem");
    await expect(guests).toHaveCount(9);
    await expect(dialog.getByText("3 yes, 6 awaiting")).toBeVisible();
    const acceptedBadges = guests.locator("[data-accepted-indicator]");
    await expect(acceptedBadges).toHaveCount(3);
    expect(await acceptedBadges.evaluateAll(badges => badges.every(badge => {
      const avatar = badge.parentElement?.querySelector('[data-slot="avatar"]');
      if (!avatar) return false;
      const image = avatar.getBoundingClientRect();
      const tick = badge.getBoundingClientRect();
      return tick.width <= 14 && tick.height <= 14
        && tick.left >= image.right - 6 && tick.left < image.right
        && tick.top >= image.bottom - 10 && tick.top < image.bottom
        && tick.right > image.right && tick.bottom > image.bottom;
    }))).toBe(true);
    expect(await guests.evaluateAll(items => items.every(item => {
      const accepted = item.textContent?.includes("Accepted") ?? false;
      return Boolean(item.querySelector("[data-accepted-indicator]")) === accepted;
    }))).toBe(true);
    await expect(guests.filter({ hasText: "Manish" }).locator("[data-photo-source=hussh]")).toHaveCount(1);
    await expect(guests.filter({ hasText: "You" }).locator("[data-photo-source=hussh]")).toHaveCount(1);
    for (const name of ["Manish", "You"]) {
      await expect.poll(() => guests.filter({ hasText: name }).locator("[data-photo-source=hussh] img").evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
    }
    expect(calls.some(call => call.path.endsWith("/guest-photo-token"))).toBe(false);
    const guestBounds = await guests.evaluateAll(items => items.map(item => {
      const { x, y, width: rowWidth } = item.getBoundingClientRect();
      return { x, y, rowWidth };
    }));
    expect(guestBounds.every((row, index) => row.rowWidth > 0 && row.x === guestBounds[0]?.x && (index === 0 || row.y > guestBounds[index - 1]!.y))).toBe(true);
    expect(guestBounds.every(row => row.x + row.rowWidth <= bounds.x + bounds.width + 1)).toBe(true);
    const actionButtons = dialog.getByRole("button", { name: /^(Accept|Decline|Decline & offer another time)$/ });
    for (const button of await actionButtons.all()) {
      const normal = (await button.boundingBox())!;
      expect(normal.height).toBeGreaterThanOrEqual(44);
      await button.hover();
      const hovered = (await button.boundingBox())!;
      expect(hovered.width).toBe(normal.width);
      expect(hovered.height).toBe(normal.height);
      expect(hovered.x).toBe(normal.x);
      expect(await button.evaluate(element => getComputedStyle(element).borderRadius)).toBe("999px");
    }
    await expect(page.locator('[data-slot="dialog-overlay"]')).toBeVisible();
    expect(await page.locator('[data-slot="dialog-overlay"]').evaluate(node => getComputedStyle(node).backdropFilter)).not.toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `invitations-detail-top-${testInfo.project.name}-${width}.png`) });
    await page.getByRole("button", { name: "Decline & offer another time" }).scrollIntoViewIfNeeded();
    const offerBounds = (await page.getByRole("button", { name: "Decline & offer another time" }).boundingBox())!;
    expect(offerBounds.y + offerBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `invitations-detail-${testInfo.project.name}-${width}.png`) });
    await page.getByRole("button", { name: "Decline & offer another time" }).click();
    await expect(dialog.getByLabel("Alternative date")).toBeVisible();
    await expect(dialog.getByLabel("Alternative duration in minutes")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Check time & send email" })).toBeDisabled();
    await expect(page.getByTestId("calendar-action")).toBeEmpty();
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    const accept = page.getByRole("button", { name: "Accept", exact: true });
    await accept.scrollIntoViewIfNeeded();
    await accept.click();
    await expect(page.getByText("This time is already booked")).toBeVisible();
    expect(calls.filter(call => call.path.endsWith("/attendance/rsvp/confirm"))).toHaveLength(0);
    await page.getByRole("button", { name: "Accept anyway" }).click();
    await expect(dialog).toBeHidden();
    expect(calls.filter(call => call.path.endsWith("/attendance/rsvp/confirm"))).toHaveLength(1);
    await page.getByRole("tab", { name: "Responded", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open invitation: QA Product Sync" })).toBeVisible();
    await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
    expect(errors).toEqual([]); expect(unexpectedRequests).toEqual([]);
  });
}

for (const width of [390, 1280]) {
  test(`Calendar Insights library and notes at ${width}px`, async ({ page }) => {
    const fixture = await openFixture(page, width);
    await page.route("**/api/one/calendar/insights", route => route.fulfill({ json: {
      complete: true, meeting_count: 8, meeting_minutes: 480, overlaps: 1, back_to_back: 2, time_zone: "Asia/Kolkata",
      days: [12, 13, 14, 15, 16, 17, 18].map((day, index) => ({ date: `2026-10-${day}`, minutes: [60, 120, 180, 60, 60, 0, 0][index], meetings: 1 })),
      recurring: [{ title: "QA weekly review", minutes: 60 }], focus: [{ start_at: "2026-10-15T09:30:00Z", end_at: "2026-10-15T11:30:00Z" }],
    } }));
    await page.route("**/api/one/calendar/meetings", route => {
      const body = route.request().postDataJSON() as { date: string; time_zone: string; query: string };
      const rows = [
        { id: "notes", calendar_id: "primary", account_id: "default", occurrence_id: "a".repeat(64), grant_id: "b".repeat(64), sources: [{ calendar_id: "primary", event_id: "notes" }], title: "QA Design review", start: { dateTime: "2026-10-14T09:00:00Z" }, artifact_kinds: ["notes"], availability: { notes: "available" }, discovery: "checked", file_state: "available" },
        { id: "video", calendar_id: "primary", account_id: "default", occurrence_id: "c".repeat(64), grant_id: "b".repeat(64), sources: [{ calendar_id: "primary", event_id: "video" }], title: "QA Product demo", start: { dateTime: "2026-10-14T08:00:00Z" }, artifact_kinds: ["recording"], availability: { recording: "available" }, discovery: "checked", file_state: "available" },
      ];
      return route.fulfill({ json: { complete: true, calendar_complete: true, next_cursor: null, limitations: [], checked_events: 2, meeting_file_access: "ready", account_id: "default", date: body.date, time_zone: body.time_zone, meetings: rows.filter(row => row.title.toLowerCase().includes((body.query || "").toLowerCase())) } });
    });
    await page.route("**/api/one/calendar/meetings/detail", route => route.fulfill({ json: { complete: true, discovery: "checked", calendar_id: "primary", event: { title: "QA Design review" }, artifacts: [
      { file_id: "qa-doc", kind: "notes", state: "available", title: "QA Meeting notes", url: "https://docs.google.com/document/d/qa-doc", text: "Synthetic browser fixture only.", text_format: "plain", can_download: true },
      { file_id: "qa-transcript", kind: "transcript", state: "permission_required" },
    ] } }));
    await page.getByRole("tab", { name: "Insights", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Executive snapshot" })).toBeVisible();
    await expect(page.getByText("8", { exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-overview-${width}.png`), fullPage: true });
    const libraryEntry = page.getByRole("button", { name: /Recordings & Notes/ });
    await libraryEntry.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-entry-${width}.png`) });
    await libraryEntry.click();
    await page.getByRole("tab", { name: "Notes", exact: true }).click();
    await expect(page.getByRole("button", { name: /QA Product demo/ })).toBeVisible();
    await expect(page.getByText(/Notes access is not verified/)).toBeVisible();
    await page.getByRole("searchbox").fill("Design");
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-library-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: /QA Design review/ }).click();
    await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask One about this meeting" })).toHaveCount(0);
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-meeting-${width}.png`), fullPage: true });
    await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = element.scrollHeight; });
    const askBounds = (await page.getByRole("button", { name: "Download" }).boundingBox())!;
    const chromeBounds = (await page.getByTestId("reserved-bottom-chrome").boundingBox())!;
    expect(askBounds.y + askBounds.height).toBeLessThanOrEqual(chromeBounds.y);
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-meeting-actions-${width}.png`) });
    await expect(page.getByText("Synthetic browser fixture only.")).toBeVisible();
    await expect(page.getByText("QA Meeting notes")).toBeVisible();
    await page.getByRole("button", { name: "Back to recordings and notes" }).click();
    await expect(page.getByRole("searchbox")).toHaveValue("Design");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(fixture.errors).toEqual([]);
  });
}

for (const width of [390, 1280]) {
  test(`Calendar meeting grant stays ready across an empty day and denied Meet day at ${width}px`, async ({ page }) => {
    const fixture = await openFixture(page, width);
    await page.route("**/api/one/calendar/insights", route => route.fulfill({ json: {
      complete: true, meeting_count: 0, meeting_minutes: 0, overlaps: 0, back_to_back: 0,
      time_zone: "Asia/Kolkata", days: [], recurring: [], focus: [],
    } }));
    await page.route("**/api/one/calendar/meetings", route => {
      const body = route.request().postDataJSON() as { date: string; time_zone: string };
      const denied = body.date !== "2026-10-14";
      const meetings = denied ? [{
        id: "restricted", calendar_id: "primary", account_id: "default",
        occurrence_id: "d".repeat(64), grant_id: "b".repeat(64),
        sources: [{ calendar_id: "primary", event_id: "restricted" }],
        title: "QA Restricted meeting", start: { dateTime: "2026-10-15T09:00:00Z" },
        artifact_kinds: [], availability: {}, discovery: "resource_denied", file_state: "provider_policy",
      }] : [];
      return route.fulfill({ json: {
        complete: !denied, calendar_complete: true, next_cursor: null, limitations: denied ? ["resource_denied"] : [],
        checked_events: denied ? 1 : 0, meeting_file_access: "ready", meetings,
        account_id: "default", date: body.date, time_zone: body.time_zone,
      } });
    });
    await page.getByRole("tab", { name: "Insights", exact: true }).click();
    await page.getByRole("button", { name: /Recordings & Notes/ }).click();
    await expect(page.getByText("No timed meetings for this day.")).toBeVisible();
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(page.getByText(/Google denied access to one or more meeting files/)).toBeVisible();
    await expect(page.getByRole("button", { name: /QA Restricted meeting/ })).toBeVisible();
    await expect(page.getByText("No timed meetings for this day.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Allow recording and notes access" })).toHaveCount(0);
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-denied-with-ready-grant-${width}.png`) });
    await page.getByRole("button", { name: "Previous day" }).click();
    await expect(page.getByText("No timed meetings for this day.")).toBeVisible();
    await expect(page.getByTestId("calendar-action")).toBeEmpty();
    expect(fixture.errors).toEqual([]);
  });
}

for (const width of [390, 1280]) {
  test(`date-only invitations and centered modal details at ${width}px`, async ({ page }) => {
    const fixture = await openFixture(page, width);
    const events = Array.from({ length: 10 }, (_, index) => ({ ...dayEvents("2026-10-14")[0], id: `invitation-${index + 1}`, title: `QA Invitation ${index + 1}`, response_status: "needsAction", can_respond: true, conflicts: [] }));
    events.push({ ...events[0], ...dayEvents("2026-10-15")[0], id: "tomorrow", title: "QA Tomorrow" });
    let reads = 0;
    await page.route("**/api/one/calendar/invitations", route => {
      reads++;
      return route.fulfill({ json: { events, pending_count: 11, unreadable_calendars: [], complete: true, time_zone: "Asia/Kolkata", start_at: "2026-10-13T00:00:00Z", end_at: "2026-10-17T00:00:00Z" } });
    });
    await page.getByRole("tab", { name: "Invitations", exact: true }).click();
    const rows = page.getByRole("button", { name: /^Open invitation:/ });
    await expect(rows).toHaveCount(10);
    await expect(page.getByRole("tab", { name: "Pending (10)" })).toBeVisible();
    await expect(page.getByText("Select an invitation to see its details.")).toHaveCount(0);
    await page.screenshot({ path: path.join(screenshotDirectory, `invitations-day-list-${width}.png`) });
    for (const index of [1, 9]) {
      const row = page.getByRole("button", { name: `Open invitation: QA Invitation ${index}`, exact: true });
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await expect(page.getByRole("article", { name: `Invitation details: QA Invitation ${index}` })).toBeVisible();
      const modal = page.getByRole("dialog", { name: "Invitation details", exact: true });
      const detailBox = (await modal.boundingBox())!;
      expect(Math.abs(detailBox.x + detailBox.width / 2 - width / 2)).toBeLessThanOrEqual(2);
      await page.screenshot({ path: path.join(screenshotDirectory, `invitations-day-selected-${index}-${width}.png`) });
      await page.getByRole("button", { name: "Invitations", exact: true }).click();
      await expect(row).toBeFocused();
    }
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAccessibleName("Open invitation: QA Tomorrow");
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await expect(page.getByText("No pending invitations on this date.")).toBeVisible();
    await page.getByRole("button", { name: "Previous day", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(rows).toHaveCount(10);
    const before = reads;
    await page.getByRole("tab", { name: "Schedule", exact: true }).click();
    await page.getByRole("tab", { name: "Invitations", exact: true }).click();
    await expect(rows).toHaveCount(10);
    await expect(page.getByRole("status", { name: "Invitations loading" })).toHaveCount(0);
    expect(reads).toBe(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(fixture.errors).toEqual([]);
  });
}

test("quiet loading preserves same-context previews and exposes real failures", async ({ page }) => {
  await openFixture(page, 1280);
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/one/calendar/invitations", async route => {
    await gate;
    return route.fulfill({ status: 503, json: { detail: { message: "Calendar temporarily unavailable", reason_code: "calendar_invalid_response" } } });
  });
  await page.getByRole("tab", { name: "Invitations", exact: true }).click();
  await expect(page.getByRole("status", { name: "Invitations loading" })).toBeVisible();
  await expect(page.getByText("Loading invitations…", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(screenshotDirectory, "invitations-initial-loading.png") });
  release();
  await expect(page.getByRole("alert")).toContainText("Invitations could not be loaded");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Schedule", exact: true }).click();
  await page.getByRole("tab", { name: "Free time", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Ask One about/ })).toHaveCount(3);
  const before = await page.getByRole("button", { name: /^Ask One about/ }).first().boundingBox();
  gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/one/calendar/schedule/availability", async route => {
    await gate;
    return route.fulfill({ status: 503, json: { detail: { message: "Calendar temporarily unavailable", reason_code: "calendar_invalid_response" } } });
  });
  await page.clock.setFixedTime(new Date(qaNow + 5000));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const preview = page.locator('[aria-label="Previous availability"]');
  await expect(preview).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ask One about/ })).toHaveCount(0);
  expect((await preview.locator("li").first().boundingBox())!.y).toBe(before!.y);
  await page.screenshot({ path: path.join(screenshotDirectory, "free-time-background-refresh.png") });
  release();
  await expect(preview).toHaveCount(0);
  await expect(page.getByText("Availability could not be checked.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Insights", exact: true }).click();
  await expect(page.getByText("Scheduled events", { exact: true })).toBeVisible();
  gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/one/calendar/insights", async route => { await gate; return route.fulfill({ status: 503, json: { detail: "Insights temporarily unavailable" } }); });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Scheduled events", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDirectory, "insights-background-refresh.png") });
  release();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Scheduled events", { exact: true })).toHaveCount(0);
  gate = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Scheduled events", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Snapshot loading")).toBeVisible();
  release();
  await expect(page.getByRole("alert")).toBeVisible();
});


test("decline reason sends once and returns to the same Calendar page", async ({ page }) => {
  const { calls, errors, unexpectedRequests } = await openFixture(page, 390);
  await page.getByRole("tab", { name: "Invitations", exact: true }).click();
  await page.getByRole("button", { name: "Open invitation: QA Product Sync" }).click();
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review decline email" })).toBeDisabled();
  await page.getByLabel("Reason for declining").fill("I have another commitment.");
  await page.getByRole("button", { name: "Review decline email" }).click();
  await expect(page.getByText("To: qa-organizer-0@example.test")).toBeVisible();
  await expect(page.getByText(/I have another commitment\./)).toBeVisible();
  expect(calls.filter(call => call.path.endsWith("/attendance/workspace/confirm"))).toHaveLength(0);
  await page.getByRole("button", { name: "Decline & send email" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("calendar-action")).toHaveText("");
  expect(page.url()).toContain("/calendar-connected-fixture");
  expect(calls.filter(call => call.path.endsWith("/attendance/workspace/confirm"))).toHaveLength(1);
  expect(errors).toEqual([]); expect(unexpectedRequests).toEqual([]);
});
