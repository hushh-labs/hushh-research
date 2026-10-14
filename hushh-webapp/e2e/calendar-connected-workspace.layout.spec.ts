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
    calendars: sources, date: day, time_zone: zone, time_min: new Date(rangeStart).toISOString(), time_max: new Date(right).toISOString() };
}
const privateLongTitle = "QA Product Sync with the architecture team and a deliberately long private planning title that must remain complete in event details";
const privateLongLocation = "A long private meeting location with room instructions and a confidential customer source that must remain complete in event details";
function fixtureEvents(day: string, variant: "standard" | "long" | "empty") {
  if (variant === "empty") return [];
  const events = dayEvents(day);
  return variant === "long" ? events.map(event => event.calendar_id === "primary" && event.id === "shared-id"
    ? { ...event, title: privateLongTitle, location: privateLongLocation } : event) : events;
}
async function openFixture(page: Page, width: number, locked = false, variant: "standard" | "long" | "empty" = "standard") {
  await page.setViewportSize({ width, height: width > 1000 ? 1100 : 950 });
  await page.clock.setFixedTime(new Date(qaNow));
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
  await page.route("https://calendar-fixture.test/calendar-fixture.js", route => route.fulfill({ contentType: "application/javascript; charset=utf-8", body: script }));
  await page.route("https://calendar-fixture.test/calendar-connected-fixture**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected Calendar QA</title><style>${css}</style><style>:root{--app-bottom-content-clearance:164px}body{margin:0}</style></head><body><div id="root"></div><script src="/calendar-fixture.js"></script></body></html>` }));
  let failAvailability = false;
  const calls: Array<{ path: string; body: Record<string, unknown>; authorization: string | undefined; response?: ReturnType<typeof freeWindows> }> = [];
  await page.route("**/api/one/calendar/**", async route => {
    const request = route.request();
    const routePath = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown>;
    const call = { path: routePath, body, authorization: request.headers().authorization } as typeof calls[number];
    calls.push(call);
    if (routePath.endsWith("/schedule/today")) return route.fulfill({ json: { events: fixtureEvents(String(body.date), variant), date: body.date, time_zone: body.time_zone, calendars: sources, unreadable_calendars: [] } });
    if (routePath.endsWith("/schedule/availability")) {
      const response = freeWindows(body); call.response = response;
      return failAvailability
        ? route.fulfill({ status: 502, json: { detail: { message: "A subscribed calendar was unavailable.", reason_code: "calendar_invalid_response" } } })
        : route.fulfill({ json: response });
    }
    return route.fulfill({ status: 500, json: { detail: "Unexpected fixture request" } });
  });
  await page.goto(`https://calendar-fixture.test/calendar-connected-fixture${locked ? "?locked=1" : ""}`);
  await awaitProductFont(page);
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  if (!locked && variant !== "empty") await expect(page.getByRole("button", { name: /^QA Product Sync/ })).toBeVisible();
  return { errors, unexpectedRequests, calls, failAvailability: () => { failAvailability = true; } };
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
for (const width of [320, 390, 1440]) {
  test(`connected Calendar geometry, timeline, windows and shared session recovery at ${width}px`, async ({ page }) => {
    const { errors, unexpectedRequests, calls, failAvailability } = await openFixture(page, width);
    const tabs = page.getByRole("tablist", { name: "Calendar navigation" });
    const tabBounds = (await tabs.boundingBox())!;
    expect(tabBounds.height).toBe(36);
    expect(Math.abs((await page.locator("[data-calendar-workspace]").boundingBox())!.width - tabBounds.width)).toBeLessThanOrEqual(1);
    if (width > 1000) expect(tabBounds.width).toBe(820);
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
    await expect(page.getByRole("dialog")).toContainText("Time zone and availability hours for this session.");
    for (let index = 0; index < 6; index++) { await page.keyboard.press("Tab"); expect(await page.getByRole("dialog").evaluate(element => element.contains(document.activeElement))).toBe(true); }
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await tabs.getByRole("tab", { name: "Schedule", exact: true }).focus();
    await page.keyboard.press("ArrowRight"); await expect(tabs.getByRole("tab", { name: "Invitations", exact: true })).toBeFocused();
    await expect(page.getByText("Coming soon", { exact: true })).toBeVisible();
    await page.keyboard.press("ArrowRight"); await expect(tabs.getByRole("tab", { name: "Insights", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await page.getByRole("tab", { name: "Free time", exact: true }).click();
    await expect(page.getByRole("heading", { name: "5 available slots today", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Free time", exact: true })).toHaveCSS("background-color", selectedSurface);
    await expect(page.getByRole("tab", { name: "Today", exact: true })).toHaveCSS("background-color", inactiveSurface);
    const availabilityCall = calls.find(call => call.path.endsWith("/schedule/availability"))!;
    expect(availabilityCall.body.duration_minutes).toBe(15);
    expect(availabilityCall.authorization).toBe("Bearer synthetic-firebase-owner-token");
    expect(availabilityCall.response?.windows).toHaveLength(3);
    await expect(page.getByRole("button", { name: /^Ask One about/ })).toHaveCount(3);
    await expect(page.getByText("Showing 3 of 5 available windows.")).toBeVisible();
    for (const window of availabilityCall.response!.windows) expect(Math.floor((Date.parse(window.end_at) - Date.parse(window.start_at)) / 60_000)).toBe(window.duration_minutes);
    await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ animations: "disabled", path: path.join(screenshotDirectory, `calendar-free-time-${width}.png`) });
    await assertActionsClearChrome(page, width, "free");
    const add = page.getByRole("button", { name: /^Ask One about/ }).last();
    await add.click(); await expect(page.getByTestId("calendar-action")).toContainText("15-minute meeting");
    await expect(page.getByTestId("calendar-action")).toContainText("2026-10-14");
    await page.getByRole("button", { name: /Need a different time/ }).click();
    await expect(page.getByTestId("calendar-action")).toContainText("availability hours are 09:00 to 17:00");
    await page.getByRole("tab", { name: "30 min", exact: true }).click();
    await expect(page.getByRole("heading", { name: "4 available slots today", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next day", exact: true }).click();
    await expect(page.getByLabel("Selected date")).toHaveValue("2026-10-15");
    await expect(page.getByRole("link", { name: /View full availability/ })).toHaveAttribute("href", "https://calendar.google.com/calendar/u/0/r/day/2026/10/15?authuser=qa-owner%40example.com");
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    failAvailability();
    await menu.click(); await page.getByRole("menuitem", { name: "Refresh Calendar", exact: true }).click();
    await expect(page.getByText("Availability could not be checked.", { exact: true })).toBeVisible();
    await expect(page.getByText("No free slots in this window.", { exact: true })).toHaveCount(0);
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
    await expect(page.getByRole("heading", { name: "5 available slots on this day", exact: true })).toBeVisible();
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
    await expect(page.getByRole("link", { name: /View more events/ })).toHaveAttribute("href", "https://calendar.google.com/calendar/u/0/r/day/2026/10/14?authuser=qa-owner%40example.com");
    await page.getByTestId("calendar-scroll-root").evaluate(element => { element.scrollTop = element.scrollHeight; });
    const emptyChrome = (await page.getByTestId("reserved-bottom-chrome").boundingBox())!;
    const emptyDisconnect = (await page.getByRole("button", { name: "Disconnect Calendar", exact: true }).boundingBox())!;
    expect(emptyDisconnect.y + emptyDisconnect.height).toBeLessThanOrEqual(emptyChrome.y);
    expect(empty.errors).toEqual([]);
    expect(empty.unexpectedRequests).toEqual([]);
  });
}
