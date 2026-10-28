import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./product-font";
import { calendarBoardDayFixture } from "./calendar-board-day";

// Real component + actual typed Calendar transport; only authentication/router
// and HTTP provider boundaries are synthetic. This is rendered UI evidence,
// not proof that an external Google account was available in the test session.
let script: string;
let css: string;
let fixtureDirectory: string;
export const screenshotDirectory = process.env.CALENDAR_QA_SCREENSHOT_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), "calendar-qa-evidence-"));

export function registerCalendarConnectedFixture() {
  test.use({ timezoneId: "Asia/Kolkata" });
  test.beforeAll(async () => {
    const root = process.cwd();
    const { build } = await import("vite");
    const { Scanner } = await import("@tailwindcss/oxide");
    const scanner = new Scanner({});
    const candidates = new Set<string>();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-connected-"));
    fixtureDirectory = outDir;
    const boundary = path.join(root, "e2e/fixtures/calendar-connected-boundaries.ts");
    const identityBoundary = path.join(root, "e2e/fixtures/calendar-connected-identity.ts");
    await build({
      configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic" } },
      plugins: [{ name: "calendar-fixture-css", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id))
          for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      } }],
      resolve: { alias: [
        { find: "@/lib/vault/vault-context", replacement: boundary },
        { find: "@/hooks/use-auth", replacement: identityBoundary },
        { find: "@/hooks/use-effective-avatar-url", replacement: identityBoundary },
        { find: /^(?:@\/lib\/services\/|\.\/)api-service$/, replacement: boundary },
        { find: /^(?:@\/lib\/services\/|\.\/)auth-service$/, replacement: boundary },
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

}

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
export const qaNow = new Date("2026-10-14T04:05:00Z").getTime();
const sources = [
  { id: "qa-owner@example.com", name: "QA Personal", primary: true, access_role: "owner", background_color: "#4285f4" },
  { id: "qa-work@example.com", name: "QA Work", access_role: "reader", background_color: "#0b8043" },
];
export function dayEvents(day: string) {
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
export const privateLongTitle = "QA Product Sync with the architecture team and a deliberately long private planning title that must remain complete in event details";
export const privateLongLocation = "A long private meeting location with room instructions and a confidential customer source that must remain complete in event details";
function fixtureEvents(day: string, variant: "standard" | "long" | "empty" | "busy") {
  if (variant === "empty") return [];
  const events = dayEvents(day);
  return variant === "long" ? events.map(event => event.calendar_id === "primary" && event.id === "shared-id"
    ? { ...event, title: privateLongTitle, location: privateLongLocation } : event) : events;
}
export async function openFixture(page: Page, width: number, locked = false, variant: "standard" | "long" | "empty" | "busy" = "standard", replay: false | "future" | "today" = false, boardMode = false, brokenWorkPhoto = false) {
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
  const fixturePortraits = [1, 2, 3].map(number => `data:image/webp;base64,${fs.readFileSync(path.join(process.cwd(), `public/one-location/onboarding/orbit-person-${number}.webp`)).toString("base64")}`);
  await page.route("**/*", route => { unexpectedRequests.push(route.request().url()); return route.abort(); });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  for (const provider of ["google-meet-reference", "microsoft-teams-reference"]) {
    await page.route(`https://calendar-fixture.test/one-calendar/providers/${provider}.png`, route => route.fulfill({
      contentType: "image/png", body: fs.readFileSync(path.join(process.cwd(), `public/one-calendar/providers/${provider}.png`)),
    }));
  }
  await page.route("**/api/one/connections", route => route.fulfill({ json: { items: [
    { connectionId: "qa-manish", userId: "qa-manish", email: "manish@example.test", emailVerified: true, displayName: "Manish", photoUrl: fixturePortraits[2], createdAt: null },
    { connectionId: "qa-priya", userId: "qa-priya", email: "qa-organizer-0@example.test", emailVerified: true, displayName: "Priya Mehta", photoUrl: fixturePortraits[1], createdAt: null },
    { connectionId: "qa-work", userId: "qa-work", email: "qa-work@example.com", emailVerified: true, displayName: "QA Work", photoUrl: brokenWorkPhoto ? "data:image/png;base64,AA==" : fixturePortraits[1], createdAt: null },
  ] } }));
  await page.route("**/api/account/email-aliases", route => route.fulfill({ json: { success: true, user_id: "synthetic-calendar-owner", aliases: [] } }));
  await page.route("https://calendar-fixture.test/calendar-fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("https://calendar-fixture.test/calendar-connected-fixture**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected Calendar QA</title><style>${css}</style><style>:root{--app-bottom-content-clearance:164px}body{margin:0}</style></head><body><div id="root"></div><script>window.__calendarFixturePhoto=${JSON.stringify(fixturePortraits[0])}</script><script src="/calendar-fixture.js"></script></body></html>` }));
  let failAvailability = false;
  let mailFailure = false;
  let scheduleVariant = variant;
  let scheduleGate: Promise<void> | null = null;
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
      return route.fulfill({ json: calendarBoardDayFixture({
        day: String(body.date), zone: String(body.time_zone), durationMinutes: Number(body.duration_minutes),
        now: qaNow, busy: variant === "busy", instant,
      }) });
    }
    if (boardMode && routePath.endsWith("/conflicts/workspace/review")) {
      const keep = body.keep as Record<string, string>;
      const decline = (body.decline as Record<string, string>[])[0];
      const title = (ref: Record<string, string>) => ref.event_id === "client" ? "QA Client Call" : "QA Design Review";
      return route.fulfill({ json: { review_id: "synthetic-conflict-review", review_token: "synthetic-reviewed-plan-token".repeat(3), expires_at: "2030-01-01T00:00:00Z", previews: [
        { kind: "keep", ref: keep, title: title(keep), account_email: keep.account_id === "work" ? "qa-work@example.com" : "qa-owner@example.com", action: "accept", start: { dateTime: "2026-10-14T05:00:00Z" }, end: { dateTime: "2026-10-14T06:00:00Z" } },
        { kind: "decline", ref: decline, title: title(decline), account_email: decline.account_id === "work" ? "qa-work@example.com" : "qa-owner@example.com", action: "decline and send note", start: { dateTime: "2026-10-14T04:30:00Z" }, end: { dateTime: "2026-10-14T05:30:00Z" }, recipient: "organizer-design@example.test", sender_label: "QA Owner", subject: "Unable to attend", message: decline.message },
      ] } });
    }
    if (boardMode && routePath.endsWith("/conflicts/workspace/confirm")) return route.fulfill({ json: { complete: true, results: [
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
        attendees: [
          { email: "qa-owner@example.com", self: true, response_status: invitationResponses.get(event.id) || "needsAction" },
          { email: `qa-organizer-${index}@example.test`, display_name: "Organizer", response_status: "accepted" },
          ...(index === 0 ? [
            { email: "anoushka@example.test", display_name: "Anoushka", response_status: "accepted" },
            { email: "manish@example.test", display_name: "Manish", response_status: "accepted" },
            { email: "long-calendar-attendee-for-responsive-verification@example.test", response_status: "needsAction" },
            { email: "ankit@example.test", response_status: "needsAction" },
            { email: "divya@example.test", response_status: "needsAction" },
            { email: "roopmann@example.test", response_status: "needsAction" },
            { email: "smirthika@example.test", response_status: "needsAction" },
          ] : []),
        ],
      })),
      pending_count: ["shared-id", "design"].filter(id => !invitationResponses.has(id)).length,
      unreadable_calendars: [], time_zone: body.time_zone, complete: true,
      start_at: "2026-10-14T00:00:00Z", end_at: "2027-01-12T00:00:00Z",
    } });
    if (routePath.includes("/attendance/") && routePath.endsWith("/review")) {
      const reviewId = `review-${attendanceReviews.size}`;
      attendanceReviews.set(reviewId, body);
      const event = dayEvents("2026-10-14").find(item => item.id === body.event_id && item.calendar_id === body.calendar_id) || dayEvents("2026-10-14")[0];
      return route.fulfill({ json: { review_id: reviewId, review_token: "synthetic-memory-only-review-token".repeat(2), title: event.title,
        start: event.start, end: event.end,
        response_status: body.response_status || "declined", calendar_id: body.calendar_id, expires_at: "2030-01-01T00:00:00Z",
        conflicts: body.response_status === "accepted" ? [{ title: "QA Existing meeting", start: { dateTime: "2026-10-14T04:30:00Z" }, end: { dateTime: "2026-10-14T05:00:00Z" } }] : [],
        openings: body.offer_times ? [{ start_at: "2030-10-15T04:30:00Z", end_at: "2030-10-15T05:00:00Z" }] : [],
        recipient: body.offer_times || body.send_message ? "qa-organizer-0@example.test" : null, subject: body.offer_times ? "Another time for QA Product Sync" : body.send_message ? "Unable to attend QA Product Sync" : null,
        message: body.offer_times ? `${body.message}\n\nhttps://one.example.test/calendar/reschedule#synthetic-capability` : body.send_message ? body.message : null,
        rescheduling_link: body.offer_times ? "https://one.example.test/calendar/reschedule#synthetic-capability" : null,
      } });
    }
    if (routePath.includes("/attendance/") && routePath.endsWith("/confirm")) {
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
    if (routePath.endsWith("/schedule/today")) {
      if (scheduleGate) await scheduleGate;
      const otherOwner = request.headers().authorization === "Bearer synthetic-firebase-other-owner-token";
      return route.fulfill({ json: { events: otherOwner ? [] : fixtureEvents(String(body.date), scheduleVariant), date: body.date, time_zone: body.time_zone, calendars: otherOwner ? [{ id: "other-owner@example.com", name: "Other owner", primary: true }] : sources, unreadable_calendars: [] } });
    }
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
  await expect(page.getByRole("heading", { name: "Calendar", exact: true, hidden: true }), `Calendar fixture render errors: ${errors.join("; ")}`).toHaveClass(/sr-only/);
  if (!locked && variant !== "empty") await expect(page.getByRole("button", { name: boardMode ? /^Open QA Design Review/ : /^QA Product Sync/ }).first()).toBeVisible();
  return { errors, unexpectedRequests, calls, failMail: () => { mailFailure = true; }, failAvailability: (failed = true) => { failAvailability = failed; },
    holdSchedule: () => {
      if (scheduleGate) throw new Error("Schedule response already held");
      let release!: () => void;
      scheduleGate = new Promise<void>(resolve => { release = resolve; });
      return (nextVariant: typeof variant) => { scheduleVariant = nextVariant; scheduleGate = null; release(); };
    } };
}
export async function assertActionsClearChrome(page: Page, width: number, suffix: string) {
  await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = element.scrollHeight; });
  const fixed = (await page.getByTestId("reserved-bottom-chrome").boundingBox())!;
  for (const name of ["Try Calendar Agent with One", "Disconnect Calendar"]) {
    const bounds = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(fixed.y);
  }
  await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-actions${suffix === "today" ? "" : "-free"}-${width}.png`) });
}
