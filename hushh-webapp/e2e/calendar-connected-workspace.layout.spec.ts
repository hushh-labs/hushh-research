import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Real component + actual typed Calendar transport; only authentication/router
// and HTTP provider boundaries are synthetic. This is rendered UI evidence,
// not proof that an external Google account was available in the test session.
test.use({ timezoneId: "Asia/Kolkata" });

let script: string;
let css: string;
let fixtureDirectory: string;
const screenshotDirectory = process.env.CALENDAR_QA_SCREENSHOT_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), "calendar-qa-evidence-"));

test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-connected-"));
  fixtureDirectory = outDir;
  const boundary = path.join(root, "e2e/fixtures/calendar-connected-boundaries.ts");
  await build({
    configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic" } },
    plugins: [{ name: "calendar-fixture-css", transform(source, id) {
      if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
        for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
    } }],
    resolve: { alias: [
      { find: "@/lib/vault/vault-context", replacement: boundary },
      { find: "@/lib/services/api-service", replacement: boundary },
      { find: "next/navigation", replacement: boundary },
      { find: "@", replacement: root },
    ] },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
    build: { outDir, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/calendar-connected-workspace.tsx"), name: "CalendarFixture", formats: ["iife"], fileName: () => "fixture.js" } },
  });
  script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css")
        : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
  css += fs.readdirSync(outDir).filter(file => file.endsWith(".css")).map(file => fs.readFileSync(path.join(outDir, file), "utf8")).join("\n");
  fs.mkdirSync(screenshotDirectory, { recursive: true });
});

test.afterAll(() => {
  if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

function instant(day: string, clock: string, zone = "Asia/Kolkata") {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = clock.split(":").map(Number);
  let value = Date.UTC(year, month - 1, date, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let step = 0; step < 2; step++) {
    const parts = formatter.formatToParts(new Date(value));
    const part = (type: string) => Number(parts.find(item => item.type === type)!.value);
    const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    value -= wall - Date.UTC(year, month - 1, date, hour, minute);
  }
  return value;
}
const qaNow = new Date("2026-10-14T04:05:00Z").getTime();
const sources = [
  { id: "qa-owner@example.com", name: "QA Personal", primary: true, access_role: "owner", background_color: "#4285f4" },
  { id: "qa-work@example.com", name: "QA Work", access_role: "reader", background_color: "#0b8043" },
];
function dayEvents(day: string) {
  const event = (id: string, title: string, start: string, end: string, source = 0, details: object = {}) => ({
    id, title, calendar_id: source === 0 ? "primary" : sources[source].id, source_calendar_id: sources[source].id,
    calendar_name: sources[source].name, calendar_color: sources[source].background_color, event_color: sources[source].background_color,
    status: "confirmed", start: { dateTime: new Date(instant(day, start)).toISOString() }, end: { dateTime: new Date(instant(day, end)).toISOString() },
    can_decline: source === 0, organizer: { email: "qa-organizer@example.com" },
    html_link: `https://calendar.google.com/calendar/event?eid=qa-${id}-${source}`, ...details,
  });
  return [
    event("shared-id", "QA Product Sync", "10:00", "10:30", 0, { conference_url: "https://meet.google.com/abc-defg-hij", conference_name: "Google Meet", description: "Synthetic event details for rendered QA." }),
    event("design", "QA Design Review", "11:00", "11:45", 1, { conference_url: "https://zoom.us/j/123456789", conference_name: "Zoom Meeting" }),
    event("lunch", "QA Lunch with Aditya", "12:30", "13:30", 0, { location: "The Grid, Koregaon Park", event_color: "#f6bf26" }),
    event("shared-id", "QA Engineering Standup", "14:00", "15:00", 1, { conference_url: "https://meet.google.com/abc-defg-hij", conference_name: "Google Meet" }),
    event("client", "QA Client Call – Acme", "16:00", "17:00", 1, { conference_url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_qa/0", conference_name: "Microsoft Teams" }),
    event("gym", "QA Gym", "19:00", "20:00", 0, { location: "Cult Fit" }),
    // Informational all-day item: the synthetic provider marks it transparent,
    // so it appears in Today but contributes no busy time to availability.
    { id: "all-day", title: "QA Team retreat", calendar_id: "primary", source_calendar_id: sources[0].id, calendar_name: sources[0].name,
      calendar_color: sources[0].background_color, start: { date: day }, end: { date: new Date(new Date(`${day}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10) } },
  ];
}
function freeWindows(body: Record<string, unknown>) {
  const day = String(body.date), zone = String(body.time_zone);
  const left = instant(day, String(body.start_time), zone), right = instant(day, String(body.end_time), zone);
  const rangeStart = Math.min(Math.max(left, Math.floor(qaNow / 60_000) * 60_000 + 60_000), right);
  let cursor = rangeStart;
  const windows = [];
  const busy = dayEvents(day).flatMap(event => {
    const start = event.start, end = event.end;
    return "dateTime" in start && "dateTime" in end ? [[Date.parse(String(start.dateTime)), Date.parse(String(end.dateTime))]] : [];
  });
  for (const [start, end] of [...busy, [right, right]]) {
    const limit = Math.min(start, right);
    const elapsed = Math.floor((limit - cursor) / 60_000);
    if (elapsed >= Number(body.duration_minutes)) windows.push({ start_at: new Date(cursor).toISOString(), end_at: new Date(limit).toISOString(), duration_minutes: elapsed });
    cursor = Math.max(cursor, end);
    if (cursor >= right) break;
  }
  return { windows: windows.slice(0, 3), full_count: windows.length, requested_duration_minutes: body.duration_minutes,
    calendars: sources, date: day, time_zone: zone, time_min: new Date(left).toISOString(), time_max: new Date(right).toISOString() };
}
const privateLongTitle = "QA Product Sync with the architecture team and a deliberately long private planning title that must remain complete in event details";
const privateLongLocation = "A long private meeting location with room instructions and a confidential customer source that must remain complete in event details";
function fixtureEvents(day: string, variant: "standard" | "long" | "empty") {
  if (variant === "empty") return [];
  const events = dayEvents(day);
  return variant === "long" ? events.map(event => event.calendar_id === "primary" && event.id === "shared-id"
    ? { ...event, title: privateLongTitle, location: privateLongLocation } : event) : events;
}
async function openFixture(page: Page, width: number, locked = false, variant: "standard" | "long" | "empty" = "standard", replay: false | "future" | "today" = false, boardMode = false) {
  // Settle the previous fixture before registering the next fixture's error
  // collector: navigating away intentionally cancels its pending reads.
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "wait" });
  page.removeAllListeners("pageerror");
  page.removeAllListeners("console");
  await page.setViewportSize({ width, height: width > 1000 ? 1100 : 950 });
  await page.clock.setFixedTime(new Date(replay === "today" ? "2030-01-17T08:42:20Z" : replay ? "2030-01-16T02:00:00Z" : qaNow));
  const errors: string[] = [];
  const unexpectedRequests: string[] = [];
  await page.route("**/*", route => { unexpectedRequests.push(route.request().url()); return route.abort(); });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  for (const provider of ["google-meet-reference", "microsoft-teams-reference"]) {
    await page.route(`https://calendar-fixture.test/one-calendar/providers/${provider}.png`, route => route.fulfill({
      contentType: "image/png", body: fs.readFileSync(path.join(process.cwd(), `public/one-calendar/providers/${provider}.png`)),
    }));
  }
  await page.route("https://calendar-fixture.test/fonts/Inter/InterVariable.woff2", route => route.fulfill({ contentType: "font/woff2", body: fs.readFileSync(path.join(process.cwd(), "public/fonts/Inter/InterVariable.woff2")) }));
  await page.route("https://calendar-fixture.test/calendar-fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("https://calendar-fixture.test/calendar-connected-fixture**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected Calendar QA</title><style>${css}</style><style>:root{--app-bottom-content-clearance:164px}body{margin:0}</style></head><body><div id="root"></div><script src="/calendar-fixture.js"></script></body></html>` }));
  let failAvailability = false;
  let mailFailure = false;
  const invitationResponses = new Map<string, string>();
  const attendanceReviews = new Map<string, Record<string, unknown>>();
  const calls: Array<{ path: string; body: Record<string, unknown>; authorization: string | undefined; response?: ReturnType<typeof freeWindows> }> = [];
  await page.route("**/api/one/calendar/**", async route => {
    const request = route.request();
    const routePath = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown>;
    const call = { path: routePath, body, authorization: request.headers().authorization } as typeof calls[number];
    calls.push(call);
    if (routePath.endsWith("/status/synthetic-calendar-owner")) return route.fulfill({ json: { connected: true, access_level: "manage", google_email: "qa-owner@example.com" } });
    if (boardMode && routePath.endsWith("/board/day")) {
      const day = String(body.date), zone = String(body.time_zone);
      const event = (account_id: string, id: string, title: string, first: string, last: string) => ({
        account_id, id, calendar_id: "primary", title, etag: `etag-${id}`,
        start: { dateTime: new Date(instant(day, first, zone)).toISOString() },
        end: { dateTime: new Date(instant(day, last, zone)).toISOString() },
        organizer: { email: `organizer-${id}@example.test` }, can_decline: true,
        attendees: [{ email: `qa-${account_id}@example.com`, response_status: "needsAction" }],
      });
      const first = event("default", "design", "QA Design Review", "10:00", "11:00");
      const second = event("work", "client", "QA Client Call", "10:30", "11:30");
      const third = event("projects", "focus", "QA Project Focus", "13:00", "14:00");
      const opening = [{ start_at: new Date(instant(day, "15:00", zone)).toISOString(), end_at: new Date(instant(day, "16:00", zone)).toISOString() }];
      return route.fulfill({ json: { date: day, time_zone: zone, duration_minutes: body.duration_minutes,
        checked_at: new Date(qaNow).toISOString(), complete: true, conflicts_complete: true,
        shared_free_windows: opening,
        conflicts: [{ left: { account_id: "default", calendar_id: "primary", event_id: "design" }, right: { account_id: "work", calendar_id: "primary", event_id: "client" }, start_at: second.start.dateTime, end_at: first.end.dateTime }],
        accounts: [
          { account_id: "default", google_email: "qa-owner@example.com", connection_status: "connected", status: "complete", events: [first], free_windows: opening, unreadable_calendars: [] },
          { account_id: "work", google_email: "qa-work@example.com", connection_status: "connected", status: "complete", events: [second], free_windows: opening, unreadable_calendars: [] },
          { account_id: "projects", google_email: "qa-projects@example.com", connection_status: "connected", status: "complete", events: [third], free_windows: opening, unreadable_calendars: [] },
        ],
      } });
    }
    if (boardMode && routePath.endsWith("/conflicts/review")) {
      const keep = body.keep as Record<string, string>;
      const decline = (body.decline as Record<string, string>[])[0];
      const title = (ref: Record<string, string>) => ref.event_id === "client" ? "QA Client Call" : "QA Design Review";
      return route.fulfill({ json: { review_id: "synthetic-conflict-review", review_token: "synthetic-reviewed-plan-token".repeat(3), expires_at: "2030-01-01T00:00:00Z", previews: [
        { kind: "keep", ref: keep, title: title(keep), account_email: keep.account_id === "work" ? "qa-work@example.com" : "qa-owner@example.com", action: "accept", start: { dateTime: "2026-10-14T05:00:00Z" }, end: { dateTime: "2026-10-14T06:00:00Z" } },
        { kind: "decline", ref: decline, title: title(decline), account_email: decline.account_id === "work" ? "qa-work@example.com" : "qa-owner@example.com", action: "decline and send note", start: { dateTime: "2026-10-14T04:30:00Z" }, end: { dateTime: "2026-10-14T05:30:00Z" }, recipient: "organizer-design@example.test", sender_label: "QA Owner", subject: "Unable to attend", message: decline.message },
      ] } });
    }
    if (boardMode && routePath.endsWith("/conflicts/confirm")) return route.fulfill({ json: { complete: true, results: [
      { kind: "keep", ref: { account_id: "work", calendar_id: "primary", event_id: "client" }, calendar: "accepted", email: "not_sent" },
      { kind: "decline", ref: { account_id: "default", calendar_id: "primary", event_id: "design" }, calendar: "declined", email: "sent" },
    ] } });
    if (routePath.endsWith("/insights")) return route.fulfill({ json: {
      complete: true, meeting_count: 0, meeting_minutes: 0, overlaps: 0, back_to_back: 0,
      time_zone: body.time_zone, days: [], recurring: [], focus: [],
    } });
    if (routePath.endsWith("/invitations")) return route.fulfill({ json: {
      events: fixtureEvents("2026-10-14", "standard").slice(0, 3).map((event, index) => ({ ...event,
        response_status: invitationResponses.get(event.id) || (index === 2 ? "declined" : "needsAction"),
        can_respond: true, conflicts: index === 0 ? [{ title: "QA Existing meeting", start: event.start, end: event.end }] : [],
        organizer: { displayName: ["Priya Mehta", "Rohan Kapoor", "Alex Chen"][index], email: `qa-organizer-${index}@example.test` },
        attendees: [{ email: "qa-owner@example.com", self: true, response_status: invitationResponses.get(event.id) || "needsAction" }, { email: `qa-organizer-${index}@example.test`, display_name: "Organizer", response_status: "accepted" }],
      })),
      pending_count: ["shared-id", "design"].filter(id => !invitationResponses.has(id)).length,
      unreadable_calendars: [], time_zone: body.time_zone, complete: true,
      start_at: "2026-10-14T00:00:00Z", end_at: "2027-01-12T00:00:00Z",
    } });
    if (routePath.endsWith("/attendance/review")) {
      const reviewId = `review-${attendanceReviews.size}`;
      attendanceReviews.set(reviewId, body);
      return route.fulfill({ json: { review_id: reviewId, review_token: "synthetic-memory-only-review-token".repeat(2), title: "QA Product Sync",
        response_status: body.response_status || "declined", calendar_id: body.calendar_id, expires_at: "2030-01-01T00:00:00Z",
        conflicts: body.response_status === "accepted" ? [{ title: "QA Existing meeting", start: { dateTime: "2026-10-14T04:30:00Z" }, end: { dateTime: "2026-10-14T05:00:00Z" } }] : [],
        openings: body.offer_times ? [{ start_at: "2030-10-15T04:30:00Z", end_at: "2030-10-15T05:00:00Z" }] : [],
        recipient: body.offer_times || body.send_message ? "qa-organizer-0@example.test" : null, subject: body.offer_times ? "Another time for QA Product Sync" : null,
        message: body.offer_times ? `${body.message}\n\nhttps://one.example.test/calendar/reschedule#synthetic-capability` : null,
        rescheduling_link: body.offer_times ? "https://one.example.test/calendar/reschedule#synthetic-capability" : null,
      } });
    }
    if (routePath.endsWith("/attendance/confirm")) {
      const review = attendanceReviews.get(String(body.review_id))!;
      invitationResponses.set(String(review.event_id), String(review.response_status || "declined"));
      return route.fulfill({ json: { calendar: review.response_status || "declined", email: (review.offer_times || review.send_message) ? mailFailure ? "failed" : "sent" : "not_sent", calendar_error: null, email_error: mailFailure ? "Synthetic Mail failure. Your RSVP is saved." : null } });
    }
    if (replay && routePath.endsWith("/schedule/availability")) {
      const bundle = JSON.parse(fs.readFileSync(process.env.CALENDAR_PROVIDER_REPLAY_PATH!, "utf8"));
      expect(body.time_zone).toBe("Asia/Calcutta");
      expect(body.start_time).toBe("00:00"); expect(body.end_time).toBe("24:00");
      const response = replay === "today" ? bundle.today[String(body.duration_minutes)] : bundle.days[String(body.date)][String(body.duration_minutes)];
      return route.fulfill({ json: response });
    }
    if (routePath.endsWith("/schedule/today")) return route.fulfill({ json: { events: fixtureEvents(String(body.date), variant), date: body.date, time_zone: body.time_zone, calendars: sources, unreadable_calendars: [] } });
    if (routePath.endsWith("/schedule/availability")) {
      const response = freeWindows(body); call.response = response;
      return failAvailability
        ? route.fulfill({ status: 502, json: { detail: { message: "Availability could not be checked.", reason_code: "calendar_invalid_response" } } })
        : route.fulfill({ json: response });
    }
    return route.fulfill({ status: 500, json: { detail: "Unexpected fixture request" } });
  });
  const query = boardMode ? "?board=1" : replay ? "?providerReplay=1" : locked ? "?locked=1" : "";
  await page.goto(`https://calendar-fixture.test/calendar-connected-fixture${query}`);
  expect(page.url()).toBe(`https://calendar-fixture.test/calendar-connected-fixture${query}`);
  await expect(page).toHaveTitle("Connected Calendar QA");
  await awaitProductFont(page);
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  if (!locked && variant !== "empty") await expect(page.getByRole("button", { name: boardMode ? /^Open QA Design Review/ : /^QA Product Sync/ })).toBeVisible();
  return { errors, unexpectedRequests, calls, failMail: () => { mailFailure = true; }, failAvailability: (failed = true) => { failAvailability = failed; } };
}
async function assertActionsClearChrome(page: Page, width: number, suffix: string) {
  await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = element.scrollHeight; });
  const fixed = (await page.getByTestId("reserved-bottom-chrome").boundingBox())!;
  for (const name of ["Try Calendar Agent with One", "Disconnect Calendar"]) {
    const bounds = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(fixed.y);
  }
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-actions${suffix === "today" ? "" : "-free"}-${width}.png`) });
}
for (const width of [390, 1440]) {
  test(`three-account board and inline conflict review at ${width}px`, async ({ page }) => {
    const { errors, unexpectedRequests, calls } = await openFixture(page, width, false, "standard", false, true);
    await expect(page.locator("[data-calendar-account-board]")).toBeVisible();
    for (const email of ["qa-owner@example.com", "qa-work@example.com", "qa-projects@example.com"]) await expect(page.getByRole("heading", { name: email })).toBeVisible();
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
    expect(calls.some(call => call.path.endsWith("/conflicts/review"))).toBe(true);
    expect(calls.some(call => call.path.endsWith("/conflicts/confirm"))).toBe(true);
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
    expect(await page.getByRole("heading", { name: "Calendar", exact: true }).evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/Inter/);
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
    await expect(page.getByRole("dialog")).toContainText("Synthetic event details for rendered QA.");
    for (let index = 0; index < 5; index++) { await page.keyboard.press("Tab"); expect(await page.getByRole("dialog").evaluate(element => element.contains(document.activeElement))).toBe(true); }
    await page.getByTestId("calendar-fixture-lock").dispatchEvent("click");
    expect(await page.evaluate(() => document.body.textContent?.includes("Synthetic event details for rendered QA."))).toBe(false);
    await expect(page.getByText("Calendar session unavailable.", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /unlock/i })).toHaveCount(0);
    await page.getByTestId("calendar-fixture-authorize").dispatchEvent("click");
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
    await page.getByTestId("calendar-fixture-lock").dispatchEvent("click");
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
    await page.getByRole("textbox", { name: "Time zone", exact: true }).fill("Asia/Calcutta");
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
    await page.getByRole("textbox", { name: "Time zone", exact: true }).fill("Asia/Calcutta");
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
    const bounds = (await dialog.boundingBox())!;
    expect(Math.abs(bounds.x + bounds.width / 2 - width / 2)).toBeLessThanOrEqual(2);
    await expect(page.locator('[data-slot="dialog-overlay"]')).toBeVisible();
    expect(await page.locator('[data-slot="dialog-overlay"]').evaluate(node => getComputedStyle(node).backdropFilter)).not.toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
    expect(calls.filter(call => call.path.endsWith("/attendance/confirm"))).toHaveLength(0);
    await page.getByRole("button", { name: "Accept anyway" }).click();
    await expect(dialog).toBeHidden();
    expect(calls.filter(call => call.path.endsWith("/attendance/confirm"))).toHaveLength(1);
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
    await page.route("**/api/one/calendar/meetings", route => route.fulfill({ json: { complete: true, window_days: 30, meetings: [
      { id: "notes", calendar_id: "primary", title: "QA Design review", start: { dateTime: "2026-10-13T09:00:00Z" }, artifact_kinds: ["notes"] },
      { id: "video", calendar_id: "primary", title: "QA Product demo", start: { dateTime: "2026-10-12T09:00:00Z" }, artifact_kinds: ["recording"] },
    ] } }));
    await page.route("**/api/one/calendar/meetings/detail", route => route.fulfill({ json: { complete: true, discovery: "checked", calendar_id: "primary", event: { title: "QA Design review" }, artifacts: [
      { file_id: "qa-doc", kind: "notes", state: "available", title: "QA Meeting notes", url: "https://docs.google.com/document/d/qa-doc", text: "Synthetic browser fixture only.\n\nDecisions\nKeep the existing Calendar shell.\n\nFollow-ups\nReview the responsive layout and permission states.", can_ask: true },
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
    await expect(page.getByRole("button", { name: /QA Product demo/ })).toHaveCount(0);
    await page.getByRole("searchbox").fill("Design");
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-library-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: /QA Design review/ }).click();
    await expect(page.getByRole("link", { name: "Open source" })).toHaveAttribute("href", "https://docs.google.com/document/d/qa-doc");
    await expect(page.getByRole("button", { name: "Ask One about this meeting" })).toBeEnabled();
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-meeting-${width}.png`), fullPage: true });
    await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = element.scrollHeight; });
    const askBounds = (await page.getByRole("button", { name: "Ask One about this meeting" }).boundingBox())!;
    const chromeBounds = (await page.getByTestId("reserved-bottom-chrome").boundingBox())!;
    expect(askBounds.y + askBounds.height).toBeLessThanOrEqual(chromeBounds.y);
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `insights-meeting-actions-${width}.png`) });
    await page.getByRole("tab", { name: "Transcript", exact: true }).click();
    await expect(page.getByText("Permission required. Calendar access does not include access to this meeting file.")).toBeVisible();
    await page.getByRole("button", { name: "Back to recordings and notes" }).click();
    await expect(page.getByRole("searchbox")).toHaveValue("Design");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
  await expect(page.getByText("Last loaded snapshot · updates pending")).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Decline & send email" })).toBeDisabled();
  await page.getByLabel("Reason for declining").fill("I have another commitment.");
  await page.getByRole("button", { name: "Decline & send email" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("calendar-action")).toHaveText("");
  expect(page.url()).toContain("/calendar-connected-fixture");
  expect(calls.filter(call => call.path.endsWith("/attendance/confirm"))).toHaveLength(1);
  expect(errors).toEqual([]); expect(unexpectedRequests).toEqual([]);
});
